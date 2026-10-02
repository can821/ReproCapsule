import { mkdtemp, mkdir, readdir, lstat, realpath, copyFile, chmod, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ReproError } from './errors.js';

const excludedNames = new Set(['.git', 'node_modules', '.DS_Store', '.npmrc', '.yarnrc', '.yarnrc.yml', '.ssh', '.aws', '.gnupg', '.kube', '.envrc', '.netrc', '.pypirc', 'credentials.json', 'secrets.json']);
export const protectedNames = new Set(['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml']);
function excluded(name) {
  return excludedNames.has(name) || name === '.env' || name.startsWith('.env.') ||
    /\.(?:pem|key|p12|pfx)$/i.test(name) || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)/.test(name);
}
export const isControlFile = (file) => protectedNames.has(path.basename(file));

export async function inventory(repo) {
  const root = await realpath(repo);
  if (!(await lstat(root)).isDirectory()) throw new ReproError('INVALID_REPO', 'Repository must be a directory.');
  const files = [], exclusions = [];
  async function visit(dir, prefix = '') {
    const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const full = path.join(dir, entry.name);
      const stat = await lstat(full);
      if (excluded(entry.name) || !stat.isFile() && !stat.isDirectory()) {
        exclusions.push({ path: relative, reason: stat.isSymbolicLink() ? 'symlink' : 'excluded-or-special' });
      } else if (stat.isDirectory()) await visit(full, relative);
      else files.push(relative);
    }
  }
  await visit(root);
  return { root, files, exclusions };
}

export async function copyFiles(source, destination, files) {
  for (const relative of files) {
    if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes('..')) {
      throw new ReproError('UNSAFE_PATH', 'File path must stay inside the workspace.');
    }
    const from = path.join(source, relative), to = path.join(destination, relative);
    const stat = await lstat(from);
    if (!stat.isFile()) throw new ReproError('SOURCE_CHANGED', 'A source file changed type while copying.');
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
    // Preserve executable bits, but make the isolated copy writable; no hard links.
    await chmod(to, (stat.mode & 0o777) | 0o600);
  }
}

export async function createWorkspace(repo) {
  const info = await inventory(repo);
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'reprocapsule-'));
  const root = await realpath(temporary);
  const snapshot = path.join(root, 'snapshot'), candidate = path.join(root, 'candidate');
  try {
    await mkdir(snapshot);
    await copyFiles(info.root, snapshot, info.files);
    return {
      ...info, root, source: info.root, snapshot, candidate,
      async materialize(files) {
        await rm(candidate, { recursive: true, force: true });
        await mkdir(candidate);
        await copyFiles(snapshot, candidate, files);
        return candidate;
      },
      async cleanup() { await rm(root, { recursive: true, force: true }); },
    };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
}

export async function validateOutput(repo, output) {
  const source = await realpath(repo);
  const requested = path.resolve(output);
  let ancestor = requested;
  const missing = [];
  while (true) {
    try { await lstat(ancestor); break; }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      missing.unshift(path.basename(ancestor));
      ancestor = path.dirname(ancestor);
    }
  }
  const canonical = path.join(await realpath(ancestor), ...missing);
  const relative = path.relative(source, canonical);
  if (!relative || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    throw new ReproError('UNSAFE_OUTPUT', 'Output must be outside the original repository.');
  }
  if (!missing.length) throw new ReproError('OUTPUT_EXISTS', 'Output already exists; choose a new directory.');
  return canonical;
}
