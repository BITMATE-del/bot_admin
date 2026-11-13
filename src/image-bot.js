import crypto from 'node:crypto';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { reviseDesignRegion, editWholeImage, interpretImageRequest } from './ai-image-design.js';
import { replaceTextStrict } from './strict-text-replace.js';
import { createImageCredits } from './image-credits.js';
import { createPhotoAdminMenu } from './photo-admin-menu.js';

// Preserve the previously working contextual edit path for printed/striped
// backgrounds. Strict font rendering is tried first, but its inability to
// model a background must NOT prevent the user from editing as before.
// Never swallow unrelated errors or silently use a different font on a flat
// background. The older path retains its typography/placement QA.
// Construct a character-complete replacement request. Many labels contain
// supplementary Hanja and a final ')' outside the user-typed source string.
// Those neighboring glyphs must NEVER be treated as part of the replacement.
// When an edit targets only a short Korean name, protect a neighboring
// parenthetical Hanja suffix by keeping it OUTSIDE the AI edit rectangle.
// This is conservative; if text geometry is unclear we keep the selected
// rectangle and rely on the existing validation rather than guessing.
export async function isolateKoreanNameSelection(sourceBuffer,selection,from,to){
  if(!/^[가-힣]{2,4}$/.test(from)||! /^[가-힣]{2,4}$/.test(to)||
    Array.from(from).length!==Array.from(to).length)return selection;
  const {x,y,w,h}=selection;
  if(w<72||h<18)return selection;
  const region=await sharp(sourceBuffer).rotate().extract({left:x,top:y,width:w,height:h})
    .removeAlpha().raw().toBuffer({resolveWithObject:true});
  const {data,info}=region,ch=info.channels;
  const values=[];
  for(let py=0;py<h;py+=2)for(let px=0;px<w;px+=2){
    const k=(py*w+px)*ch;
    values.push((data[k]+data[k+1]+data[k+2])/3);
  }
  values.sort((a,b)=>a-b);
  const paper=values[Math.floor(values.length*.88)];
  if(paper<165)return selection;
  const threshold=Math.min(128,paper-62);
  const ink=new Uint8Array(w);
  let top=h,bottom=-1,left=w,right=-1;
  for(let py=0;py<h;py++)for(let px=0;px<w;px++){
    const k=(py*w+px)*ch;
    const v=(data[k]+data[k+1]+data[k+2])/3;
    if(v>=threshold)continue;
    ink[px]++;
    top=Math.min(top,py);bottom=Math.max(bottom,py);
    left=Math.min(left,px);right=Math.max(right,px);
  }
  const glyphH=bottom-top+1;
  if(glyphH<10||glyphH>h*.85||left<2||right>=w-2)return selection;
  const nominal=left+Array.from(from).length*glyphH*.98;
  // A distinct suffix should remain substantially to the right of the
  // expected name boundary. Find an ink-free gap close to that boundary.
  if(right<nominal+glyphH*.42)return selection;
  let best=null;
  for(let cut=Math.max(left+glyphH,Math.floor(nominal-glyphH*.28));
    cut<=Math.min(w-4,Math.ceil(nominal+glyphH*.28));cut++){
    const window=ink[Math.max(0,cut-1)]+ink[cut]+ink[Math.min(w-1,cut+1)];
    const distance=Math.abs(cut-nominal);
    const penalty=window*5+distance*.20;
    if(!best||penalty<best.penalty)best={cut,penalty,window};
  }
  if(!best||best.window>2||best.cut<left+glyphH)return selection;
  const protectedPixels=ink.slice(best.cut+2).reduce((sum,v)=>sum+v,0);
  if(protectedPixels<Math.max(8,glyphH*.6))return selection;
  const nextW=best.cut+1;
  console.info('name suffix protected by cropping edit selection',JSON.stringify({
    oldWidth:w,newWidth:nextW,glyphHeight:glyphH,protectedPixels
  }));
  return {...selection,w:nextW};
}
export function buildCharacterSafeEditInstruction(from,to,selection){
  const original=JSON.stringify(String(from));
  const replacement=JSON.stringify(String(to));
  const complete=s=>Array.from(String(s)).length;
  return [
    'STRICT TEXT SUBSTITUTION. Replace exactly '+original+' with exactly '+replacement+'.',
    'The source substring contains '+complete(from)+' Unicode characters and the new substring contains '+complete(to)+' characters.',
    'EVERY other printed character in the image is immutable, including both parentheses ( and ), brackets, commas, periods, spaces, Korean, Hanja, and punctuation.',
    'If the original label contains a parenthesized Hanja name, retain BOTH the opening ( and closing ) and all Hanja characters unless explicitly present in the requested source substring.',
    'In particular NEVER omit, erase, crop, rewrite, or invent the rightmost closing parenthesis ). Even if it is near the selected region boundary, keep it identical to the uploaded image.',
    'PRESERVE SOURCE GLYPH SIZE: retain original text glyph HEIGHT in pixels, thin stroke weight, baseline, spacing and scale. Fit longer text by natural horizontal width within the selection, NOT by increasing font-size, vertically stretching letters, or reducing unrelated text.',
    'Preserve the existing patterned background, print texture, muted original ink color and stroke contrast. Remove only ghosts from the old replaced substring; never leave overlapping text or a second text layer.',
    'The user-selected region is approximately '+selection.w+' pixels wide and '+selection.h+' pixels high. These are editing boundaries, NOT target glyph dimensions. Do not fill the rectangle with enlarged text.',
    'All punctuation and characters outside the requested substring remain exactly as in the original, even if located inside the selection rectangle.'
  ].join(' ');
}
async function replaceSelectedText(buf,selection,from,to){
  const textSelection=await isolateKoreanNameSelection(buf,selection,from,to);
  try{
    return await replaceTextStrict(buf,textSelection,from,to);
  }catch(error){
    // Source-matching fonts are a quality preference, NOT permission to block
    // all editing. If the installed font set cannot reproduce an unusual
    // printed face, use the previously working contextual editor instead.
    // Preserve true input/selection failures and don't swallow API failures.
    const reason=String(error?.message||'');
    const fallbackReasons=[
      '원본 배경 무늬를 정확하게 복원할 근거가 부족해',
      '원본 글씨체와 일치하는 서체를 찾지 못했어',
      '기존 글자와 배경을 확실하게 구분할 수 없어',
    ];
    if(!fallbackReasons.some(text=>reason.includes(text)))throw error;
    console.info('strict renderer unavailable; using contextual text editor',
      JSON.stringify({width:textSelection.w,height:textSelection.h,reason:reason.slice(0,120)}));
    return reviseDesignRegion(buf,textSelection,buildCharacterSafeEditInstruction(from,to,textSelection));
  }
}
const token = process.env.IMAGE_BOT_TOKEN;
const editorOrigin = 'https://botadmin-production.up.railway.app';
const editorUrl = jobId => editorOrigin + '/image-editor?job=' + encodeURIComponent(jobId) + '&v=20261109-7';
const sessions = new Map();
const pending = new Map();
const manualJobs = new Map();
const JOB_TABLE='image_edit_temporary_jobs';
async function ensureTemporaryJobs(pool){
  await pool.query(`CREATE TABLE IF NOT EXISTS image_edit_temporary_jobs (
    id varchar(32) PRIMARY KEY,
    chat_id text NOT NULL,
    uid text NOT NULL,
    image_bytes bytea,
    source_text text NOT NULL,
    target_text text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    state text NOT NULL DEFAULT 'ready',
    error text
  )`);
  await pool.query("DELETE FROM image_edit_temporary_jobs WHERE created_at < NOW() - INTERVAL '30 minutes'");
}
async function storeTemporaryJob(pool,job){
  await pool.query(`INSERT INTO image_edit_temporary_jobs
    (id,chat_id,uid,image_bytes,source_text,target_text,created_at,state)
    VALUES ($1,$2,$3,$4,$5,$6,to_timestamp($7 / 1000.0),'ready')`,
    [job.id,String(job.chatId),job.uid,job.buf,job.change.from,job.change.to,job.created]);
}
async function readTemporaryJob(pool,id){
  if(!/^[a-f0-9]{32}$/.test(String(id||'')))return null;
  const {rows}=await pool.query(`SELECT id,chat_id,uid,image_bytes,source_text,target_text,
    (extract(epoch from created_at)*1000)::bigint AS created_ms,state,error
    FROM image_edit_temporary_jobs
    WHERE id=$1 AND created_at > NOW() - INTERVAL '30 minutes'`,[id]);
  const row=rows[0];
  if(!row)return null;
  // A restarted worker cannot reliably resume an image API call. A previously
  // claimed job is never silently replayed, so billing cannot be duplicated.
  const state=['ready','done','failed'].includes(row.state)?row.state:'interrupted';
  return {id:row.id,chatId:row.chat_id,uid:row.uid,buf:row.image_bytes,
    change:{from:row.source_text,to:row.target_text},
    created:Number(row.created_ms),state,error:row.error||(
      state==='interrupted'?'서버가 교체되어 이전 편집 작업이 중단됐어. 중복 처리를 막기 위해 같은 작업은 자동 재실행하지 않아.':''
    )};
}
async function setTemporaryJobState(pool,id,state,error=null){
  await pool.query('UPDATE image_edit_temporary_jobs SET state=$2,error=$3 WHERE id=$1',[id,state,error]);
}

