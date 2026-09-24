import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export const sha256 = (data) => createHash('sha256').update(data).digest('hex');
export async function readJson(file) { return JSON.parse(await fs.readFile(file, 'utf8')); }
export async function writeJson(file, value) { await fs.writeFile(file, JSON.stringify(value, null, 2) + '\n'); }

// Reject both lexical traversal and symlink/junction escapes before any mutation.
export async function assertInside(root, candidate, { allowRoot = false } = {}) {
  const absoluteRoot = path.resolve(root);
  const absolute = path.resolve(candidate);
  const relative = path.relative(absoluteRoot, absolute);
  if ((!allowRoot && !relative) || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new Error(`Path is outside permitted root: ${absolute}`);
  }
  for (let rootPart = absoluteRoot; ; rootPart = path.dirname(rootPart)) {
    try {
      if ((await fs.lstat(rootPart)).isSymbolicLink()) throw new Error(`Permitted root itself resolves through an unexpected link: ${absoluteRoot}`);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(rootPart) === rootPart) break;
  }
  let ancestor = absolute;
  for (;;) {
    try {
      const resolved = await fs.realpath(ancestor);
      let existingRoot = absoluteRoot;
      let tail = '';
      for (;;) {
          try { existingRoot = path.join(await fs.realpath(existingRoot), tail); break; }
        catch (error) {
          if (error.code !== 'ENOENT') throw error;
          tail = path.join(path.basename(existingRoot), tail);
          const parent = path.dirname(existingRoot);
          if (parent === existingRoot) throw error;
          existingRoot = parent;
        }
      }
      const reconstructed = path.join(resolved, path.relative(ancestor, absolute));
      const realRelative = path.relative(existingRoot, reconstructed);
      if ((!allowRoot && !realRelative) || realRelative === '..' || realRelative.startsWith('..' + path.sep) || path.isAbsolute(realRelative)) {
        throw new Error(`Resolved path escapes permitted root: ${absolute}`);
      }
      return absolute;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw error;
      ancestor = parent;
    }
  }
}

export async function treeInventory(root, { exclude = () => false } = {}) {
  const files = [];
  async function walk(dir, ancestors = new Set()) {
    const canonical = await fs.realpath(dir);
    if (ancestors.has(canonical)) throw new Error(`Cyclic symlink in source tree: ${dir}`);
    const nextAncestors = new Set(ancestors).add(canonical);
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).split(path.sep).join('/');
      if (exclude(relative)) continue;
      const stat = await fs.stat(full);
      if (stat.isDirectory()) await walk(full, nextAncestors);
      else if (stat.isFile()) files.push({ path: relative, bytes: stat.size, sha256: sha256(await fs.readFile(full)) });
      else throw new Error(`Unsupported runtime file type: ${full}`);
    }
  }
  await walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  return { sha256: sha256(JSON.stringify(files)), fileCount: files.length, files };
}

export function parseArgs(argv, allowed) {
  const options = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if (!allowed.includes(key)) throw new Error(`Unknown option: ${key}`);
    if (key === '--execute') options[key] = true;
    else {
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}`);
      options[key] = value;
    }
  }
  return options;
}
