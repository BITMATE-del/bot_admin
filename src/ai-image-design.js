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
  'For ordinary graphic design, prefer the visual conventions already shown in this image over default generated styles.',
  'Match neighboring shapes, local spacing, edge softness and graphic consistency. Avoid changing the original background or adding new design motifs.',
  'When editing a design label, preserve every character completely; do not truncate the first or last character. Keep the entire edited content comfortably inside the allowed area.',
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
  const normalizedCanvas=await sharp(output).resize(1024,1024,{fit:'fill'}).png().toBuffer();
  const normalizedCrop=await sharp(normalizedCanvas)
    .extract({left,top,width:displayWidth,height:displayHeight}).png().toBuffer();
  const normalized=await sharp(normalizedCrop).resize(width,height,{fit:'fill'}).png().toBuffer();
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
  // Materialize stages independently. libvips may otherwise rearrange extract,
  // resize and extend in a single pipeline, shifting the edit selection.
  const croppedSource = await sharp(upright)
    .extract({left:cropLeft,top:cropTop,width:cropW,height:cropH}).png().toBuffer();
  const scaledSource = await sharp(croppedSource)
    .resize(fitW,fitH,{fit:'fill'}).png().toBuffer();
  const crop = await sharp(scaledSource).extend({
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
  // Materialize each resize before extraction: sharp otherwise may reorder
  // extract operations and attempt cropping at incompatible source dimensions.
  const generatedAt1024=await sharp(generated).resize(1024,1024,{fit:'fill'}).png().toBuffer();
  const contextualPatch=await sharp(generatedAt1024)
    .extract({left:offsetX,top:offsetY,width:fitW,height:fitH}).png().toBuffer();
  const fitted=await sharp(contextualPatch).resize(cropW,cropH,{fit:'fill'}).png().toBuffer();
  const patch=await sharp(fitted)
    .extract({left:x-cropLeft,top:y-cropTop,width:w,height:h})
    .ensureAlpha().raw().toBuffer({resolveWithObject:true});
  // Blend only along the inside edge to avoid a rectangular seam while preserving
  // every pixel outside the selected region. Scale feather for small selections.
  const fade=Math.max(0,Math.min(6,Math.floor(Math.min(w,h)/10)));
  const bytes=patch.data;
  const channels=patch.info.channels;
  for(let py=0;py<h;py++){
    for(let px=0;px<w;px++){
      const border=Math.min(px,py,w-1-px,h-1-py);
      const opacity=fade ? Math.min(1,(border+0.5)/fade) : 1;
      const alphaOffset=(py*w+px)*channels+3;
      bytes[alphaOffset]=Math.round(bytes[alphaOffset]*opacity);
    }
  }
  // Avoid reporting a visually unchanged region as a successful edit.
  const selectedOriginal=await sharp(upright).extract({left:x,top:y,width:w,height:h})
    .ensureAlpha().raw().toBuffer();
  let changedPixels=0;
  for(let i=0;i<bytes.length;i+=channels){
    const difference=Math.max(
      Math.abs(bytes[i]-selectedOriginal[i]),
      Math.abs(bytes[i+1]-selectedOriginal[i+1]),
      Math.abs(bytes[i+2]-selectedOriginal[i+2])
    );
    if(difference>=8)changedPixels++;
  }
  if(changedPixels<Math.max(2,Math.floor(w*h*0.001))){
    throw new Error('편집 결과에 실질적인 변화가 없어 전송하지 않았어. 수정 영역을 확인해 줘.');
  }
  const blendedPatch=await sharp(bytes,{raw:{width:w,height:h,channels}})
    .png().toBuffer();
  // Compositing never modifies image pixels outside the selected rectangle.
  return sharp(upright).composite([{input:blendedPatch,left:x,top:y}]).png().toBuffer();
}


/**
 * Turns minimal Korean editing requests into specific image-edit instructions.
 * Image context disambiguates shorthand (skin retouch vs removing a person).
 * Falls back to a conservative deterministic interpretation on API failures.
 */
export async function interpretImageRequest(sourceBuffer,shortRequest) {
  const text=String(shortRequest||'').trim().slice(0,300);
  if (!text) throw new Error('수정 내용을 한 단어라도 입력해 줘.');
  // Interpret even very short requests against the actual image, without keyword-specific behavior.
  if (!process.env.OPENAI_API_KEY)return text;
  try {
    const thumb=await sharp(sourceBuffer).rotate().resize(512,512,{fit:'inside'}).jpeg({quality:70}).toBuffer();
    const ctrl=new AbortController(),timeout=setTimeout(()=>ctrl.abort(),18000);
    try {
      const response=await fetch('https://api.openai.com/v1/chat/completions',{
        method:'POST',headers:{Authorization:'Bearer '+process.env.OPENAI_API_KEY,'Content-Type':'application/json'},
        signal:ctrl.signal,
        body:JSON.stringify({
          model:process.env.OPENAI_VISION_MODEL||'gpt-4.1-mini',
          temperature:0.1,max_tokens:250,
          messages:[
            {role:'system',content:'You are a general-purpose photo-edit instruction interpreter. Examine the image and interpret the Korean user request, even when it is one word, fragmented, abbreviated or colloquial. Return only ONE concise, actionable image editing instruction in English. Preserve any clearly specified text and numeric values exactly. Resolve ambiguous references using the actual visual context, without inventing edits. Preserve unaffected objects, typography, identity, composition, lighting, perspective, textures and image layout unless the user explicitly requests their change. When the request is uncertain, choose the smallest plausible change. Do not make users write elaborate prompts.'},
            {role:'user',content:[{type:'text',text:'Image edit request: '+text},{type:'image_url',image_url:{url:'data:image/jpeg;base64,'+thumb.toString('base64'),detail:'low'}}]}
          ]
        })
      });
      if (!response.ok)return text;
      const data=await response.json();
      const interpreted=data?.choices?.[0]?.message?.content?.trim();
      return interpreted && interpreted.length<900 ? interpreted : text;
    } finally {clearTimeout(timeout);}
  } catch(error) {
    console.warn('AI instruction interpretation fallback:',error.message);
    return text;
  }
}
