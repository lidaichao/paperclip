import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { uiRoot } from './paths.mjs';

const KIT = path.resolve(import.meta.dirname, '..');
const SOURCE = path.join(uiRoot, 'src');

export const displayHelper = `
/** Localize a known monitor display string; raw ETA/offset contracts stay English. */
export function displayMonitorRelative(raw: string): string {
  if (displayLocale() !== "zh-CN") return raw;
  if (raw === "due now") return l10n("local.manual_monitor_due_now");
  if (raw === "now") return l10n("local.manual_monitor_now");
  const match = /^(?:(in |overdue by ))?(\\d+[smhd](?: \\d+[smhd])?)( ago)?$/.exec(raw);
  if (!match || (Boolean(match[1]) === Boolean(match[3]))) return raw;
  const duration = match[2].replace(/(\\d+)([smhd])/g, (_token, count: string, unit: string) =>
    l10n(\`local.manual_monitor_duration_\${unit}\`, { v0: count }),
  );
  if (match[1] === "in ") return l10n("local.manual_monitor_in", { v0: duration });
  if (match[1] === "overdue by ") return l10n("local.manual_monitor_overdue", { v0: duration });
  return l10n("local.manual_monitor_ago", { v0: duration });
}

export function formatMonitorEtaDisplay(nextCheckAt: MonitorDate, now: MonitorDate = new Date()): string {
  return displayMonitorRelative(formatMonitorEta(nextCheckAt, now));
}

export function formatMonitorOffsetDisplay(nextCheckAt: MonitorDate): string {
  return displayMonitorRelative(formatMonitorOffset(nextCheckAt));
}
`;

function once(source, before, after, name) {
  if (source.includes(after)) return source;
  if (!source.includes(before)) {
    throw new Error(`Monitor patch anchor changed: ${name}`);
  }
  if (source.split(before).length !== 2) throw new Error(`Ambiguous monitor patch anchor: ${name}`);
  return source.replace(before, after);
}

function addHelperImport(source) {
  if (/import\s*\{[^}]*\bdisplayMonitorRelative\b[^}]*\}\s*from\s*["'][^"']*issue-monitor["']/s.test(source)) return source;
  return once(source, '  formatMonitorEta,', '  formatMonitorEta,\n  displayMonitorRelative,', 'monitor helper import');
}

