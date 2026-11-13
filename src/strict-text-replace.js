import sharp from 'sharp';

// Exact-font-first rendering. A replacement is permitted only when the SAME
// font reproduces the existing text pixels with high confidence. Neither the
// original background nor the replacement characters are AI-generated.
const FONTS=['Noto Serif CJK KR','Noto Sans CJK KR','DejaVu Sans'];
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const median=a=>{const v=a.sort((x,y)=>x-y);return v[Math.floor(v.length/2)]};
// Recover repeatable diagonal/striped printing backgrounds from the
// original border, without guessing arbitrary photographic textures.
const backgroundModel=(pixels,w,h,extraPoints=[])=>{
  const points=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    if(x<3||y<3||x>=w-3||y>=h-3){
      const k=(y*w+x)*4;
      points.push({x,y,rgb:[pixels[k],pixels[k+1],pixels[k+2]]});
    }
  }
  // Neighboring unedited pixels provide evidence for repeating print textures,
  // even when the selection's own border contains ink or a curved shadow.
  // Coordinates remain relative to the edit rectangle.
  if(extraPoints.length)points.push(...extraPoints);
  const constant=[0,1,2].map(ch=>median(points.map(p=>p.rgb[ch])));
  const diff=(rgb,bg)=>Math.max(...rgb.map((v,j)=>Math.abs(v-bg[j])));
  const noise=points.reduce((sum,p)=>sum+diff(p.rgb,constant),0)/points.length;
  const flat={kind:'flat',error:noise,at:()=>constant};
  if(noise<=8)return flat;
  let best=null;
  for(const [vx,vy] of [[1,1],[1,-1],[2,1],[2,-1],[1,2],[1,-2],[3,1],[3,-1],[1,3],[1,-3]]){
    for(let period=4;period<=28;period++){
      const samples=Array.from({length:period},()=>[[],[],[]]);
      for(const p of points){
        const phase=((vx*p.x+vy*p.y)%period+period)%period;
        for(let ch=0;ch<3;ch++)samples[phase][ch].push(p.rgb[ch]);
      }
      if(samples.some(row=>row.some(arr=>arr.length<4)))continue;
      const palette=samples.map(row=>row.map(arr=>median(arr)));
      const error=points.reduce((sum,p)=>{
        const phase=((vx*p.x+vy*p.y)%period+period)%period;
        return sum+diff(p.rgb,palette[phase]);
      },0)/points.length;
      if(!best||error<best.error)best={kind:'periodic',error,vx,vy,period,
        at:(x,y)=>palette[((vx*x+vy*y)%period+period)%period]};
    }
  }
  // Backgrounds can contain a gentle light gradient or JPEG-compressed
  // diagonal stripes. Judge a repeatable model against a baseline and permit
  // small compression error; arbitrary photographic noise still fails.
  const cx=(w-1)/2,cy=(h-1)/2;
  const gradient=[0,1,2].map(ch=>{
    const a=points.reduce((sum,p)=>sum+(p.x-cx)*(p.rgb[ch]-constant[ch]),0);
    const b=points.reduce((sum,p)=>sum+(p.y-cy)*(p.rgb[ch]-constant[ch]),0);
    const xx=points.reduce((sum,p)=>sum+(p.x-cx)**2,0);
    const yy=points.reduce((sum,p)=>sum+(p.y-cy)**2,0);
    return {center:constant[ch],slopeX:a/Math.max(1,xx),slopeY:b/Math.max(1,yy)};
  });
  const planarAt=(x,y)=>gradient.map(p=>Math.max(0,Math.min(255,Math.round(
    p.center+p.slopeX*(x-cx)+p.slopeY*(y-cy)
  ))));
  const planarError=points.reduce((sum,p)=>sum+diff(p.rgb,planarAt(p.x,p.y)),0)/points.length;
  const planar={kind:'gradient',error:planarError,at:planarAt};
  if(planarError<=Math.min(11,noise*.52))return planar;
  if(best&&best.error<=Math.min(15,noise*.68))return best;
  console.info('strict background model inconclusive',JSON.stringify({
    width:w,height:h,noise:+noise.toFixed(2),
    periodicError:best?+best.error.toFixed(2):null,
    gradientError:+planarError.toFixed(2)
  }));
  return null;
};
// Pure pixel-level cleanup so faint-ink removal can be tested separately from
// candidate-font size selection and clipping checks.
export function restoreOldGlyphHalos(region,mask,soft,model,w,h){
  const base=Buffer.from(region);
  // Remove faint remnants of the OLD glyph before compositing the new glyph.
  // Crucially, do not paint every differing pixel: repeating hatching, grain,
  // shadows and compression noise must remain intact. Restrict restoration to
  // a 3px neighborhood of confidently detected old ink, including antialiasing
  // at the top of letters. Do not expand the text bounding rectangle.
  const oldInkNeighborhood=new Uint8Array(w*h);
  for(let py=0;py<h;py++)for(let px=0;px<w;px++)if(mask[py*w+px]){
    for(let dy=-3;dy<=3;dy++)for(let dx=-3;dx<=3;dx++){
      const xx=px+dx,yy=py+dy;
      if(xx>=0&&xx<w&&yy>=0&&yy<h)oldInkNeighborhood[yy*w+xx]=1;
    }
  }
  let restored=0;
  for(let i=0;i<w*h;i++){
    if(!oldInkNeighborhood[i]||soft[i]<10)continue;
    const k=i*4,x=i%w,y=Math.floor(i/w),predicted=model.at(x,y);
    // At >26 RGB difference we replace confident old-ink remnants; for a
    // 10..26 antialiased edge gradually blend into the unchanged pattern.
    const opacity=Math.max(0,Math.min(1,(soft[i]-10)/16));
    for(let ch=0;ch<3;ch++)
      base[k+ch]=Math.round(base[k+ch]*(1-opacity)+predicted[ch]*opacity);
    base[k+3]=255;
    restored++;
  }
  return {base,restored};

}

