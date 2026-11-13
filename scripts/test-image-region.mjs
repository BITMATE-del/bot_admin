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
  // Verify actual curated font binaries were fetched during Docker build.
  // In local dev the manifest is absent; CI's Dockerfile creates it first.
  const {availableFontLibraryStats,availableFontFamilies}=await import('../src/strict-text-replace.js');
  if(process.env.REQUIRE_CURATED_FONTS==='1'){
    const library=availableFontLibraryStats();
    console.info('curated Korean font catalog verified',JSON.stringify(library));
    assert.ok(library.curatedFamilies>=20,'Must install 20+ licensed Korean font families');
    assert.ok(library.curatedFaces>=30,'Must install 30+ Korean font faces');
    assert.ok(availableFontFamilies().includes('Nanum Myeongjo'));
    assert.ok(availableFontFamilies().includes('Nanum Brush Script'));
  }
  // Changing Hangul character shapes must not silently change actual
  // glyph height, even when the font family and source point size match.
  const {matchTargetGlyphHeight}=await import('../src/strict-text-replace.js');
  const targetFitted=await matchTargetGlyphHeight(
    '허연선','Noto Serif CJK KR',400,27,220,80,21);
  assert.ok(targetFitted&&Math.abs(targetFitted.box.h-21)<=1,
    'Target text ink height must follow the original 21px glyph height');
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
  // Unit regression: faint anti-aliased old glyph near a dark stroke is
  // restored, but unrelated patterned/gray background pixels remain unchanged.
  const {restoreOldGlyphHalos}=await import('../src/strict-text-replace.js');
  const hw=30,hh=20,hregion=Buffer.alloc(hw*hh*4,255);
  const hm=new Uint8Array(hw*hh),hs=new Uint8Array(hw*hh);
  const darkIndex=10*hw+10,ghostIndex=10*hw+13,backgroundIndex=15*hw+25;
  for(let ch=0;ch<3;ch++){
    hregion[darkIndex*4+ch]=15;
    hregion[ghostIndex*4+ch]=220;
    hregion[backgroundIndex*4+ch]=220;
  }
  hm[darkIndex]=1;
  hs[darkIndex]=240;hs[ghostIndex]=35;hs[backgroundIndex]=35;
  const restoredResult=restoreOldGlyphHalos(hregion,hm,hs,{at:()=>[255,255,255]},hw,hh);
  assert.ok(restoredResult.restored>=2,'Old dark stroke and its faint ghost should be restored');
  assert.equal(restoredResult.base[ghostIndex*4],255,'Faint old text remnant must be erased');
  assert.equal(restoredResult.base[backgroundIndex*4],220,'Unrelated background texture must remain intact');
  assert.equal(hregion[ghostIndex*4],220,'Original input pixels must never be mutated');
  const texturedSvg=Buffer.from('<svg width="280" height="140" xmlns="http://www.w3.org/2000/svg"><defs><pattern id="p" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M-2 8L8 -2M2 10L10 2" stroke="#b7b7b7" stroke-width="2"/></pattern></defs><rect width="280" height="140" fill="#ddd"/><rect width="280" height="140" fill="url(#p)"/><text x="140" y="76" font-size="38" fill="#151515" font-family="Noto Sans CJK KR" text-anchor="middle">박정현</text></svg>');
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
  // Non-document typography QA: check top/bottom separately, even when
  // edited glyph height itself remains identical.
  const {assessLabelConsistency}=await import('../src/ai-image-design.js');
  const tw=70,th=40;
  const sourceLabel=new Uint8Array(tw*th*4).fill(255);
  const shiftedLabel=new Uint8Array(tw*th*4).fill(255);
  const drawBar=(target,top)=>{
    for(let yy=top;yy<top+14;yy++)for(let xx=15;xx<41;xx++){
      const k=(yy*tw+xx)*4;
      target[k]=55;target[k+1]=55;target[k+2]=55;
    }
  };
  drawBar(sourceLabel,12);drawBar(shiftedLabel,15);
  assert.equal(assessLabelConsistency(sourceLabel,sourceLabel,tw,th),null,
    'Unchanged label geometry should pass');
  assert.match(assessLabelConsistency(sourceLabel,shiftedLabel,tw,th)||'',
    /위아래 경계/,
    'A three-pixel vertical drift must not pass geometric QA');
  // Generic right-edge clipping detection: unchanged punctuation should
  // never trigger a false alarm, while newly cut-off ink still fails.
  const {detectNewRightEdgeInk}=await import('../src/ai-image-design.js');
  const rw=30,rh=20,white=new Uint8Array(rw*rh*4).fill(255);
  const withExisting=Uint8Array.from(white);
  for(let yy=4;yy<13;yy++)for(const xx of [rw-2,rw-1]){
    const k=(yy*rw+xx)*4;
    for(let ch=0;ch<3;ch++)withExisting[k+ch]=60;
  }
  assert.equal(detectNewRightEdgeInk(withExisting,withExisting,rw,rh,[255,255,255]),false,
    'Unmodified right-edge punctuation must never count as new clipping');
  assert.equal(detectNewRightEdgeInk(white,withExisting,rw,rh,[255,255,255]),true,
    'Actual newly clipped content at boundary must still be rejected');
  const isolated=Uint8Array.from(white);
  for(let ch=0;ch<3;ch++)isolated[((7*rw)+(rw-1))*4+ch]=25;
  assert.equal(detectNewRightEdgeInk(white,isolated,rw,rh,[255,255,255]),false,
    'Isolated border noise must not abort an otherwise valid image edit');
  // Printed-name ink height must be measured in pixels, not inferred
  // from the entire selection rectangle or the length of Hanja suffix.
  const {measurePrintedNameMetrics}=await import('../src/ai-image-design.js');
  const smallName=await sharp(Buffer.from('<svg width="190" height="78" xmlns="http://www.w3.org/2000/svg"><rect width="190" height="78" fill="#dcdcdc"/><text x="20" y="47" font-size="19" font-family="Noto Serif CJK KR" fill="#444">이용주</text></svg>')).ensureAlpha().raw().toBuffer();
  const largeName=await sharp(Buffer.from('<svg width="190" height="78" xmlns="http://www.w3.org/2000/svg"><rect width="190" height="78" fill="#dcdcdc"/><text x="20" y="49" font-size="27" font-family="Noto Serif CJK KR" fill="#444">허연선</text></svg>')).ensureAlpha().raw().toBuffer();
  const m1=measurePrintedNameMetrics(smallName,190,78);
  const m2=measurePrintedNameMetrics(largeName,190,78);
  console.info('name pixel metric regression',JSON.stringify({before:m1,after:m2}));
  assert.ok(m1&&m2&&m2.height>=m1.height+4,
    'Printed glyph metric must see a 19px -> 27px name enlargement');
  const {normalizePrintedNameInk}=await import('../src/printed-name-ink.js');
  const resizedName=normalizePrintedNameInk(smallName,largeName,190,78,m1,m2);
  assert.ok(resizedName,'Oversized AI name should be correctable on neutral printed paper');
  const adjusted=measurePrintedNameMetrics(resizedName.bytes,190,78);
  console.info('printed AI name scaling test',JSON.stringify({
    original:m1.height,generated:m2.height,corrected:adjusted?.height
  }));
  assert.ok(adjusted&&Math.abs(adjusted.height-m1.height)<=1,
    'AI generated Hangul text should be normalized to original ink pixel height');
  // The background outside the local old printed-name area is never changed.
  for(let y=0;y<78;y++)for(let x=120;x<190;x++){
    const i=(y*190+x)*4;
    assert.equal(resizedName.bytes[i],largeName[i],
      'Raster scale correction may not modify unaffected paper background');
  }
  // Tonal-only regression: the new name is deliberately much darker than
  // the original. Match its print tone without moving, resizing or changing
  // the surrounding paper or alpha channel.
  const {matchPrintedNameInkTone}=await import('../src/printed-name-ink.js');
  const darkName=Uint8Array.from(smallName);
  for(let y=m1.top;y<=m1.bottom;y++)for(let x=m1.left;x<=m1.right;x++){
    const k=(y*190+x)*4,avg=(smallName[k]+smallName[k+1]+smallName[k+2])/3;
    if(avg<175)for(let ch=0;ch<3;ch++)darkName[k+ch]=Math.max(0,smallName[k+ch]-34);
  }
  const darkMetrics=measurePrintedNameMetrics(darkName,190,78);
  assert.ok(darkMetrics,'Darkened input must remain a valid name image');
  const correctedTone=matchPrintedNameInkTone(smallName,darkName,190,78,m1,darkMetrics);
  assert.ok(correctedTone&&Math.max(...correctedTone.lift)>=20,
    'Darkened text should be lightened based on actual source ink');
  for(let y=0;y<78;y++)for(let x=0;x<190;x++){
    const k=(y*190+x)*4;
    if(x>=125){
      for(let ch=0;ch<4;ch++)assert.equal(correctedTone.bytes[k+ch],darkName[k+ch],
        'Tonal correction must not touch the paper background');
    }
    assert.equal(correctedTone.bytes[k+3],darkName[k+3],
      'Tonal correction must leave alpha unchanged');
  }
  const tonedMetrics=measurePrintedNameMetrics(correctedTone.bytes,190,78);
  assert.equal(tonedMetrics.height,darkMetrics.height,
    'Tonal correction must not change text glyph height');
  console.info('printed ink tone calibration regression',JSON.stringify({
    lift:correctedTone.lift,pixels:correctedTone.corrected,
    sourceHeight:m1.height,correctedHeight:tonedMetrics.height
  }));
  // Protect the parenthesized suffix as pixels, not merely with AI text.
  // The edit rectangle includes the name and Hanja; the name crop must stop
  // BEFORE the suffix, so all suffix pixels are guaranteed unchanged.
  const {isolateKoreanNameSelection}=await import('../src/image-bot.js');
  const suffixSvg=Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="115"><rect width="320" height="115" fill="#e7e7e7"/><text x="15" y="60" font-size="24" font-family="Noto Serif CJK KR" fill="#363636">이용주(李應宙)</text></svg>');
  const suffixSource=await sharp(suffixSvg).png().toBuffer();
  const wideSelection={x:5,y:27,w:250,h:55};
  const narrowed=await isolateKoreanNameSelection(suffixSource,wideSelection,'이용주','허연선');
  console.info('name suffix protection regression',JSON.stringify({input:wideSelection,result:narrowed}));
  assert.ok(narrowed.w<wideSelection.w*.68,
    'Clear Korean name + Hanja suffix should exclude suffix from AI editing area');
  assert.ok(narrowed.w>38,'Korean name edit area must still cover the full name');
  // Even if the image model paints over the closing parenthesis, preserve
  // every suffix pixel from the original scanned image after compositing.
  const {preserveOriginalNameSuffix}=await import('../src/image-bot.js');
  const damaged=await sharp(suffixSource).composite([{
    input:{create:{width:wideSelection.w-narrowed.w,height:wideSelection.h,
      channels:4,background:{r:255,g:255,b:255,alpha:1}}},
    left:wideSelection.x+narrowed.w,top:wideSelection.y
  }]).png().toBuffer();
  const restored=await preserveOriginalNameSuffix(
    suffixSource,damaged,wideSelection,narrowed
  );
  const beforeRaw=await sharp(suffixSource).ensureAlpha().raw().toBuffer();
  const afterRaw=await sharp(restored).ensureAlpha().raw().toBuffer();
  for(let y=wideSelection.y;y<wideSelection.y+wideSelection.h;y++)
    for(let x=wideSelection.x+narrowed.w;x<wideSelection.x+wideSelection.w;x++){
      const k=(y*320+x)*4;
      for(let ch=0;ch<4;ch++)assert.equal(afterRaw[k+ch],beforeRaw[k+ch],
        'Hanja and last closing parenthesis must stay pixel-identical');
    }
  console.info('protected Hanja suffix identical pixels',JSON.stringify({
    fromX:wideSelection.x+narrowed.w,width:wideSelection.w-narrowed.w
  }));
  // A typical user crop ends on the closing ')', not after generous
  // whitespace. Still isolate only the name; do not make the user reselect.
  const tightSuffixSelection={x:5,y:27,w:176,h:55};
  const tightResult=await isolateKoreanNameSelection(
    suffixSource,tightSuffixSelection,'이용주','허연선');
  console.info('tight parenthesized suffix isolation',JSON.stringify({
    input:tightSuffixSelection,result:tightResult
  }));
  assert.ok(tightResult.w<tightSuffixSelection.w-24,
    'Name crop must exclude Hanja even if the original suffix touches the right edge');
  assert.ok(tightResult.w>38,'Tight name crop must still include Korean letters');
  const keepFull=await isolateKoreanNameSelection(suffixSource,wideSelection,'이용주','허연선님');
  assert.deepEqual(keepFull,wideSelection,
    'Never guess cropped spans for replacement words with different character count');
  const {canFallbackToContextualTextEdit}=await import('../src/image-bot.js');
  assert.equal(canFallbackToContextualTextEdit(
    '원본 글씨체와 일치하는 서체를 찾지 못했어. 다른 글꼴을 새로 만들어 적용하지 않았고 이용권도 차감하지 않아.'),true,
    'Missing installed source font must NOT abort the edit');
  assert.equal(canFallbackToContextualTextEdit(
    '원본 배경 무늬를 정확하게 복원할 근거가 부족해.'),true,
    'Background modeling failure must use existing AI editor');
  assert.equal(canFallbackToContextualTextEdit(
    '수정 영역을 정확하게 선택해 줘.'),false,
    'Invalid user selection must not silently fall back');
  // Hanja labels and terminal punctuation are out-of-scope immutable glyphs.
  // Regression: requesting a Korean-name replacement must preserve an
  // untouched Hanja parenthetical suffix including the rightmost ')'.
  const {buildCharacterSafeEditInstruction}=await import('../src/image-bot.js');
  const protectedLabel=buildCharacterSafeEditInstruction('이용주','허연선',{x:5,y:5,w:170,h:42});
  assert.ok(protectedLabel.includes('exactly "이용주" with exactly "허연선"'));
  assert.ok(protectedLabel.includes('closing parenthesis )'));
  assert.ok(protectedLabel.includes('all Hanja characters'));
  assert.ok(protectedLabel.includes('glyph HEIGHT in pixels'));
  assert.ok(protectedLabel.includes('editing boundaries, NOT target glyph dimensions'));
  assert.ok(!protectedLabel.includes('Replace the entire selected area'));
  console.log('PASS: strict non-generative text, boundaries, isolated composite, text-style retry rejection, dimensions, and invalid selection');
}finally{
  globalThis.fetch=originalFetch;
}
