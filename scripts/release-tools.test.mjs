import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareSourceMaps } from './prepare-upgrade.mjs';
import { assertInside, treeInventory } from './release-utils.mjs';
import { validateReleaseTarget } from './build-release.mjs';

const row = (key, english, extra = {}) => ({ key, english, sourceFile: 'ui/src/a.tsx', sourceContext: 'button', placeholders: [], ...extra });

test('upgrade diff blocks stale English, context, placeholder reuse and removed keys', () => {
  const before = [row('same', 'Save'), row('meaning', 'Archive'), row('context', 'Run'), row('placeholder', 'Hello {{name}}', { placeholders: ['name'] }), row('gone', 'Old')];
  const after = [row('same', 'Save'), row('meaning', 'Delete'), row('context', 'Run', { sourceContext: 'noun' }), row('placeholder', 'Hello {{agent}}', { placeholders: ['agent'] }), row('new', 'Created')];
  const result = compareSourceMaps(before, after);
  assert.deepEqual(result.reusableKeys, ['same']);
  assert.deepEqual(result.requiresReviewKeys, ['context', 'meaning', 'new', 'placeholder']);
  assert.equal(result.englishChanged.length, 2);
  assert.equal(result.contextChanged.length, 1);
  assert.equal(result.placeholderChanged.length, 1);
  assert.equal(result.added.length, 1); assert.equal(result.removed.length, 1);
  assert.equal(result.releaseBlocked, true);
});

test('placeholder ordering is irrelevant but multiplicity must be retained', () => {
  const base = row('x', '{{a}} {{b}}', { placeholders: ['a', 'b'] });
  assert.equal(compareSourceMaps([base], [{ ...base, placeholders: ['b', 'a'] }]).releaseBlocked, false);
  assert.equal(compareSourceMaps([base], [{ ...base, placeholders: ['a', 'b', 'b'] }]).placeholderChanged.length, 1);
  assert.throws(() => compareSourceMaps([base, base], [base]), /Duplicate/);
});

test('release validation rejects traversal, absolute paths, existing releases and symlink escapes', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-release-test-'));
  const root = path.join(fixture, 'releases');
  await fs.mkdir(root);
  try {
    for (const invalid of ['../outside', '2026.831.1-zh.1/../outside', path.join(fixture, 'outside'), 'bad']) {
      await assert.rejects(validateReleaseTarget(root, invalid), /Invalid release ID/);
    }
    await assert.rejects(assertInside(root, fixture), /outside/);
    const release = await validateReleaseTarget(root, '2026.831.1-zh.1');
    await fs.mkdir(release);
    await assert.rejects(validateReleaseTarget(root, '2026.831.1-zh.1'), /overwrite/);
    const outside = path.join(fixture, 'outside');
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(assertInside(root, path.join(root, 'escape', 'child')), /escapes/);
    await assert.rejects(assertInside(path.join(root, 'escape'), path.join(root, 'escape', 'child')), /unexpected link/);
  } finally {
    // The fixture is created by this test beneath the OS temp root; resolve and
    // validate the exact directory before recursive cleanup.
    await assertInside(os.tmpdir(), fixture);
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test('backend evidence detects mutations while deliberate UI exclusions remain separate', async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'paperclip-hash-test-'));
  try {
    await fs.mkdir(path.join(fixture, 'ui-dist'));
    await fs.writeFile(path.join(fixture, 'server.js'), 'const status = "todo";');
    await fs.writeFile(path.join(fixture, 'ui-dist/index.html'), 'English');
    const options = { exclude: value => value === 'ui-dist' || value.startsWith('ui-dist/') };
    const before = await treeInventory(fixture, options);
    await fs.writeFile(path.join(fixture, 'ui-dist/index.html'), '中文');
    assert.equal((await treeInventory(fixture, options)).sha256, before.sha256);
    await fs.writeFile(path.join(fixture, 'server.js'), 'const status = "待办";');
    assert.notEqual((await treeInventory(fixture, options)).sha256, before.sha256);
  } finally { await assertInside(os.tmpdir(), fixture); await fs.rm(fixture, { recursive: true, force: true }); }
});