const successfulEditDurations=[];
const FREE_PASS_GROUP='@angggggaggg';
const FREE_PASS_LINK='https://t.me/angggggaggg';
const purchasePending=new Map();
function estimateRemaining(state,elapsed){
  if(state==='done')return {min:0,max:0,basis:'complete'};
  if(state==='ready'||state==='failed')return {min:null,max:null,basis:'none'};
  if(state==='sending')return {min:0,max:20,basis:'stage'};
  const sorted=[...successfulEditDurations].sort((a,b)=>a-b);
  const historical=sorted.length>=3;
  const typical=historical?sorted[Math.floor(sorted.length/2)]:80;
  const minTime=historical?Math.max(15,Math.floor(typical*0.6)):30;
  const maxTime=historical?Math.max(minTime+30,Math.ceil(typical*1.8)):150;
  if(elapsed>=maxTime)return {min:null,max:null,basis:'overdue'};
  return {min:Math.max(0,minTime-elapsed),max:Math.max(0,maxTime-elapsed),basis:historical?'history':'initial'};
}

const MAX_IMAGE = 12 * 1024 * 1024;
const MAX_SIDE = 5000;
const ttl = 30 * 60 * 1000;
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const tg = async (method, data) => {
  const resp = await fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data),signal:AbortSignal.timeout(25000)
  });
  const json=await resp.json();
  if(!json.ok) throw new Error(json.description || 'Telegram API error');
  return json.result;
};
const send = (id,text) => tg('sendMessage',{chat_id:id,text});
const guideImagePath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public/photo-bot-guide.png');
async function sendPurchaseGuidePhoto(chatId,buttons){
 const imagePath=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../public/photo-bot-payment-guide.png');
 const png=await readFile(imagePath);
 const metadata=await sharp(png).metadata();
 if(metadata.format!=='png'||!metadata.width||!metadata.height)throw Error('충전 안내 이미지 PNG 형식이 올바르지 않아.');
 const form=new FormData();
 form.append('chat_id',String(chatId));
 form.append('photo',new Blob([png],{type:'image/png'}),'photo-bot-payment-guide.png');
 form.append('reply_markup',JSON.stringify({inline_keyboard:buttons}));
 const response=await fetch('https://api.telegram.org/bot'+token+'/sendPhoto',{
  method:'POST',body:form,signal:AbortSignal.timeout(45000)
 });
 const result=await response.json();
 if(!result.ok)throw Error(result.description||'충전 안내 이미지 전송 실패');
}
async function sendGuidePhoto(chatId,buttons){
  const png=await readFile(guideImagePath);
  const dimensions=await sharp(png).metadata();
  if(dimensions.format!=='png'||!dimensions.width||!dimensions.height)
    throw new Error('안내 이미지 PNG 파일이 올바르지 않아.');
  const form=new FormData();
  form.append('chat_id',String(chatId));
  form.append('photo',new Blob([png],{type:'image/png'}),'photo-bot-guide.png');
  form.append('reply_markup',JSON.stringify({inline_keyboard:buttons}));
  const response=await fetch('https://api.telegram.org/bot'+token+'/sendPhoto',{
    method:'POST',body:form,signal:AbortSignal.timeout(45000)
  });
  const result=await response.json();
  if(!result.ok)throw new Error(result.description||'안내 이미지 전송 실패');
}

