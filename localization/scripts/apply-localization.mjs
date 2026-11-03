import fs from 'node:fs/promises';
import path from 'node:path';
import ts from 'typescript';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import { kitRoot as kit, projectRoot as root } from './paths.mjs';
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
const plannedWrites=[];
for(const [relative,edits] of groups){
 const file=path.join(root,relative);
 const original=await fs.readFile(file,'utf8');
 let source=original;
 const parsed=ts.createSourceFile(file,original,ts.ScriptTarget.Latest,true,file.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);const suffixNodes=new Set();
 const currentNodes=new Map();
 function normJSX(s){const lines=s.replace(/\r/g,'').split('\n');let last=0;for(let i=0;i<lines.length;i++)if(/[^ \t]/.test(lines[i]))last=i;return lines.map((line,i)=>{let value=line.replace(/\t/g,' ');if(i!==0)value=value.replace(/^ +/,'');if(i!==lines.length-1)value=value.replace(/ +$/,'');return value&&(i!==last)?value+' ':value;}).join('');}
 function currentValue(n){if(ts.isJsxText(n))return normJSX(n.getText(parsed));if(ts.isTemplateExpression(n)){let value=n.head.text;let index=0;for(const span of n.templateSpans)value+=`{{v${index++}}}`+span.literal.text;return value;}return n.text;}
 function indexCurrentNodes(n){if(ts.isJsxText(n)||ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isTemplateExpression(n))currentNodes.set(`${n.getStart(parsed)}:${n.end}`,currentValue(n).trim());ts.forEachChild(n,indexCurrentNodes);}indexCurrentNodes(parsed);
 const verifiedEdits=edits.filter(row=>currentNodes.get(`${row.start}:${row.end}`)===row.english);
 if(verifiedEdits.length===0)continue;
 const templateNodes=new Map();function scanTemplates(n){if(ts.isTemplateExpression(n))templateNodes.set(n.getStart(parsed),n);ts.forEachChild(n,scanTemplates);}scanTemplates(parsed);
 function suffixScan(n){if(ts.isConditionalExpression(n)&&ts.isStringLiteral(n.whenTrue)&&ts.isStringLiteral(n.whenFalse)&&[n.whenTrue.text,n.whenFalse.text].includes('')&&[n.whenTrue.text,n.whenFalse.text].some(v=>v==='s'||v==='es')&&/(?:===|!==|==|!=|>|<)\s*1\b/.test(n.condition.getText(parsed))){for(const branch of [n.whenTrue,n.whenFalse])if(branch.text)suffixNodes.add(branch.getStart(parsed));}ts.forEachChild(n,suffixScan);}suffixScan(parsed);
 function renderRange(start,end){let text=original.slice(start,end);const selected=[];let outerEnd=-1;for(const row of verifiedEdits.filter(x=>x.start>=start&&x.end<=end).sort((a,b)=>a.start-b.start||b.end-a.end)){if(row.start>=outerEnd){selected.push(row);outerEnd=row.end;}}for(const row of selected.reverse())text=text.slice(0,row.start-start)+render(row)+text.slice(row.end-start);return text;}
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
 const missingImports=[];
 if(!/import\s*\{[^}]*\bl10n\b[^}]*\}\s*from\s*["'][^"']*i18n["']/s.test(source))missingImports.push('l10n');
 if(source.includes('englishPluralSuffix(')&&!/import\s*\{[^}]*\benglishPluralSuffix\b[^}]*\}\s*from\s*["'][^"']*i18n["']/s.test(source))missingImports.push('englishPluralSuffix');
 const importLine=missingImports.length?`import { ${missingImports.join(', ')} } from ${JSON.stringify(imp)};\n`:'';
 const directives=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);let insertion=0;
 for(const statement of directives.statements){if(ts.isExpressionStatement(statement)&&ts.isStringLiteral(statement.expression))insertion=statement.end;else break;}
 if(importLine)source=insertion?source.slice(0,insertion)+';\n'+importLine+source.slice(insertion):importLine+source;
 const ast=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
 if(ast.parseDiagnostics.length)throw Error(`Invalid syntax ${relative}: `+ast.parseDiagnostics.map(d=>ts.flattenDiagnosticMessageText(d.messageText,' ')).join('; '));
 plannedWrites.push({file,source});
 report.push({file:relative,occurrences:verifiedEdits.length,before:createHash('sha256').update(original).digest('hex'),after:createHash('sha256').update(source).digest('hex')});
}
for(const item of plannedWrites)await fs.writeFile(item.file,item.source);
await fs.writeFile(path.join(kit,'integration/applied-files.json'),JSON.stringify(report,null,2));
await fs.writeFile(path.join(kit,'integration/protected-occurrences.json'),JSON.stringify(skipped,null,2));
console.log(JSON.stringify({files:report.length,occurrences:report.reduce((s,r)=>s+r.occurrences,0),protected:skipped.length}));
