import crypto from 'node:crypto';
import sharp from 'sharp';
import { createWorker } from 'tesseract.js';

const token = process.env.IMAGE_BOT_TOKEN;
const sessions = new Map();
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
  return {x:c*dx-s*dy+ow/2,y:s*dx+c*dy+oh/2};
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
      const padding=2;
      const rw=found.x1-found.x0+padding*2,rh=found.y1-found.y0+padding*2;
      const cx=found.cx,cy=found.cy;
      const pos=found.position;
      const px=Math.round(pos.x),py=Math.round(pos.y);
      const region={left:px-rw/2-4,right:px+rw/2+4,top:py-rh/2-4,bottom:py+rh/2+4};
      if(regions.some(r=>region.left<r.right&&region.right>r.left&&region.top<r.bottom&&region.bottom>r.top))throw new Error('수정할 문구 영역이 겹칩니다.');
      regions.push(region);
      const rgb=sample(pos.x,pos.y-Math.max(4,rh));
      const luminance=(rgb[0]*.299+rgb[1]*.587+rgb[2]*.114);
      const color=luminance>140?'#1d2026':'#f5f5f5';
      const fill='rgb('+rgb.join(',')+')';
      const angle=found.angle;
      const fontSize=Math.max(9,Math.round(rh*.84));
      // Only the detected text polygon is repainted; all other pixels are taken from the original.
      const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+width+'" height="'+height+'"><g transform="translate('+pos.x+' '+pos.y+') rotate('+(-angle)+')"><rect x="'+(-rw/2)+'" y="'+(-rh/2)+'" width="'+rw+'" height="'+rh+'" fill="'+fill+'"/><text x="0" y="'+(fontSize*.32)+'" font-size="'+fontSize+'" font-family="Noto Sans CJK KR,DejaVu Sans,sans-serif" fill="'+color+'" text-anchor="middle">'+esc(change.to)+'</text></g></svg>';
      overlays.push({input:Buffer.from(svg),left:0,top:0});
    }
  }finally{await worker.terminate();}
  const mark='<svg xmlns="http://www.w3.org/2000/svg" width="85" height="20"><rect width="85" height="20" rx="3" fill="#071321" fill-opacity=".85"/><text x="42" y="14" fill="#b8c8d9" font-family="Noto Sans CJK KR,sans-serif" font-size="11" text-anchor="middle">편집 이미지</text></svg>';
  overlays.push({input:Buffer.from(mark),left:Math.max(0,width-90),top:Math.max(0,height-24)});
  return await sharp(upright).ensureAlpha().composite(overlays).png().toBuffer();
}
async function sendImage(chatId,buf){
  const form=new FormData();
  form.append('chat_id',String(chatId));
  form.append('caption','요청한 문구를 수정한 편집 이미지입니다. 원본 거래 증빙으로 사용하지 마세요.');
  form.append('document',new Blob([buf],{type:'image/png'}),'edited.png');
  const resp=await fetch('https://api.telegram.org/bot'+token+'/sendDocument',{method:'POST',body:form,signal:AbortSignal.timeout(30000)});
  const json=await resp.json();
  if(!json.ok)throw new Error(json.description||'이미지 전송 실패');
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
async function handle(update){
  const msg=update.message;
  if(!msg||msg.chat?.type!=='private')return;
  const chatId=msg.chat.id;
  if(msg.text==='/start'||msg.text==='/help'){
    await send(chatId,'🖼 이미지 부분 수정 봇\n\n1. 원본 이미지를 사진 또는 파일로 전송\n2. 변경할 내용을 전송\n   36.05 > 921.42\n3. 수정한 이미지를 파일로 받습니다.\n\n여러 줄을 한 번에 입력할 수도 있습니다.\n인식이 불명확하면 원본 보호를 위해 수정하지 않습니다.\n※ 결과에는 편집 표시가 들어갑니다.');
    return;
  }
  const item=msg.photo?.at(-1)||((msg.document?.mime_type||'').startsWith('image/')?msg.document:null);
  if(item){
    const buf=await download(item.file_id);
    await sharp(buf).metadata();
    sessions.set(chatId,{buf,created:Date.now()});
    await send(chatId,'이미지를 받았어. 바꿀 문구를 보내줘.\n예: 36.05 > 921.42\n또는: 36.05를 921.42로 바꿔줘\n비스듬한 문구도 인식하며, 중복될 때는 첫번째에 있는 30 > 33처럼 입력해 줘.');
    return;
  }
  if(!msg.text)return;
  const saved=sessions.get(chatId);
  if(!saved||Date.now()-saved.created>ttl){sessions.delete(chatId);await send(chatId,'먼저 이미지를 업로드해 줘.');return;}
  const changes=pairs(msg.text);
  if(!changes){await send(chatId,'수정할 내용을 이해하지 못했어. 아래 중 편한 방식으로 보내줘.\n\n30 > 33\n30을 33으로 바꿔줘\n첫번째에 있는 30을 33으로 바꿔줘\n\n이미지는 다시 보내지 않아도 돼.');return;}
  if(changes.length>8)throw new Error('한 번에 8개까지만 수정할 수 있어요.');
  await tg('sendChatAction',{chat_id:chatId,action:'upload_document'});
  const output=await replaceText(saved.buf,changes);
  await sendImage(chatId,output);
}
export function mountImageBot(app,base){
  if(!token){console.log('Image bot disabled (IMAGE_BOT_TOKEN absent)');return async()=>{};}
  const secret=crypto.createHash('sha256').update(token+':image-webhook').digest('hex');
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
    handle(req.body).catch(async e=>{
      console.error('image bot update failed:',e.message);
      const chatId=req.body?.message?.chat?.id;
      if(chatId)try{await send(chatId,'수정 실패: '+String(e.message).slice(0,200));}catch{}
    });
  });
  const sweep=setInterval(()=>{for(const [id,s] of sessions)if(Date.now()-s.created>ttl)sessions.delete(id);for(const [id,t] of recent)if(Date.now()-t>3600000)recent.delete(id);},60000);
  sweep.unref();
  return async()=>{
    const me=await tg('getMe');
    await tg('setWebhook',{url:base+'/telegram/image-webhook',secret_token:secret,allowed_updates:['message'],drop_pending_updates:false});
    console.log('Image editor bot started @'+me.username);
  };
}