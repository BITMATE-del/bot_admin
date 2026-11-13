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
  'For short design labels, preserve the exact original visible glyph height, original baseline, font weight, text color, and its existing alignment. Do not enlarge, vertically scale, or change its font size when the new label is longer. Added digits may extend the line horizontally within the selected area, never increase letter height.',
  'TYPEFACE IDENTITY IS CRITICAL for Korean handwriting, brush calligraphy, old printed lettering and serif fonts. Do NOT replace the original script with a clean modern sans-serif or generic Korean system font. Reproduce the source stroke vocabulary: thick-to-thin modulation, hairline strokes, sharp ink terminals, tapered ends, irregular hand-lettered contours, original ink texture and nonuniform character proportions. These details matter more than smoothness or modern legibility. Copy the visual writing style of the original glyphs even though the replacement characters differ.',
  'For photographs and printed text over patterned, hatched or striped backgrounds, the background pattern must remain precisely in place. Preserve the source grain and hatching beneath and between new strokes; never paint a smooth rectangle, solid fill or blur to hide old glyphs.',
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
    let sumR=0,sumG=0,sumB=0,minX=w,maxX=-1,minY=h,maxY=-1;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=(y*w+x)*4;
      const r=bytes[i],g=bytes[i+1],b=bytes[i+2];
      if(colorDistance(r,g,b)<32)continue;
      count++;sumX+=x;sumY+=y;sumBrightness+=(r+g+b)/3;
      sumR+=r;sumG+=g;sumB+=b;minX=Math.min(minX,x);maxX=Math.max(maxX,x);
      minY=Math.min(minY,y);maxY=Math.max(maxY,y);
    }
    return count?{count,x:sumX/count,y:sumY/count,brightness:sumBrightness/count,
      color:[sumR/count,sumG/count,sumB/count],
      left:minX,right:maxX,top:minY,bottom:maxY,
      width:maxX-minX+1,height:maxY-minY+1,
      centerX:(minX+maxX)/2,centerY:(minY+maxY)/2}:null;
  };
  // Measure stroke thickness independently of the number of characters.
  // A regenerated bold/sans-serif font can pass overall color and height
  // checks while still looking different from the source typeface.
  const strokeWidth=bytes=>{
    const horizontal=[],vertical=[];
    const ink=(x,y)=>{
      const i=(y*w+x)*4;
      return colorDistance(bytes[i],bytes[i+1],bytes[i+2])>=42;
    };
    for(let y=2;y<h-2;y++){
      let run=0;
      for(let x=1;x<w;x++){
        if(ink(x,y))run++;
        else if(run){if(run<=Math.min(24,Math.ceil(h*.6)))horizontal.push(run);run=0;}
      }
    }
    for(let x=2;x<w-2;x++){
      let run=0;
      for(let y=1;y<h;y++){
        if(ink(x,y))run++;
        else if(run){if(run<=Math.min(24,Math.ceil(h*.6)))vertical.push(run);run=0;}
      }
    }
    const robust=arr=>{
      if(arr.length<8)return null;
      arr.sort((a,b)=>a-b);
      // A trimmed upper-half median reduces sensitivity to antialiasing dots.
      return arr[Math.floor(arr.length*.60)];
    };
    return {horizontal:robust(horizontal),vertical:robust(vertical)};
  };
  const a=sample(original),b=sample(edited);
  if(!a||a.count<n*.012||a.count>n*.4)return null;
  if(!b)return '편집 영역에서 글자 형태가 사라졌어.';
  const density=b.count/a.count;
  if(density<.45||density>2.2)return '수정본 글자의 전체 획 밀도가 원본과 크게 달라.';
  const beforeStroke=strokeWidth(original),afterStroke=strokeWidth(edited);
  const strokeRatios=['horizontal','vertical']
    .filter(axis=>beforeStroke[axis]!==null&&afterStroke[axis]!==null&&beforeStroke[axis]>=2)
    .map(axis=>afterStroke[axis]/beforeStroke[axis]);
  if(strokeRatios.some(ratio=>ratio<.68||ratio>1.45))
    return '수정본 글꼴의 획 두께가 원본과 크게 달라.';
  // Antialiasing and changed digit shapes alter the ratio of edge pixels to
  // fully painted glyph pixels. Comparing the *average* foreground brightness
  // spuriously rejects correct colors. Compare robust, high-contrast glyph
  // cores instead; preserve rejection for genuinely recolored labels.
  const coreInk=bytes=>{
    const cores=[];
    for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
      const i=(y*w+x)*4;
      const rgb=[bytes[i],bytes[i+1],bytes[i+2]];
      if(colorDistance(...rgb)>=65)cores.push(rgb);
    }
    if(cores.length<Math.max(5,Math.floor(n*.008)))return null;
    const medianChannel=channel=>{
      const v=cores.map(p=>p[channel]).sort((a,b)=>a-b);
      return v[Math.floor(v.length*.5)];
    };
    return [medianChannel(0),medianChannel(1),medianChannel(2)];
  };
  const sourceCore=coreInk(original),resultCore=coreInk(edited);
  if(sourceCore&&resultCore){
    const brightness=rgb=>(rgb[0]*.299+rgb[1]*.587+rgb[2]*.114);
    if(Math.abs(brightness(sourceCore)-brightness(resultCore))>36)
      return '수정본 글자 색상 명도가 원본과 크게 달라.';
    const colorShift=Math.max(...sourceCore.map((v,i)=>Math.abs(v-resultCore[i])));
    if(colorShift>48)return '수정본의 글자 색상이 원본과 크게 달라.';
  }
  // A selected text line must retain its visible height and geometric
  // center even when replacement digits increase its total width. These are
  // bounding-box measurements, NOT ink centroids (which shift with digits).
  // Only evaluate flat-background isolated text with measurable foreground.
  const heightRatio=b.height/a.height;
  // Do not let newly generated numeric amounts look larger than the source.
  // Allow just 1-2 raster pixels for antialiasing / digit-shape differences.
  // For tiny labels keep a proportional fallback to avoid quantization noise.
  const maxExtraHeight=a.height>=16 ? Math.max(1,Math.floor(a.height*.04)) : Math.max(1,Math.ceil(a.height*.08));
  const maxShrinkHeight=a.height>=16 ? Math.max(2,Math.ceil(a.height*.05)) : Math.max(1,Math.ceil(a.height*.08));
  if(a.height>=8 && (b.height>a.height+maxExtraHeight ||
      b.height<a.height-maxShrinkHeight)){
    return '수정본 숫자 줄의 글자 높이가 원본과 달라.';
  }
  const centerToleranceX=Math.max(3,Math.min(10,w*.025));
  const centerToleranceY=Math.max(3,Math.min(6,h*.055));
  if(Math.abs(a.centerX-b.centerX)>centerToleranceX){
    return '수정본 숫자 줄의 가로 중앙 정렬이 원본과 달라.';
  }
  if(Math.abs(a.centerY-b.centerY)>centerToleranceY){
    return '수정본 숫자 줄의 세로 중심이 원본과 달라.';
  }
  // Allow extra digits to increase line width, but never clip against the
  // selected rectangle. At least a few actual background pixels must remain.
  const horizontalMargin=Math.max(2,Math.ceil(Math.min(w*.015,7)));
  if(b.left<horizontalMargin||b.right>=w-horizontalMargin){
    return '수정본 글자가 선택 영역 좌우 여백을 침범해.';
  }
  if(b.top<2||b.bottom>=h-2){
    return '수정본 글자가 선택 영역 상하 여백을 침범해.';
  }
  return null;
}

