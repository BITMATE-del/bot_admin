import sharp from 'sharp';

const API = 'https://api.openai.com/v1/images/edits';
const ALLOWED = new Set(['gpt-image-2.6-sunburst','gpt-image-2.6-flare','gpt-image-2.5-sunburst','gpt-image-2.5-flare','gpt-image-2']);
const MODEL = () => {
  const configured = process.env.OPENAI_IMAGE_MODEL?.trim();
  return ALLOWED.has(configured) ? configured : 'gpt-image-2.5-sunburst';
};
const MAX_SIDE = 5000;
// A predictable API budget is more important than silently retrying failed edits.
// These limits are per running process and reset on restart.
const MAX_CALLS_PER_HOUR = Math.max(1,Number.parseInt(process.env.IMAGE_API_HOURLY_LIMIT||'12',10)||12);
const MAX_SIMULTANEOUS = Math.max(1,Number.parseInt(process.env.IMAGE_API_CONCURRENCY||'2',10)||2);
const recentCalls = [];
let activeCalls = 0;

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
  'For short design labels, keep the replacement on the same baseline and within the original glyph height, with the same perceived stroke weight, muted/bright text color, and left alignment. Do not recenter or enlarge the text.',
  'When editing a design label, preserve every character completely; do not truncate the first or last character. Keep the entire edited content comfortably inside the allowed area.',
  'Make the edited content visually consistent with the scene and the surrounding visual material.'
].join('\n');

async function invoke(input,instruction,mask) {
  if (!process.env.OPENAI_API_KEY) throw new Error('Railway에 OPENAI_API_KEY가 등록되지 않았습니다.');
  const now=Date.now();
  while(recentCalls.length && recentCalls[0]<now-3600000)recentCalls.shift();
  if(recentCalls.length>=MAX_CALLS_PER_HOUR)throw new Error('시간당 이미지 API 호출 한도에 도달해 추가 과금을 방지했어. 잠시 후 다시 요청해 줘.');
  if(activeCalls>=MAX_SIMULTANEOUS)throw new Error('이미지 편집 요청이 동시에 진행 중이야. 중복 과금을 막기 위해 추가 요청을 받지 않았어.');
  recentCalls.push(now);
  activeCalls++;
  try {
  const form = new FormData();
  const model=MODEL();
  const preferredQuality=String(process.env.IMAGE_API_QUALITY||'high').trim().toLowerCase();
  const validQuality=new Set(['low','medium','high','xhigh','max']);
  const quality=validQuality.has(preferredQuality) && (['xhigh','max'].includes(preferredQuality) ? model.includes('2.5-') : true) ? preferredQuality : 'high';
  const started=Date.now();
  form.append('model',model);
  form.append('image',new Blob([input],{type:'image/png'}),'original.png');
  if (mask) form.append('mask',new Blob([mask],{type:'image/png'}),'mask.png');
  form.append('prompt',promptFor(instruction));
  form.append('size','1024x1024');
  form.append('quality',quality);
  form.append('output_format','png');
  // Output is composited into an opaque source image. Do not accept an
  // automatically chosen transparent background for regional editing.
  form.append('background','opaque');
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
    const output=Buffer.from(data,'base64');
    console.info('image API complete',JSON.stringify({
      model,quality,elapsedMs:Date.now()-started,
      inputBytes:input.length,outputBytes:output.length,
      masked:Boolean(mask),usage:result?.usage||null
    }));
    return output;
  } catch(err) {
    if (err.name==='AbortError') throw new Error('AI 편집 요청이 시간 초과되었습니다.');
    throw err;
  } finally {clearTimeout(timer);}
  } finally {activeCalls--;}
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