const normal = s => String(s).normalize('NFKC').replace(/\s/g,'').toLowerCase();
const parseChange = raw => {
  const row=String(raw).trim().normalize('NFKC');
  const arrow=row.match(/^(.+?)\s*(?:→|->|>|⇒|➜)\s*(.+)$/);
  const natural=row.match(/^(.+?)(?:을|를)\s+(.+?)(?:으로|로)\s*(?:바꿔줘|바꿔|변경해줘|변경|수정해줘|수정|교체해줘|교체|바꾸기|변경하기)[.! ]*$/);
  const naturalShort=row.match(/^(.+?)(?:을|를)\s+(.+?)(?:으로|로)\s*$/);
  const match=arrow||natural||naturalShort;
  if(!match)return null;
  const from=match[1].trim(),to=match[2].trim();
  if(!from||!to||from.length>70||to.length>70)return null;
  return {from,to};
};
const pairs = s => {
  const lines=String(s).split(/\n/).map(x=>x.trim()).filter(Boolean);
  const parsed=lines.map(parseChange);
  if(parsed.some(x=>!x))return null;
  return parsed;
};
function extractWords(data){
  const out=[];
  const add=w=>{const b=w.bbox;if(w.text&&b&&Number.isFinite(b.x0)&&Number.isFinite(b.y0))out.push({text:String(w.text),bbox:b,confidence:w.confidence||0});};
  if(Array.isArray(data.words))data.words.forEach(add);
  else for(const block of data.blocks||[])for(const para of block.paragraphs||[])for(const line of para.lines||[])for(const word of line.words||[])add(word);
  return out.sort((a,b)=>Math.abs(a.bbox.y0-b.bbox.y0)>16?a.bbox.y0-b.bbox.y0:a.bbox.x0-b.bbox.x0);
}
function findBox(words, phrase){
  const target=normal(phrase);
  const matches=[];
  for(let i=0;i<words.length;i++){
    let joined='';
    for(let j=i;j<Math.min(i+12,words.length);j++){
      if(j>i && (words[j].bbox.x0<words[j-1].bbox.x0-5 || Math.abs(words[j].bbox.y0-words[i].bbox.y0)>22))break;
      joined+=normal(words[j].text);
      if(joined===target){
        matches.push({x0:Math.min(...words.slice(i,j+1).map(w=>w.bbox.x0)),y0:Math.min(...words.slice(i,j+1).map(w=>w.bbox.y0)),x1:Math.max(...words.slice(i,j+1).map(w=>w.bbox.x1)),y1:Math.max(...words.slice(i,j+1).map(w=>w.bbox.y1))});break;
      }
      if(joined.length>target.length)break;
    }
  }
  if(matches.length!==1)throw new Error(matches.length?'같은 문구가 여러 곳에 있어 자동 수정이 중단됐습니다: '+phrase:'이미지에서 문구를 정확히 찾지 못했습니다: '+phrase);
  return matches[0];
}
function parseTarget(value){
  const match=value.match(/^(?:첫\s*번째|첫\s*번)\s*(?:에\s*있는)?\s*(.+)$/);
  if(match)return {phrase:match[1].trim(),index:0};
  const last=value.match(/^(?:마지막)\s*(?:에\s*있는)?\s*(.+)$/);
  if(last)return {phrase:last[1].trim(),index:-1};
  return {phrase:value,index:null};
}
function pointToOriginal(x,y,angle,ow,oh,rw,rh){
  const rad=angle*Math.PI/180,c=Math.cos(rad),s=Math.sin(rad);
  const dx=x-rw/2,dy=y-rh/2;
  // Inverse of the clockwise OCR canvas rotation, not a second forward rotation.
  return {x:c*dx+s*dy+ow/2,y:-s*dx+c*dy+oh/2};
}
function originalOCRBounds(found,width,height){
  // OCR boxes are measured in the rotated image. Convert every corner
  // into source coordinates before using a rectangle for preview or editing.
  const corners=[
    [found.x0,found.y0],[found.x1,found.y0],
    [found.x0,found.y1],[found.x1,found.y1]
  ].map(([x,y])=>pointToOriginal(x,y,found.angle,width,height,found.rw,found.rh));
  const left=Math.max(0,Math.floor(Math.min(...corners.map(p=>p.x))-4));
  const top=Math.max(0,Math.floor(Math.min(...corners.map(p=>p.y))-4));
  // Reserve space for wider replacement glyphs without shifting the
  // left-hand anchor. The source OCR box is frequently tight to the ink.
  const glyphWidth=Math.max(1,Math.max(...corners.map(p=>p.x))-Math.min(...corners.map(p=>p.x)));
  const rightPad=Math.max(8,Math.min(28,Math.ceil(glyphWidth*0.25)));
  const right=Math.min(width,Math.ceil(Math.max(...corners.map(p=>p.x))+rightPad));
  const bottom=Math.min(height,Math.ceil(Math.max(...corners.map(p=>p.y))+4));
  if(right-left<4||bottom-top<4)throw new Error('자동 선택 영역의 좌표가 올바르지 않아 직접 위치를 선택해 줘.');
  return {left,top,right,bottom};
}
async function locate(worker, baseBuffer, scale, width,height, target){
  const variants=[0,-12,12,-25,25,-40,40];
  const found=[];
  for(const angle of variants){
    const rotated=angle===0?baseBuffer:await sharp(baseBuffer).rotate(angle,{background:'#ffffff'}).png().toBuffer();
    const meta=await sharp(rotated).metadata();
    const ocr=await worker.recognize(rotated,{}, {text:true,blocks:true});
    const words=extractWords(ocr.data);
    // OCR may detect the same text at multiple rotation angles; deduplicate by original position.
    const goal=normal(target.phrase);
    for(let i=0;i<words.length;i++){
      let phrase='';
      for(let j=i;j<Math.min(words.length,i+7);j++){
        const w=words[j],prev=words[j-1];
        if(j>i&&(Math.abs(w.bbox.y0-words[i].bbox.y0)>32*scale || w.bbox.x0<prev.bbox.x0-6*scale))break;
        phrase+=normal(w.text);
        if(phrase===goal){
          const selected=words.slice(i,j+1);
          const x0=Math.min(...selected.map(w=>w.bbox.x0))/scale,y0=Math.min(...selected.map(w=>w.bbox.y0))/scale;
          const x1=Math.max(...selected.map(w=>w.bbox.x1))/scale,y1=Math.max(...selected.map(w=>w.bbox.y1))/scale;
          const cx=(x0+x1)/2,cy=(y0+y1)/2;
          const position=pointToOriginal(cx,cy,angle,width,height,meta.width/scale,meta.height/scale);
          if(position.x>=0&&position.x<width&&position.y>=0&&position.y<height)
            found.push({angle,x0,y0,x1,y1,cx,cy,position,confidence:selected.reduce((acc,w)=>acc+(w.confidence||0),0)/selected.length,rw:meta.width/scale,rh:meta.height/scale});
          break;
        }
        if(phrase.length>goal.length)break;
      }
    }
    if(found.length && target.index===null && angle===0)break;
  }
  const groups=[];
  for(const m of found){
    let g=groups.find(g=>Math.hypot(g.best.position.x-m.position.x,g.best.position.y-m.position.y)<12);
    if(!g)groups.push(g={best:m});
    else if(m.confidence>g.best.confidence)g.best=m;
  }
  groups.sort((a,b)=>a.best.position.y-b.best.position.y||a.best.position.x-b.best.position.x);
  if(!groups.length)throw new Error('글자를 찾지 못했습니다: '+target.phrase+'. 이미지에서 해당 부분을 잘라 확대해서 다시 올려주세요.');
  if(target.index===null&&groups.length>1)throw new Error('같은 문구가 '+groups.length+'곳에서 인식됐습니다. "첫번째에 있는 '+target.phrase+' > 새문구" 또는 "마지막 '+target.phrase+' > 새문구"로 지정해 주세요.');
  return (target.index===-1?groups.at(-1):groups[0]).best;
}
async function replaceText(input,changes){
  const upright=await sharp(input).rotate().png().toBuffer();
  const meta=await sharp(upright).metadata();
  if(!meta.width||!meta.height||meta.width>MAX_SIDE||meta.height>MAX_SIDE)throw new Error('지원하지 않는 이미지 크기입니다.');
  const width=meta.width,height=meta.height;
  const scale=width<800?3:width<1400?2:1;
  const enlarged=await sharp(upright).resize({width:width*scale}).png().toBuffer();
  const worker=await createWorker('kor+eng',1,{logger:()=>{}});
  const overlays=[],regions=[];
  const base=await sharp(upright).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const channels=base.info.channels;
  const sample=(x,y)=>{
    const cx=Math.max(0,Math.min(Math.floor(x),base.info.width-1));
    const cy=Math.max(0,Math.min(Math.floor(y),base.info.height-1));
    const i=(cy*base.info.width+cx)*channels;
    return [base.data[i],base.data[i+1],base.data[i+2]];
  };
  try{
    for(const change of changes){
      const target=parseTarget(change.from);
      const found=await locate(worker,enlarged,scale,width,height,target);
      const region=originalOCRBounds(found,width,height);
      const rw=region.right-region.left,rh=region.bottom-region.top;
      const pos=found.position;
      if(regions.some(r=>region.left<r.right&&region.right>r.left&&region.top<r.bottom&&region.bottom>r.top))throw new Error('수정할 문구 영역이 겹칩니다.');
      regions.push(region);
      const rgb=sample(pos.x,pos.y-Math.max(4,rh));
      const luminance=(rgb[0]*.299+rgb[1]*.587+rgb[2]*.114);
      const color=luminance>140?'#1d2026':'#f5f5f5';
      const fill='rgb('+rgb.join(',')+')';
      const angle=found.angle;
      const fontSize=Math.max(5,Math.min(Math.round(rh*.77),Math.floor((rw-3)/Math.max(1,Array.from(change.to).length)*1.42)));
      // Only the detected text polygon is repainted; all other pixels are taken from the original.
      const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'"><defs><clipPath id="editbox"><rect x="'+(-rw/2)+'" y="'+(-rh/2)+'" width="'+rw+'" height="'+rh+'"/></clipPath></defs><g transform="translate('+pos.x+' '+pos.y+') rotate('+(-angle)+')"><rect x="'+(-rw/2)+'" y="'+(-rh/2)+'" width="'+rw+'" height="'+rh+'" fill="'+fill+'"/><g clip-path="url(#editbox)"><text x="0" y="'+(fontSize*.32)+'" font-size="'+fontSize+'" font-family="Noto Sans CJK KR,DejaVu Sans,sans-serif" fill="'+color+'" text-anchor="middle">'+esc(change.to)+'</text></g></g></svg>';
      overlays.push({input:Buffer.from(svg),left:0,top:0});
    }
  }finally{await worker.terminate();}
  // Leave unrelated pixels untouched; no decorative elements are added.
  const output=await sharp(upright).ensureAlpha().composite(overlays).png().toBuffer();
  const marker=regions.map((r,i)=>'<rect x="'+Math.max(0,r.left)+'" y="'+Math.max(0,r.top)+'" width="'+Math.max(1,r.right-r.left)+'" height="'+Math.max(1,r.bottom-r.top)+'" fill="none" stroke="#fa3b32" stroke-width="3"/><text x="'+Math.max(0,r.left)+'" y="'+Math.max(16,r.top-5)+'" fill="#ffffff" stroke="#000000" stroke-width="3" paint-order="stroke" font-size="16" font-family="sans-serif">수정위치 '+(i+1)+'</text>').join('');
  const previewSvg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'">'+marker+'</svg>';
  const preview=await sharp(upright).composite([{input:Buffer.from(previewSvg),left:0,top:0}]).png().toBuffer();
  return {output,preview,regions};
}
async function sendPreview(chatId,buf,id,manualUrl){
  const form=new FormData();
  form.append('chat_id',String(chatId));
  form.append('caption','빨간 사각형이 수정하려는 위치야. 정확할 때만 [위치 확인 · 수정]을 눌러줘. 다른 위치면 취소하고 해당 부분을 확대해서 올려줘.');
  form.append('reply_markup',JSON.stringify({inline_keyboard:[[{text:'✅ 위치 확인 · 수정',callback_data:'im:ok:'+id},{text:'❌ 취소',callback_data:'im:no:'+id}],[{text:'✏️ 텔레그램에서 위치 선택',web_app:{url:manualUrl}}],[{text:'🌐 브라우저로 열기',url:manualUrl}]]}));
  form.append('photo',new Blob([buf],{type:'image/png'}),'preview.png');
  const resp=await fetch('https://api.telegram.org/bot'+token+'/sendPhoto',{method:'POST',body:form,signal:AbortSignal.timeout(30000)});
  const json=await resp.json();if(!json.ok)throw new Error(json.description||'미리보기 전송 실패');
}
async function sendImage(chatId,buf){
  const form=new FormData();
  form.append('chat_id',String(chatId));
  form.append('caption','편집본 · 원본 이미지에서 수정한 결과입니다.');
  form.append('document',new Blob([buf],{type:'image/png'}),'edited.png');
  const resp=await fetch('https://api.telegram.org/bot'+token+'/sendDocument',{method:'POST',body:form,signal:AbortSignal.timeout(30000)});
  const json=await resp.json();
  if(!json.ok)throw new Error(json.description||'이미지 전송 실패');
}
async function verifyOutputFile(original,edited,allowExtended=false){
  const [source,output]=await Promise.all([
    sharp(original).rotate().png().toBuffer(),
    sharp(edited).png().toBuffer()
  ]);
  const [a,b]=await Promise.all([sharp(source).metadata(),sharp(output).metadata()]);
  if(!b.width||!b.height||a.width!==b.width||(!allowExtended && a.height!==b.height)||(allowExtended && (b.height<=a.height||b.height>a.height+1200))){
    throw new Error('편집본 해상도가 원본과 달라 전송하지 않았어.');
  }
  if(source.equals(output)){
    throw new Error('편집본에 변경된 내용이 없어 전송하지 않았어.');
  }
  const {data,info}=await sharp(output)
    .resize({width:Math.min(b.width,256),withoutEnlargement:true})
    .ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let alphaMissing=0;
  for(let i=3;i<data.length;i+=info.channels)if(data[i]===0)alphaMissing++;
  if(alphaMissing>info.width*info.height*0.1){
    throw new Error('편집본에 비정상적인 투명 영역이 있어 전송하지 않았어.');
  }
}
async function sendOriginalAndEdit(chatId,original,edited,allowExtended=false){
  await verifyOutputFile(original,edited,allowExtended);
  const form=new FormData();
  form.append('chat_id',String(chatId));
  form.append('media',JSON.stringify([
    {type:'document',media:'attach://source',caption:'원본'},
    {type:'document',media:'attach://revision',caption:'편집본 (수정된 이미지)'}
  ]));
  const normalized=await sharp(original).rotate().png().toBuffer();
  form.append('source',new Blob([normalized],{type:'image/png'}),'original.png');
  form.append('revision',new Blob([edited],{type:'image/png'}),'edited.png');
  const response=await fetch('https://api.telegram.org/bot'+token+'/sendMediaGroup',{
    method:'POST',body:form,signal:AbortSignal.timeout(45000)
  });
  const result=await response.json();
  if(!result.ok)throw new Error(result.description||'원본과 편집본 전송 실패');
}
async function download(fileId){
  const file=await tg('getFile',{file_id:fileId});
  if((file.file_size||0)>MAX_IMAGE)throw new Error('12MB 이하 이미지를 올려주세요.');
  const resp=await fetch('https://api.telegram.org/file/bot'+token+'/'+file.file_path,{signal:AbortSignal.timeout(30000)});
  if(!resp.ok)throw new Error('이미지 다운로드 실패');
  const arr=await resp.arrayBuffer();
  if(arr.byteLength>MAX_IMAGE)throw new Error('이미지 크기가 너무 큽니다.');
  return Buffer.from(arr);
}