// Measure dark printed glyph height independently of the surrounding
// diagonal paper pattern. Used ONLY when the requested replacement is a short
// isolated name; unlike flat-label QA, this works on lightly textured paper.
export function measurePrintedNameMetrics(bytes,w,h){
  if(w<30||h<14||bytes.length<w*h*4)return null;
  const luminance=new Uint8Array(w*h);
  const sample=[];
  for(let py=0;py<h;py++)for(let px=0;px<w;px++){
    const i=(py*w+px)*4,v=Math.round((bytes[i]+bytes[i+1]+bytes[i+2])/3);
    luminance[py*w+px]=v;
    if((px+py)%3===0)sample.push(v);
  }
  sample.sort((a,b)=>a-b);
  const paper=sample[Math.floor(sample.length*.85)];
  if(paper<165)return null;
  const threshold=Math.min(130,paper-57);
  const rows=new Uint16Array(h),cols=new Uint16Array(w);
  let dark=0;
  for(let py=0;py<h;py++)for(let px=0;px<w;px++){
    if(luminance[py*w+px]>=threshold)continue;
    dark++;rows[py]++;cols[px]++;
  }
  if(dark<Math.max(40,w*h*.005)||dark>w*h*.38)return null;
  // Exclude stray dust pixels: the row needs several substantial foreground
  // pixels, rather than one isolated speck.
  const rowMin=Math.max(3,Math.floor(w*.035));
  const colMin=Math.max(2,Math.floor(h*.06));
  let top=h,bottom=-1,left=w,right=-1;
  for(let py=0;py<h;py++)if(rows[py]>=rowMin){top=Math.min(top,py);bottom=Math.max(bottom,py);}
  for(let px=0;px<w;px++)if(cols[px]>=colMin){left=Math.min(left,px);right=Math.max(right,px);}
  if(bottom<top||right<left||top<1||bottom>=h-1)return null;
  return {height:bottom-top+1,width:right-left+1,top,bottom,left,right,
    centerY:(top+bottom)/2,paper,threshold};
}
// High-confidence warning for dark calligraphic lettering over patterned
// bright backgrounds. Unlike the flat-label detector, this ignores background
// texture and measures solid near-black ink runs, looking for an obvious loss
// of thick/thin variation. Different characters naturally change run lengths,
// so only extreme departures can fail this heuristic.
export function assessTexturedInkStrokeContrast(original,edited,w,h){
  if(w<55||h<24||original.length!==edited.length)return null;
  const borderBrightness=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)
    if(x<2||x>=w-2||y<2||y>=h-2){
      const i=(y*w+x)*4;
      borderBrightness.push((original[i]+original[i+1]+original[i+2])/3);
    }
  borderBrightness.sort((a,b)=>a-b);
  if(borderBrightness[Math.floor(borderBrightness.length*.5)]<105)return null;
  const inkRuns=(bytes)=>{
    let count=0;
    const mask=new Uint8Array(w*h);
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=(y*w+x)*4;
      const mx=Math.max(bytes[i],bytes[i+1],bytes[i+2]);
      if(mx<80){mask[y*w+x]=1;count++;}
    }
    if(count<w*h*.035||count>w*h*.42)return null;
    const horizontal=[],vertical=[];
    for(let y=0;y<h;y++){
      let run=0;
      for(let x=0;x<=w;x++){
        if(x<w&&mask[y*w+x])run++;
        else if(run){if(run<=Math.min(20,h*.6))horizontal.push(run);run=0;}
      }
    }
    for(let x=0;x<w;x++){
      let run=0;
      for(let y=0;y<=h;y++){
        if(y<h&&mask[y*w+x])run++;
        else if(run){if(run<=Math.min(20,h*.6))vertical.push(run);run=0;}
      }
    }
    if(horizontal.length<70||vertical.length<70)return null;
    const spread=a=>{a.sort((x,y)=>x-y);return a[Math.floor(a.length*.9)]/Math.max(1,a[Math.floor(a.length*.5)]);};
    return {horizontal:spread(horizontal),vertical:spread(vertical)};
  };
  const a=inkRuns(original),b=inkRuns(edited);
  if(!a||!b)return null;
  const originalVaries=Math.max(a.horizontal,a.vertical);
  const editedVaries=Math.max(b.horizontal,b.vertical);
  if(originalVaries>=2.1&&editedVaries<=1.4&&editedVaries/originalVaries<.68)
    return '원본의 붓글씨 획 굵기 대비가 수정본에서 사라졌어.';
  // Distinctive old-print / brush lettering has complex serif terminals.
  // Measuring dark ink perimeter per dark pixel catches a replacement that
  // becomes mechanically smooth and monoline, even if its average stroke
  // thickness and background remain correct. Analyze ONLY pixels of dark
  // lettering; do not alter or reconstruct a single background pixel.
  const edgeComplexity=bytes=>{
    const ink=new Uint8Array(w*h);
    let painted=0,edges=0;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const i=(y*w+x)*4;
      if(Math.max(bytes[i],bytes[i+1],bytes[i+2])<90){
        ink[y*w+x]=1;painted++;
      }
    }
    if(painted<Math.max(600,w*h*.045)||painted>w*h*.45)return null;
    for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){
      const idx=y*w+x;
      edges+=(ink[idx]!==ink[idx+1])+(ink[idx]!==ink[idx+w]);
    }
    return {complexity:edges/painted,painted};
  };
  const before=edgeComplexity(original),after=edgeComplexity(edited);
  if(before&&after&&before.complexity>.42&&
     after.complexity<before.complexity*.86){
    console.warn('image lettering edge-complexity mismatch',JSON.stringify({
      before:+before.complexity.toFixed(3),after:+after.complexity.toFixed(3)
    }));
    return '수정본 글꼴의 획 끝과 세부 윤곽이 원본보다 단순해. 원본 필체와 달라.';
  }
  return null;
}