// Conservative comparison for short labels on near-flat backgrounds.
// On photographs or textured regions this intentionally returns null rather
// than guessing whether two different strings share the same typography.
function assessLabelConsistency(original,edited,w,h){
  if(w<8||h<8||original.length!==edited.length)return null;
  const n=w*h, border=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    if(x<2||y<2||x>=w-2||y>=h-2){
      const i=(y*w+x)*4;
      border.push([original[i],original[i+1],original[i+2]]);
    }
  }
  const med=a=>{const v=a.sort((x,y)=>x-y);return v[Math.floor(v.length/2)]};
  const bg=[0,1,2].map(c=>med(border.map(p=>p[c])));
  const colorDistance=(r,g,b)=>Math.max(Math.abs(r-bg[0]),Math.abs(g-bg[1]),Math.abs(b-bg[2]));
  let borderVar=0;
  for(const p of border)borderVar+=colorDistance(...p);
  if(borderVar/border.length>13)return null;
  const sample=(bytes)=>{
    let count=0,sumX=0,sumY=0,sumBrightness=0;
    let sumR=0,sumG=0,sumB=0,minY=h,maxY=-1;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=(y*w+x)*4;
      const r=bytes[i],g=bytes[i+1],b=bytes[i+2];
      if(colorDistance(r,g,b)<32)continue;
      count++;sumX+=x;sumY+=y;sumBrightness+=(r+g+b)/3;
      sumR+=r;sumG+=g;sumB+=b;minY=Math.min(minY,y);maxY=Math.max(maxY,y);
    }
    return count?{count,x:sumX/count,y:sumY/count,brightness:sumBrightness/count,
      color:[sumR/count,sumG/count,sumB/count],height:maxY-minY+1}:null;
  };
  const a=sample(original),b=sample(edited);
  if(!a||a.count<n*.012||a.count>n*.4)return null;
  if(!b)return '편집 영역에서 글자 형태가 사라졌어.';
  const density=b.count/a.count;
  if(density<.45||density>2.2)return '수정본 글자의 전체 획 밀도가 원본과 크게 달라.';
  if(Math.abs(a.brightness-b.brightness)>30)return '수정본 글자 색상 명도가 원본과 크게 달라.';
  const colorShift=Math.max(...a.color.map((v,i)=>Math.abs(v-b.color[i])));
  if(colorShift>40)return '수정본의 글자 색상이 원본과 크게 달라.';
  const heightRatio=b.height/a.height;
  if(heightRatio<.8||heightRatio>1.2)return '수정본 글자 크기가 원본과 크게 달라.';
  if(Math.abs(a.y-b.y)>Math.max(3,h*.18)||Math.abs(a.x-b.x)>Math.max(4,w*.17)){
    return '수정본 글자의 기준 위치가 원본과 크게 달라.';
  }
  return null;
}

