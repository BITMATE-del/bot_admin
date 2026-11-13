// Optional printed-name raster correction for AI-generated text ONLY.
// Never resize the full patch: doing that moves the paper hatching and creates
// visible rectangular seams. We remove and rescale only the old AI ink.
const median = values => {
  const ordered=[...values].sort((a,b)=>a-b);
  return ordered[Math.floor(ordered.length/2)];
};
const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
export function normalizePrintedNameInk(original,edited,w,h,sourceMetrics,resultMetrics){
  if(!sourceMetrics||!resultMetrics||w<36||h<16||
    original.length<w*h*4||edited.length<w*h*4)return null;
  const heightError=resultMetrics.height-sourceMetrics.height;
  if(Math.abs(heightError)<=2||Math.abs(heightError)>Math.max(16,sourceMetrics.height*.7))
    return null;
  // Apply only to a small, self-contained text label on light neutral paper.
  // Do not use on dark UI, colored gradients, or densely patterned pictures.
  const backgrounds=[];
  const sourcePaper=[];
  for(let y=0;y<h;y++)for(let x=0;x<w;x++){
    const k=(y*w+x)*4;
    const light=(edited[k]+edited[k+1]+edited[k+2])/3;
    if(light>167)backgrounds.push(light);
    const source=(original[k]+original[k+1]+original[k+2])/3;
    if(source>167)sourcePaper.push(source);
  }
  if(backgrounds.length<w*h*.38||sourcePaper.length<w*h*.38)return null;
  const paper=median(backgrounds),paperSource=median(sourcePaper);
  if(paper<185||Math.abs(paper-paperSource)>22)return null;
  const threshold=clamp(Math.floor(paper-42),112,190);
  const bbox=resultMetrics;
  if(bbox.left<3||bbox.right>=w-3||bbox.top<3||bbox.bottom>=h-3)return null;
  const inside=(x,y)=>x>=bbox.left-2&&x<=bbox.right+2&&y>=bbox.top-2&&y<=bbox.bottom+2;
  const originalBytes=Uint8Array.from(edited);
  const color=(x,y)=>{
    const k=(y*w+x)*4;
    return [edited[k],edited[k+1],edited[k+2]];
  };
  const isForeground=(x,y)=>{
    if(!inside(x,y))return false;
    const c=color(x,y);
    return (c[0]+c[1]+c[2])/3<threshold;
  };
  const countInk=()=>{
    let ink=0;
    for(let y=bbox.top;y<=bbox.bottom;y++)for(let x=bbox.left;x<=bbox.right;x++)
      if(isForeground(x,y))ink++;
    return ink;
  };
  const darkPixels=countInk();
  if(darkPixels<Math.max(25,bbox.width*bbox.height*.025)||
     darkPixels>bbox.width*bbox.height*.55)return null;
  // Prepare an ink-free, locally reconstructed paper. A nearby bright source
  // pixel is better than an arbitrary flat color for lightly textured scans.
  const plate=Uint8Array.from(edited);
  const candidateBackground=(x,y)=>{
    const samples=[[],[],[]];
    for(let d=2;d<=11;d++){
      for(const [xx,yy] of [[x-d,y],[x+d,y],[x,y-d],[x,y+d],
        [x-d,y-d],[x+d,y+d]]){
        if(xx<0||xx>=w||yy<0||yy>=h||isForeground(xx,yy))continue;
        const k=(yy*w+xx)*4;
        const l=(edited[k]+edited[k+1]+edited[k+2])/3;
        if(l<Math.max(166,paper-30))continue;
        for(let ch=0;ch<3;ch++)samples[ch].push(edited[k+ch]);
      }
      if(samples[0].length>=7)break;
    }
    if(samples[0].length<3)return null;
    return samples.map(values=>Math.round(median(values)));
  };
  const bgCache=new Map();
  for(let y=Math.max(0,bbox.top-2);y<=Math.min(h-1,bbox.bottom+2);y++){
    for(let x=Math.max(0,bbox.left-2);x<=Math.min(w-1,bbox.right+2);x++){
      const idx=y*w+x,k=idx*4;
      if((edited[k]+edited[k+1]+edited[k+2])/3>=paper-26)continue;
      const bg=candidateBackground(x,y);
      if(!bg)return null;
      bgCache.set(idx,bg);
      plate[k]=bg[0];plate[k+1]=bg[1];plate[k+2]=bg[2];
    }
  }
  // Sample actual AI ink RGB, including its anti-aliasing, at the new height.
  const out=Uint8Array.from(plate);
  const targetTop=Math.round(sourceMetrics.centerY-sourceMetrics.height/2);
  const targetBottom=targetTop+sourceMetrics.height-1;
  const targetLeft=Math.round(sourceMetrics.left);
  const dx=clamp(Math.round(sourceMetrics.centerY-resultMetrics.centerY),-10,10);
  if(targetTop<2||targetBottom>=h-2)return null;
  const scale=resultMetrics.height/sourceMetrics.height;
  const interpolate=(x,y,ch)=>{
    const ky=clamp(y,0,h-1),kx=clamp(x,0,w-1);
    return edited[(ky*w+kx)*4+ch];
  };
  for(let y=targetTop;y<=targetBottom;y++){
    const sourceY=bbox.top+((y-targetTop+.5)*scale)-.5;
    const sy0=Math.floor(sourceY),sy1=sy0+1,t=sourceY-sy0;
    for(let x=bbox.left;x<=bbox.right;x++){
      const px0=clamp(sy0,0,h-1),px1=clamp(sy1,0,h-1);
      const k0=(px0*w+x)*4,k1=(px1*w+x)*4,k=(y*w+x)*4;
      const l0=(edited[k0]+edited[k0+1]+edited[k0+2])/3;
      const l1=(edited[k1]+edited[k1+1]+edited[k1+2])/3;
      const darkness=Math.max(0,paper-(l0*(1-t)+l1*t));
      const alpha=clamp((darkness-17)/Math.max(1,paper-70),0,1);
      if(alpha<.015)continue;
      const bg=bgCache.get(y*w+x)||candidateBackground(x,y);
      if(!bg)return null;
      // Preserve natural gray ink instead of painting an artificially black
      // replacement, while avoiding multiple draws of the same character.
      for(let ch=0;ch<3;ch++){
        const inkValue=Math.min(interpolate(x,Math.round(sourceY),ch),Math.round(paper*.42));
        out[k+ch]=Math.round(bg[ch]*(1-alpha)+inkValue*alpha);
      }
    }
  }
  return {bytes:out,before:resultMetrics.height,after:sourceMetrics.height,
    filled:bgCache.size,originalHeight:sourceMetrics.height};
}