// Correct a small glyph-height mismatch without asking the generative model to
// redraw the typography. Only run on isolated lettering over a nearly flat
// background; anything textured, clipped, too distorted or ambiguous fails
// closed. This never changes pixels outside the user's selected rectangle.
async function normalizeFlatLabelHeight(original,edited,w,h){
  if(w<25||h<15||original.length!==edited.length)return null;
  const median=values=>{values.sort((a,b)=>a-b);return values[Math.floor(values.length/2)];};
  const border=bytes=>{
    const samples=[];
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      if(x<2||y<2||x>=w-2||y>=h-2){
        const i=(y*w+x)*4;samples.push([bytes[i],bytes[i+1],bytes[i+2]]);
      }
    }
    const bg=[0,1,2].map(i=>median(samples.map(p=>p[i])));
    const variation=samples.reduce((sum,p)=>sum+Math.max(...p.map((v,i)=>Math.abs(v-bg[i]))),0)/samples.length;
    return {bg,variation};
  };
  const sourceBorder=border(original),editedBorder=border(edited);
  if(sourceBorder.variation>9||editedBorder.variation>14)return null;
  if(Math.max(...sourceBorder.bg.map((v,i)=>Math.abs(v-editedBorder.bg[i])))>20)return null;
  const measure=(bytes,bg)=>{
    let left=w,right=-1,top=h,bottom=-1,count=0;
    const colors=[[],[],[]];
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const k=(y*w+x)*4;
      const d=Math.max(Math.abs(bytes[k]-bg[0]),Math.abs(bytes[k+1]-bg[1]),Math.abs(bytes[k+2]-bg[2]));
      if(d<32)continue;
      left=Math.min(left,x);right=Math.max(right,x);
      top=Math.min(top,y);bottom=Math.max(bottom,y);count++;
      if(d>65)for(let channel=0;channel<3;channel++)colors[channel].push(bytes[k+channel]);
    }
    if(count<Math.max(12,w*h*.01)||count>w*h*.40||right<left||
       top<2||bottom>=h-2||left<2||right>=w-2||
       colors.some(array=>array.length<10))return null;
    return {left,right,top,bottom,count,width:right-left+1,height:bottom-top+1,
      cx:(left+right)/2,cy:(top+bottom)/2,
      color:colors.map(values=>median(values))};
  };
  const a=measure(original,sourceBorder.bg),b=measure(edited,editedBorder.bg);
  if(!a||!b||a.height<10)return null;
  const delta=b.height-a.height;
  const allowedExtra=Math.max(1,Math.floor(a.height*.04));
  const allowedShrink=Math.max(2,Math.ceil(a.height*.05));
  if(delta<=allowedExtra&&delta>=-allowedShrink)return null;
  // Permit minor repair only. A significantly different font cannot safely
  // be solved by stretching a different glyph.
  const ratio=a.height/b.height;
  if(ratio<.85||ratio>1.15)return null;
  if(Math.abs(a.cx-b.cx)>Math.max(5,w*.04)||Math.abs(a.cy-b.cy)>Math.max(5,h*.12))return null;
  const foregroundContrast=Math.max(...b.color.map((v,i)=>Math.abs(v-editedBorder.bg[i])));
  if(foregroundContrast<45)return null;
  const ink=Buffer.alloc(b.width*b.height*4);
  for(let py=0;py<b.height;py++)for(let px=0;px<b.width;px++){
    const i=((py+b.top)*w+(px+b.left))*4,k=(py*b.width+px)*4;
    const d=Math.max(...b.color.map((v,j)=>Math.abs(edited[i+j]-editedBorder.bg[j])));
    const intensity=Math.max(...[0,1,2].map(j=>Math.abs(edited[i+j]-editedBorder.bg[j])));
    const opacity=Math.max(0,Math.min(255,Math.round(255*intensity/foregroundContrast)));
    for(let channel=0;channel<3;channel++)ink[k+channel]=b.color[channel];
    ink[k+3]=intensity<9?0:opacity;
  }
  const resized=await sharp(ink,{raw:{width:b.width,height:b.height,channels:4}})
    .resize(b.width,a.height,{fit:'fill',kernel:'lanczos3'}).png().toBuffer();
  const placeX=Math.round(a.cx-b.width/2),placeY=Math.round(a.cy-a.height/2);
  if(placeX<2||placeY<2||placeX+b.width>w-2||placeY+a.height>h-2)return null;
  const background=await sharp({create:{width:w,height:h,channels:4,
    background:{r:sourceBorder.bg[0],g:sourceBorder.bg[1],b:sourceBorder.bg[2],alpha:1}}})
    .composite([{input:resized,left:placeX,top:placeY}]).raw().toBuffer();
  return background;
}