const bounds=(mask,w,h)=>{
  let left=w,top=h,right=-1,bottom=-1,n=0;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(mask[y*w+x]){
    left=Math.min(left,x);right=Math.max(right,x);
    top=Math.min(top,y);bottom=Math.max(bottom,y);n++;
  }
  return n?{left,top,right,bottom,w:right-left+1,h:bottom-top+1,n}:null;
};
const alpha=async(text,font,fontSize,w,h,weight=400)=>{
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><text x="'+(w/2)+'" y="'+(h/2+fontSize*.34)+'" font-family="'+esc(font)+'" font-weight="'+weight+'" font-size="'+fontSize+'" text-anchor="middle" fill="#000">'+esc(text)+'</text></svg>';
  return sharp(Buffer.from(svg)).ensureAlpha().raw().toBuffer();
};
const outMask=(bytes,w,h)=>{const mask=new Uint8Array(w*h);for(let i=0;i<mask.length;i++)mask[i]=bytes[i*4+3]>110?1:0;return mask;};
const compare=(source,sourceBox,rendered,renderBox,w,h)=>{
  if(!renderBox)return 0;
  // Compare normalized silhouettes, but also demand correct font-size and
  // aspect ratio; glyph identity must match, not merely overall weight.
  const ratio=(renderBox.w/renderBox.h)/(sourceBox.w/sourceBox.h);
  if(ratio<.88||ratio>1.12)return 0;
  const X=44,Y=24;
  let a=0,b=0,intersection=0,union=0;
  for(let gy=0;gy<Y;gy++)for(let gx=0;gx<X;gx++){
    const sx=sourceBox.left+Math.min(sourceBox.w-1,Math.floor((gx+.5)*sourceBox.w/X));
    const sy=sourceBox.top+Math.min(sourceBox.h-1,Math.floor((gy+.5)*sourceBox.h/Y));
    const rx=renderBox.left+Math.min(renderBox.w-1,Math.floor((gx+.5)*renderBox.w/X));
    const ry=renderBox.top+Math.min(renderBox.h-1,Math.floor((gy+.5)*renderBox.h/Y));
    const i=source[sy*w+sx],j=rendered[ry*w+rx];
    if(i)a++;if(j)b++;
    if(i&&j)intersection++;if(i||j)union++;
  }
  return union?intersection/union:0;
};
export async function replaceTextStrict(sourceBuffer,selection,from,to){
  const original=await sharp(sourceBuffer).rotate().png().toBuffer();
  const meta=await sharp(original).metadata();
  const {x,y,w,h}=selection;
  if(![x,y,w,h].every(Number.isInteger)||x<0||y<0||w<12||h<12||x+w>meta.width||y+h>meta.height)
    throw new Error('수정 영역을 정확하게 선택해 줘.');
  if(!from||!to||from===to||from.length>60||to.length>60)
    throw new Error('기존 문구와 새 문구를 확인해 줘.');
  const region=await sharp(original).extract({left:x,top:y,width:w,height:h}).ensureAlpha().raw().toBuffer();
  let model=backgroundModel(region,w,h);
  if(!model){
    // Read-only context: pixels OUTSIDE the user-selected box are sampled to
    // reconstruct the existing pattern, but will never be modified.
    const margin=Math.max(10,Math.min(28,Math.round(Math.min(w,h)*.3)));
    const left=Math.max(0,x-margin),top=Math.max(0,y-margin);
    const right=Math.min(meta.width,x+w+margin),bottom=Math.min(meta.height,y+h+margin);
    const contextW=right-left,contextH=bottom-top;
    const context=await sharp(original).extract({left,top,width:contextW,height:contextH}).ensureAlpha().raw().toBuffer();
    const extra=[];
    for(let py=0;py<contextH;py+=2)for(let px=0;px<contextW;px+=2){
      const globalX=px+left,globalY=py+top;
      if(globalX>=x&&globalX<x+w&&globalY>=y&&globalY<y+h)continue;
      const k=(py*contextW+px)*4;
      extra.push({x:globalX-x,y:globalY-y,
        rgb:[context[k],context[k+1],context[k+2]]});
    }
    const candidate=backgroundModel(region,w,h,extra);
    if(candidate){
      // Verify against the selection border as a held-out reference: if the
      // external context follows a different panel/texture, reject it.
      const samples=[];
      for(let py=0;py<h;py++)for(let px=0;px<w;px++)
        if(px<3||py<3||px>=w-3||py>=h-3){
          const k=(py*w+px)*4,expected=candidate.at(px,py);
          samples.push(Math.max(...[0,1,2].map(ch=>Math.abs(region[k+ch]-expected[ch]))));
        }
      samples.sort((a,b)=>a-b);
      const med=samples[Math.floor(samples.length/2)];
      if(med<=15)model=candidate;
    }
  }
  if(!model)throw new Error('원본 배경 무늬를 정확하게 복원할 근거가 부족해. 다른 필체나 배경을 만들어 적용하지 않았어.');
  const mask=new Uint8Array(w*h),soft=new Uint8Array(w*h);
  let colors=[[],[],[]];
  for(let i=0;i<mask.length;i++){
    const x=i%w,y=Math.floor(i/w),k=i*4,ref=model.at(x,y);
    const d=Math.max(...[0,1,2].map(ch=>Math.abs(region[k+ch]-ref[ch])));
    // A background texture cannot be classified as dark ink merely because
    // it differs from a global average; compare to the predicted local pixel.
    soft[i]=d;
    if(d>=42){
      mask[i]=1;
      if(d>65)for(let ch=0;ch<3;ch++)colors[ch].push(region[k+ch]);
    }
  }
  const src=bounds(mask,w,h);
  if(!src||src.n<w*h*.015||src.n>w*h*.40||src.left<3||src.top<3||src.right>=w-3||src.bottom>=h-3||
     colors.some(c=>c.length<12))
    throw new Error('기존 글자와 배경을 확실하게 구분할 수 없어. 원본은 유지했어.');
  const ink=colors.map(c=>median(c));
  let best=null;
  for(const font of FONTS)for(const weight of [400,700])
    for(const size of [Math.round(src.h*1.03),Math.round(src.h*1.15),Math.round(src.h*1.28),Math.round(src.h*1.42)]){
      if(size<7)continue;
      const rendered=await alpha(from,font,size,w,h,weight);
      const rm=outMask(rendered,w,h), rb=bounds(rm,w,h);
      const score=compare(mask,src,rm,rb,w,h);
      if(!best||score>best.score)best={font,size,weight,score};
    }
  // Deliberately conservative: don't pretend a brush/printed face is a
  // generic Korean sans font. Exact font is otherwise unknowable from pixels.
  if(!best||best.score<.76)
    throw new Error('원본 글씨체와 일치하는 서체를 찾지 못했어. 다른 글꼴을 새로 만들어 적용하지 않았고 이용권도 차감하지 않아.');
  const newImage=await alpha(to,best.font,best.size,w,h,best.weight);
  const newMask=outMask(newImage,w,h), dest=bounds(newMask,w,h);
  if(!dest||dest.left<3||dest.top<3||dest.right>=w-3||dest.bottom>=h-3)
    throw new Error('새 문구가 선택 영역을 벗어나거나 잘릴 수 있어. 원본을 유지했어.');
  // The selected rectangle's original flat background can be restored exactly
  // by its robust median RGB. No AI fill, typography hallucination or dark box.
  // Keep all measured background pixels untouched. Repair only source ink,
  // using modeled repeating background when a texture is present.
  const {base,restored}=restoreOldGlyphHalos(region,mask,soft,model,w,h);
  console.info('strict text faint-ink cleanup',JSON.stringify({width:w,height:h,restored}));
  const offsetX=Math.round((src.left+src.right-dest.left-dest.right)/2);
  const offsetY=Math.round((src.top+src.bottom-dest.top-dest.bottom)/2);
  if(dest.left+offsetX<3||dest.right+offsetX>=w-3||dest.top+offsetY<3||dest.bottom+offsetY>=h-3)
    throw new Error('원본 위치에 새 문구를 배치하면 잘려. 선택 영역을 넓혀 줘.');
  for(let py=dest.top;py<=dest.bottom;py++)for(let px=dest.left;px<=dest.right;px++){
    const k=(py*w+px)*4,dx=px+offsetX,dy=py+offsetY,j=(dy*w+dx)*4;
    const a=newImage[k+3]/255;
    const back=model.at(dx,dy);
    for(let ch=0;ch<3;ch++)base[j+ch]=Math.round(ink[ch]*a+back[ch]*(1-a));
  }
  const patch=await sharp(base,{raw:{width:w,height:h,channels:4}}).png().toBuffer();
  console.info('strict text replace matched source face',JSON.stringify({score:+best.score.toFixed(3),font:best.font,weight:best.weight,background:model.kind,backgroundError:+model.error.toFixed(2),width:w,height:h}));
  return sharp(original).composite([{input:patch,left:x,top:y}]).png().toBuffer();
}