async function makeManualJob(chatId,buf,change,uid,pool){
  const id=crypto.randomBytes(16).toString('hex');
  const job={id,chatId,uid:String(uid),buf,change,created:Date.now(),busy:false,state:'ready'};
  await storeTemporaryJob(pool,job);
  manualJobs.set(id,job);
  return id;
}
async function manualEdit(buf,{x,y,w,h,after,angle}){
  const original=await sharp(buf).rotate().png().toBuffer();
  const meta=await sharp(original).metadata(),W=meta.width,H=meta.height;
  if(!Number.isInteger(x)||!Number.isInteger(y)||!Number.isInteger(w)||!Number.isInteger(h)||x<0||y<0||w<4||h<4||w>W*.8||h>H*.45||x+w>W||y+h>H)
    throw new Error('수정 영역이 올바르지 않아.');
  if(typeof after!=='string'||!after.trim()||after.length>70||!Number.isFinite(angle)||Math.abs(angle)>60)throw new Error('입력값을 확인해 줘.');
  const pixels=await sharp(original).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const n=pixels.info.channels;
  const sample=(px,py)=>{
    px=Math.max(0,Math.min(W-1,Math.round(px)));
    py=Math.max(0,Math.min(H-1,Math.round(py)));
    const idx=(py*W+px)*n;
    return [pixels.data[idx],pixels.data[idx+1],pixels.data[idx+2]];
  };
  const around=[sample(x-2,y+h/2),sample(x+w+2,y+h/2),sample(x+w/2,y-2)];
  const bg=around.map((_,i)=>Math.round(around.reduce((a,r)=>a+r[i],0)/3));
  const lum=bg[0]*.299+bg[1]*.587+bg[2]*.114;
  const fg=lum>140?'#191c20':'#f1f5fa';
  const fontSize=Math.max(5,Math.min(90,Math.round(h*.75),Math.floor((w-4)/Math.max(1,Array.from(after).length)*1.38)));
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+W+'" height="'+H+'"><defs><clipPath id="region"><rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'"/></clipPath></defs><g clip-path="url(#region)"><rect x="'+x+'" y="'+y+'" width="'+w+'" height="'+h+'" fill="rgb('+bg.join(',')+')"/><g transform="translate('+(x+w/2)+' '+(y+h/2)+') rotate('+angle+')"><text x="0" y="'+(fontSize*.34)+'" font-size="'+fontSize+'" font-family="Noto Sans CJK KR,DejaVu Sans,sans-serif" text-anchor="middle" fill="'+fg+'">'+esc(after)+'</text></g></g></svg>';
  return sharp(original).composite([{input:Buffer.from(svg),left:0,top:0}]).png().toBuffer();
}
async function sendManualLink(chatId,jobId,base){
  const url=editorUrl(jobId);
  await tg('sendMessage',{chat_id:chatId,text:'수정할 글자의 위치를 직접 선택할 수 있어. 아래 첫 버튼은 텔레그램 내부 화면, 두 번째는 외부 브라우저로 열어. 열리지 않으면 주소를 복사해서 크롬에 붙여넣어 줘. (30분 유효)\n\n'+url,disable_web_page_preview:true,reply_markup:{inline_keyboard:[[{text:'✏️ 텔레그램에서 위치 선택',web_app:{url}}],[{text:'🌐 브라우저로 열기',url}]]}});
}

async function sendBalance(chatId,uid,credits,heading='사용 가능 횟수'){
  const b=await credits.status(uid);
  await send(chatId,'🎫 '+heading+'\n고유 UID: '+b.uid+'\n무료 이용권: '+b.trial_left+'회\n구매 이용권: '+(b.point_left+b.paid_left)+'회\n전체 잔여: '+b.remaining+'회\n완료한 편집: '+b.used+'회\n※ 결과 전송 성공 시에만 이용권 1회 차감');
  return b;
}
async function obtainCredit(chatId,uid,credits,source,summary=''){
  const reserved=await credits.reserve(uid,source,summary);
  if(!reserved.ok){
    await send(chatId,reserved.reason==='blocked'?'관리자에 의해 사용이 제한된 계정이야.':'이용 가능한 편집 횟수가 없어. /이용권구매 에서 구매를 신청할 수 있어.');
    return null;
  }
  return reserved.id;
}
async function showPhotoHome(chatId,uid,adminMenu){
 const buttons=[
  [{text:'✏️ 편집하기',callback_data:'ui:edit'}],
  [{text:'🎁 첫 무료 이용권 받기',callback_data:'ui:free'}],
  [{text:'🎫 이용권 구매하기',callback_data:'ui:shop'}],
  [{text:'📊 내 이용권',callback_data:'ui:balance'},{text:'🧾 구매 내역',callback_data:'ui:orders'}]
 ];
 if(await adminMenu.isAdmin(uid))buttons.push([{text:'🔐 관리자 전용',callback_data:'pa:home'}]);
 await sendGuidePhoto(chatId,buttons);
}
async function sendInvoice(chatId,order,commerce){
 const asset=order.payment_asset;
 const exactly=String(order.payment_amount);
 const text=(order.existing?'🔄 기존 입금 대기 주문 재안내':'✅ 이용권 구매 신청 완료')+
  '\n주문 번호: #'+order.id+
  '\n상품: '+order.name+' ('+order.credits+'매)'+
  '\n기준 가격: '+Number(order.price_usdt).toLocaleString('en-US')+' USDT'+
  '\n결제: '+(asset==='USDT'?'USDT (TRC20)':'TRON (TRX)')+
  '\n\n입금 수량: '+exactly+' '+asset+
  '\n입금 주소:\n'+order.payment_address+
  (order.instructions?'\n\n'+order.instructions:'')+
  '\n\n⚠️ 소수점까지 안내된 정확한 수량을 입금해 줘.\n신청 후 24시간 안에 확정되어야 자동 지급돼.\n입금 전 네트워크와 주소를 다시 확인해 줘.';
 await tg('sendMessage',{chat_id:chatId,text,reply_markup:{inline_keyboard:[
  [{text:'🧾 내 구매 내역',callback_data:'ui:orders'}],
  [{text:'↩ 상품 목록',callback_data:'ui:shop'},{text:'🏠 처음으로',callback_data:'ui:home'}]
 ]}});
}
async function showPhotoShop(chatId,commerce){
 const shop=await commerce.storefront();
 if(!shop.enabled||!shop.packages.length){
  await send(chatId,'현재 이용권 구매 준비 중이야. 결제 지갑 설정이 완료되면 구매할 수 있어.');
  return;
 }
 const buttons=shop.packages.map(p=>[{
  text:p.name+' · '+Number(p.price_usdt).toLocaleString('en-US')+' USDT',
  callback_data:'shop:'+p.id
 }]);
 buttons.push([{text:'🧾 구매 내역',callback_data:'ui:orders'},{text:'🏠 처음으로',callback_data:'ui:home'}]);
 try{
  await sendPurchaseGuidePhoto(chatId,buttons);
 }catch(error){
  // Preserve purchase access if the poster file is not yet in the repo.
  console.warn('purchase guide image unavailable; sending original purchase menu:',error.message);
  await tg('sendMessage',{chat_id:chatId,
   text:'🎁 이용권 충전 안내\nUSDT(TRC20) 또는 TRON(TRX)으로 충전할 수 있어.\n상품 선택 후 발급된 주소에 정확한 수량을 입금하면 확정 거래 확인 후 자동으로 이용권이 지급돼.\n충전 완료 후 단순 변심에 따른 환불은 제한되며 관련 법령이 우선 적용돼.',
   reply_markup:{inline_keyboard:buttons}
  });
 }
}
async function showFreePass(chatId,uid,credits){
 if(await credits.freePassClaimed(uid)){
  await send(chatId,'첫 무료 이용권은 계정당 1회만 받을 수 있어. 이미 지급받은 UID야.\n/잔여횟수 에서 현재 이용권을 확인해 줘.');
  return;
 }
 await tg('sendMessage',{chat_id:chatId,
  text:'🎁 첫 무료 이용권 받기\n\n아래 텔레그램 그룹에 입장하면 무료 편집 이용권 1회를 받을 수 있어.\n\n✅ UID당 평생 1회만 지급\n✅ 입장 후 [입장 확인 · 이용권 받기]를 눌러 줘.\n✅ 가입 여부가 확인된 경우에만 지급돼.',
  reply_markup:{inline_keyboard:[
   [{text:'📢 그룹 입장하기',url:FREE_PASS_LINK}],
   [{text:'✅ 입장 확인 · 이용권 받기',callback_data:'ui:verifyfree'}]
  ]}
 });
}
async function verifyFreePass(chatId,uid,credits){
 if(await credits.freePassClaimed(uid)){
  await send(chatId,'이미 첫 무료 이용권을 지급받은 UID야. 계정당 1회만 받을 수 있어.');return;
 }
 let membership;
 try{
  membership=await tg('getChatMember',{chat_id:FREE_PASS_GROUP,user_id:Number(uid)});
 }catch(e){
  console.error('free pass membership check unavailable:',e.message);
  await send(chatId,'그룹 가입 상태를 조회하지 못했어. 그룹에 포토샵봇이 관리자로 등록되어 있는지 확인해 줘.\n확인 전에는 이용권을 지급하지 않아.');
  return;
 }
 const status=membership?.status;
 const joined=status==='creator'||status==='administrator'||status==='member'||
  (status==='restricted'&&membership.is_member===true);
 if(!joined){
  await tg('sendMessage',{chat_id:chatId,
   text:'아직 그룹 입장이 확인되지 않았어. 아래 링크로 입장한 뒤 다시 확인해 줘.',
   reply_markup:{inline_keyboard:[
    [{text:'📢 그룹 입장하기',url:FREE_PASS_LINK}],
    [{text:'✅ 입장 다시 확인',callback_data:'ui:verifyfree'}]
   ]}
  });
  return;
 }
 const result=await credits.grantFreePassOnce(uid);
 if(!result.ok){
  await send(chatId,result.reason==='blocked'?'이용이 제한된 계정에는 이용권을 지급할 수 없어.':'이미 첫 무료 이용권을 지급받은 UID야. 계정당 1회만 받을 수 있어.');
  return;
 }
 await send(chatId,'🎉 그룹 가입 확인 완료!\n첫 무료 편집 이용권 1회가 지급됐어.\n이용권은 UID당 평생 한 번만 지급돼.');
 await sendBalance(chatId,uid,credits,'무료 이용권 지급 완료');
}
async function handle(update,base,credits,commerce,adminMenu,pool){
  if(await adminMenu.handle(update))return;
  const cb=update.callback_query;
  if(cb?.data==='ui:home'){
    if(cb.message?.chat?.type!=='private')return;
    await tg('answerCallbackQuery',{callback_query_id:cb.id}).catch(()=>{});
    await showPhotoHome(cb.message.chat.id,cb.from.id,adminMenu);
    return;
  }
  if(cb?.data==='ui:edit'){
    if(cb.message?.chat?.type!=='private')return;
    await tg('answerCallbackQuery',{callback_query_id:cb.id}).catch(()=>{});
    await credits.touch(cb.from.id,cb.from);
    const balance=await credits.status(cb.from.id);
    if(balance.is_blocked){
      await send(cb.message.chat.id,'관리자가 사용을 제한한 계정이야.');
    }else if(balance.remaining<1){
      await send(cb.message.chat.id,'🎫 사용 가능한 편집 이용권이 없어.\n첫 무료 이용권 받기 또는 이용권 구매하기 메뉴를 이용해 줘.');
    }else{
      sessions.delete(cb.message.chat.id);
      pending.delete(String(cb.from.id));
      await send(cb.message.chat.id,'✏️ 이미지 편집하기\n\n수정할 이미지를 이 채팅에 사진 또는 파일로 업로드해 줘.\n이미지를 받으면 바꿀 문구를 입력하고 수정할 영역을 선택할 수 있어.\n\n잔여 이용권: '+balance.remaining+'매');
    }
    return;
  }
  if(['ui:free','ui:verifyfree'].includes(cb?.data)){
    if(cb.message?.chat?.type!=='private')return;
    await tg('answerCallbackQuery',{callback_query_id:cb.id}).catch(()=>{});
    await credits.touch(cb.from.id,cb.from);
    if(cb.data==='ui:free')await showFreePass(cb.message.chat.id,cb.from.id,credits);
    else await verifyFreePass(cb.message.chat.id,cb.from.id,credits);
    return;
  }
  if(['ui:shop','ui:balance','ui:orders'].includes(cb?.data)){
    if(cb.message?.chat?.type!=='private')return;
    await tg('answerCallbackQuery',{callback_query_id:cb.id}).catch(()=>{});
    const chatId=cb.message.chat.id,uid=cb.from.id;
    if(cb.data==='ui:shop')await showPhotoShop(chatId,commerce);
    else if(cb.data==='ui:balance')await sendBalance(chatId,uid,credits,'내 편집 이용권');
    else {
      const items=await commerce.ordersFor(String(uid));
      const states={pending:'입금 확인 대기',approved:'승인 완료',rejected:'거절'};
      await send(chatId,items.length
        ?'🧾 구매 신청 내역\n'+items.map(x=>'#'+x.id+' '+x.package_name+
          ' ('+x.credits+'매 / '+Number(x.payment_amount||0).toLocaleString('en-US')+' '+(x.payment_asset||'USDT')+') · '+(states[x.state]||x.state)).join('\n')
        :'아직 구매 신청 내역이 없어.');
    }
    return;
  }
  if(cb?.data?.startsWith('shop:')){
    const chatId=cb.message?.chat?.id;
    if(!chatId||cb.message.chat.type!=='private')return;
    const id=Number(cb.data.slice(5));
    const shop=await commerce.storefront();
    const product=shop.enabled&&shop.packages.find(p=>Number(p.id)===id);
    if(!product){
      await tg('answerCallbackQuery',{callback_query_id:cb.id,text:'판매하지 않는 상품이야.',show_alert:true});
      return;
    }
    await credits.touch(cb.from.id,cb.from);
    await tg('answerCallbackQuery',{callback_query_id:cb.id,text:'결제 통화를 선택해 줘.'});
    await tg('sendMessage',{chat_id:chatId,
      text:'🎫 '+product.name+'\n가격: '+Number(product.price_usdt).toLocaleString('en-US')+' USDT\n\n결제할 통화를 선택해 줘.\nTRON(TRX)은 관리자 설정 환산율로 계산돼.',
      reply_markup:{inline_keyboard:[
       ...shop.methods.map(asset=>[{
        text:asset==='USDT'?'USDT / TRC20':'TRON / TRX',
        callback_data:'pay:'+id+':'+asset
       }]),
       [{text:'↩ 상품 목록',callback_data:'ui:shop'},{text:'🏠 처음으로',callback_data:'ui:home'}]
      ]}
    });
    return;
  }
  if(cb?.data?.startsWith('pay:')){
    if(cb.message?.chat?.type!=='private')return;
    const [,id,asset]=cb.data.split(':');
    await tg('answerCallbackQuery',{callback_query_id:cb.id}).catch(()=>{});
    await credits.touch(cb.from.id,cb.from);
    try{
      const order=await commerce.order(String(cb.from.id),Number(id),asset);
      await sendInvoice(cb.message.chat.id,order,commerce);
    }catch(e){
      console.error('photo shop payment request failed:',{message:e.message,code:e.code||null});
      await tg('sendMessage',{chat_id:cb.message.chat.id,
       text:'구매 신청을 완료하지 못했어.\n원인: '+String(e.message).slice(0,185)+'\n\n다른 방법을 선택하거나 상품 목록으로 돌아가서 확인해 줘.',
       reply_markup:{inline_keyboard:[
        [{text:'↩ 결제 수단',callback_data:'shop:'+id}],
        [{text:'🧾 구매 내역',callback_data:'ui:orders'},{text:'🏠 처음으로',callback_data:'ui:home'}]
       ]}});
    }
    return;
  }
  if(cb?.data?.startsWith('imode:')){
    await tg('answerCallbackQuery',{callback_query_id:cb.id,text:'이제 편집만 지원해. 이미지를 다시 올려 줘.',show_alert:true});
    return;
  }
  if(cb?.data?.startsWith('im:')){
    const parts=cb.data.split(':');
    const key=String(cb.from.id);
    const job=pending.get(key);
    if(!job||job.id!==parts[2]||Date.now()-job.created>ttl){await tg('answerCallbackQuery',{callback_query_id:cb.id,text:'이 요청은 만료됐어. 다시 요청해 줘.',show_alert:true});return;}
    if(parts[1]==='no'){pending.delete(key);await tg('answerCallbackQuery',{callback_query_id:cb.id,text:'취소했어. 원본은 수정하지 않았어.'});await send(job.chatId,'수정을 취소했어. 수정 위치가 정확하지 않다면 해당 글자 부분을 확대해서 새 이미지로 올려줘.');return;}
    if(parts[1]!=='ok')return;
    pending.delete(key);
    await tg('answerCallbackQuery',{callback_query_id:cb.id,text:'확인했어. 편집을 시작할게.'});
    const creditId=await obtainCredit(job.chatId,cb.from.id,credits,'ocr_confirm',job.change.from+' → '+job.change.to);
    if(!creditId)return;
    try {
      const region=job.regions?.[0];
      if(!region)throw new Error('자동으로 찾은 수정 영역이 없어. 브라우저에서 직접 선택해 줘.');
      const upright=await sharp(job.buf).rotate().png().toBuffer();
      const {width:sourceW,height:sourceH}=await sharp(upright).metadata();
      const x=Math.max(0,Math.floor(region.left));
      const y=Math.max(0,Math.floor(region.top));
      const right=Math.min(sourceW,Math.ceil(region.right));
      const bottom=Math.min(sourceH,Math.ceil(region.bottom));
      if(![x,y,right,bottom].every(Number.isFinite)||right-x<4||bottom-y<4){
        throw new Error('자동 수정 영역이 원본 범위를 벗어났어. 브라우저에서 직접 선택해 줘.');
      }
      const output=await replaceSelectedText(job.buf,{x,y,w:right-x,h:bottom-y},job.change.from,job.change.to);
      await sendOriginalAndEdit(job.chatId,job.buf,output);
      await credits.consume(creditId);
      await sendBalance(job.chatId,cb.from.id,credits,'편집 완료 · 남은 이용권').catch(console.error);
    } catch(error) {
      await credits.release(creditId).catch(console.error);
      await send(job.chatId,'AI 편집 실패: '+error.message+'\n편집 실패 시 이용권은 차감되지 않아.');
    }
    return;
  }
  const msg=update.message;
  if(!msg||msg.chat?.type!=='private')return;
  const chatId=msg.chat.id;
  await credits.touch(msg.from.id,msg.from);
  const userKey=String(msg.from.id);
  if(msg.text?.trim()==='/취소'){purchasePending.delete(userKey);await send(chatId,'진행 중이던 구매 신청을 취소했어.');return;}
  if(['/무료이용권','/무료체험','/free'].includes(msg.text?.trim())){await showFreePass(chatId,msg.from.id,credits);return;}
  if(['/이용권구매','/구매','/shop'].includes(msg.text?.trim())){await showPhotoShop(chatId,commerce);return;}
  if(['/구매내역','/orders'].includes(msg.text?.trim())){
    const items=await commerce.ordersFor(userKey);
    if(!items.length){await send(chatId,'아직 구매 신청 내역이 없어. /이용권구매 에서 신청할 수 있어.');return;}
    const states={pending:'입금 확인 대기',approved:'승인 완료',rejected:'거절'};
    await send(chatId,'🧾 최근 구매 신청 내역\n'+items.map(x=>'#'+x.id+' '+x.package_name+' ('+x.credits+'회 / '+Number(x.price_krw).toLocaleString('ko-KR')+'원) · '+(states[x.state]||x.state)).join('\n'));
    return;
  }
  if(msg.text==='/start'||msg.text==='/help'){
    await showPhotoHome(chatId,msg.from.id,adminMenu);
    return;
  }
  if(['/잔여횟수','/balance','/credits'].includes(msg.text?.trim())){
    await sendBalance(chatId,msg.from.id,credits);
    return;
  }
  if(['/내UID','/uid'].includes(msg.text?.trim())){
    await send(chatId,'고유 UID: '+msg.from.id+'\n이 UID를 기준으로 무료 체험 횟수가 관리돼.');
    return;
  }
  const item=msg.photo?.at(-1)||((msg.document?.mime_type||'').startsWith('image/')?msg.document:null);
  if(item){
    const buf=await download(item.file_id);
    await sharp(buf).metadata();
    sessions.set(chatId,{buf,created:Date.now(),mode:'edit'});
    pending.delete(String(msg.from.id));
    const balance=await credits.status(msg.from.id);
    if(balance.is_blocked){sessions.delete(chatId);await send(chatId,'관리자가 사용을 제한한 계정이야.');return;}
    await send(chatId,balance.remaining>0
      ?'이미지를 받았어. 바꿀 문구를 입력해 줘. 예: 일식 > 한식\n🎫 잔여 편집 횟수: '+balance.remaining+'회'
      :'이용 가능한 편집 이용권이 없어. /start에서 첫 무료 이용권 받기를 누르거나 이용권을 구매해 줘.');
    return;
  }
  if(!msg.text)return;
  const saved=sessions.get(chatId);
  if(!saved||Date.now()-saved.created>ttl){sessions.delete(chatId);await send(chatId,'먼저 이미지를 업로드해 줘.');return;}
  const compact=msg.text.trim().match(/^([^\s>→]{1,50})\s+([^\s>→]{1,50})$/u);
  const changes=pairs(msg.text) || (compact && /\d/.test(compact[1]) && /\d/.test(compact[2]) ? [{from:compact[1],to:compact[2]}] : null);
  if(!changes){
    const request=msg.text.trim();
    if(!request.length||request.length>300) {await send(chatId,'어떤 부분을 어떻게 수정할지 짧게 말해 줘.');return;}
    const creditId=await obtainCredit(chatId,msg.from.id,credits,'whole_image',request);
    if(!creditId)return;
    await tg('sendChatAction',{chat_id:chatId,action:'upload_document'}).catch(()=>{});
    try {
      const instruction=await interpretImageRequest(saved.buf,request);
      const result=await editWholeImage(saved.buf,instruction);
      await sendOriginalAndEdit(chatId,saved.buf,result);
      await credits.consume(creditId);
      await sendBalance(chatId,msg.from.id,credits,'편집 완료 · 남은 이용권').catch(console.error);
    } catch(e) {
      await credits.release(creditId).catch(console.error);
      await send(chatId,'AI 편집 실패: '+String(e.message).slice(0,210)+'\n편집 실패 시 이용권은 차감되지 않아.');
    }
    return;
  }
  if(changes.length>1) {await send(chatId,'현재 정밀 영역 수정은 한 번에 한 곳씩 지원해. 첫 번째 변경부터 진행해 줘.');return;}
  await tg('sendChatAction',{chat_id:chatId,action:'upload_document'});
  // Provide the manual picker BEFORE potentially slow OCR initialization.
  // The user can proceed even if OCR stalls, times out, or fails.
  let balance;
  try { balance=await credits.status(msg.from.id); }
  catch(e){
    console.error('image credits check failed:',e.message);
    await send(chatId,'편집 이용권을 확인하지 못했어. 잠시 후 다시 시도해 줘.');
    return;
  }
  if(balance.remaining<1){
    await send(chatId,'편집 이용권이 부족해. /이용권구매 에서 추가 구매를 신청할 수 있어.');
    return;
  }
  const manualId=await makeManualJob(chatId,saved.buf,changes[0],msg.from.id,pool);
  await sendManualLink(chatId,manualId,base);
  // Optional OCR previews must never block selection. The preview is an
  // enhancement only, and is disabled by default because Korean OCR warmup
  // can be slower than an interactive request, especially on cold starts.
  if(process.env.IMAGE_OCR_PREVIEW_ENABLED==='true'){
    const timeoutMs=8000;
    let timeout;
    try{
      const outcome=await Promise.race([
        replaceText(saved.buf,changes),
        new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('OCR_TIMEOUT')),timeoutMs);})
      ]);
      const {output,preview,regions}=outcome;
      const id=crypto.randomBytes(8).toString('hex');
      pending.set(String(msg.from.id),{id,chatId,output,regions,buf:saved.buf,change:changes[0],created:Date.now()});
      await sendPreview(chatId,preview,id,editorUrl(manualId));
    }catch(e){
      console.warn('Optional OCR preview skipped; manual editor remains available:',e.message);
    }finally{
      clearTimeout(timeout);
    }
  }
}
export function mountImageBot(app,base,pool,commerce){
  const credits=createImageCredits(pool);
  const adminMenu=createPhotoAdminMenu(commerce.telegramAdmin,tg,send);
  if(!token){console.log('Image bot disabled (IMAGE_BOT_TOKEN absent)');return async()=>{};}
  const secret=crypto.createHash('sha256').update(token+':image-webhook').digest('hex');
  const getManual=async req=>{
    const cached=manualJobs.get(req.params.id);
    if(cached&&Date.now()-cached.created<=ttl)return cached;
    const restored=await readTemporaryJob(pool,req.params.id);
    if(restored)manualJobs.set(restored.id,restored);
    return restored;
  };
  app.get('/api/image-job/:id/info',async(req,res)=>{
    const job=await getManual(req);if(!job)return res.status(404).json({error:'요청이 만료됐습니다.'});
    try{
      // Ship a browser-safe, opaque JPEG preview inline to avoid broken
      // PNG/image subrequests. The original buffer remains unchanged for output.
      const preview=await sharp(job.buf).rotate().flatten({background:'#ffffff'})
        .jpeg({quality:88,mozjpeg:true}).toBuffer();
      res.set('Cache-Control','no-store').json({
        before:job.change.from,after:job.change.to,mode:job.mode||'edit',
        preview:'data:image/jpeg;base64,'+preview.toString('base64')
      });
    }catch(e){
      console.error('image preview preparation failed:',e.message);
      res.status(500).json({error:'원본 이미지 미리보기를 준비하지 못했어.'});
    }
  });
  app.get('/api/image-job/:id/original',async(req,res)=>{
    const job=await getManual(req);if(!job)return res.sendStatus(404);
    res.set('Cache-Control','no-store').type('png');
    try{res.send(await sharp(job.buf).rotate().png().toBuffer());}catch{res.sendStatus(500);}
  });

  app.get('/api/image-job/:id/status',async(req,res)=>{
    const job=await getManual(req);
    if(!job)return res.status(404).json({state:'expired',progress:0,message:'편집 요청이 만료됐어.'});
    const stages={
      ready:[0,'수정 위치 선택 대기'],
      reserving:[8,'사용 가능 횟수 확인 중'],
      preparing:[15,'원본 이미지 준비 중'],
      editing:[60,'AI가 이미지를 수정 중'],
      verifying:[85,'편집 결과 파일 검수 중'],
      sending:[95,'텔레그램으로 결과 전송 중'],
      done:[100,'수정 완료'],
      failed:[0,'수정 실패'],
      interrupted:[0,'서버 교체로 작업 중단']
    };
    const state=job.state||'ready';
    const [progress,message]=stages[state]||stages.ready;
    const elapsedSeconds=job.startedAt?Math.floor((Date.now()-job.startedAt)/1000):0;
    const eta=estimateRemaining(state,elapsedSeconds);
    res.set('Cache-Control','no-store').json({
      state,progress,message,error:job.error||null,
      elapsedSeconds,etaMinSeconds:eta.min,etaMaxSeconds:eta.max,etaBasis:eta.basis
    });
  });
  app.post('/api/image-job/:id/apply',async(req,res)=>{
    const job=await getManual(req);
    if(!job)return res.status(404).json({error:'Expired edit request'});
    if(['reserving','preparing','editing','verifying','sending'].includes(job.state))return res.status(202).json({state:job.state});
    if(job.state==='done')return res.json({state:'done'});
    if(job.state==='interrupted'||job.state==='failed')return res.status(409).json({error:job.error||'이 작업은 다시 실행할 수 없어. 새 작업을 만들어 줘.'});
    if(String(req.body?.after||'')!==job.change.to)return res.status(400).json({error:'Unexpected replacement value'});
    const values=Object.fromEntries(['x','y','w','h','angle'].map(k=>[k,Number(req.body[k])]));
    if(!['x','y','w','h'].every(k=>Number.isInteger(values[k]))||!Number.isFinite(values.angle))return res.status(400).json({error:'Invalid edit selection'});
    // Do not reject longer replacement text by character count. Actual
    // clipping is checked against rendered output by image-region QA.
    // Claim the job atomically across old/new Railway containers.
    // A replay cannot reserve credits or spawn a second paid image edit.
    const claimed=await pool.query(`UPDATE image_edit_temporary_jobs
      SET state='reserving',error=NULL
      WHERE id=$1 AND state='ready'
        AND created_at > NOW() - INTERVAL '30 minutes'
      RETURNING id`,[job.id]);
    if(!claimed.rowCount)return res.status(409).json({error:'이미 처리 중이거나 중단된 작업이야. 중복 편집은 허용하지 않아.'});
    job.state='reserving';job.error=null;
    let creditId;
    try{
      const reservation=await credits.reserve(job.uid,'manual_region',job.change.from+' → '+job.change.to);
      if(!reservation.ok){
        job.state='failed';job.error='편집 이용권 잔여 횟수가 없어. /잔여횟수 로 확인해 줘.';
        await setTemporaryJobState(pool,job.id,'failed',job.error);
        return res.status(402).json({error:job.error,code:'NO_CREDITS'});
      }
      creditId=reservation.id;
    }catch(error){
      job.state='failed';job.error='이용권 확인에 실패했어. 다시 시도해 줘.';
      await setTemporaryJobState(pool,job.id,'failed',job.error);
      return res.status(503).json({error:job.error});
    }
    job.state='preparing';job.startedAt=Date.now();
    await setTemporaryJobState(pool,job.id,'preparing');
    res.status(202).json({state:'preparing',progress:15});
    (async()=>{
      try{
        job.state='editing';
        const output=await replaceSelectedText(job.buf,values,job.change.from,job.change.to);
        job.state='verifying';
        await verifyOutputFile(job.buf,output);
        job.state='sending';
        await sendOriginalAndEdit(job.chatId,job.buf,output);
        await credits.consume(creditId);
        job.state='done';
        await setTemporaryJobState(pool,job.id,'done');
        await sendBalance(job.chatId,job.uid,credits,'편집 완료 · 남은 이용권').catch(console.error);
        if(job.startedAt){
          const secs=Math.max(1,Math.round((Date.now()-job.startedAt)/1000));
          successfulEditDurations.push(secs);
          if(successfulEditDurations.length>60)successfulEditDurations.shift();
        }
      }catch(error){
        await credits.release(creditId).catch(console.error);
        job.error=String(error.message||error).slice(0,240)+' · 실패한 편집은 차감하지 않아.';
        job.state='failed';
        await setTemporaryJobState(pool,job.id,'failed',job.error).catch(console.error);
        console.error('image editor task:',job.error);
        await send(job.chatId,'❌ 이미지 편집 실패\n'+job.error+'\n편집 이용권은 차감하지 않았어.').catch(console.error);
      }
    })().catch(async error=>{
      await credits.release(creditId).catch(console.error);
      job.state='failed';job.error=String(error.message||error).slice(0,240);
      await setTemporaryJobState(pool,job.id,'failed',job.error).catch(console.error);
      console.error('image editor task unexpected:',error);
      await send(job.chatId,'❌ 이미지 편집 오류\n'+job.error+'\n편집 이용권은 차감하지 않았어.').catch(console.error);
    });
  });
  const recent=new Map();
  app.post('/telegram/image-webhook',async(req,res)=>{
    const a=Buffer.from(req.get('x-telegram-bot-api-secret-token')||'');
    const b=Buffer.from(secret);
    if(a.length!==b.length||!crypto.timingSafeEqual(a,b))return res.sendStatus(403);
    const id=req.body?.update_id;
    if(!Number.isSafeInteger(id))return res.sendStatus(400);
    if(recent.has(id))return res.sendStatus(200);
    recent.set(id,Date.now());
    res.sendStatus(200);
    handle(req.body,base,credits,commerce,adminMenu,pool).catch(async e=>{
      console.error('image bot update failed:',e.message);
      const chatId=req.body?.message?.chat?.id;
      if(chatId)try{await send(chatId,'수정 실패: '+String(e.message).slice(0,200));}catch{}
    });
  });
  const sweep=setInterval(()=>{pool.query("DELETE FROM image_edit_temporary_jobs WHERE created_at < NOW() - INTERVAL '30 minutes'").catch(console.error);for(const [id,s] of sessions)if(Date.now()-s.created>ttl)sessions.delete(id);for(const [id,s] of pending)if(Date.now()-s.created>ttl)pending.delete(id);for(const [id,s] of manualJobs)if(Date.now()-s.created>ttl)manualJobs.delete(id);for(const [id,t] of recent)if(Date.now()-t>3600000)recent.delete(id);for(const [id,v] of purchasePending)if(Date.now()-v.created>15*60*1000)purchasePending.delete(id);},60000);
  sweep.unref();
  return async()=>{
    await credits.init();
    await ensureTemporaryJobs(pool);
    const me=await tg('getMe');
    await tg('setWebhook',{url:base+'/telegram/image-webhook',secret_token:secret,allowed_updates:['message','callback_query'],drop_pending_updates:false});
    console.log('Image editor bot started @'+me.username);
  };
}