import assert from 'node:assert/strict';
import sharp from 'sharp';
import {reviseDesignRegion} from '../src/ai-image-design.js';

// Deterministic in-memory mock: regression tests must never send photos to external APIs.
process.env.OPENAI_API_KEY='test-key-only';
const W=180,H=110;
const source=await sharp({
  create:{width:W,height:H,channels:4,background:{r:215,g:225,b:235,alpha:1}}
}).png().toBuffer();
const aiOutput=await sharp({
  create:{width:1024,height:1024,channels:4,background:{r:45,g:125,b:65,alpha:1}}
}).png().toBuffer();
const originalFetch=globalThis.fetch;
globalThis.fetch=async()=>new Response(JSON.stringify({data:[{b64_json:aiOutput.toString('base64')}]}),{
  status:200,headers:{'content-type':'application/json'}
});
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
  const flatDark=await sharp({create:{width:1024,height:1024,channels:4,background:{r:2,g:2,b:2,alpha:1}}}).png().toBuffer();
  globalThis.fetch=async()=>new Response(JSON.stringify({data:[{b64_json:flatDark.toString('base64')}]}),{status:200});
  await assert.rejects(
    ()=>reviseDesignRegion(source,{x:25,y:20,w:50,h:30},'Edit graphic'),
    /검은 단색 영역/
  );
  globalThis.fetch=async()=>new Response(JSON.stringify({data:[{b64_json:aiOutput.toString('base64')}]}),{status:200});
  // A fully transparent response must never be delivered as a black patch.
  const transparent=await sharp({create:{width:1024,height:1024,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).png().toBuffer();
  globalThis.fetch=async()=>new Response(JSON.stringify({data:[{b64_json:transparent.toString('base64')}]}),{status:200});
  await assert.rejects(()=>reviseDesignRegion(source,{x:25,y:20,w:50,h:30},'Retouch design detail'),/투명 영역/);
  globalThis.fetch=async()=>new Response(JSON.stringify({data:[{b64_json:aiOutput.toString('base64')}]}),{status:200});
  await assert.rejects(()=>reviseDesignRegion(source,{x:W-2,y:1,w:20,h:20},'test'),/수정 영역/);
  console.log('PASS: boundaries, isolated composite, dimensions, and invalid selection');
}finally{
  globalThis.fetch=originalFetch;
}
