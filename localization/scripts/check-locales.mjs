import fs from 'node:fs/promises';
import path from 'node:path';
import {stripTypeScriptTypes} from 'node:module';
import {kitRoot as kit, projectRoot as root} from './paths.mjs';
const read=async p=>JSON.parse(await fs.readFile(p,'utf8'));
const en=await read(path.join(root,'ui/src/i18n/locales/en.json'));
const zh=await read(path.join(root,'ui/src/i18n/locales/zh-CN.json'));
let validation=await fs.readFile(path.join(root,'ui/src/i18n/locale-validation.ts'),'utf8');
validation=validation.replace('import en from "./locales/en.json";',`const en=${JSON.stringify(en)};`);
const module=await import('data:text/javascript;base64,'+Buffer.from(stripTypeScriptTypes(validation)).toString('base64'));
const errors=module.validateLocaleMessages(zh,en);
// applied-files.json describes only the latest patch batch. An incremental
// pass can legitimately rewrite it to [], so it cannot measure total coverage.
async function sourceFiles(dir){
 const result=[];
 for(const entry of await fs.readdir(dir,{withFileTypes:true})){
  const file=path.join(dir,entry.name);
  if(entry.isDirectory()){
   if(!['__tests__','fixtures','i18n'].includes(entry.name))result.push(...await sourceFiles(file));
  }else if(/\.(?:tsx?|jsx?)$/.test(entry.name)&&!/(?:\.test|\.spec|\.stories|\.d)\./.test(entry.name))result.push(file);
 }
 return result;
}
// A key-only audit cannot see an entirely untranslated component. Keep this
// list small and grow it as each product surface is converted to l10n.
const literalGuardFiles=new Set([
 'ui/src/components/ProjectWorkRecords.tsx',
 'ui/src/components/WorkPackageConsole.tsx',
]);
const observedGuardFiles=new Set();
const unlocalizedUiLiterals=[];
function withoutComments(text){
 let state='code', quote='', output='';
 for(let i=0;i<text.length;i++){
  const char=text[i], next=text[i+1];
  if(state==='line'){
   if(char==='\n'){state='code';output+='\n';}else output+=' ';
  }else if(state==='block'){
   if(char==='*'&&next==='/'){state='code';output+='  ';i++;}
   else output+=char==='\n'?'\n':' ';
  }else if(state==='quote'){
   output+=char;
   if(char==='\\'&&next!==undefined){output+=next;i++;}
   else if(char===quote)state='code';
  }else if(char==='/'&&next==='/'){state='line';output+='  ';i++;}
  else if(char==='/'&&next==='*'){state='block';output+='  ';i++;}
  else if(char==='"'||char==="'"||char==='`'){state='quote';quote=char;output+=char;}
  else output+=char;
 }
 return output;
}
const missing=[];let usages=0;let translatedFiles=0;
for(const file of await sourceFiles(path.join(root,'ui/src'))){
 const text=await fs.readFile(file,'utf8');
 const relative=path.relative(root,file).split(path.sep).join('/');
 if(literalGuardFiles.has(relative)){
  observedGuardFiles.add(relative);
  const sourceNoComments=withoutComments(text);
  // These screens use status-to-key maps resolved at render time. Validate
  // the literal map values as well as direct translation calls below.
  for(const match of sourceNoComments.matchAll(/["']local\.([^"'\s]+)["']/g)){
   if(!(match[1] in en.local))missing.push(`${relative}: ${match[1]}`);
  }
  for(const [index,line] of sourceNoComments.split(/\r?\n/).entries()){
   if(/[\u3400-\u9fff]/u.test(line))
    unlocalizedUiLiterals.push(`${relative}:${index+1}: ${line.trim().slice(0,80)}`);
  }
 }
 let fileUsages=0;
 for(const match of text.matchAll(/\bl10n\(\s*["']local\.([^"' ]+)["']/g)){
  usages++;fileUsages++;
  if(!(match[1] in en.local))missing.push(`${path.relative(root,file)}: ${match[1]}`);
 }
 if(fileUsages>0)translatedFiles++;
}
if(translatedFiles===0||usages===0)throw Error('Localization coverage audit found zero source files or translated call sites. Check ui/src and the scanner before release.');
const missingUiGuardFiles=[...literalGuardFiles].filter(file=>!observedGuardFiles.has(file));
if(errors.length||missing.length||missingUiGuardFiles.length||unlocalizedUiLiterals.length)throw Error(JSON.stringify({errors,missing,missingUiGuardFiles,unlocalizedUiLiterals},null,2));
const count=Object.keys(en.local).length;
const unchanged=Object.keys(en.local).filter(key=>en.local[key]===zh.local[key]);
const report={passed:true,catalogEntries:count,sourceFiles:translatedFiles,translatedCallSites:usages,checkedUiLiteralFiles:literalGuardFiles.size,placeholderAndSafetyErrors:0,missingKeys:0,unlocalizedUiLiterals:0,unchangedDisplayEntries:unchanged.length,note:'Source coverage requires the independent residual audit and browser checks; catalog completeness alone is not a full-interface claim.'};
if(!process.argv.includes('--audit-only'))await fs.writeFile(path.join(kit,'releases/locale-validation.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
