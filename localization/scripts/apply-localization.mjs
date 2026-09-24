import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import { currentSourceBackupRoot, kitRoot as kit, projectRoot as root } from './paths.mjs';
execFileSync('git',['-C',root,'rev-parse','--show-toplevel'],{encoding:'utf8'});
const rows=JSON.parse(await fs.readFile(path.join(kit,'integration/occurrences.json'),'utf8'));
const groups=new Map();
const skipped=[];
const excluded=new Set();
for(const file of await fs.readdir(path.join(kit,'integration'))){if(/exclusions.*\.json$/.test(file)){const data=JSON.parse(await fs.readFile(path.join(kit,'integration',file),'utf8'));for(const r of data)excluded.add(r.key);}}
for(const r of rows){
 if((r.sourceFile==='ui/src/lib/skill-create.ts'&&['New Skill','Describe when agents should use this skill.'].includes(r.english))||(r.sourceFile==='ui/src/pages/RoutineDetail.tsx'&&r.sourceContext==='display-variable'&&r.english==='{{v0}}-{{v1}}')){skipped.push({...r,reason:'Generated skill content or trigger identifier, not interface copy'});continue;}
 if(excluded.has(r.key)||/^(?:\[\d\d:\d\d(?::\d\d)?\]|--[\w-]|(?:npx|pnpm|npm|node|curl|git|codex|claude|bash|powershell|python)\s+[-\w./]|[A-Z_]{3,}=)/.test(r.english)||/^(?:bg-|text-|border-|flex |grid |inline-flex |font-|w-\d|h-\d)/.test(r.english)||r.sourceFile.endsWith('/LanguageSwitcher.tsx')||(r.sourceFile==='ui/src/pages/IssueDetail.tsx'&&['Assignee','Originating'].includes(r.english)&&r.sourceContext==='jsx-attribute')) {skipped.push({...r,reason:'Protected literal, code example, or stable attribution identifier'});continue;}
 const list=groups.get(r.sourceFile)??[];list.push(r);groups.set(r.sourceFile,list);
}
const report=[];
async function restoreNoLongerTranslated(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isDirectory())await restoreNoLongerTranslated(p);else{const relative=path.relative(currentSourceBackupRoot,p).replaceAll('\\','/');if(!groups.has(relative))await fs.copyFile(p,path.join(root,relative));}}}
try{await restoreNoLongerTranslated(currentSourceBackupRoot);}catch(e){if(e.code!=='ENOENT')throw e;}
for(const [relative,edits] of groups){
 const file=path.join(root,relative);
 const backup=path.join(currentSourceBackupRoot,relative);
 let original;
 try{original=await fs.readFile(backup,'utf8');}catch{original=await fs.readFile(file,'utf8');await fs.mkdir(path.dirname(backup),{recursive:true});await fs.writeFile(backup,original);}
 let source=original;
 const parsed=ts.createSourceFile(file,original,ts.ScriptTarget.Latest,true,file.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);const suffixNodes=new Set();
 const templateNodes=new Map();function scanTemplates(n){if(ts.isTemplateExpression(n))templateNodes.set(n.getStart(parsed),n);ts.forEachChild(n,scanTemplates);}scanTemplates(parsed);
 function suffixScan(n){if(ts.isConditionalExpression(n)&&ts.isStringLiteral(n.whenTrue)&&ts.isStringLiteral(n.whenFalse)&&[n.whenTrue.text,n.whenFalse.text].includes('')&&[n.whenTrue.text,n.whenFalse.text].some(v=>v==='s'||v==='es')&&/(?:===|!==|==|!=|>|<)\s*1\b/.test(n.condition.getText(parsed))){for(const branch of [n.whenTrue,n.whenFalse])if(branch.text)suffixNodes.add(branch.getStart(parsed));}ts.forEachChild(n,suffixScan);}suffixScan(parsed);
 function renderRange(start,end){let text=original.slice(start,end);const selected=[];let outerEnd=-1;for(const row of edits.filter(x=>x.start>=start&&x.end<=end).sort((a,b)=>a.start-b.start||b.end-a.end)){if(row.start>=outerEnd){selected.push(row);outerEnd=row.end;}}for(const row of selected.reverse())text=text.slice(0,row.start-start)+render(row)+text.slice(row.end-start);return text;}
 function render(r){
  const template=templateNodes.get(r.start);
  const params=r.expressions.length?', {'+r.expressions.map((e,i)=>{const node=template?.templateSpans[i]?.expression;const nested=node?renderRange(node.getStart(parsed),node.end):e;return `v${i}: (${/\?\s*["'](?:s|es)?["']\s*:\s*["'](?:s|es)?["']\s*$/.test(e)?`englishPluralSuffix(${nested})`:nested})`;}).join(', ')+'}':'';
  let call=`l10n(${JSON.stringify(r.key)}${params})`;
  if(suffixNodes.has(r.start))call=`englishPluralSuffix(${JSON.stringify(r.english)})`;
  if(r.sourceContext!=='jsx-text'&&(r.prefix||r.suffix))call='('+[r.prefix?JSON.stringify(r.prefix):null,call,r.suffix?JSON.stringify(r.suffix):null].filter(Boolean).join(' + ')+')';
  let replacement=call;
  if(r.sourceContext==='jsx-attribute')replacement=`{${call}}`;
  if(r.sourceContext==='jsx-text')replacement=(r.prefix?'{" "}':'')+`{${call}}`+(r.suffix?'{" "}':'');
  return replacement;
 }
 source=renderRange(0,original.length);
 let imp=path.relative(path.dirname(file),path.join(root,'ui/src/i18n')).replaceAll('\\','/');if(!imp.startsWith('.'))imp='./'+imp;
 const importLine=`import { l10n${source.includes('englishPluralSuffix(')?', englishPluralSuffix':''} } from ${JSON.stringify(imp)};\n`;
 const directives=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);let insertion=0;
 for(const statement of directives.statements){if(ts.isExpressionStatement(statement)&&ts.isStringLiteral(statement.expression))insertion=statement.end;else break;}
 source=insertion?source.slice(0,insertion)+';\n'+importLine+source.slice(insertion):importLine+source;
 const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
 if(ast.parseDiagnostics.length)throw Error(`Invalid syntax ${relative}: `+ast.parseDiagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,' ')).join('; '));
 await fs.writeFile(file,source);
 report.push({file:relative,occurrences:edits.length,before:createHash('sha256').update(original).digest('hex'),after:createHash('sha256').update(source).digest('hex')});
}
await fs.writeFile(path.join(kit,'integration/applied-files.json'),JSON.stringify(report,null,2));
await fs.writeFile(path.join(kit,'integration/protected-occurrences.json'),JSON.stringify(skipped,null,2));
console.log(JSON.stringify({files:report.length,occurrences:report.reduce((s,r)=>s+r.occurrences,0),protected:skipped.length}));
