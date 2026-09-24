import { promises as fs } from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { assertInside, parseArgs, readJson, sha256, treeInventory, writeJson } from './release-utils.mjs';

const VERSION = '2026.831.1';
const COMMIT = '65ec059bde30d98c92165b24a30a540800dd1f6f';
const INSTALL = 'H:/AIagent/Luna/tools/paperclip';
const SOURCE = 'H:/AIagent/Luna/tools/paperclip-source';
const RELEASES = 'H:/AIagent/Luna/tools/paperclip-releases';
const ASSETS = path.resolve(import.meta.dirname, '..');
const UI_PATH = 'node_modules/@paperclipai/server/ui-dist';

export async function validateReleaseTarget(releasesRoot, releaseId) {
  if (!/^\d{4}\.\d+\.\d+-zh\.\d+$/.test(releaseId)) throw new Error('Invalid release ID; expected YYYY.N.N-zh.N.');
  const target = await assertInside(releasesRoot, path.join(releasesRoot, releaseId));
  try { await fs.lstat(target); throw new Error(`Refusing to overwrite existing release: ${target}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return target;
}

async function main() {
  const args = parseArgs(process.argv.slice(2), ['--release', '--test-report', '--execute']);
  const releaseId = args['--release'] ?? `${VERSION}-zh.1`;
  if (!releaseId.startsWith(`${VERSION}-zh.`)) throw new Error(`Only the pinned backend ${VERSION} is supported. Upgrade the reviewed script baseline first.`);
  const target = await validateReleaseTarget(RELEASES, releaseId);
  const packageJson = await readJson(path.join(INSTALL, 'node_modules/paperclipai/package.json'));
  const backend = await readJson(path.join(INSTALL, 'node_modules/@paperclipai/server/package.json'));
  if (packageJson.version !== VERSION || backend.version !== VERSION) throw new Error('Installed CLI/backend does not match the pinned version.');
  const sourceCommit = execFileSync('git', ['-C', SOURCE, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).trim();
  if (sourceCommit !== COMMIT) throw new Error(`Wrong source commit: ${sourceCommit}`);
  const lockPath = path.join(INSTALL, 'package-lock.json');
  const lockBytes = await fs.readFile(lockPath);
  const lock = JSON.parse(lockBytes);
  const pinned = lock.packages?.['node_modules/paperclipai'];
  if (pinned?.version !== VERSION || !pinned.integrity) throw new Error('Missing or mismatched npm package integrity in installation lockfile.');
  const uiSource = path.join(SOURCE, 'ui/dist');
  await fs.access(path.join(uiSource, 'index.html'));
  const uiInventory = await treeInventory(uiSource);
  const catalogInventory = await treeInventory(path.join(ASSETS, 'locale'));
  const patchInventory = await treeInventory(path.join(ASSETS, 'integration/patches'));
  if (!uiInventory.fileCount || !catalogInventory.fileCount || !patchInventory.fileCount) throw new Error('UI assets, locale files, and replayable patches must all exist.');
  if (!args['--test-report']) throw new Error('Supply --test-report with the reviewed validation evidence JSON.');
  const testReportPath = await assertInside(ASSETS, path.resolve(args['--test-report']));
  const testBytes = await fs.readFile(testReportPath);
  const testReport = JSON.parse(testBytes);
  if (testReport.passed !== true) throw new Error('Validation evidence must explicitly contain passed: true.');
  const plan = { releaseId, target, sourceCommit, upstreamVersion: VERSION, backendVersion: backend.version, uiFileCount: uiInventory.fileCount, catalogSha256: catalogInventory.sha256, action: args['--execute'] ? 'build-candidate' : 'preflight-only' };
  console.log(JSON.stringify(plan));
  if (!args['--execute']) return;

  // Never touch the running installation or active-release.json. An incomplete
  // directory is retained on failure and has no release-manifest.json marker.
  await fs.mkdir(RELEASES, { recursive: true });
  await validateReleaseTarget(RELEASES, releaseId);
  await fs.mkdir(target);
  await writeJson(path.join(target, 'BUILD-INCOMPLETE.json'), { startedAt: new Date().toISOString(), ...plan });
  const excludeUi = relative => relative === UI_PATH || relative.startsWith(UI_PATH + '/');
  const sourceRuntime = await treeInventory(path.join(INSTALL, 'node_modules'), { exclude: relative => excludeUi('node_modules/' + relative) });
  for (const name of ['package.json', 'package-lock.json']) await fs.copyFile(path.join(INSTALL, name), path.join(target, name));
  // Copy the complete root dependency tree, dereferencing Windows links. Only
  // the existing UI build is excluded because it is replaced immediately below.
  await fs.cp(path.join(INSTALL, 'node_modules'), path.join(target, 'node_modules'), {
    recursive: true, dereference: true, force: false, errorOnExist: true,
    filter: source => !excludeUi(path.relative(INSTALL, source).split(path.sep).join('/')),
  });
  const uiTarget = await assertInside(target, path.join(target, UI_PATH));
  await fs.cp(uiSource, uiTarget, { recursive: true, dereference: true, force: false, errorOnExist: true });
  const copiedRuntime = await treeInventory(path.join(target, 'node_modules'), { exclude: relative => excludeUi('node_modules/' + relative) });
  if (copiedRuntime.sha256 !== sourceRuntime.sha256) throw new Error('Copied backend/dependency bytes differ from the official installation. Candidate is incomplete.');
  const copiedUi = await treeInventory(uiTarget);
  if (copiedUi.sha256 !== uiInventory.sha256) throw new Error('Copied UI differs from reviewed build. Candidate is incomplete.');
  await writeJson(path.join(target, 'backend-files.json'), copiedRuntime);
  await writeJson(path.join(target, 'ui-assets.json'), copiedUi);
  await fs.copyFile(testReportPath, path.join(target, 'validation-report.json'));
  const manifest = {
    schemaVersion: 1, status: 'candidate', releaseId,
    upstreamVersion: VERSION, sourceCommit, packageIntegrity: pinned.integrity,
    lockfileSha256: sha256(lockBytes), localizationVersion: releaseId.split('-')[1],
    catalogSha256: catalogInventory.sha256, patchSha256: patchInventory.sha256,
    backendVersion: backend.version, backendHash: copiedRuntime.sha256,
    backendHashScope: 'Every file in the complete root node_modules tree except @paperclipai/server/ui-dist; identical to the installed official dependency tree.',
    uiAssetManifestSha256: sha256(await fs.readFile(path.join(target, 'ui-assets.json'))),
    uiTreeSha256: copiedUi.sha256, testReportSha256: sha256(testBytes),
    entrypoint: 'node_modules/paperclipai/dist/index.js', builtAt: new Date().toISOString(),
    deployment: 'Not activated. Requires explicit release verification and switch by deployment owner.',
  };
  await fs.unlink(path.join(target, 'BUILD-INCOMPLETE.json'));
  await writeJson(path.join(target, 'release-manifest.json'), manifest);
  console.log(JSON.stringify({ candidate: target, manifestSha256: sha256(await fs.readFile(path.join(target, 'release-manifest.json'))), backendHash: manifest.backendHash }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main().catch(error => { console.error(error.message); process.exitCode = 1; });
