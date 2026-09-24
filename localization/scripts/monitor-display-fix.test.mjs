import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { planMonitorFixes, transformMonitorFile } from './monitor-display-fix.mjs';

function functionSource(source, name) {
  const match = source.match(new RegExp('export function '+name+'\\([^]*?\\n\\}'));
  assert.ok(match, `missing function ${name}`);
  return match[0];
}

test('patch preflight and rerun preserve raw ETA/offset, countdown and state derivation', async () => {
  const plan = await planMonitorFixes();
  for (const item of plan) assert.equal(transformMonitorFile(item.relative, item.after), item.after, item.relative);
  const helper = plan.find(item=>item.relative==='lib/issue-monitor.ts');
  for (const name of ['formatMonitorEta','formatMonitorOffset','deriveMonitorState','useMonitorCountdown']) {
    assert.equal(functionSource(helper.after,name), functionSource(helper.before,name), name);
  }
  const recovery = plan.find(item=>item.relative==='lib/recovery-lineage.ts');
  assert.equal(functionSource(recovery.after,'formatRecoveryRetryOffset'), functionSource(recovery.before,'formatRecoveryRetryOffset'));
  for (const item of plan) {
    for (const line of item.before.split(/\r?\n/).filter(line=>/=== "(?:due now|now)"|startsWith\("overdue by "\)/.test(line))) {
      // Return text may change only when it is a display composition, not the condition.
      const condition = line.match(/(?:\w+ === "(?:due now|now)"|\w+\??\.startsWith\("overdue by "\))/)?.[0];
      if (condition) assert.ok(item.after.includes(condition), `${item.relative}: ${condition}`);
    }
  }
});

test('actual transformed helper preserves English while rendering Chinese without source writes', async () => {
  const helper=(await planMonitorFixes()).find(item=>item.relative==='lib/issue-monitor.ts');
  let source=stripTypeScriptTypes(helper.after).replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,'');
  source+='\nthis.api={formatMonitorEta,formatMonitorOffset,formatMonitorEtaLabel,formatMonitorEtaDisplay,formatMonitorOffsetDisplay,displayMonitorRelative,deriveMonitorState};';
  const messages=JSON.parse(await fs.readFile(new URL('../integration/manual-messages-monitor.json',import.meta.url),'utf8'));
  const clock=Date.parse('2026-07-17T20:00:00Z');
  let lang='en';
  class ClockDate extends Date { static now(){return clock;} }
  const context={Date:ClockDate,displayLocale:()=>lang==='zh-CN'?'zh-CN':'en-US',l10n:(key,params={})=>{
    const value=messages[key.replace(/^local.manual_/,'')][lang==='zh-CN'?1:0];
    return value.replace(/{{(\w+)}}/g,(_,name)=>String(params[name]));
  }};
  vm.runInNewContext(source,context);
  const {api}=context;
  const now=new ClockDate(clock);
  const later=ms=>new ClockDate(clock+ms);
  for (const locale of ['en','zh-CN']) {
    lang=locale;
    assert.equal(api.formatMonitorEta(later(-60_000),now),'overdue by 1m');
    assert.equal(api.formatMonitorEta(later(-59_999),now),'due now');
    assert.equal(api.formatMonitorOffset(later(10_000)),'now');
    assert.equal(api.formatMonitorOffset(later(-12*60_000)),'12m ago');
  }
  assert.equal(api.formatMonitorEtaDisplay(later(132*60_000),now),'2小时 12分钟后');
  assert.equal(api.formatMonitorEtaDisplay(later(45_000),now),'45秒后');
  assert.equal(api.formatMonitorEtaLabel(later(-18*60_000),now),'已逾期18分钟');
  assert.equal(api.formatMonitorOffsetDisplay(later(-12*60_000)),'12分钟前');
  assert.equal(api.formatMonitorOffsetDisplay(now),'现在');
  assert.equal(api.displayMonitorRelative('in user-workspace'),'in user-workspace');
  lang='en';
  for(const raw of ['in 2h 12m','overdue by 18m','now','due now','3m ago'])assert.equal(api.displayMonitorRelative(raw),raw);
  assert.equal(api.formatMonitorEtaLabel(later(132*60_000),now),'In 2h 12m');
});
