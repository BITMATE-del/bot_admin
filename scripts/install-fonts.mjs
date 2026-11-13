// Fetch publicly licensed Korean font faces during the Railway Docker build.
// Source: https://github.com/google/fonts/tree/main/ofl
// Each family must provide an OFL.txt file. No downloaded binaries are committed.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const families=[
 ['nanummyeongjo','Nanum Myeongjo','serif'],['gowunbatang','Gowun Batang','serif'],
 ['songmyung','Song Myung','serif'],['hahmlet','Hahmlet','serif'],
 ['notoserifkr','Noto Serif KR','serif'],['nanumgothic','Nanum Gothic','sans'],
 ['gothica1','Gothic A1','sans'],['gowundodum','Gowun Dodum','sans'],
 ['ibmplexsanskr','IBM Plex Sans KR','sans'],['blackhansans','Black Han Sans','display'],
 ['dohyeon','Do Hyeon','display'],['jua','Jua','display'],
 ['nanumbrushscript','Nanum Brush Script','brush'],['nanumpenscript','Nanum Pen Script','handwriting'],
 ['gaegu','Gaegu','handwriting'],['gamjaflower','Gamja Flower','handwriting'],
 ['poorstory','Poor Story','handwriting'],['gugi','Gugi','brush'],
 ['yeonsung','Yeon Sung','handwriting'],['stylish','Stylish','handwriting'],
 ['sunflower','Sunflower','serif'],['himelody','Hi Melody','handwriting'],
 ['cuteFont','Cute Font','handwriting'],['eastseadokdo','East Sea Dokdo','brush'],
 ['dokdo','Dokdo','brush'],['kiranghaerang','Kirang Haerang','display']
];
const output='/usr/local/share/fonts/korean-curated';
const manifest='/app/src/font-library.generated.json';
const MAX_FILE=20000000, TIMEOUT=18000;
const get=async(url)=>{
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),TIMEOUT);
 try {
  const res=await fetch(url,{signal:controller.signal,headers:{'User-Agent':'bitmate-font-catalog/1.0','Accept':'application/vnd.github+json'}});
  if(!res.ok)throw Error('HTTP '+res.status+' '+url);
  return res;
 }finally{clearTimeout(timer);}
};
const isFont=bytes=>{
 const sig=bytes.subarray(0,4).toString('ascii');
 return sig==='OTTO'||sig==='ttcf'||sig==='true'||bytes.readUInt32BE(0)===0x00010000;
};
await mkdir(output,{recursive:true});
const results=[];
for(const [slug0,family,category] of families){
 const slug=slug0.toLowerCase();
 try {
  const api='https://api.github.com/repos/google/fonts/contents/ofl/'+slug;
  const entries=await (await get(api)).json();
  if(!Array.isArray(entries))throw Error('directory not found');
  const license=entries.find(f=>f.name==='OFL.txt');
  if(!license)throw Error('OFL license missing');
  const licenseText=await (await get(license.download_url)).text();
  if(!/SIL OPEN FONT LICENSE/i.test(licenseText))throw Error('unexpected license');
  const fontFiles=entries.filter(f=>/\.(ttf|otf)$/i.test(f.name)&&f.download_url)
    .sort((a,b)=>{
      const rank=n=>/regular|\[wght\]/i.test(n)?0:/light/i.test(n)?1:/bold/i.test(n)?2:3;
      return rank(a.name)-rank(b.name);
    }).slice(0,3);
  let downloaded=0;
  for(const file of fontFiles){
    if(file.size>MAX_FILE)continue;
    const bytes=Buffer.from(await (await get(file.download_url)).arrayBuffer());
    if(!isFont(bytes)||bytes.length>MAX_FILE)throw Error('invalid or oversized font');
    const name=slug+'-'+file.name.replace(/[^a-zA-Z0-9._\-\[\]]/g,'_');
    await writeFile(path.join(output,name),bytes);
    downloaded++;
  }
  if(!downloaded)throw Error('no supported faces');
  await writeFile(path.join(output,slug+'-OFL.txt'),licenseText);
  results.push({family,category,faces:downloaded,source:api,license:'OFL-1.1'});
  console.log('FONT_OK',family,downloaded);
 }catch(err){console.warn('FONT_SKIP',family,String(err?.message||err).slice(0,170));}
}
await writeFile(manifest,JSON.stringify({source:'google/fonts',license:'OFL-1.1',families:results},null,2));
console.log('FONT_LIBRARY_SUMMARY',JSON.stringify({
 families:results.length,faces:results.reduce((s,f)=>s+f.faces,0),
 requested:families.length
}));
if(results.length<8)throw Error('font library download insufficient: '+results.length+' families; preserving previous deployment');
