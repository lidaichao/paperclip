import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import {createHash} from 'node:crypto';
import { currentSourceBackupRoot, kitRoot as kit, projectRoot as root } from './paths.mjs';
const read=async name=>JSON.parse(await fs.readFile(path.join(kit,name),'utf8'));
const reviewed=await read('integration/reviewed-extra.json');
const sourceMap=await read('integration/source-map.json');
const occurrences=await read('integration/occurrences.json');
const catalog=await read('locale/en/catalog.json');
const translations={};const positions=new Set(occurrences.map(x=>x.sourceFile+':'+x.start));
const files=new Map();let added=0;const missing=[];
function value(n){if(ts.isTemplateExpression(n)){let text=n.head.text,expressions=[];for(const span of n.templateSpans){text+='{{v'+expressions.length+'}}'+span.literal.text;expressions.push(span.expression.getText());}return {text,expressions};}return {text:n.text,expressions:[]};}
for(const r of reviewed){
 let sf=files.get(r.sourceFile);if(!sf){let source;try{source=await fs.readFile(path.join(currentSourceBackupRoot,r.sourceFile),'utf8');}catch{source=await fs.readFile(path.join(root,r.sourceFile),'utf8');}sf=ts.createSourceFile(r.sourceFile,source,ts.ScriptTarget.Latest,true,r.sourceFile.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);files.set(r.sourceFile,sf);}
 const matches=[];
 function visit(n){if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isTemplateExpression(n)){const data=value(n);const line=sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1;if(line===r.line&&data.text.trim()===r.english.trim())matches.push({n,data});}ts.forEachChild(n,visit);}visit(sf);
 if(matches.length!==1){missing.push({file:r.sourceFile,line:r.line,english:r.english,matches:matches.length});continue;}
 const {n,data}=matches[0];
 let key=sourceMap.find(x=>x.english===r.english)?.key;
 if(!key)key='local.'+r.english.toLowerCase().replace(/\{\{.*?\}\}/g,'value').replace(/[^a-z0-9]+/g,'_').slice(0,45).replace(/_$/,'')+'_'+createHash('sha256').update(r.english).digest('hex').slice(0,8);
 translations[key]=r.translation;catalog[key]=r.english;
 if(!sourceMap.some(x=>x.key===key))sourceMap.push({key,english:r.english,sourceFile:r.sourceFile,sourceContext:'reviewed-display',placeholders:data.expressions.map((_,i)=>'v'+i),locations:[r.sourceFile+':'+r.line]});
 if(positions.has(r.sourceFile+':'+n.getStart(sf)))continue;
 occurrences.push({key,english:r.english,sourceFile:r.sourceFile,line:r.line,sourceContext:ts.isJsxAttribute(n.parent)?'jsx-attribute':'reviewed-display',placeholders:data.expressions.map((_,i)=>'v'+i),start:n.getStart(sf),end:n.end,expressions:data.expressions,prefix:data.text.match(/^\s*/)[0],suffix:data.text.match(/\s*$/)[0],reviewReason:r.reason});positions.add(r.sourceFile+':'+n.getStart(sf));added++;
}
if(missing.length){await fs.writeFile(path.join(kit,'integration/reviewed-unmatched.json'),JSON.stringify(missing,null,2));throw Error(`${missing.length} reviewed entries do not match original source; inspect reviewed-unmatched.json`);}
for(const [name,data] of [['integration/source-map.json',sourceMap],['integration/occurrences.json',occurrences],['locale/en/catalog.json',catalog],['locale/zh-CN/supplement.json',translations]])await fs.writeFile(path.join(kit,name),JSON.stringify(data,null,2));
console.log(JSON.stringify({reviewed:reviewed.length,added,translated:Object.keys(translations).length}));
