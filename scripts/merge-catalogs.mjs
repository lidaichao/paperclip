import fs from 'node:fs/promises';
import path from 'node:path';
const kit=path.resolve('H:/AIagent/Luna/tools/paperclip-zh-cn');
const root=path.resolve('H:/AIagent/Luna/tools/paperclip-source');
const en=JSON.parse(await fs.readFile(path.join(kit,'locale/en/catalog.json'),'utf8'));
const entities={ldquo:'“',rdquo:'”',rsquo:'’',apos:"'",quot:'"',lt:'<',gt:'>',middot:'·',rarr:'→',rsaquo:'›',times:'×',amp:'&',hellip:'…'};
function decode(s){return s.replace(/&([a-z]+);/g,(whole,key)=>entities[key]??whole);}
for(const key of Object.keys(en))en[key]=decode(en[key]);
const translated={};
for(let i=0;i<3;i++){try{Object.assign(translated,JSON.parse(await fs.readFile(path.join(kit,`locale/zh-CN/shard-${i}.json`),'utf8')));}catch(e){if(e.code!=='ENOENT')throw e;}}
for(let i=0;i<3;i++){try{Object.assign(translated,JSON.parse(await fs.readFile(path.join(kit,`locale/zh-CN/extra-${i}.json`),'utf8')));}catch(e){if(e.code!=='ENOENT')throw e;}}
for(let i=0;i<3;i++){try{Object.assign(translated,JSON.parse(await fs.readFile(path.join(kit,`locale/zh-CN/final-${i}.json`),'utf8')));}catch(e){if(e.code!=='ENOENT')throw e;}}
try{const manual=JSON.parse(await fs.readFile(path.join(kit,'integration/manual-messages.json'),'utf8'));for(const [key,pair] of Object.entries(manual)){en['local.manual_'+key]=pair[0];translated['local.manual_'+key]=pair[1];}}catch(e){if(e.code!=='ENOENT')throw e;}
try{Object.assign(translated,JSON.parse(await fs.readFile(path.join(kit,'locale/zh-CN/supplement.json'),'utf8')));}catch(e){if(e.code!=='ENOENT')throw e;}
const editorial={"Most agents":"智能体数最多","Unfiled":"未分类","View profile":"查看个人资料","Edit profile":"编辑个人资料"};
for(const [key,english] of Object.entries(en))if(editorial[english])translated[key]=editorial[english];
const missing=Object.keys(en).filter(k=>!(k in translated));
if(missing.length&&!process.argv.includes('--preview'))throw Error(`${missing.length} untranslated entries remain`);
const zh=Object.fromEntries(Object.entries(en).map(([k,v])=>[k,translated[k]??v]));
for(const key of Object.keys(zh))zh[key]=decode(zh[key]);
function nested(flat){return Object.fromEntries(Object.entries(flat).map(([k,v])=>[k.replace(/^local\./,''),v]));}
for(const [locale,flat] of [['en',en],['zh-CN',zh]]){
 const target=path.join(root,`ui/src/i18n/locales/${locale}.json`);
 const base=JSON.parse(await fs.readFile(target,'utf8'));base.local=nested(flat);
 await fs.writeFile(target,JSON.stringify(base,null,2)+'\n');
}
await fs.writeFile(path.join(kit,'locale/zh-CN/catalog.json'),JSON.stringify(zh,null,2)+'\n');
await fs.writeFile(path.join(root,'ui/src/i18n/display-keys.json'),JSON.stringify(Object.fromEntries(Object.entries(en).map(([k,v])=>[v.toLowerCase(),k])),null,2)+'\n');
await fs.copyFile(path.join(kit,'integration/mdx-messages.json'),path.join(root,'ui/src/i18n/editor-messages.json'));
console.log(JSON.stringify({total:Object.keys(en).length,translated:Object.keys(translated).length,missing:missing.length,preview:missing.length>0}));
