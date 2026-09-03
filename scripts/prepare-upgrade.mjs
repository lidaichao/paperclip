import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertInside, parseArgs, readJson, writeJson } from './release-utils.mjs';

function normalize(input) {
  const rows = Array.isArray(input) ? input : input.entries ?? input.items ?? input.candidates;
  if (!Array.isArray(rows)) throw new Error('Source map must be an array or contain entries/items/candidates.');
  const result = new Map();
  for (const row of rows) {
    if (!row || typeof row.key !== 'string' || !row.key || typeof row.english !== 'string') throw new Error('Each entry needs a nonempty key and English string.');
    if (result.has(row.key)) throw new Error(`Duplicate source map key: ${row.key}`);
    const placeholders = row.placeholders ?? [...row.english.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)].map(match => match[1]);
    if (!Array.isArray(placeholders) || placeholders.some(value => typeof value !== 'string')) throw new Error(`Invalid placeholders: ${row.key}`);
    result.set(row.key, { ...row, placeholders: [...placeholders].sort() });
  }
  return result;
}

export function compareSourceMaps(before, after) {
  const oldMap = normalize(before), newMap = normalize(after);
  const report = { added: [], removed: [], englishChanged: [], contextChanged: [], placeholderChanged: [], reusableKeys: [], requiresReviewKeys: [] };
  for (const [key, newer] of newMap) {
    const older = oldMap.get(key);
    if (!older) { report.added.push(newer); report.requiresReviewKeys.push(key); continue; }
    let changed = false;
    for (const [category, fields] of [
      ['englishChanged', ['english']],
      ['contextChanged', ['sourceFile', 'sourceContext']],
      ['placeholderChanged', ['placeholders']],
    ]) {
      if (fields.some(field => JSON.stringify(older[field] ?? null) !== JSON.stringify(newer[field] ?? null))) {
        report[category].push({ key, before: Object.fromEntries(fields.map(field => [field, older[field] ?? null])), after: Object.fromEntries(fields.map(field => [field, newer[field] ?? null])) });
        changed = true;
      }
    }
    (changed ? report.requiresReviewKeys : report.reusableKeys).push(key);
  }
  for (const [key, older] of oldMap) if (!newMap.has(key)) report.removed.push(older);
  report.requiresReviewKeys.sort(); report.reusableKeys.sort();
  return { schemaVersion: 1, inheritancePolicy: 'Only reusableKeys may inherit translations automatically; all changed/new keys require explicit review. Removed keys must be archived, not silently discarded.', ...report, releaseBlocked: report.requiresReviewKeys.length > 0 || report.removed.length > 0 };
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['--old', '--new', '--out']);
  if (!args['--old'] || !args['--new'] || !args['--out']) throw new Error('Usage: node prepare-upgrade.mjs --old old-map.json --new new-map.json --out integration/upgrade-report.json');
  const projectRoot = path.resolve(import.meta.dirname, '..');
  const out = await assertInside(projectRoot, path.resolve(args['--out']));
  const report = compareSourceMaps(await readJson(args['--old']), await readJson(args['--new']));
  await writeJson(out, report);
  console.log(JSON.stringify({ report: out, releaseBlocked: report.releaseBlocked, added: report.added.length, removed: report.removed.length, englishChanged: report.englishChanged.length, contextChanged: report.contextChanged.length, placeholderChanged: report.placeholderChanged.length }));
  if (report.releaseBlocked) process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
