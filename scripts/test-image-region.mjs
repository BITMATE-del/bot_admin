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
  console.log('PASS: boundaries, isolated composite, text-style retry rejection, dimensions, and invalid selection');
}finally{
  globalThis.fetch=originalFetch;
}
