import ts from 'typescript';
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
const root=path.resolve('H:/AIagent/Luna/tools/paperclip-source');
const kit=path.resolve('H:/AIagent/Luna/tools/paperclip-zh-cn');
const displayProps=new Set(['label','title','description','placeholder','aria-label','aria-description','alt','tooltip','helpText','helperText','emptyText','emptyMessage','loadingText','errorMessage','confirmLabel','cancelLabel','submitLabel','buttonLabel','searchPlaceholder','noResultsText','hint','subtitle','emptyDescription','loadingMessage','disabledReason','searchLabel','gets']);
const displayAttribute=(n)=>displayProps.has(n)||['body','detail','caption','explanation','summary'].includes(n)||/(?:Label|Text|Title|Description|Message|Hint)$/.test(n);
const machine=/^(?:https?:|[A-Za-z]:[\\/]|\/|\.{1,2}\/|#[\w-]+$|[\w-]+\.(?:json|ts|tsx|md|js|sh|exe)$|[A-Z][A-Z0-9_]{2,}$)/;
function human(s,display=false){return /[A-Za-z]/.test(s)&&s.length<2000&&!/^(?:https?:|[A-Za-z]:[\\/]|\/|\.{1,2}\/|--[\w-]|\[\d\d:\d\d\]|\s*\{[\s\S]*["':]|\s*<[\s\S]*>\s*$)/.test(s.trim())&&(display||(!machine.test(s.trim())&&!/^[a-z0-9_.:/-]+$/.test(s.trim())));}
function protectedContext(n,sf){for(let a=n.parent;a;a=a.parent){if(ts.isJsxElement(a)&&/^(?:code|pre|CodeBlock|SyntaxHighlighter|TerminalOutput)$/.test(a.openingElement.tagName.getText(sf)))return true;}return false;}
function normJSX(s){const lines=s.replace(/\r/g,'').split('\n');let last=0;for(let i=0;i<lines.length;i++)if(/[^ \t]/.test(lines[i]))last=i;return lines.map((line,i)=>{let s=line.replace(/\t/g,' ');if(i!==0)s=s.replace(/^ +/,'');if(i!==lines.length-1)s=s.replace(/ +$/,'');return s&&(i!==last)?s+' ':s;}).join('');}
function name(n,sf){return n?.getText(sf).replace(/^['"]|['"]$/g,'')??'';}
function enclosingDisplay(n,sf){
 let p=n.parent,cur=n;
 for(let i=0;p&&i<12;i++,cur=p,p=p.parent){
  if(ts.isJsxExpression(p)){const q=p.parent;if(ts.isJsxAttribute(q))return displayAttribute(name(q.name,sf));return true;}
  if(ts.isConditionalExpression(p)){if(cur===p.condition)return false;continue;}
  if(ts.isBinaryExpression(p)){if([ts.SyntaxKind.AmpersandAmpersandToken,ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind)){if(cur===p.left)return false;continue;}if(p.operatorToken.kind===ts.SyntaxKind.PlusToken)continue;return false;}
  if(ts.isParenthesizedExpression(p)||ts.isAsExpression(p)||ts.isTemplateSpan(p)||ts.isTemplateExpression(p))continue;
  return false;
 }
 return false;
}
function propIsDisplay(n,sf){
 const p=n.parent;if(!ts.isPropertyAssignment(p)||p.initializer!==n||!displayProps.has(name(p.name,sf)))return false;
 for(let a=p.parent;a;a=a.parent){
  if(ts.isCallExpression(a)){
   const call=a.expression.getText(sf);
   if(!/^(?:useMemo|useCallback|setBreadcrumbs|pushToast)$/.test(call)&&!/(?:\.map|\.flatMap)$/.test(call))return false;
  }
  if(ts.isVariableDeclaration(a)&&/prompt|payload|request|instructions|template|defaultIssue|defaultTask/i.test(a.name.getText(sf)))return false;
  if(ts.isArrowFunction(a)||ts.isFunctionDeclaration(a)||ts.isSourceFile(a))return true;
 }
 return false;
}
function contextFor(n,sf){
 if(ts.isJsxText(n))return 'jsx-text';
 if(ts.isJsxAttribute(n.parent)&&displayAttribute(name(n.parent.name,sf)))return 'jsx-attribute';
 if(enclosingDisplay(n,sf))return 'jsx-expression';
 if(propIsDisplay(n,sf))return 'display-property';
 let cur=n;while(cur.parent&&(ts.isParenthesizedExpression(cur.parent)||ts.isAsExpression(cur.parent)||(ts.isConditionalExpression(cur.parent)&&cur!==cur.parent.condition)||(ts.isBinaryExpression(cur.parent)&&cur===cur.parent.right&&[ts.SyntaxKind.BarBarToken,ts.SyntaxKind.QuestionQuestionToken].includes(cur.parent.operatorToken.kind))))cur=cur.parent;
 if(cur!==n&&propIsDisplay(cur,sf))return 'display-property';
 if(ts.isVariableDeclaration(cur.parent)&&/(?:Label|Title|Message|Description|Heading|Hint|Copy|Text|Caption|Summary|Detail|Explanation)$/i.test(cur.parent.name.getText(sf))&&!/prompt|command|payload|request|instructions|template/i.test(cur.parent.name.getText(sf)))return 'display-variable';
 if(ts.isPropertyAssignment(cur.parent)&&['body','message'].includes(name(cur.parent.name,sf))){let a=cur.parent.parent.parent;if(ts.isCallExpression(a)&&a.expression.getText(sf)==='pushToast')return 'ui-message';}
 if(ts.isPropertyAssignment(n.parent)&&n.parent.initializer===n){for(let a=n.parent;a;a=a.parent){if(ts.isVariableDeclaration(a)){if(/(?:Labels|DisplayNames|Verbs|Descriptions)$/i.test(a.name.getText(sf))||a.name.getText(sf)==='help')return 'display-property';break;}if(ts.isCallExpression(a)||ts.isFunctionLike(a))break;}}
 const p=n.parent;
 if(ts.isCallExpression(p)&&p.arguments.includes(n)){
  const callee=p.expression.getText(sf);
  if(/^(?:toast\.(?:success|error|info|warning)|alert|confirm|window\.confirm|set\w*(?:Error|Notice|Message|Toast))$/.test(callee))return 'ui-message';
 }
 if(ts.isVariableDeclaration(p)&&/(?:Label|Title|Message|Description|Heading)$/.test(p.name.getText(sf)))return 'display-variable';
 if(ts.isReturnStatement(p)){
  for(let a=p.parent;a;a=a.parent){if(ts.isFunctionDeclaration(a)||ts.isFunctionExpression(a)||ts.isArrowFunction(a)){
   const nm=a.name?.getText(sf)??(ts.isVariableDeclaration(a.parent)?a.parent.name.getText(sf):'');
   if(/(?:Label|Title|Description|Message|Summary|humanize|formatStatus|formatAction)/i.test(nm))return 'display-return';break;
  }}
 }
 return null;
}
async function files(dir){let out=[];for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory()){if(!['fixtures','i18n','api','__tests__'].includes(e.name))out.push(...await files(p));}else if(/\.(tsx?|jsx?)$/.test(e.name)&&!/(?:\.test|\.spec|\.stories|\.d)\./.test(e.name))out.push(p);}return out;}
function template(n,sf){if(ts.isTemplateExpression(n)){let text=n.head.text;const expressions=[];for(const span of n.templateSpans){text+=`{{v${expressions.length}}}`+span.literal.text;expressions.push(span.expression.getText(sf));}return {text,expressions};}return{text:n.text,expressions:[]};}
const entries=new Map();const occurrences=[];const residual=[];
const inputFiles=await files(path.join(root,'ui/src'));
for(const file of inputFiles){
 const relative=path.relative(root,file).replaceAll('\\','/');let source;try{source=await fs.readFile(path.join(kit,'integration/source-before',relative),'utf8');}catch{source=await fs.readFile(file,'utf8');}
 const sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,file.endsWith('tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
 function visit(n){
  const candidate=ts.isJsxText(n)||ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)||ts.isTemplateExpression(n);
  if(candidate){
   const value=ts.isJsxText(n)?{text:normJSX(n.getText(sf)),expressions:[]}:template(n,sf);
   const english=value.text?.trim();const category=contextFor(n,sf);
   if(english&&human(english,!!category)&&!protectedContext(n,sf)){
    if(category){
     const key='local.'+english.toLowerCase().replace(/\{\{.*?\}\}/g,'value').replace(/[^a-z0-9]+/g,'_').slice(0,45).replace(/_$/,'')+'_'+createHash('sha256').update(english).digest('hex').slice(0,8);
     const location=sf.getLineAndCharacterOfPosition(n.getStart(sf));
     const row={key,english,sourceFile:relative,line:location.line+1,sourceContext:category,placeholders:value.expressions.map((_,i)=>`v${i}`),start:n.getStart(sf),end:n.end,expressions:value.expressions,prefix:value.text.match(/^\s*/)[0],suffix:value.text.match(/\s*$/)[0]};
     occurrences.push(row);
     const entry=entries.get(key)??{key,english,sourceFile:relative,sourceContext:category,placeholders:row.placeholders,locations:[]};entry.locations.push(`${relative}:${row.line}`);entries.set(key,entry);
     if(ts.isTemplateExpression(n))return;
    }else if(english.length>2){residual.push({english,sourceFile:relative,line:sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1,kind:ts.SyntaxKind[n.parent.kind],context:n.parent.getText(sf).slice(0,350)});}
   }
  }
  ts.forEachChild(n,visit);
 }
 visit(sf);
}
await fs.mkdir(path.join(kit,'integration'),{recursive:true});
const rows=[...entries.values()].sort((a,b)=>a.key.localeCompare(b.key));
await fs.writeFile(path.join(kit,'integration/source-map.json'),JSON.stringify(rows,null,2));
await fs.writeFile(path.join(kit,'integration/occurrences.json'),JSON.stringify(occurrences,null,2));
await fs.writeFile(path.join(kit,'integration/residual-candidates.json'),JSON.stringify(residual,null,2));
await fs.writeFile(path.join(kit,'locale/en/catalog.json'),JSON.stringify(Object.fromEntries(rows.map(r=>[r.key,r.english])),null,2));
await fs.writeFile(path.join(kit,'integration/surface-inventory.json'),JSON.stringify(inputFiles.map(f=>path.relative(root,f).replaceAll('\\','/')),null,2));
console.log(JSON.stringify({files:inputFiles.length,unique:rows.length,occurrences:occurrences.length,residualCandidates:residual.length}));
