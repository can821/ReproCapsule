import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ReproError } from './errors.js';
export const inWorkspace = (file, directory) => file === directory || file.startsWith(`${directory}/`);

export async function discoverWorkspaces(root, pkg, files) {
  if (pkg.workspaces === undefined) return [];
  if (!Array.isArray(pkg.workspaces)) throw new ReproError('UNSUPPORTED_PACKAGE_MANAGER', 'Workspace support requires an array of relative directories or terminal /* patterns.');
  const dirs = new Set();
  for (const pattern of pkg.workspaces) {
    if (typeof pattern !== 'string' || !pattern || pattern.startsWith('/') || pattern.split('/').some(p => !p || p === '.' || p === '..') || /[\\!?{}\[\]]/.test(pattern) || pattern.includes('*') && (!pattern.endsWith('/*') || pattern.slice(0,-2).includes('*'))) throw new ReproError('UNSUPPORTED_PACKAGE_MANAGER', 'Unsupported or unsafe npm workspace pattern.');
    const matches = files.filter(file => file.endsWith('/package.json')).map(file => path.posix.dirname(file)).filter(dir =>
      pattern.endsWith('/*') ? path.posix.dirname(dir) === pattern.slice(0,-2) : dir === pattern);
    if (!matches.length) throw new ReproError('UNSUPPORTED_PACKAGE_MANAGER', 'Workspace pattern has no allowed package manifest.');
    for (const dir of matches) dirs.add(dir);
  }
  const result = [];
  for (const directory of [...dirs].sort()) {
    if ([...dirs].some(other => other !== directory && inWorkspace(directory,other))) throw new ReproError('UNSUPPORTED_PACKAGE_MANAGER', 'Nested workspace roots are unsupported.');
    const manifest = JSON.parse(await readFile(path.join(root,directory,'package.json'),'utf8'));
    if (!manifest.name || typeof manifest.name !== 'string' || !manifest.version || manifest.workspaces || result.some(w => w.name === manifest.name)) throw new ReproError('INVALID_PACKAGE', 'Workspaces require unique names, versions and no nested workspace declarations.');
    for (const section of ['dependencies','devDependencies','optionalDependencies','peerDependencies']) {
      if (manifest[section] && (typeof manifest[section] !== 'object' || Array.isArray(manifest[section]))) throw new ReproError('INVALID_PACKAGE', 'Workspace dependency declarations must be objects.');
      if (Object.values(manifest[section] ?? {}).some(spec => typeof spec !== 'string' || /^(file:|link:|workspace:)/.test(spec))) throw new ReproError('UNSUPPORTED_PACKAGE_MANAGER', 'Workspace dependencies must use npm version ranges; file/link/workspace protocols are unsupported here.');
    }
    result.push({ path: directory, name: manifest.name, manifest });
  }
  return result;
}

export function workspaceSelection(pkg, workspaces, files) {
  if (!workspaces.length) return pkg;
  const selected = workspaces.filter(w => files.includes(`${w.path}/package.json`));
  const names = new Set(selected.map(w => w.name)), allNames = new Set(workspaces.map(w => w.name));
  for (const manifest of [pkg,...selected.map(w => w.manifest)]) {
    for (const section of ['dependencies','devDependencies','optionalDependencies','peerDependencies']) {
      if (Object.keys(manifest[section] ?? {}).some(name => allNames.has(name) && !names.has(name))) throw new ReproError('INSTALL_FAILED', 'Candidate removes a declared local workspace dependency.');
    }
  }
  return { ...pkg, workspaces: selected.map(w => w.path) };
}