// Only recover colored lettering from an erroneous dark AI fill on a nearly
// uniform, light background. Never attempt this for dark source lettering,
// textured panels, or when the glyph color cannot be separated with confidence.
// The original background is used pixel-for-pixel; the AI cannot repaint it.
function recoverColoredLabelFromDarkFill(source,generated,w,h){
  if(w<28||h<16||source.length!==generated.length)return null;
  const median=values=>{values.sort((a,b)=>a-b);return values[Math.floor(values.length>>1)];};
  const border=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    if(x<2||x>=w-2||y<2||y>=h-2){
      const i=(y*w+x)*4;border.push([source[i],source[i+1],source[i+2]]);
    }
  }
  const bg=[0,1,2].map(j=>median(border.map(p=>p[j])));
  const difference=(a,b)=>Math.max(...a.map((v,j)=>Math.abs(v-b[j])));
  const noise=border.reduce((sum,p)=>sum+difference(p,bg),0)/border.length;
  if(noise>9||Math.min(...bg)<100)return null;
  let originalInk=0;const colorSamples=[[],[],[]];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=(y*w+x)*4,rgb=[source[i],source[i+1],source[i+2]];
    if(difference(rgb,bg)<65)continue;
    originalInk++;
    for(let j=0;j<3;j++)colorSamples[j].push(rgb[j]);
  }
  if(originalInk<Math.max(12,w*h*.01)||originalInk>w*h*.38)return null;
  const glyph=[0,1,2].map(j=>median(colorSamples[j]));
  // A dark generated rectangle cannot be separated from black/dark glyphs.
  // Only distinct mid-bright or vivid text is recoverable.
  if(Math.max(...glyph)<90||difference(glyph,[15,15,15])<78)return null;
  // Erase the OLD label before composing the candidate characters. Keeping
  // source pixels underneath would ghost both amounts into the result.
  const out=Buffer.alloc(source.length);
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=(y*w+x)*4;
    const existing=[source[i],source[i+1],source[i+2]];
    for(let j=0;j<3;j++)out[i+j]=difference(existing,bg)<18?existing[j]:bg[j];
    out[i+3]=255;
  }
  let retained=0,minX=w,minY=h,maxX=-1,maxY=-1;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const i=(y*w+x)*4;
    const candidate=[generated[i],generated[i+1],generated[i+2]];
    // Keep only foreground-colored pixels that are clearly non-background;
    // a dark AI fill is NEVER composited into the original source.
    if(difference(candidate,glyph)>38||Math.max(...candidate)<65)continue;
    retained++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);
    minY=Math.min(minY,y);maxY=Math.max(maxY,y);
    for(let j=0;j<3;j++)out[i+j]=candidate[j];
    out[i+3]=255;
  }
  if(retained<originalInk*.48||retained>originalInk*2.0)return null;
  if(minX<3||minY<3||maxX>=w-3||maxY>=h-3)return null;
  // Require a meaningful amount of the generated text to be present.
  if(maxX-minX+1<w*.12||maxY-minY+1<h*.15)return null;
  return out;
}

