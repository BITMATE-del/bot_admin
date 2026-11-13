import assert from 'node:assert/strict';
import sharp from 'sharp';

// Deterministic in-memory mock: regression tests must never send photos to external APIs.
process.env.OPENAI_API_KEY='test-key-only';
process.env.IMAGE_API_HOURLY_LIMIT='100'; // Mock-only runs; no external image calls.
const {reviseDesignRegion}=await import('../src/ai-image-design.js');
const W=180,H=110;
const source=await sharp({
  create:{width:W,height:H,channels:4,background:{r:215,g:225,b:235,alpha:1}}
}).png().toBuffer();
const aiOutput=await sharp({
  create:{width:1024,height:1024,channels:4,background:{r:45,g:125,b:65,alpha:1}}
}).png().toBuffer();
const originalFetch=globalThis.fetch;
let editRequestCount=0;
globalThis.fetch=async(_url,options)=>{
  editRequestCount++;
  assert.ok(['gpt-image-2.5-sunburst','gpt-image-2.5-flare','gpt-image-2.6-sunburst','gpt-image-2.6-flare','gpt-image-2'].includes(options.body.get('model')));
  assert.equal(options.body.get('quality'),'high');
  assert.equal(options.body.get('background'),'opaque');
  return new Response(JSON.stringify({data:[{b64_json:aiOutput.toString('base64')}]}),{
    status:200,headers:{'content-type':'application/json'}
  });
};
try{
  for(const selection of [{x:45,y:25,w:50,h:32},{x:0,y:0,w:35,h:25},{x:145,y:83,w:35,h:27},{x:80,y:60,w:8,h:8}]){
    const edited=await reviseDesignRegion(source,selection,'Retouch a small graphic detail');
    const {data:raw}=await sharp(edited).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    const {data:original}=await sharp(source).ensureAlpha().raw().toBuffer({resolveWithObject:true});
    let changed=0;
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
      const index=(y*W+x)*4;
      const differs=raw[index]!==original[index]||raw[index+1]!==original[index+1]||raw[index+2]!==original[index+2]||raw[index+3]!==original[index+3];
      const inside=x>=selection.x&&x<selection.x+selection.w&&y>=selection.y&&y<selection.y+selection.h;
      assert.ok(inside||!differs,'Detected an edit outside the selected rectangle');
      if(inside&&differs)changed++;
    }
    assert.ok(changed>0,'Selected region was not modified');
    const meta=await sharp(edited).metadata();
    assert.equal(meta.width,W);assert.equal(meta.height,H);
  }
  assert.equal(editRequestCount,4,'Each distinct test edit should make one image API request');
  // Regression: wide and tall images must preserve output dimensions and
  // never modify pixels outside the selected source-image coordinates.
  for(const [ww,hh,sel] of [
    [420,95,{x:190,y:28,w:34,h:21}],
    [95,420,{x:23,y:175,w:26,h:44}]
  ]){
    const fixture=await sharp({create:{width:ww,height:hh,channels:4,background:{r:215,g:225,b:235,alpha:1}}}).png().toBuffer();
    const out=await reviseDesignRegion(fixture,sel,'Retouch a small graphic detail');
    const [before,after]=await Promise.all([
      sharp(fixture).ensureAlpha().raw().toBuffer(),
      sharp(out).ensureAlpha().raw().toBuffer()
    ]);
    let altered=0;
    for(let yy=0;yy<hh;yy++)for(let xx=0;xx<ww;xx++){
      const i=(yy*ww+xx)*4;
      const changed=before[i]!==after[i]||before[i+1]!==after[i+1]||before[i+2]!==after[i+2];
      const inside=xx>=sel.x&&xx<sel.x+sel.w&&yy>=sel.y&&yy<sel.y+sel.h;
      assert.ok(inside||!changed,'Edit leaked outside selected coordinates on a rectangular canvas');
      if(changed)altered++;
    }
    assert.ok(altered>0,'Expected a change inside selected coordinates');
  }
  const flatDark=await sharp({create:{width:1024,height:1024,channels:4,background:{r:2,g:2,b:2,alpha:1}}}).png().toBuffer();
  globalThis.fetch=async()=>new Response(JSON.stringify({data:[{b64_json:flatDark.toString('base64')}]}),{status:200});
  await assert.rejects(
    ()=>reviseDesignRegion(source,{x:25,y:20,w:50,h:30},'Edit graphic'),
    /검은색으로 지워/
  );
  // Regression: a black masked result gets one unmasked retry. A valid
  // second result is accepted without touching pixels outside the selection.
  let fallbackCalls=0;
  globalThis.fetch=async(_url,options)=>{
    fallbackCalls++;
    assert.equal(Boolean(options.body.get('mask')),fallbackCalls===1,
      'Retry must omit mask only after the failed masked attempt');
    return new Response(JSON.stringify({data:[{
      b64_json:(fallbackCalls===1?flatDark:aiOutput).toString('base64')
    }]}),{status:200});
  };
  const fallbackSelection={x:25,y:20,w:50,h:30};
  const recovered=await reviseDesignRegion(source,fallbackSelection,'Retouch a small graphic detail');
  assert.equal(fallbackCalls,2,'Black result should trigger exactly one unmasked retry');
  const [recoveredData,sourceData]=await Promise.all([
    sharp(recovered).ensureAlpha().raw().toBuffer(),
    sharp(source).ensureAlpha().raw().toBuffer()
  ]);
  for(let yy=0;yy<H;yy++)for(let xx=0;xx<W;xx++){
    const i=(yy*W+xx)*4;
    const inside=xx>=fallbackSelection.x&&xx<fallbackSelection.x+fallbackSelection.w
      &&yy>=fallbackSelection.y&&yy<fallbackSelection.y+fallbackSelection.h;
    if(!inside)assert.deepEqual(
      [...recoveredData.subarray(i,i+4)],[...sourceData.subarray(i,i+4)],
      'Unmasked retry must not alter pixels outside the selected rectangle');
  }
  globalThis.fetch=async()=>new Response(JSON.stringify({data:[{b64_json:aiOutput.toString('base64')}]}),{status:200});
  // A fully transparent response must never be delivered as a black patch.
  const transparent=await sharp({create:{width:1024,height:1024,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png().toBuffer();
  globalThis.fetch=async()=>new Response(JSON.stringify({data:[{b64_json:transparent.toString('base64')}]}),{status:200});
  await assert.rejects(()=>reviseDesignRegion(source,{x:25,y:20,w:50,h:30},'Retouch design detail'),/투명 영역/);
  globalThis.fetch=async()=>new Response(JSON.stringify({data:[{b64_json:aiOutput.toString('base64')}]}),{status:200});
  await assert.rejects(()=>reviseDesignRegion(source,{x:W-2,y:1,w:20,h:20},'test'),/수정 영역/);
  // A label on a plain panel should not accept a full-area color replacement.
  const labelSvg=Buffer.from('<svg width="180" height="110" xmlns="http://www.w3.org/2000/svg"><rect width="180" height="110" fill="#d7e1eb"/><text x="30" y="54" font-size="27" fill="#212121" font-family="sans-serif">Menu</text></svg>');
  const labeled=await sharp(labelSvg).png().toBuffer();
  const greenOutput=await sharp({create:{width:1024,height:1024,channels:4,background:{r:45,g:125,b:65,alpha:1}}}).png().toBuffer();
  let qualityCalls=0;
  globalThis.fetch=async()=>{
    qualityCalls++;
    return new Response(JSON.stringify({data:[{b64_json:greenOutput.toString('base64')}]}),{status:200});
  };
  await assert.rejects(
    ()=>reviseDesignRegion(labeled,{x:20,y:20,w:95,h:45},'Edit label'),
    /텍스트 스타일 검수 실패|오른쪽 경계/
  );
  assert.ok(qualityCalls>=1&&qualityCalls<=2,'Bad output must be rejected with at most one quality retry');
  // Strict text replacement must NEVER use the image-generation endpoint.
  // A plain original rendered in an available face should match its source.
  const {replaceTextStrict}=await import('../src/strict-text-replace.js');
  const strictSvg=Buffer.from('<svg width="280" height="140" xmlns="http://www.w3.org/2000/svg"><rect width="280" height="140" fill="#ffffff"/><text x="140" y="76" font-family="Noto Serif CJK KR" font-size="38" fill="#191919" text-anchor="middle">박정현</text></svg>');
  const strictSource=await sharp(strictSvg).png().toBuffer();
  let strictApiCalls=0;
  globalThis.fetch=async()=>{strictApiCalls++;throw new Error('Unexpected AI image request');};
  const strictRect={x:20,y:32,w:240,h:60};
  const strictEdited=await replaceTextStrict(strictSource,strictRect,'박정현','바구리');
  assert.equal(strictApiCalls,0,'Strict text replacement must not invoke AI');
  const strictBefore=await sharp(strictSource).ensureAlpha().raw().toBuffer();
  const strictAfter=await sharp(strictEdited).ensureAlpha().raw().toBuffer();
  let strictChanged=0;
  for(let py=0;py<140;py++)for(let px=0;px<280;px++){
    const k=(py*280+px)*4;
    const changed=[0,1,2].some(ch=>strictBefore[k+ch]!==strictAfter[k+ch]);
    const inside=px>=strictRect.x&&px<strictRect.x+strictRect.w&&py>=strictRect.y&&py<strictRect.y+strictRect.h;
    if(changed){strictChanged++;assert.ok(inside,'Strict renderer changed an outside pixel');}
  }
  assert.ok(strictChanged>20,'Strict render should modify text');
  // A faint 2px outline around the OLD text must be erased before the
  // target is printed; it must not become a second ghost layer.
  const haloSvg=Buffer.from('<svg width="280" height="140" xmlns="http://www.w3.org/2000/svg"><rect width="280" height="140" fill="#fff"/><text x="140" y="76" font-family="Noto Serif CJK KR" font-size="38" stroke="#dedede" stroke-width="4" paint-order="stroke" fill="#191919" text-anchor="middle">박정현</text></svg>');
  const haloSource=await sharp(haloSvg).png().toBuffer();
  const haloOutput=await replaceTextStrict(haloSource,strictRect,'박정현','바구리');
  const cleanOutput=await sharp(strictEdited).ensureAlpha().raw().toBuffer();
  const haloData=await sharp(haloOutput).ensureAlpha().raw().toBuffer();
  let haloDifference=0,haloPixels=0;
  for(let py=40;py<89;py++)for(let px=35;px<245;px++){
    const k=(py*280+px)*4;
    for(let ch=0;ch<3;ch++){haloDifference+=Math.abs(haloData[k+ch]-cleanOutput[k+ch]);haloPixels++;}
  }
  assert.ok(haloDifference/haloPixels<5,
    'Light anti-aliased old glyph outlines must not survive as a second text layer');
  const texturedSvg=Buffer.from('<svg width="280" height="140" xmlns="http://www.w3.org/2000/svg"><defs><pattern id="p" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M-2 8L8 -2M2 10L10 2" stroke="#b7b7b7" stroke-width="2"/></pattern></defs><rect width="280" height="140" fill="#ddd"/><rect width="280" height="140" fill="url(#p)"/><text x="140" y="76" font-size="38" fill="#151515" text-anchor="middle">박정현</text></svg>');
  const texturedSource=await sharp(texturedSvg).png().toBuffer();
  const texturedEdited=await replaceTextStrict(texturedSource,strictRect,'박정현','바구리');
  const texturedBefore=await sharp(texturedSource).ensureAlpha().raw().toBuffer();
  const texturedAfter=await sharp(texturedEdited).ensureAlpha().raw().toBuffer();
  let texturedChanged=0,backgroundPreserved=0;
  for(let py=0;py<140;py++)for(let px=0;px<280;px++){
    const i=(py*280+px)*4;
    const changed=[0,1,2].some(ch=>texturedBefore[i+ch]!==texturedAfter[i+ch]);
    const inside=px>=strictRect.x&&px<strictRect.x+strictRect.w&&py>=strictRect.y&&py<strictRect.y+strictRect.h;
    if(changed){texturedChanged++;assert.ok(inside,'Patterned edit changed pixels outside selection');}
    if(inside&&!changed)backgroundPreserved++;
  }
  assert.ok(texturedChanged>20,'Periodic pattern should permit editing');
  // Golden reference: replacing a line on a repeating print texture must
  // resemble direct rendering of the SAME target face over a clean pattern.
  // This catches rectangular texture damage or conspicuous baseline drift.
  const expectedPattern=Buffer.from('<svg width="280" height="140" xmlns="http://www.w3.org/2000/svg"><defs><pattern id="p" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M-2 8L8 -2M2 10L10 2" stroke="#b7b7b7" stroke-width="2"/></pattern></defs><rect width="280" height="140" fill="#ddd"/><rect width="280" height="140" fill="url(#p)"/><text x="140" y="76" font-size="38" fill="#151515" font-family="Noto Sans CJK KR" text-anchor="middle">바구리</text></svg>');
  const expectedTextured=await sharp(expectedPattern).ensureAlpha().raw().toBuffer();
  let pixelsCompared=0,totalError=0;
  for(let py=strictRect.y;py<strictRect.y+strictRect.h;py++)
    for(let px=strictRect.x;px<strictRect.x+strictRect.w;px++){
      const k=(py*280+px)*4;
      totalError+=Math.abs(expectedTextured[k]-texturedAfter[k])
        +Math.abs(expectedTextured[k+1]-texturedAfter[k+1])
        +Math.abs(expectedTextured[k+2]-texturedAfter[k+2]);
      pixelsCompared+=3;
    }
  const fidelityError=totalError/pixelsCompared;
  console.info('strict patterned golden fidelity',JSON.stringify({meanRgbError:+fidelityError.toFixed(2)}));
  assert.ok(fidelityError<12,
    'Patterned text output diverged excessively from direct matching-font rendering');

  assert.ok(backgroundPreserved>1000,'Original pattern pixels must remain untouched');
  // Non-periodic texture is not inferable: avoid inventing a background.
  const randomBg=Buffer.alloc(280*140*4);
  let seed=1234567;
  for(let k=0;k<280*140;k++){
    seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const shade=130+seed%100;
    randomBg[k*4]=shade;randomBg[k*4+1]=shade;randomBg[k*4+2]=shade;randomBg[k*4+3]=255;
  }
  const randomPattern=await sharp(randomBg,{raw:{width:280,height:140,channels:4}}).png().toBuffer();
  await assert.rejects(
    ()=>replaceTextStrict(randomPattern,strictRect,'박정현','바구리'),
    /배경|서체|구분|글자/
  );
  assert.equal(strictApiCalls,0,'Strict replacement must never invoke AI');
  // Regression for the user's issue: background stays byte-identical while a
  // modern smooth font loses serif/brush tips. Detect typography regression,
  // not background texture, without calling any image-generation endpoint.
  const {assessTexturedInkStrokeContrast}=await import('../src/ai-image-design.js');
  const fw=220,fh=100;
  const serif=Buffer.alloc(fw*fh*4),sans=Buffer.alloc(fw*fh*4);
  for(let py=0;py<fh;py++)for(let px=0;px<fw;px++){
    const i=(py*fw+px)*4;
    for(const buf of [serif,sans]){buf[i]=215;buf[i+1]=215;buf[i+2]=215;buf[i+3]=255;}
  }
  const draw=(buf,px,py)=>{
    if(px<0||py<0||px>=fw||py>=fh)return;
    const i=(py*fw+px)*4;buf[i]=18;buf[i+1]=18;buf[i+2]=18;
  };
  for(let y=13;y<80;y+=16)for(let x=9;x<205;x+=18){
    for(let yy=y;yy<y+11;yy++)for(let xx=x;xx<x+10;xx++){
      draw(serif,xx,yy);draw(sans,xx,yy);
    }
    // Fine ink terminals on the same text body; missing in modern sans.
    for(let yy=y;yy<y+11;yy+=2)
      for(const xx of [x-2,x-1,x+10,x+11])draw(serif,xx,yy);
  }
  assert.match(
    assessTexturedInkStrokeContrast(serif,sans,fw,fh)||'',
    /획 끝|윤곽|필체|붓글씨 획 굵기/,
    'A smooth modern font must not pass as the original detailed serif face'
  );
  assert.equal(strictApiCalls,0,'Typography QA must not call the image-generation API');
  console.log('PASS: strict non-generative text, boundaries, isolated composite, text-style retry rejection, dimensions, and invalid selection');
}finally{
  globalThis.fetch=originalFetch;
}
