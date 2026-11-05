import sharp from 'sharp';

const API = 'https://api.openai.com/v1/images/edits';
const ALLOWED = new Set(['gpt-image-2.5-sunburst','gpt-image-2.5-flare','gpt-image-2']);
const MODEL = () => {
  const configured = process.env.OPENAI_IMAGE_MODEL?.trim();
  return ALLOWED.has(configured) ? configured : 'gpt-image-2.5-sunburst';
};
const MAX_SIDE = 5000;
const check = async bytes => {
  const upright = await sharp(bytes,{limitInputPixels:30000000}).rotate().png().toBuffer();
  const {width,height} = await sharp(upright).metadata();
  if (!width || !height || width>MAX_SIDE || height>MAX_SIDE) throw new Error('이미지 크기를 확인해 주세요.');
  return {upright,width,height};
};
const promptFor = instruction => [
  'Edit the provided image according to this exact user request:',
  instruction,
  'Preserve the original composition, typography, visual hierarchy, camera viewpoint, perspective, lighting, shadow, texture, colors and background unless the request explicitly changes them.',
  'Retain all unrelated text, numbers, faces, objects, spacing and layout. Do not redesign or add decorative elements.',
  'Make the edited content visually consistent with the scene and the surrounding visual material.'
].join('\n');

async function invoke(input,instruction,mask) {
  if (!process.env.OPENAI_API_KEY) throw new Error('Railway에 OPENAI_API_KEY가 등록되지 않았습니다.');
  const form = new FormData();
  form.append('model',MODEL());
  form.append('image',new Blob([input],{type:'image/png'}),'original.png');
  if (mask) form.append('mask',new Blob([mask],{type:'image/png'}),'mask.png');
  form.append('prompt',promptFor(instruction));
  form.append('size','1024x1024');
  form.append('quality','high');
  form.append('output_format','png');
  const controller = new AbortController();
  const timer = setTimeout(()=>controller.abort(),150000);
  try {
    const response = await fetch(API,{method:'POST',headers:{Authorization:'Bearer '+process.env.OPENAI_API_KEY},body:form,signal:controller.signal});
    const result = await response.json().catch(()=>({}));
    if (!response.ok) {
      const reason = String(result?.error?.message || response.statusText).slice(0,160);
      throw new Error('AI 이미지 편집 API '+response.status+': '+reason);
    }
    const data = result?.data?.[0]?.b64_json;
    if (!data) throw new Error('이미지 편집 API가 결과 이미지를 반환하지 않았습니다.');
    return Buffer.from(data,'base64');
  } catch(err) {
    if (err.name==='AbortError') throw new Error('AI 편집 요청이 시간 초과되었습니다.');
    throw err;
  } finally {clearTimeout(timer);}
}

export async function editWholeImage(sourceBuffer,instruction) {
  const {upright,width,height} = await check(sourceBuffer);
  const fitted = await sharp(upright).resize(1024,1024,{fit:'contain',background:'#fff'}).png().toBuffer();
  const output = await invoke(fitted,instruction);
  const aspect = Math.min(1024/width,1024/height);
  const displayWidth = Math.min(1024,Math.round(width*aspect));
  const displayHeight = Math.min(1024,Math.round(height*aspect));
  const left = Math.floor((1024-displayWidth)/2),top=Math.floor((1024-displayHeight)/2);
  const normalized = await sharp(output).resize(1024,1024,{fit:'fill'}).extract({left,top,width:displayWidth,height:displayHeight}).resize(width,height).png().toBuffer();
  return normalized;
}

export async function reviseDesignRegion(sourceBuffer,selection,instruction) {
  const {upright,width:W,height:H} = await check(sourceBuffer);
  const {x,y,w,h} = selection;
  if (![x,y,w,h].every(Number.isInteger) || x<0 || y<0 || w<4 || h<4 || x+w>W || y+h>H) {
    throw new Error('수정 영역을 정확하게 선택해 주세요.');
  }
  const contextMargin = Math.max(24,Math.ceil(Math.max(w,h)*2.2));
  const cropLeft=Math.max(0,x-contextMargin),cropTop=Math.max(0,y-contextMargin);
  const cropRight=Math.min(W,x+w+contextMargin),cropBottom=Math.min(H,y+h+contextMargin);
  const cropW=cropRight-cropLeft,cropH=cropBottom-cropTop;
  // Keep the cropped context's aspect ratio. Never stretch the source.
  const scale = Math.min(1024/cropW,1024/cropH);
  const fitW=Math.max(1,Math.round(cropW*scale)),fitH=Math.max(1,Math.round(cropH*scale));
  const offsetX=Math.floor((1024-fitW)/2),offsetY=Math.floor((1024-fitH)/2);
  const crop = await sharp(upright).extract({left:cropLeft,top:cropTop,width:cropW,height:cropH})
    .resize(fitW,fitH).extend({
      left:offsetX,top:offsetY,right:1024-fitW-offsetX,bottom:1024-fitH-offsetY,
      background:{r:255,g:255,b:255,alpha:255}
    }).png().toBuffer();
  const maskX=Math.max(0,Math.floor((x-cropLeft)*scale)+offsetX);
  const maskY=Math.max(0,Math.floor((y-cropTop)*scale)+offsetY);
  const maskW=Math.max(1,Math.min(1024-maskX,Math.ceil(w*scale)));
  const maskH=Math.max(1,Math.min(1024-maskY,Math.ceil(h*scale)));
  const transparency=Buffer.alloc(1024*1024,255);
  for(let yy=maskY; yy<maskY+maskH; yy++) transparency.fill(0,yy*1024+maskX,yy*1024+maskX+maskW);
  const rgba=Buffer.alloc(1024*1024*4,255);
  for(let i=0;i<transparency.length;i++)rgba[i*4+3]=transparency[i];
  const mask=await sharp(rgba,{raw:{width:1024,height:1024,channels:4}}).png().toBuffer();
  const generated=await invoke(crop,instruction,mask);
  const fitted=await sharp(generated).resize(1024,1024).extract({left:offsetX,top:offsetY,width:fitW,height:fitH}).resize(cropW,cropH).png().toBuffer();
  const patch=await sharp(fitted).extract({left:x-cropLeft,top:y-cropTop,width:w,height:h}).png().toBuffer();
  // Only selected pixels are replaced. All remaining pixels are byte-identical in RGBA space.
  return sharp(upright).composite([{input:patch,left:x,top:y}]).png().toBuffer();
}