// For an isolated label on a flat background, move generated glyph pixels
// back onto the ORIGINAL source text center rather than regenerating the image.
// Reject textured, multicolor, oversized or clipped candidates.
function alignFlatLabelCenter(original,generated,w,h){
  if(w<25||h<15||original.length!==generated.length)return null;
  const median=a=>{a.sort((x,y)=>x-y);return a[Math.floor(a.length/2)];};
  const border=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)
    if(x<2||x>=w-2||y<2||y>=h-2){
      const k=(y*w+x)*4;border.push([original[k],original[k+1],original[k+2]]);
    }
  const bg=[0,1,2].map(j=>median(border.map(p=>p[j])));
  const deviation=p=>Math.max(...p.map((v,j)=>Math.abs(v-bg[j])));
  if(border.reduce((sum,p)=>sum+deviation(p),0)/border.length>9)return null;
  const measure=bytes=>{
    let left=w,right=-1,top=h,bottom=-1,count=0;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){
      const k=(y*w+x)*4;
      if(deviation([bytes[k],bytes[k+1],bytes[k+2]])<32)continue;
      left=Math.min(left,x);right=Math.max(right,x);
      top=Math.min(top,y);bottom=Math.max(bottom,y);count++;
    }
    if(count<Math.max(10,w*h*.012)||count>w*h*.4||left<2||
       right>=w-2||top<2||bottom>=h-2)return null;
    return {left,right,top,bottom,count,cx:(left+right)/2,cy:(top+bottom)/2};
  };
  const a=measure(original),b=measure(generated);
  if(!a||!b)return null;
  const dx=Math.round(a.cx-b.cx),dy=Math.round(a.cy-b.cy);
  if(Math.abs(dx)>Math.max(7,Math.floor(w*.025))||
     Math.abs(dy)>Math.max(7,Math.floor(h*.09))||
     (!dx&&!dy))return null;
  if(b.left+dx<2||b.right+dx>=w-2||b.top+dy<2||b.bottom+dy>=h-2)return null;
  // Preserve original edge pixels. Only recolor pixels in the original text
  // rectangle; retain candidate glyph RGB, antialiasing and stroke weight.
  const out=Buffer.from(original);
  const pad=3;
  const left=Math.max(0,a.left-pad),right=Math.min(w-1,a.right+pad);
  const top=Math.max(0,a.top-pad),bottom=Math.min(h-1,a.bottom+pad);
  for(let y=top;y<=bottom;y++)for(let x=left;x<=right;x++){
    const i=(y*w+x)*4;
    if(deviation([original[i],original[i+1],original[i+2]])>=18)
      for(let channel=0;channel<3;channel++)out[i+channel]=bg[channel];
  }
  for(let y=b.top;y<=b.bottom;y++)for(let x=b.left;x<=b.right;x++){
    const k=(y*w+x)*4;
    if(deviation([generated[k],generated[k+1],generated[k+2]])<12)continue;
    const dest=((y+dy)*w+(x+dx))*4;
    out[dest]=generated[k];out[dest+1]=generated[k+1];
    out[dest+2]=generated[k+2];out[dest+3]=255;
  }
  return {data:out,dx,dy};
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
  let usedUnmaskedFallback=false;
  if(firstStats.dark>.94&&firstStats.variance<100){
    usedUnmaskedFallback=true;
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
  let variance=Math.max(0,outputSq/n-(outputSum/n)**2);
  const sourceVariance=Math.max(0,sourceSq/n-(sourceSum/n)**2);
  let darkFraction=outputDark/pixelCount;
  const sourceDarkFraction=sourceDark/pixelCount;
  console.info('image edit region quality',JSON.stringify({
    width:w,height:h,darkFraction:+darkFraction.toFixed(3),
    sourceDarkFraction:+sourceDarkFraction.toFixed(3),
    variance:Math.round(variance),sourceVariance:Math.round(sourceVariance)
  }));
  // A genuinely black generated patch is unusable when the original
  // region is visibly brighter. An already-dark background must not be
  // rejected solely for being dark; later glyph and change checks still run.
  // A noisy, newly dark patch on a light UI is not a replacement label.
  // Retrying the same masked generation usually repeats the background fill.
  // Instead, retry once WITHOUT a mask, providing the original contextual
  // image with a precise target rectangle. Only the chosen source rectangle
  // is ever composited, so pixels outside it remain original.
  if(sourceDarkFraction<.20 && darkFraction>.60 &&
     darkFraction-sourceDarkFraction>.45){
    if(attempt===0&&!usedUnmaskedFallback){
      console.warn('image patch dark-fill: retrying unmasked context',JSON.stringify({
        width:w,height:h,darkFraction:+darkFraction.toFixed(3),
        sourceDarkFraction:+sourceDarkFraction.toFixed(3)
      }));
      const px=Math.round(maskX/1024*100),py=Math.round(maskY/1024*100);
      const pw=Math.max(1,Math.round(maskW/1024*100));
      const ph=Math.max(1,Math.round(maskH/1024*100));
      const repairInstruction=instruction+
        ' EDIT ONLY THE ORIGINAL TEXT at position '+px+'% left, '+py+
        '% top, width '+pw+'%, height '+ph+
        '% of this contextual image. This is a LIGHT background UI label. '+
        'Keep the white/light background completely unchanged, no dark box, '+
        'no dark shadow, no panel redraw, no change to other lines. '+
        'Keep the original text RGB color, font height, weight, baseline, '+
        'and original horizontal center. Make the smallest possible glyph edit.';
      const repaired=await invoke(crop,repairInstruction,null);
      const repairedPatch=await extractPatch(repaired);
      const repairedStats=patchStats(repairedPatch);
      console.info('image dark-fill unmasked repair quality',JSON.stringify({
        dark:+repairedStats.dark.toFixed(3),
        variance:Math.round(repairedStats.variance)
      }));
      if(repairedStats.transparent>.05){
        throw new Error('수정본에 비정상적인 투명 영역이 있어 전송을 차단했어. 원본은 유지했어.');
      }
      if(repairedStats.dark>.60 &&
         repairedStats.dark-sourceDarkFraction>.45){
        const extracted=recoverColoredLabelFromDarkFill(originalRegion,repairedPatch.data,w,h);
        if(!extracted){
          throw new Error('AI가 글자 주변 배경을 어둡게 변형해 결과를 차단했어. 원본은 유지했어.');
        }
        const extractedStats=patchStats({data:extracted});
        // The extracted glyphs are subject to the SAME layout/typeface checks.
        // Do not treat background restoration as a successful edit by itself.
        patch=repairedPatch;
        bytes.set(extracted);
        darkFraction=extractedStats.dark;
        variance=extractedStats.variance;
        console.info('image dark-fill label extraction candidate',JSON.stringify({width:w,height:h}));
      }else{
        patch=repairedPatch;
        bytes.set(repairedPatch.data);
        darkFraction=repairedStats.dark;
        variance=repairedStats.variance;
      }
      // Run every normal typography, boundary and source-pixel check on this
      // alternate patch; do not accept a merely brighter patch as success.
      for(let py=0;py<h;py++)for(let px=0;px<w;px++){
        const border=Math.min(px,py,w-1-px,h-1-py);
        const opacity=fade ? Math.min(1,(border+0.5)/fade) : 1;
        const alphaOffset=(py*w+px)*channels+3;
        bytes[alphaOffset]=Math.round(bytes[alphaOffset]*opacity);
      }
    }else{
      const extracted=recoverColoredLabelFromDarkFill(originalRegion,bytes,w,h);
      if(!extracted){
        if(darkFraction>.94 && variance<75)
          throw new Error('AI 결과가 기존 글자와 배경을 검은색으로 지워 편집을 적용하지 않았어. 원본은 유지했어.');
        throw new Error('AI가 글자 대신 배경을 어둡게 변형해 잘못된 편집을 차단했어. 원본은 유지했어.');
      }
      const extractedStats=patchStats({data:extracted});
      bytes.set(extracted);
      darkFraction=extractedStats.dark;
      variance=extractedStats.variance;
      console.info('image dark-fill source background restored',JSON.stringify({width:w,height:h}));
    }
  }
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
    let sourceInk=0,rightInk=0,originalRightInk=0;
    for(let yy=0;yy<h;yy++)for(let xx=0;xx<w;xx++){
      const i=(yy*w+xx)*4;
      if(delta(labelOriginal,i)>=42)sourceInk++;
      if(xx>=w-edgeBand && yy>=2 && yy<h-2){
        if(delta(bytes,i)>=48)rightInk++;
        if(delta(labelOriginal,i)>=48)originalRightInk++;
      }
    }
    // Do not flag an original label that already touches the chosen border.
    // A newly created, substantial edge contact is evidence of clipping.
    if(sourceInk>=Math.max(4,Math.floor(w*h*.012)) && sourceInk<w*h*.45 &&
       rightInk>=Math.max(3,Math.ceil(h*.09)) &&
       rightInk>originalRightInk+Math.max(2,Math.ceil(h*.04))){
      if(attempt===0){
        console.warn('image right-edge clipping retry',JSON.stringify({width:w,height:h,rightInk,originalRightInk}));
        return reviseDesignRegion(sourceBuffer,selection,
          instruction+' CRITICAL: Place every replaced glyph entirely within the selected box. Leave clear space at its RIGHT boundary; do not clip the final digit or Korean character. Keep source glyph size, baseline, and background unchanged.',1);
      }
      throw new Error('수정한 글자가 선택 영역 오른쪽 경계에서 잘릴 위험이 있어. 원본을 유지했어. 다음 시도에서는 오른쪽 여백까지 더 넓게 선택해 줘.');
    }
  }
  let mismatch=assessLabelConsistency(labelOriginal,bytes,w,h);
  // These are INK metrics, not the height/width of the user selection.
  // The crop may include adjacent non-name text on arbitrary edits, so
  // apply only to the strict same-length Korean name substitution pathway.
  if(!mismatch&&instruction.includes('STRICT TEXT SUBSTITUTION')){
    const before=measurePrintedNameMetrics(labelOriginal,w,h);
    const after=measurePrintedNameMetrics(bytes,w,h);
    if(before&&after&&before.height>=12){
      const heightDelta=after.height-before.height;
      console.info('printed name glyph scale',JSON.stringify({
        original:before.height,edited:after.height,delta:heightDelta,
        width:w,height:h,attempt
      }));
      if(heightDelta>Math.max(2,Math.ceil(before.height*.10))||
         heightDelta<-Math.max(3,Math.ceil(before.height*.13))){
        mismatch='수정본 글자 크기가 원본 실제 글자 높이와 달라.';
      }
    }
  }
  // Stroke-contrast and perimeter statistics cannot establish identical
  // typeface when the WORDS themselves differ. They previously triggered an
  // expensive AI retry even for an otherwise usable, correctly composited
  // first result; the retry frequently destroyed the good background and
  // produced a second failure. Treat the typography heuristic as diagnostic
  // only. Actual background, clipping, size, alignment and color safeguards
  // remain blocking and the original composite path stays unchanged.
  const typographyWarning=assessTexturedInkStrokeContrast(labelOriginal,bytes,w,h);
  if(typographyWarning)console.warn('image typography similarity advisory (nonblocking)',JSON.stringify({
    reason:typographyWarning,width:w,height:h,attempt
  }));
  if(mismatch==='수정본 숫자 줄의 글자 높이가 원본과 달라.'){
    const corrected=await normalizeFlatLabelHeight(labelOriginal,bytes,w,h);
    if(corrected){
      const afterCorrection=assessLabelConsistency(labelOriginal,corrected,w,h);
      if(!afterCorrection){
        bytes.set(corrected);
        mismatch=null;
        console.info('image label height normalized without AI redraw',JSON.stringify({width:w,height:h}));
      }else console.info('image height correction rejected by QA',afterCorrection);
    }
  }
  if(mismatch==='수정본 숫자 줄의 세로 중심이 원본과 달라.' ||
     mismatch==='수정본 숫자 줄의 가로 중앙 정렬이 원본과 달라.'){
    const aligned=alignFlatLabelCenter(labelOriginal,bytes,w,h);
    if(aligned){
      const checked=assessLabelConsistency(labelOriginal,aligned.data,w,h);
      if(!checked){
        bytes.set(aligned.data);
        mismatch=null;
        console.info('image label center corrected without AI retry',
          JSON.stringify({dx:aligned.dx,dy:aligned.dy,width:w,height:h}));
      }else{
        console.info('image label center correction rejected by QA',checked);
      }
    }
  }
  if(mismatch){
    if(attempt===0){
      console.warn('image label quality retry:',mismatch);
      return reviseDesignRegion(sourceBuffer,selection,
        instruction+' ORIGINAL FONT FAILURE: Match the original Korean font family and stroke style exactly. If source is brush calligraphy, imitate variable brush strokes, serifs, ink taper, fine hairline strokes, uneven curves and original print noise. Never switch to generic clean sans-serif. Keep the background stripes or texture intact. CRITICAL IMAGE QA FAILURE: Keep the edited text at the SAME source font-size and visible glyph height (at most 1-2 pixels of raster difference), and the original line center X and center Y. Longer numbers may be wider, but NEVER taller, heavier or rescaled. If the line cannot fit, preserve glyph height and do not guess an enlarged replacement. Keep clear left/right padding, the original baseline, font weight, color and the unaffected lines. Never enlarge the number or shift its horizontal alignment.',1);
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
