import crypto from 'node:crypto';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';
import { reviseDesignRegion, editWholeImage, interpretImageRequest } from './ai-image-design.js';

const token = process.env.IMAGE_BOT_TOKEN;
const editorOrigin = 'https://botadmin-production.up.railway.app';
const editorUrl = jobId => editorOrigin + '/image-editor?job=' + encodeURIComponent(jobId) + '&v=20261109-4';
const sessions = new Map();
const pending = new Map();
const manualJobs = new Map();
const successfulEditDurations=[];
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

function makeManualJob(chatId,buf,change){
  const id=crypto.randomBytes(16).toString('hex');
  manualJobs.set(id,{id,chatId,buf,change,created:Date.now(),busy:false});
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

async function addLabeledNoteAtPosition(original,note,selection,style={}){
  const source=await sharp(original).rotate().png().toBuffer();
  const {width:W,height:H}=await sharp(source).metadata();
  const {x,y,w,h}=selection;
  if(![x,y,w,h].every(Number.isInteger)||x<0||y<0||w<70||h<46||x+w>W||y+h>H){
    throw new Error('추가 내용을 표시할 영역을 더 넓게 선택해 줘.');
  }
  // Reject a labeled addition if it would cover existing dark text on a
  // predominantly light, document-like background. Never overwrite content.
  const sampled=await sharp(source).extract({left:x,top:y,width:w,height:h})
    .removeAlpha().raw().toBuffer({resolveWithObject:true});
  // Ignore soft/tinted background decoration. Block only dense, high
  // contrast dark marks likely to be existing lettering on a light panel.
  const pixels=sampled.data,channels=sampled.info.channels;
  let light=0,dark=0,denseRows=0;
  for(let yy=0;yy<h;yy++){
    let rowDark=0;
    for(let xx=0;xx<w;xx++){
      const i=(yy*w+xx)*channels;
      const r=pixels[i],g=pixels[i+1],b=pixels[i+2];
      if(Math.min(r,g,b)>207)light++;
      if(Math.max(r,g,b)<145 && Math.max(r,g,b)-Math.min(r,g,b)<32){
        dark++;rowDark++;
      }
    }
    if(rowDark>=Math.max(3,Math.ceil(w*.045)))denseRows++;
  }
  if(light/(w*h)>.62&&dark>Math.max(7,w*h*.006)&&denseRows>=Math.max(3,Math.floor(h*.10))){
    throw new Error('기존 글자 위에 겹칠 수 있어. 원본 글자를 가리지 않는 빈 공간을 선택해 줘.');
  }
  const text=String(note||'').trim();
  if(!text||text.length>180)throw new Error('추가할 문구를 180자 이내로 입력해 줘.');
  const allowedFonts={noto:'Noto Sans CJK KR,sans-serif',serif:'Noto Serif CJK KR,serif',system:'DejaVu Sans,sans-serif'};
  const fontFamily=allowedFonts[style.font]||allowedFonts.noto;
  const requestedSize=Number(style.size);
  const autoSize=Math.min(20,Math.max(9,Math.min(Math.floor((h-22)/2),Math.floor((w-20)/Math.max(1,Array.from(text).length)))));
  const fontSize=Number.isInteger(requestedSize)&&requestedSize>=9&&requestedSize<=24?requestedSize:autoSize;
  const lineHeight=Math.ceil(fontSize*1.3);
  const columnWidth=Math.max(1,w-20);
  const maxChars=Math.max(1,Math.floor(columnWidth/fontSize));
  const words=Array.from(text),lines=[];
  while(words.length)lines.push(words.splice(0,maxChars).join(''));
  if(lines.length*lineHeight+23+4>h){
    throw new Error('입력한 내용을 표시하기에는 영역이 좁아. 더 넓게 지정해 줘.');
  }
  const header=22;
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'">'+
    '<rect width="'+w+'" height="'+h+'" rx="5" fill="#f3f7ff" stroke="#4269ad" stroke-width="2"/>'+
    '<rect x="0" y="0" width="'+w+'" height="'+header+'" rx="5" fill="#4269ad"/>'+
    '<text x="9" y="'+Math.round(header*.72)+'" font-size="'+Math.max(12,Math.floor(header*.65))+'" font-weight="bold" font-family="Noto Sans CJK KR,sans-serif" fill="#ffffff">추가 내용</text>'+
    lines.map((line,i)=>'<text x="10" y="'+Math.round(header+fontSize+2+i*lineHeight)+'" font-size="'+fontSize+'" font-family="'+fontFamily+'" fill="#182d50">'+esc(line)+'</text>').join('')+
    '</svg>';
  const label=await sharp(Buffer.from(svg)).png().toBuffer();
  return sharp(source).composite([{input:label,left:x,top:y}]).png().toBuffer();
}
async function renderAdditionNote(original,note){
  const source=await sharp(original).rotate().png().toBuffer();
  const {width,height}=await sharp(source).metadata();
  const text=String(note||'').trim();
  if(!text||text.length>220)throw new Error('추가할 내용을 220자 이내로 입력해 줘.');
  const fontSize=Math.max(12,Math.min(22,Math.floor(width/27)));
  const margin=16;
  const charCount=Math.max(8,Math.floor((width-margin*2)/fontSize));
  const chars=[...text],lines=[];
  while(chars.length)lines.push(chars.splice(0,charCount).join(''));
  const lineHeight=Math.ceil(fontSize*1.5);
  const extra=80+lineHeight*lines.length;
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+extra+'"><rect width="100%" height="100%" fill="#f3f6fa"/><text x="16" y="32" font-size="16" font-weight="700" fill="#26354b" font-family="Noto Sans CJK KR,sans-serif">추가 내용</text>'+lines.map((line,i)=>'<text x="16" y="'+(62+i*lineHeight)+'" font-size="'+fontSize+'" fill="#26354b" font-family="Noto Sans CJK KR,sans-serif">'+esc(line)+'</text>').join('')+'</svg>';
  const footer=await sharp(Buffer.from(svg)).png().toBuffer();
  return sharp(source).extend({bottom:extra,background:'#ffffff'}).composite([{input:footer,left:0,top:height}]).png().toBuffer();
}
async function handle(update,base){
  const cb=update.callback_query;
  if(cb?.data?.startsWith('imode:')){
    const mode=cb.data.slice(6),chatId=cb.message?.chat?.id;
    const state=sessions.get(chatId);
    if(!state||Date.now()-state.created>ttl){
      await tg('answerCallbackQuery',{callback_query_id:cb.id,text:'이미지를 다시 올려 줘.',show_alert:true});return;
    }
    if(mode!=='edit'&&mode!=='add')return;
    state.mode=mode;
    await tg('answerCallbackQuery',{callback_query_id:cb.id,text:'작업 모드를 선택했어.'});
    await send(chatId,mode==='edit'?'편집할 내용을 입력해 줘. 예: 일식 > 한식':'추가할 문구를 입력해 줘. 다음 단계에서 이미지 안의 표시 위치를 직접 선택할 수 있어.');
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
    await tg('answerCallbackQuery',{callback_query_id:cb.id,text:'확인했어. 수정 이미지를 전송할게.'});
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
      const output=await reviseDesignRegion(job.buf,{x,y,w:right-x,h:bottom-y},'Edit the selected design region only. '+job.change.from+' to '+job.change.to+'. Preserve surrounding visual context.');
      await sendOriginalAndEdit(job.chatId,job.buf,output);
    } catch(error) { await send(job.chatId,'AI 편집 실패: '+error.message); }
    return;
  }
  const msg=update.message;
  if(!msg||msg.chat?.type!=='private')return;
  const chatId=msg.chat.id;
  if(msg.text==='/start'||msg.text==='/help'){
    await send(chatId,'사진을 올리고 바꾸고 싶은 부분을 편하게 말해 줘. 짧게 말해도 이미지 내용을 보고 수정할게.');
    return;
  }
  const item=msg.photo?.at(-1)||((msg.document?.mime_type||'').startsWith('image/')?msg.document:null);
  if(item){
    const buf=await download(item.file_id);
    await sharp(buf).metadata();
    sessions.set(chatId,{buf,created:Date.now(),mode:null});
    pending.delete(String(msg.from.id));
    await tg('sendMessage',{chat_id:chatId,text:'이미지를 받았어. 원하는 작업을 선택해 줘.',reply_markup:{inline_keyboard:[[{text:'✏️ 편집',callback_data:'imode:edit'},{text:'📝 내용 추가',callback_data:'imode:add'}]]}});
    return;
  }
  if(!msg.text)return;
  const saved=sessions.get(chatId);
  if(!saved||Date.now()-saved.created>ttl){sessions.delete(chatId);await send(chatId,'먼저 이미지를 업로드해 줘.');return;}
  if(saved.mode==='add'){
    const note=msg.text.trim();
    if(!note||note.length>180){await send(chatId,'추가할 문구를 180자 이내로 입력해 줘.');return;}
    const id=makeManualJob(chatId,saved.buf,{from:'',to:note});
    const job=manualJobs.get(id);job.mode='add';
    await send(chatId,'추가할 문구를 받았어. 아래 링크에서 위치를 사각형으로 지정해 줘.\\n'+editorUrl(id));
    await sendManualLink(chatId,id,base);
    return;
  }
  if(!saved.mode){await send(chatId,'먼저 편집 또는 내용 추가 버튼을 선택해 줘.');return;}
  const compact=msg.text.trim().match(/^([^\s>→]{1,50})\s+([^\s>→]{1,50})$/u);
  const changes=pairs(msg.text) || (compact && /\d/.test(compact[1]) && /\d/.test(compact[2]) ? [{from:compact[1],to:compact[2]}] : null);
  if(!changes){
    const request=msg.text.trim();
    if(!request.length||request.length>300) {await send(chatId,'어떤 부분을 어떻게 수정할지 짧게 말해 줘.');return;}
    await tg('sendChatAction',{chat_id:chatId,action:'upload_document'});
    try {
      const instruction=await interpretImageRequest(saved.buf,request);
      const result=await editWholeImage(saved.buf,instruction);
      await sendOriginalAndEdit(chatId,saved.buf,result);
    } catch(e) {await send(chatId,'AI 편집 실패: '+String(e.message).slice(0,240));}
    return;
  }
  if(changes.length>1) {await send(chatId,'현재 정밀 영역 수정은 한 번에 한 곳씩 지원해. 첫 번째 변경부터 진행해 줘.');return;}
  await tg('sendChatAction',{chat_id:chatId,action:'upload_document'});
  await send(chatId,'요청을 받았어. 이미지 위치를 확인하고 있어.');
  const manualId=makeManualJob(chatId,saved.buf,changes[0]);
  try{
    const {output,preview,regions}=await replaceText(saved.buf,changes);
    const id=crypto.randomBytes(8).toString('hex');
    pending.set(String(msg.from.id),{id,chatId,output,regions,buf:saved.buf,change:changes[0],created:Date.now()});
    await sendPreview(chatId,preview,id,editorUrl(manualId));
    await send(chatId,'직접 위치 선택 링크: '+editorUrl(manualId)+'\n버튼으로 열리지 않으면 주소를 복사해 브라우저에서 열어줘.');
  }catch(e){
    console.warn('OCR preview unavailable; offering manual selection:',e.message);
    await send(chatId,'자동 위치 인식이 정확하지 않아 직접 선택 모드로 전환했어.');
    await sendManualLink(chatId,manualId,base);
  }
}
export function mountImageBot(app,base){
  if(!token){console.log('Image bot disabled (IMAGE_BOT_TOKEN absent)');return async()=>{};}
  const secret=crypto.createHash('sha256').update(token+':image-webhook').digest('hex');
  const getManual=req=>{
    const job=manualJobs.get(req.params.id);
    if(!job||Date.now()-job.created>ttl)return null;
    return job;
  };
  app.get('/api/image-job/:id/info',async(req,res)=>{
    const job=getManual(req);if(!job)return res.status(404).json({error:'요청이 만료됐습니다.'});
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
    const job=getManual(req);if(!job)return res.sendStatus(404);
    res.set('Cache-Control','no-store').type('png');
    try{res.send(await sharp(job.buf).rotate().png().toBuffer());}catch{res.sendStatus(500);}
  });

  app.get('/api/image-job/:id/status',(req,res)=>{
    const job=getManual(req);
    if(!job)return res.status(404).json({state:'expired',progress:0,message:'편집 요청이 만료됐어.'});
    const stages={
      ready:[0,'수정 위치 선택 대기'],
      preparing:[15,'원본 이미지 준비 중'],
      editing:[60,'AI가 이미지를 수정 중'],
      verifying:[85,'편집 결과 파일 검수 중'],
      sending:[95,'텔레그램으로 결과 전송 중'],
      done:[100,'수정 완료'],
      failed:[0,'수정 실패']
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
  app.post('/api/image-job/:id/apply',(req,res)=>{
    const job=getManual(req);
    if(!job)return res.status(404).json({error:'Expired edit request'});
    if(['preparing','editing','verifying','sending'].includes(job.state))return res.status(202).json({state:job.state});
    if(job.state==='done')return res.json({state:'done'});
    if(String(req.body?.after||'')!==job.change.to)return res.status(400).json({error:'Unexpected replacement value'});
    const values=Object.fromEntries(['x','y','w','h','angle'].map(k=>[k,Number(req.body[k])]));
    if(!['x','y','w','h'].every(k=>Number.isInteger(values[k]))||!Number.isFinite(values.angle))return res.status(400).json({error:'Invalid edit selection'});
    const originalChars=Array.from(job.change.from).length;
    const replacementChars=Array.from(job.change.to).length;
    // Do not silently cut off a longer label. Require a user-selected box
    // with enough width for the additional characters at similar text height.
    if(job.mode!=='add' && replacementChars>originalChars && values.w < Math.ceil(replacementChars*values.h*0.49)){
      return res.status(409).json({
        code:'TEXT_REGION_TOO_NARROW',
        error:'변경할 글자가 더 길어 현재 선택 영역에서 잘릴 수 있어. 글자 양옆까지 더 넓게 선택해 줘.'
      });
    }
    job.state='preparing';job.error=null;job.startedAt=Date.now();
    res.status(202).json({state:'preparing',progress:15});
    (async()=>{
      try{
        job.state='editing';
        const output=job.mode==='add'
          ? await addLabeledNoteAtPosition(job.buf,job.change.to,values,{font:req.body?.font,size:req.body?.fontSize})
          : await reviseDesignRegion(job.buf,values,job.instruction || ('Replace '+job.change.from+' with '+job.change.to+' naturally, matching existing font, texture, rotation, light and perspective.'));
        job.state='verifying';
        await verifyOutputFile(job.buf,output);
        job.state='sending';
        await sendOriginalAndEdit(job.chatId,job.buf,output);
        job.state='done';
        if(job.startedAt){
          const secs=Math.max(1,Math.round((Date.now()-job.startedAt)/1000));
          successfulEditDurations.push(secs);
          if(successfulEditDurations.length>60)successfulEditDurations.shift();
        }
      }catch(error){
        job.error=String(error.message||error).slice(0,240);
        job.state='failed';
        console.error('image editor task:',job.error);
      }
    })().catch(error=>{job.state='failed';job.error=String(error.message||error).slice(0,240);console.error('image editor task unexpected:',error);});
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
    handle(req.body,base).catch(async e=>{
      console.error('image bot update failed:',e.message);
      const chatId=req.body?.message?.chat?.id;
      if(chatId)try{await send(chatId,'수정 실패: '+String(e.message).slice(0,200));}catch{}
    });
  });
  const sweep=setInterval(()=>{for(const [id,s] of sessions)if(Date.now()-s.created>ttl)sessions.delete(id);for(const [id,s] of pending)if(Date.now()-s.created>ttl)pending.delete(id);for(const [id,s] of manualJobs)if(Date.now()-s.created>ttl)manualJobs.delete(id);for(const [id,t] of recent)if(Date.now()-t>3600000)recent.delete(id);},60000);
  sweep.unref();
  return async()=>{
    const me=await tg('getMe');
    await tg('setWebhook',{url:base+'/telegram/image-webhook',secret_token:secret,allowed_updates:['message','callback_query'],drop_pending_updates:false});
    console.log('Image editor bot started @'+me.username);
  };
}