export function transformMonitorFile(relative, original) {
  let source = original.replaceAll('\r\n', '\n');
  if (relative === 'lib/issue-monitor.ts') {
    const anchor = 'export function formatMonitorEtaLabel(nextCheckAt: MonitorDate, now: MonitorDate = new Date()): string {';
    if (!source.includes('export function displayMonitorRelative(')) source = once(source, anchor, displayHelper + '\n' + anchor, 'display helpers');
    source = once(source,
      anchor + '\n  const eta = formatMonitorEta(nextCheckAt, now);',
      anchor + '\n  const eta = formatMonitorEtaDisplay(nextCheckAt, now);',
      'sentence-case display ETA');
  } else if (relative === 'components/IssueMonitorBanner.tsx') {
    source = addHelperImport(source);
    source = once(source,
      '  const eta = formatMonitorEta(derived.nextCheckAt, now); // "in 2h 12m" | "due now" | "overdue by 18m"',
      '  const eta = formatMonitorEta(derived.nextCheckAt, now); // "in 2h 12m" | "due now" | "overdue by 18m"\n  const shownEta = displayMonitorRelative(eta);',
      'banner display ETA');
    source = source.replaceAll('{v0: (eta)}', '{v0: (shownEta)}');
    source = source.replaceAll('${eta}', '${shownEta}');
    source = once(source, 'stripTitle = `Resumes ${eta}`;', 'stripTitle = l10n("local.manual_monitor_resumes", { v0: shownEta });', 'scheduled strip');
    source = once(source, 'stripTitle = capitalize(eta);', 'stripTitle = capitalize(shownEta);', 'overdue strip');
  } else if (relative === 'components/issue-properties/IssueProperties.tsx') {
    source = addHelperImport(source);
    source = once(source, '>{monitorRelative}</div>', '>{monitorRelative ? displayMonitorRelative(monitorRelative) : null}</div>', 'monitor detail display');
    if (source.includes('const action = scheduledRetryIsContinuation ? "Continuation" : "Retry";')) {
      source = once(source,
        'const action = scheduledRetryIsContinuation ? "Continuation" : "Retry";',
        'const action = scheduledRetryIsContinuation ? l10n("local.manual_monitor_continuation") : l10n("local.manual_monitor_retry");',
        'retry action label');
    } else {
      source = once(source,
        'const action = scheduledRetryIsContinuation ? l10n("local.continuation_29f1f4d5") : "Retry";',
        'const action = scheduledRetryIsContinuation ? l10n("local.continuation_29f1f4d5") : l10n("local.manual_monitor_retry");',
        'retry action label');
    }
    source = once(source, 'return `${action} ${scheduledRetryRelative}`;', 'return `${action} ${displayMonitorRelative(scheduledRetryRelative)}`;', 'retry title display');
    source = once(source, '>· {scheduledRetryRelative}</span>', '>· {displayMonitorRelative(scheduledRetryRelative)}</span>', 'retry detail display');
  } else if (relative === 'components/IssueBlockedNotice.tsx') {
    source = once(source, 'import { formatMonitorOffset } from "../lib/issue-monitor";', 'import { formatMonitorOffset, displayMonitorRelative } from "../lib/issue-monitor";', 'blocked notice import');
    source = once(source, 'l10n("local.scheduled_value_2877115d", {v0: (relative)})', 'l10n("local.scheduled_value_2877115d", {v0: displayMonitorRelative(relative)})', 'blocked notice display');
  } else if (relative === 'components/IssueScheduledRetryCard.tsx') {
    source = once(source, 'import { formatMonitorOffset } from "@/lib/issue-monitor";', 'import { formatMonitorOffset, displayMonitorRelative } from "@/lib/issue-monitor";', 'retry card import');
    source = once(source, 'titleSuffix = "due now";', 'titleSuffix = displayMonitorRelative("due now");', 'retry card due display');
    source = once(source, 'titleSuffix = relative;', 'titleSuffix = displayMonitorRelative(relative);', 'retry card offset display');
  } else if (relative === 'lib/recovery-lineage.ts') {
    source = once(source, 'import { formatMonitorOffset } from "./issue-monitor";', 'import { formatMonitorOffset, displayMonitorRelative } from "./issue-monitor";', 'recovery lineage import');
    if (source.includes('l10n("local.retry_missed_value_3ca5a65d"')) {
      source = once(source, 'l10n("local.retry_missed_value_3ca5a65d", {v0: (offset)})', 'l10n("local.retry_missed_value_3ca5a65d", {v0: displayMonitorRelative(offset)})', 'missed retry display');
    } else {
      source = once(source,
        'parts.push(offset ? `retry missed ${offset}` : "retry missed");',
        'parts.push(offset ? l10n("local.retry_missed_value_cafb69d7", { v0: displayMonitorRelative(offset) }) : l10n("local.retry_missed_a3e392ad"));',
        'missed retry display');
    }
    if (source.includes('l10n("local.next_try_value_9e735dcd"')) {
      source = once(source, 'l10n("local.next_try_value_9e735dcd", {v0: (offset)})', 'l10n("local.next_try_value_9e735dcd", {v0: displayMonitorRelative(offset)})', 'next retry display');
    } else {
      source = once(source,
        'parts.push(offset === "now" ? "next try now" : `next try ${offset}`);',
        'parts.push(offset === "now" ? l10n("local.next_try_now_3101ffa0") : l10n("local.next_try_value_97dabfd6", { v0: displayMonitorRelative(offset) }));',
        'next retry display');
    }
  } else { throw new Error(`Unexpected monitor patch file: ${relative}`); }
  return original.includes('\r\n') ? source.replaceAll('\n', '\r\n') : source;
}

export const monitorFiles = [
  'lib/issue-monitor.ts', 'components/IssueMonitorBanner.tsx',
  'components/issue-properties/IssueProperties.tsx', 'components/IssueBlockedNotice.tsx',
  'components/IssueScheduledRetryCard.tsx', 'lib/recovery-lineage.ts',
];

export async function planMonitorFixes() {
  return Promise.all(monitorFiles.map(async relative => {
    const target = path.join(SOURCE, relative);
    const before = await fs.readFile(target, 'utf8');
    const after = transformMonitorFile(relative, before);
    return { relative, target, before, after };
  }));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--apply')) throw new Error('Only --apply is supported. Omit it for a read-only preflight.');
  const plan = await planMonitorFixes(); // All anchors checked before any writes.
  const messages = JSON.parse(await fs.readFile(path.join(KIT, 'integration/manual-messages-monitor.json'), 'utf8'));
  if (!args.includes('--apply')) {
    console.log(JSON.stringify({mode:'preflight-only', files:plan.map(p=>p.relative), messages:Object.keys(messages).length}));
    return;
  }
  const manualPath = path.join(KIT, 'integration/manual-messages.json');
  const manual = JSON.parse(await fs.readFile(manualPath, 'utf8'));
  for (const [key,pair] of Object.entries(messages)) {
    if (key in manual && JSON.stringify(manual[key]) !== JSON.stringify(pair)) throw new Error(`Conflicting monitor message: ${key}`);
    manual[key] = pair;
  }
  for (const item of plan) if (item.after !== item.before) await fs.writeFile(item.target, item.after);
  await fs.writeFile(manualPath, JSON.stringify(manual, null, 2) + '\n');
  await fs.copyFile(path.join(KIT, 'integration/monitor-display.test.ts'), path.join(SOURCE, 'lib/monitor-display.test.ts'));
  console.log('Monitor display patch applied. Run merge-catalogs.mjs before the targeted UI tests/build. Raw ETA and offset contracts preserved.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error=>{console.error(error.message);process.exitCode=1;});
