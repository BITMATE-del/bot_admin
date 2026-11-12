import sharp from 'sharp';

// Exact-font-first rendering. A replacement is permitted only when the SAME
// font reproduces the existing text pixels with high confidence. Neither the
// original background nor the replacement characters are AI-generated.
const FONTS=['Noto Serif CJK KR','Noto Sans CJK KR','DejaVu Sans'];
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const median=a=>{const v=a.sort((x,y)=>x-y);return v[Math.floor(v.length/2)]};
// Recover repeatable diagonal/striped printing backgrounds from the
// original border, without guessing arbitrary photographic textures.
const backgroundModel=(pixels,w,h)=>{
  const points=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    if(x<3||y<3||x>=w-3||y>=h-3){
      const k=(y*w+x)*4;
      points.push({x,y,rgb:[pixels[k],pixels[k+1],pixels[k+2]]});
    }
  }
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
  // If the source is not a repeatable pattern, refuse to synthesize it.
  if(!best||best.error>10||best.error>noise*.52)return null;
  return best;
};
const bounds=(mask,w,h)=>{
  let left=w,top=h,right=-1,bottom=-1,n=0;
  for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(mask[y*w+x]){
    left=Math.min(left,x);right=Math.max(right,x);
    top=Math.min(top,y);bottom=Math.max(bottom,y);n++;
  }
  return n?{left,top,right,bottom,w:right-left+1,h:bottom-top+1,n}:null;
};
const alpha=async(text,font,fontSize,w,h)=>{
  const svg='<svg xmlns="http://www.w3.org/2000/svg" width="'+w+'" height="'+h+'"><text x="'+(w/2)+'" y="'+(h/2+fontSize*.34)+'" font-family="'+esc(font)+'" font-size="'+fontSize+'" text-anchor="middle" fill="#000">'+esc(text)+'</text></svg>';
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
  const model=backgroundModel(region,w,h);
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
  for(const font of FONTS)for(const size of [Math.round(src.h*1.03),Math.round(src.h*1.15),Math.round(src.h*1.28),Math.round(src.h*1.42)]){
    if(size<7)continue;
    const rendered=await alpha(from,font,size,w,h);
    const rm=outMask(rendered,w,h), rb=bounds(rm,w,h);
    const score=compare(mask,src,rm,rb,w,h);
    if(!best||score>best.score)best={font,size,score};
  }
  // Deliberately conservative: don't pretend a brush/printed face is a
  // generic Korean sans font. Exact font is otherwise unknowable from pixels.
  if(!best||best.score<.76)
    throw new Error('원본 글씨체와 일치하는 서체를 찾지 못했어. 다른 글꼴을 새로 만들어 적용하지 않았고 이용권도 차감하지 않아.');
  const newImage=await alpha(to,best.font,best.size,w,h);
  const newMask=outMask(newImage,w,h), dest=bounds(newMask,w,h);
  if(!dest||dest.left<3||dest.top<3||dest.right>=w-3||dest.bottom>=h-3)
    throw new Error('새 문구가 선택 영역을 벗어나거나 잘릴 수 있어. 원본을 유지했어.');
  // The selected rectangle's original flat background can be restored exactly
  // by its robust median RGB. No AI fill, typography hallucination or dark box.
  // Keep all measured background pixels untouched. Repair only source ink,
  // using modeled repeating background when a texture is present.
  const base=Buffer.from(region);
  for(let i=0;i<w*h;i++){
    const k=i*4;
    if(soft[i]<12)continue;
    const x=i%w,y=Math.floor(i/w),predicted=model.at(x,y);
    const opacity=Math.max(0,Math.min(1,(soft[i]-12)/28));
    for(let ch=0;ch<3;ch++)
      base[k+ch]=Math.round(base[k+ch]*(1-opacity)+predicted[ch]*opacity);
    base[k+3]=255;
  }
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
  console.info('strict text replace matched source face',JSON.stringify({score:+best.score.toFixed(3),font:best.font,background:model.kind,backgroundError:+model.error.toFixed(2),width:w,height:h}));
  return sharp(original).composite([{input:patch,left:x,top:y}]).png().toBuffer();
}
