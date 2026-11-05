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
const pairs = s => String(s).split(/\n/).map(x=>x.trim()).filter(Boolean).map(row=>{
  const m = row.match(/^(.+?)\s*(?:→|->|>)\s*(.+)$/);
  if(!m)throw new Error('수정 명령 형식: 기존문구 > 새문구');
  const from=m[1].trim(),to=m[2].trim();
  if(from.length<1||from.length>70||to.length<1||to.length>70)throw new Error('문구는 각각 1~70자로 입력하세요.');
  return {from,to};
});
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
async function replaceText(input,changes){
  const meta=await sharp(input).metadata();
  if(!meta.width||!meta.height||meta.width>MAX_SIDE||meta.height>MAX_SIDE)throw new Error('지원하지 않는 이미지 크기입니다.');
  const scale=meta.width<800?3:meta.width<1400?2:1;
  const enlarged=await sharp(input).rotate().resize({width:meta.width*scale}).png().toBuffer();
  const enlargedMeta=await sharp(enlarged).metadata();
  const worker=await createWorker('kor+eng',1,{logger:()=>{}});
  let result;
  try {result=await worker.recognize(enlarged,{}, {text:true,blocks:true});}
  finally {await worker.terminate();}
  const words=extractWords(result.data);
  if(!words.length)throw new Error('이미지에서 글자를 인식하지 못했습니다.');
  let image=sharp(input).rotate().ensureAlpha();
  const width=enlargedMeta.width/scale,height=enlargedMeta.height/scale;
  const overlays=[],regions=[];
  const base=await sharp(input).rotate().ensureAlpha().raw().toBuffer({resolveWithObject:true});
  const px=base.info.channels;
  const sample=(x,y)=>{
    const cx=Math.max(0,Math.min(Math.floor(x),base.info.width-1));
    const cy=Math.max(0,Math.min(Math.floor(y),base.info.height-1));
    const i=(cy*base.info.width+cx)*px;
    return [base.data[i],base.data[i+1],base.data[i+2]];
  };
  for(const change of changes){
    const b=findBox(words,change.from);
    const box={left:Math.max(0,Math.floor(b.x0/scale)-2),top:Math.max(0,Math.floor(b.y0/scale)-2),right:Math.min(width,Math.ceil(b.x1/scale)+2),bottom:Math.min(height,Math.ceil(b.y1/scale)+2)};
    if(regions.some(r=>box.left<r.right&&box.right>r.left&&box.top<r.bottom&&box.bottom>r.top))throw new Error('수정 영역이 겹칩니다.');
    regions.push(box);
    const w=Math.ceil(box.right-box.left),h=Math.ceil(box.bottom-box.top);
    const rgb=sample(box.left-4,(box.top+box.bottom)/2);
    const fill='rgb('+rgb.join(',')+')';
    const size=Math.max(9,Math.round(h*0.78));
    const rightAligned=box.right>width*0.55;
    const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><rect width="100%" height="100%" fill="'+fill+'"/><text x="'+(rightAligned?w-2:2)+'" y="'+Math.round(h*.78)+'" fill="#eff3fa" font-size="'+size+'" font-family="Noto Sans CJK KR,DejaVu Sans,sans-serif" font-weight="500" text-anchor="'+(rightAligned?'end':'start')+'">'+esc(change.to)+'</text></svg>';
    overlays.push({input:Buffer.from(svg),left:box.left,top:box.top});
  }
  // A small disclosure in the returned image distinguishes it from an original statement.
  const mark='<svg xmlns="http://www.w3.org/2000/svg" width="85" height="20"><rect width="85" height="20" rx="3" fill="#071321" fill-opacity=".85"/><text x="42" y="14" fill="#b8c8d9" font-family="Noto Sans CJK KR,sans-serif" font-size="11" text-anchor="middle">편집 이미지</text></svg>';
  overlays.push({input:Buffer.from(mark),left:Math.max(0,Math.floor(width)-90),top:Math.max(0,Math.floor(height)-24)});
  return await image.composite(overlays).png().toBuffer();
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
    await send(chatId,'이미지를 받았어. 바꿀 문구를 보내줘.\n예: 36.05 > 921.42');
    return;
  }
  if(!msg.text)return;
  const saved=sessions.get(chatId);
  if(!saved||Date.now()-saved.created>ttl){sessions.delete(chatId);await send(chatId,'먼저 이미지를 업로드해 줘.');return;}
  const changes=pairs(msg.text);
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