import fs from 'node:fs/promises';
import path from 'node:path';
import { uiRoot as root } from './paths.mjs';
async function edit(rel,fn,helpers=[]){const p=path.join(root,rel);let s=await fs.readFile(p,'utf8');const before=s;s=fn(s);if(s!==before&&helpers.length){let imp=path.relative(path.dirname(p),path.join(root,'src/i18n/display')).replaceAll('\\','/');if(!imp.startsWith('.'))imp='./'+imp;const line=new RegExp('^import \\{ ([^}]+) \\} from '+JSON.stringify(imp).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')+';\\r?\\n','gm');const names=new Set(helpers);s=s.replace(line,(_,list)=>{for(const n of list.split(','))names.add(n.trim());return '';});s=`import { ${[...names].join(', ')} } from ${JSON.stringify(imp)};\n`+s;}if(s!==before)await fs.writeFile(p,s);}
await edit('src/pages/apps/Connections.tsx',s=>s.replace('label: "Healthy" | "Needs attention" | "Paused" | "Not connected";','label: string;'));
await edit('src/components/NewIssueDialog.tsx',s=>s.replace('className="w-6 shrink-0 text-center"','className="min-w-6 shrink-0 whitespace-nowrap text-center"'));
await edit('src/pages/Costs.tsx',s=>s.replaceAll('l10n("local.in_58296753")','l10n("local.manual_tokens_in")').replaceAll('l10n("local._out_0815f5b0")','l10n("local.manual_tokens_out")').replace(': "Open"',': l10n("local.manual_budget_open")'));
await edit('src/components/MarkdownEditor.tsx',s=>{if(!s.includes('translation={translateEditor}'))s=s.replace(/<MDXEditor\r?\n/,'<MDXEditor\n          translation={translateEditor}\n');if(!s.includes('import { translateEditor }'))s='import { translateEditor } from "../i18n/editor";\n'+s;return s;});
await edit('src/pages/AgentDetail.tsx',s=>s.replace('crumbs.push({ label: "Configuration" });','crumbs.push({ label: l10n("local.manual_configuration") });'));
await edit('src/components/task-chat/TaskChatComposer.tsx',s=>s.replace('const assigneeName = assigneeLabel === "Unassigned" ? "the agent" : assigneeLabel;','const selectedAssignee = reassignOptions?.find((option) => option.id === assigneeValue);\n  const assigneeName = selectedAssignee && assigneeValue ? selectedAssignee.label : displayText("the agent");'),['displayText']);
await edit('src/pages/IssueDetail.tsx',s=>s.replace('const accessibleLabel = via ? `${label}: ${actor.name} · via ${via}` : `${label}: ${actor.name}`;','const shownLabel = displayText(label);\n  const accessibleLabel = via ? `${shownLabel}: ${actor.name} · via ${via}` : `${shownLabel}: ${actor.name}`;').replace('leading-none text-background/70">{label}</div>','leading-none text-background/70">{shownLabel}</div>'),['displayText']);
await edit('src/i18n/index.ts',s=>s.replace('const saved = window.localStorage.getItem(LOCALE_STORAGE_KEY);','const storage = typeof window === "undefined" ? globalThis.localStorage : window.localStorage;\n    const saved = storage?.getItem(LOCALE_STORAGE_KEY);'));
await edit('vitest.setup.ts',s=>s.includes('paperclip.locale')?s:s+'\n// Existing upstream assertions exercise English; Chinese behavior has dedicated tests.\nglobalThis.localStorage.setItem("paperclip.locale", "en");\n');
const statusFiles=['components/StatusBadge.tsx','components/StatusIcon.tsx','components/KanbanBoard.tsx','components/GoalProperties.tsx','components/IssueBlockedNotice.tsx','components/IssueRunLedger.tsx','components/IssueLinkQuicklook.tsx','components/IssueFiltersPopover.tsx','components/ProjectProperties.tsx','components/IssueWorkspaceCard.tsx','components/routine-sections/operate-sections.tsx','pages/AgentDetail.tsx','components/ExecutionWorkspaceCloseDialog.tsx'];
for(const file of statusFiles)await edit('src/'+file,s=>{
 s=s.replace(/return (status|s)\.replace\(\/_\/g, " "\)\.replace\(\/\\b\\w\/g, \((?:c|character)\) => (?:c|character)\.toUpperCase\(\)\);/g,'return enumLabel($1);');
 s=s.replace(/return status\.replace\(\/_\/g, " "\);/g,'return enumLabel(status);');
 s=s.replace(/\{(status|issue\.status|run\.status|label)\.replace(?:All)?\((?:"_"|\/[_-]+\/g|\/\[_-\]\/g), " "\)\}/g,'{enumLabel($1)}');
 s=s.replace('{label ?? status.replace(/[_-]/g, " ")}','{label ?? enumLabel(status, "lower")}');
 s=s.replace('return s.charAt(0).toUpperCase() + s.slice(1);','return enumLabel(status, "sentence");');
 s=s.replace('{issue.status}</span>','{enumLabel(issue.status)}</span>');
 return s;
},['enumLabel']);
for(const file of ['src/lib/utils.ts','src/lib/timeAgo.ts'])await edit(file,s=>{
 s=s.replace(/\.toLocale(DateString|String)\("en-US"/g,'.toLocale$1(displayLocale()');
 s=s.replace('return "just now";','return displayText("just now");');
 return s;
},['displayText','displayLocale']);
await edit('src/components/SourceTrustBadge.tsx',s=>s.replace('artifactLabel?: "comment" | "document" | "work product" | "content";','artifactLabel?: string;').replace('`Promoted from low-trust${sourceTrust.promotedAt ? ` on ${new Date(sourceTrust.promotedAt).toLocaleString()}` : ""}.`','l10n("local.manual_source_promoted", {v0: sourceTrust.promotedAt ? l10n("local.manual_source_promoted_on", {v0: new Date(sourceTrust.promotedAt).toLocaleString(displayLocale())}) : ""})').replace('`Authored by a low-trust review agent. Raw ${artifactLabel} is not auto-shared with higher-trust agents.`','l10n("local.manual_source_raw", {v0: displayText(artifactLabel)})'),['displayText','displayLocale']);
for(const file of ['src/lib/utils.ts','src/lib/timeAgo.ts'])await edit(file,s=>{
 s=s.replaceAll('displayText("just now")','l10n("local.manual_just_now")');
 for(const [suffix,key] of [['m ago','minutes_ago'],['h ago','hours_ago'],['d ago','days_ago'],['w ago','weeks_ago'],['mo ago','months_ago'],['/mo','monthly_budget'],['s','duration_s'],['m','duration_m'],['h','duration_h'],['d','duration_d']]){
  const re=new RegExp('`\\$\\{([^{}]+)\\}'+suffix.replaceAll('/','\\/')+'`','g');
  s=s.replace(re,(_,expr)=>`l10n("local.manual_${key}", {v0: ${expr}})`);
 }
 for(const [a,b,key] of [['m','s','duration_ms'],['h','m','duration_hm'],['d','h','duration_dh']])s=s.replace(new RegExp('`\\$\\{([^{}]+)\\}'+a+' \\$\\{([^{}]+)\\}'+b+'`','g'),(_,one,two)=>`l10n("local.manual_${key}", {v0: ${one}, v1: ${two}})`);
 return s.replace('return "0s";','return l10n("local.manual_duration_s", {v0: 0});');
});
await edit('src/lib/issue-monitor.ts',s=>s.replaceAll('new Intl.DateTimeFormat(options.locale,','new Intl.DateTimeFormat(options.locale ?? displayLocale(),').replace('return `Today, ${time}`;','return l10n("local.manual_today_time", {v0: time});'),['displayLocale']);
await edit('src/components/StatusBadge.tsx',s=>s.replace('return enumLabel(status);','return enumLabel(status, "sentence");').replace('{label ?? enumLabel(status)}','{label ?? enumLabel(status, "lower")}').replace('{enumLabel(label)}','{enumLabel(label, "lower")}'));
// These reviewed display helpers were not necessarily part of literal extraction.
for(const file of ['src/components/SourceTrustBadge.tsx','src/lib/utils.ts','src/lib/timeAgo.ts','src/lib/issue-monitor.ts'])await edit(file,s=>s.includes('l10n(')&&!/^import\s*\{[^}]*\bl10n\b/m.test(s)?'import { l10n } from "../i18n";\n'+s:s);
console.log('Applied reviewed presentation fixes.');
// Normalize duplicated generated helper imports left by interrupted prior runs.
async function dedupe(dir){for(const e of await fs.readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);if(e.isDirectory())await dedupe(p);else if(/\.tsx?$/.test(e.name)){let s=await fs.readFile(p,'utf8');const seen=new Set();const fixed=s.replace(/^import \{ ([^}\n]+) \} from (["'][^"']*i18n(?:\/display)?["']);\r?\n/gm,(whole,names,mod)=>{const remaining=names.split(',').map(x=>x.trim()).filter(n=>{const key=mod.replaceAll("'",'"')+':'+n;if(seen.has(key))return false;seen.add(key);return true;});return remaining.length?'import { '+remaining.join(', ')+' } from '+mod+';\n':'';});if(fixed!==s)await fs.writeFile(p,fixed);}}}
await dedupe(path.join(root,'src'));
