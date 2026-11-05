import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../public/index.html',import.meta.url),'utf8');
const found=[...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)];
if(!found.length)throw new Error('No inline UI script found');
for(const [,source] of found)new vm.Script(source,{filename:'public/index.html (inline script)'});
console.log('UI scripts OK');
