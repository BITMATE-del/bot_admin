import sharp from 'sharp';

// Exact-font-first rendering. A replacement is permitted only when the SAME
// font reproduces the existing text pixels with high confidence. Neither the
// original background nor the replacement characters are AI-generated.
const FONTS=['Noto Serif CJK KR','Noto Sans CJK KR','DejaVu Sans'];
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const median=a=>{const v=a.sort((x,y)=>x-y);return v[Math.floor(v.length/2)]};
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
  const perimeter=[];
  for(let py=0;py<h;py++)for(let px=0;px<w;px++)if(px<2||px>=w-2||py<2||py>=h-2){
    const k=(py*w+px)*4;perimeter.push([region[k],region[k+1],region[k+2]]);
  }
  const bg=[0,1,2].map(c=>median(perimeter.map(p=>p[c])));
  const dist=(k,bytes)=>Math.max(...[0,1,2].map(c=>Math.abs(bytes[k+c]-bg[c])));
  const edgeNoise=perimeter.reduce((sum,p)=>sum+Math.max(...p.map((v,c)=>Math.abs(v-bg[c]))),0)/perimeter.length;
  if(edgeNoise>8)throw new Error('원본 배경에 무늬·질감이 있어 정확한 복원이 어려워. 원본 서체와 배경을 유지할 수 있는 자료가 필요해.');
  const mask=new Uint8Array(w*h);let colors=[[],[],[]];
  for(let i=0;i<mask.length;i++){
    const k=i*4,d=dist(k,region);
    if(d>=42){
      mask[i]=1;
      if(d>65)for(let c=0;c<3;c++)colors[c].push(region[k+c]);
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
  if(!best||best.score<.68)
    throw new Error('원본 글씨체와 일치하는 서체를 찾지 못했어. 다른 글꼴을 새로 만들어 적용하지 않았고 이용권도 차감하지 않아.');
  const newImage=await alpha(to,best.font,best.size,w,h);
  const newMask=outMask(newImage,w,h), dest=bounds(newMask,w,h);
  if(!dest||dest.left<3||dest.top<3||dest.right>=w-3||dest.bottom>=h-3)
    throw new Error('새 문구가 선택 영역을 벗어나거나 잘릴 수 있어. 원본을 유지했어.');
  // The selected rectangle's original flat background can be restored exactly
  // by its robust median RGB. No AI fill, typography hallucination or dark box.
  const base=Buffer.alloc(w*h*4);
  for(let i=0;i<w*h;i++){
    const k=i*4;for(let j=0;j<3;j++)base[k+j]=bg[j];base[k+3]=255;
  }
  const offsetX=Math.round((src.left+src.right-dest.left-dest.right)/2);
  const offsetY=Math.round((src.top+src.bottom-dest.top-dest.bottom)/2);
  if(dest.left+offsetX<3||dest.right+offsetX>=w-3||dest.top+offsetY<3||dest.bottom+offsetY>=h-3)
    throw new Error('원본 위치에 새 문구를 배치하면 잘려. 선택 영역을 넓혀 줘.');
  for(let py=dest.top;py<=dest.bottom;py++)for(let px=dest.left;px<=dest.right;px++){
    const k=(py*w+px)*4,dx=px+offsetX,dy=py+offsetY,j=(dy*w+dx)*4;
    const a=newImage[k+3]/255;
    for(let ch=0;ch<3;ch++)base[j+ch]=Math.round(ink[ch]*a+bg[ch]*(1-a));
  }
  const patch=await sharp(base,{raw:{width:w,height:h,channels:4}}).png().toBuffer();
  console.info('strict text replace matched source face',JSON.stringify({score:+best.score.toFixed(3),font:best.font,width:w,height:h}));
  return sharp(original).composite([{input:patch,left:x,top:y}]).png().toBuffer();
}