export async function reviseDesignRegion(sourceBuffer,selection,instruction,attempt=0) {
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
  // Map both rectangle edges using the *actual* resized dimensions.
  // Using a scale calculated before fitW/fitH were rounded can shift the mask
  // by several source pixels on narrow or highly rectangular crops.
  const leftEdge=Math.round((x-cropLeft)*fitW/cropW)+offsetX;
  const rightEdge=Math.round((x+w-cropLeft)*fitW/cropW)+offsetX;
  const topEdge=Math.round((y-cropTop)*fitH/cropH)+offsetY;
  const bottomEdge=Math.round((y+h-cropTop)*fitH/cropH)+offsetY;
  const maskX=Math.max(0,Math.min(1023,leftEdge));
  const maskY=Math.max(0,Math.min(1023,topEdge));
  const maskW=Math.max(1,Math.min(1024-maskX,rightEdge-maskX));
  const maskH=Math.max(1,Math.min(1024-maskY,bottomEdge-maskY));
  const transparency=Buffer.alloc(1024*1024,255);
  for(let yy=maskY; yy<maskY+maskH; yy++) transparency.fill(0,yy*1024+maskX,yy*1024+maskX+maskW);
  const rgba=Buffer.alloc(1024*1024*4,255);
  for(let i=0;i<transparency.length;i++)rgba[i*4+3]=transparency[i];
  const mask=await sharp(rgba,{raw:{width:1024,height:1024,channels:4}}).png().toBuffer();
  // The masked image endpoint can occasionally return solid black inside
  // an alpha-0 mask. If it does, retry once as an unmasked contextual edit.
  // Only the user's chosen rectangle is ever composited onto the original.
  const extractPatch=async generated=>{
    const at1024=await sharp(generated).resize(1024,1024,{fit:'fill'}).png().toBuffer();
    const contextual=await sharp(at1024)
      .extract({left:offsetX,top:offsetY,width:fitW,height:fitH}).png().toBuffer();
    const fitted=await sharp(contextual).resize(cropW,cropH,{fit:'fill'}).png().toBuffer();
    return sharp(fitted)
      .extract({left:x-cropLeft,top:y-cropTop,width:w,height:h})
      .ensureAlpha().raw().toBuffer({resolveWithObject:true});
  };
  const patchStats=raw=>{
    let dark=0,transparent=0,sum=0,sq=0;
    const n=w*h;
    for(let i=0;i<raw.data.length;i+=4){
      const r=raw.data[i],g=raw.data[i+1],b=raw.data[i+2];
      if(Math.max(r,g,b)<38)dark++;
      if(raw.data[i+3]<16)transparent++;
      for(const value of [r,g,b]){sum+=value;sq+=value*value;}
    }
    return {dark:dark/n,transparent:transparent/n,
      variance:Math.max(0,sq/(3*n)-(sum/(3*n))**2)};
  };
  let generated=await invoke(crop,instruction,mask);
  let patch=await extractPatch(generated);
  let firstStats=patchStats(patch);
  if(firstStats.dark>.94&&firstStats.variance<100){
    console.warn('masked edit produced nearly solid black region; trying one unmasked contextual edit',
      JSON.stringify({width:w,height:h,dark:+firstStats.dark.toFixed(3),
        variance:Math.round(firstStats.variance)}));
    // A precise relative location helps the unmasked call focus on the target.
    const relativeX=Math.round(maskX/1024*100),relativeY=Math.round(maskY/1024*100);
    const relativeW=Math.round(maskW/1024*100),relativeH=Math.round(maskH/1024*100);
    const fallbackInstruction=instruction+
      ' The image contains the original layout. Edit only the small rectangle at '+
      relativeX+'% from left, '+relativeY+'% from top, width '+relativeW+
      '% and height '+relativeH+'% of this image. Replace the text there; '+
      'keep its background, color and scale intact. Do not create a blank, '+
      'black, or solid-color patch. Preserve everything else exactly.';
    generated=await invoke(crop,fallbackInstruction,null);
    patch=await extractPatch(generated);
    const recovered=patchStats(patch);
    console.info('unmasked fallback region quality',JSON.stringify({
      width:w,height:h,dark:+recovered.dark.toFixed(3),
      variance:Math.round(recovered.variance)
    }));
  }
  // An image edit response can contain transparent pixels whose RGB channels
  // are black. Reject such output before compositing rather than displaying
  // transparent/black rectangles to the user.
  let transparentPixels=0;
  for(let i=3;i<patch.data.length;i+=4){
    if(patch.data[i]<16)transparentPixels++;
  }
  if(transparentPixels > w*h*0.05){
    throw new Error('편집 결과의 투명 영역이 비정상적으로 많아 적용하지 않았어. 원본은 유지돼.');
  }
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
  // Reject a solid dark fill generated in place of actual content.
  // Compare with the selected source so genuinely dark UI regions are not
  // mistaken for failed edits.
  const originalRegion=await sharp(upright)
    .extract({left:x,top:y,width:w,height:h}).ensureAlpha().raw().toBuffer();
  let outputDark=0,sourceDark=0,outputSum=0,outputSq=0,sourceSum=0,sourceSq=0;
  const pixelCount=w*h;
  for(let i=0;i<bytes.length;i+=channels){
    const r=bytes[i],g=bytes[i+1],b=bytes[i+2];
    if(Math.max(r,g,b)<38)outputDark++;
    if(Math.max(originalRegion[i],originalRegion[i+1],originalRegion[i+2])<38)sourceDark++;
    for(let c=0;c<3;c++){
      const o=bytes[i+c],a=originalRegion[i+c];
      outputSum+=o;outputSq+=o*o;
      sourceSum+=a;sourceSq+=a*a;
    }
  }
  // Compute RGB population variance correctly. The old implementation
  // subtracted three times the squared mean and collapsed most variances
  // to zero, incorrectly flagging normal dark-themed text panels as black.
  const n=3*pixelCount;
  const variance=Math.max(0,outputSq/n-(outputSum/n)**2);
  const sourceVariance=Math.max(0,sourceSq/n-(sourceSum/n)**2);
  const darkFraction=outputDark/pixelCount,sourceDarkFraction=sourceDark/pixelCount;
  console.info('image edit region quality',JSON.stringify({
    width:w,height:h,darkFraction:+darkFraction.toFixed(3),
    sourceDarkFraction:+sourceDarkFraction.toFixed(3),
    variance:Math.round(variance),sourceVariance:Math.round(sourceVariance)
  }));
  // A genuinely black generated patch is unusable when the original
  // region is visibly brighter. An already-dark background must not be
  // rejected solely for being dark; later glyph and change checks still run.
  if(darkFraction>.94 && variance<75 &&
     (sourceDarkFraction<.55 || sourceVariance>Math.max(500,variance*8))){
    throw new Error('AI 결과가 기존 글자와 배경을 검은색으로 지워 편집을 적용하지 않았어. 원본은 유지했어.');
  }
  const labelOriginal=await sharp(upright).extract({left:x,top:y,width:w,height:h})
    .ensureAlpha().raw().toBuffer();
  // On flat UI label backgrounds, reject foreground pixels that touch the
  // selection boundary: clipping is irreversible after patch extraction.
  // Only evaluate a likely text region; textured photographs are ignored.
  const edgeBand=Math.min(2,Math.max(1,Math.floor(w/14)));
  const borderSamples=[];
  for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){
    if(xx<2||yy<2||xx>=w-2||yy>=h-2){
      const i=(yy*w+xx)*4;
      borderSamples.push([labelOriginal[i],labelOriginal[i+1],labelOriginal[i+2]]);
    }
  }
  const median=arr=>{arr.sort((a,b)=>a-b);return arr[Math.floor(arr.length/2)]};
  const bg=[0,1,2].map(c=>median(borderSamples.map(px=>px[c])));
  const delta=(buffer,i)=>Math.max(
    Math.abs(buffer[i]-bg[0]),Math.abs(buffer[i+1]-bg[1]),Math.abs(buffer[i+2]-bg[2])
  );
  const borderNoise=borderSamples.reduce((sum,p)=>sum+Math.max(
    Math.abs(p[0]-bg[0]),Math.abs(p[1]-bg[1]),Math.abs(p[2]-bg[2])
  ),0)/Math.max(1,borderSamples.length);
  if(borderNoise<14){
    let sourceInk=0,rightInk=0;
    for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){
      const i=(yy*w+xx)*4;
      if(delta(labelOriginal,i)>=42)sourceInk++;
      if(xx>=w-edgeBand && yy>=2 && yy<h-2 && delta(bytes,i)>=48)rightInk++;
    }
    if(sourceInk>=Math.max(4,Math.floor(w*h*.012)) && sourceInk<w*h*.45 &&
       rightInk>=Math.max(3,Math.ceil(h*.09))){
      throw new Error('글자가 선택 영역 오른쪽 경계에 닿아 잘릴 가능성이 있어. 오른쪽 여유를 포함해 다시 선택해 줘.');
    }
  }
  const mismatch=assessLabelConsistency(labelOriginal,bytes,w,h);
  if(mismatch){
    if(attempt===0){
      console.warn('image label quality retry:',mismatch);
      return reviseDesignRegion(sourceBuffer,selection,
        instruction+' Preserve the source label height, RGB color, glyph density and vertical alignment. Do not upscale or recolor the label.',1);
    }
    throw new Error('텍스트 스타일 검수 실패: '+mismatch+' 원본은 유지했어.');
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
