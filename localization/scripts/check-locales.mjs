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
const missing=[];let usages=0;let translatedFiles=0;
for(const file of await sourceFiles(path.join(root,'ui/src'))){
 const text=await fs.readFile(file,'utf8');
 let fileUsages=0;
 for(const match of text.matchAll(/\bl10n\(\s*["']local\.([^"' ]+)["']/g)){
  usages++;fileUsages++;
  if(!(match[1] in en.local))missing.push(`${path.relative(root,file)}: ${match[1]}`);
 }
 if(fileUsages>0)translatedFiles++;
}
if(translatedFiles===0||usages===0)throw Error('Localization coverage audit found zero source files or translated call sites. Check ui/src and the scanner before release.');
if(errors.length||missing.length)throw Error(JSON.stringify({errors,missing},null,2));
const count=Object.keys(en.local).length;
const unchanged=Object.keys(en.local).filter(key=>en.local[key]===zh.local[key]);
const report={passed:true,catalogEntries:count,sourceFiles:translatedFiles,translatedCallSites:usages,placeholderAndSafetyErrors:0,missingKeys:0,unchangedDisplayEntries:unchanged.length,note:'Source coverage requires the independent residual audit and browser checks; catalog completeness alone is not a full-interface claim.'};
if(!process.argv.includes('--audit-only'))await fs.writeFile(path.join(kit,'releases/locale-validation.json'),JSON.stringify(report,null,2));
console.log(JSON.stringify(report));
