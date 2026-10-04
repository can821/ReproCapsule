import { readFile, writeFile, rm, mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runCommand } from './runner.js';
import { discoverWorkspaces } from './workspaces.js';
import { ReproError } from './errors.js';

export const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies'];
export const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
export function dependencyIds(pkg) {
  return dependencySections.flatMap((section) => Object.keys(pkg[section] ?? {}).map((name) => `${section}:${name}`)).sort();
}
export function selectDependencies(pkg, retained) {
  const selected = structuredClone(pkg), keep = new Set(retained);
  for (const section of dependencySections) {
    if (selected[section]) selected[section] = Object.fromEntries(Object.entries(selected[section]).filter(([name]) => keep.has(`${section}:${name}`)));
  }
  return selected;
}
async function jsonFile(root, name, optional = false) {
  try { return JSON.parse(await readFile(path.join(root, name), 'utf8')); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return null;
    throw new ReproError('INVALID_LOCKFILE', `Cannot read valid ${name}.`);
  }
}
function internalReference(spec) {
  if (typeof spec !== 'string') throw new ReproError('INVALID_PACKAGE', 'Dependency versions must be strings.');
  if (/^(?:link:|workspace:)/.test(spec)) throw new ReproError('UNSUPPORTED_PACKAGE_MANAGER', 'Workspace/link dependencies are unsupported.');
  if (!spec.startsWith('file:')) return null;
  const relative = spec.slice(5).replaceAll('\\', '/');
  if (!relative || path.isAbsolute(relative) || relative.split('/').includes('..')) {
    throw new ReproError('EXTERNAL_DEPENDENCY', 'Local file dependencies must stay inside the repository.');
  }
  return path.posix.normalize(relative).replace(/^\.\//, '');
}
export function localReferences(pkg) {
  return [...new Set([...dependencySections, 'peerDependencies'].flatMap((section) =>
    Object.values(pkg[section] ?? {}).map(internalReference).filter(Boolean)))];
}
export async function detectPackageManager(root, files) {
  if (!files.includes('package.json')) return { kind: 'none', needsInstall: false, ids: [], localPaths: [] };
  const pkg = await jsonFile(root, 'package.json');
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new ReproError('INVALID_PACKAGE', 'package.json must contain an object.');
  if ((pkg.packageManager && !/^npm@\d/.test(pkg.packageManager)) ||
      files.includes('yarn.lock') || files.includes('pnpm-lock.yaml') || files.includes('npm-shrinkwrap.json')) {
    throw new ReproError('UNSUPPORTED_PACKAGE_MANAGER', 'Only npm with package-lock.json is supported.');
  }
  for (const section of [...dependencySections, 'peerDependencies']) {
    if (pkg[section] && (typeof pkg[section] !== 'object' || Array.isArray(pkg[section]))) throw new ReproError('INVALID_PACKAGE', 'Dependency sections must be objects.');
  }
  const workspaces = await discoverWorkspaces(root, pkg, files);
  const ids = dependencyIds(pkg), localPaths = localReferences(pkg);
  const needsInstall = workspaces.length > 0 || ids.length > 0 || Object.keys(pkg.peerDependencies ?? {}).length > 0;
  const lock = await jsonFile(root, 'package-lock.json', !needsInstall);
  if (lock) {
    if (![2, 3].includes(lock.lockfileVersion) || !lock.packages?.['']) throw new ReproError('INVALID_LOCKFILE', 'npm lockfile version 2 or 3 with root metadata is required.');
    const lockedRoot = lock.packages[''];
    if (JSON.stringify(pkg.workspaces ?? []) !== JSON.stringify(lockedRoot.workspaces ?? [])) throw new ReproError('INVALID_LOCKFILE', 'Workspace declarations disagree with package-lock.json.');
    for (const ws of workspaces) {
      const locked = lock.packages[ws.path];
      if (!locked || locked.version !== ws.manifest.version) throw new ReproError('INVALID_LOCKFILE', 'Workspace lock entry is missing or inconsistent.');
      for (const section of [...dependencySections, 'peerDependencies']) {
        const entries = value => JSON.stringify(Object.entries(value ?? {}).sort());
        if (entries(locked[section]) !== entries(ws.manifest[section])) throw new ReproError('INVALID_LOCKFILE', 'Workspace dependency declarations disagree with lock.');
      }
    }
    for (const section of [...dependencySections, 'peerDependencies']) {
      const normalized = (value) => JSON.stringify(Object.entries(value ?? {}).sort(([a], [b]) => a.localeCompare(b)));
      if (normalized(pkg[section]) !== normalized(lockedRoot[section])) throw new ReproError('INVALID_LOCKFILE', 'Root dependency declarations disagree with package-lock.json.');
    }
    for (const item of Object.values(lock.packages)) {
      if (item.resolved) internalReference(item.link ? `file:${item.resolved}` : item.resolved);
      for (const section of [...dependencySections, 'peerDependencies']) {
        for (const spec of Object.values(item[section] ?? {})) internalReference(spec);
      }
    }
  }
  return { kind: 'npm', pkg, lock, ids, localPaths, workspaces, needsInstall, packageManager: pkg.packageManager ?? null };
}

export async function discoverNpm({ npmPath = process.env.REPROCAPSULE_NPM, cwd, timeoutMs = 5000 } = {}) {
  let executable = npmPath || 'npm';
  if (executable.includes('/')) executable = path.resolve(executable);
  else {
    const located = await runCommand({ command: `command -v ${quote(executable)}`, cwd, timeoutMs });
    if (located.exitCode !== 0 || !path.isAbsolute(located.stdout.trim())) throw new ReproError('NPM_UNAVAILABLE', 'npm unavailable; supply --npm-path or REPROCAPSULE_NPM.');
    executable = located.stdout.trim();
  }
  const command = /\.[cm]?js$/.test(executable) ? `${quote(process.execPath)} ${quote(executable)}` : quote(executable);
  const result = await runCommand({ command: `${command} --version`, cwd, timeoutMs });
  const version = result.stdout.trim();
  if (result.exitCode !== 0 || result.timedOut || result.outputExceeded || !/^\d+\.\d+\.\d+(?:[-+].*)?$/.test(version)) {
    throw new ReproError('NPM_UNAVAILABLE', 'npm unavailable. Supply --npm-path or REPROCAPSULE_NPM; no software is installed automatically.');
  }
  if (Number(version.split('.')[0]) < 9) throw new ReproError('NPM_UNAVAILABLE', 'npm 9+ is required.');
  return { command, version };
}

export async function npmInstall({ cwd, npm, updateLock = false, timeoutMs = 60_000, allowInstallScripts = false, offline = false }) {
  // Cache/logs live outside the candidate and are removed, never shipped in capsules.
  const cache = await mkdtemp(path.join(os.tmpdir(), 'reprocapsule-npm-'));
  const results = [];
  await writeFile(path.join(cache, 'user.npmrc'), '');
  await writeFile(path.join(cache, 'global.npmrc'), '');
  const flags = `--prefix ${quote(cwd)} --global=false --no-audit --no-fund --update-notifier=false --include=dev --include=optional --include=peer --cache ${quote(cache)} --userconfig ${quote(path.join(cache, 'user.npmrc'))} --globalconfig ${quote(path.join(cache, 'global.npmrc'))}${offline ? ' --offline' : ''}`;
  const started = Date.now();
  async function execute(args) {
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) throw new ReproError('INSTALL_TIMEOUT', 'npm installation timed out.');
    const result = await runCommand({ cwd, command: `${npm.command} ${args} ${flags}`, timeoutMs: remaining });
    results.push(result);
    if (result.timedOut) throw new ReproError('INSTALL_TIMEOUT', 'npm installation timed out.');
    if (result.outputExceeded) throw new ReproError('INSTALL_OUTPUT_LIMIT', 'npm output limit exceeded.');
    if (result.exitCode !== 0 || result.signal) {
      const mismatch = /(?:npm (?:error|ERR!) code EUSAGE|in sync|Missing: .* from lock file|Invalid: lock file)/.test(result.stderr);
      throw new ReproError(mismatch ? 'INVALID_LOCKFILE' : 'INSTALL_FAILED', mismatch ? 'npm rejected package-lock consistency.' : 'npm installation failed; raw output is not published.');
    }
  }
  try {
    await rm(path.join(cwd, 'node_modules'), { recursive: true, force: true });
    // npm owns all transitive lockfile resolution; scripts never run during lock updates.
    if (updateLock) await execute('install --package-lock-only --ignore-scripts');
    await execute(`ci${allowInstallScripts ? '' : ' --ignore-scripts'}`);
    return { success: true, durationMs: Date.now() - started, commands: results.length, scriptsAllowed: allowInstallScripts, results };
  } finally { await rm(cache, { recursive: true, force: true }); }
}

export async function writePackageSelection(cwd, pkg, ids) {
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify(selectDependencies(pkg, ids), null, 2) + '\n');
}

// A per-workspace shim lets reproduction commands use `npm test` even when the
// caller supplied an npm-cli.js path. Nothing is installed on the user's PATH.
export async function npmEnvironment(npm, workspaceRoot) {
  const bin = path.join(workspaceRoot, 'tools');
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, 'npm'), `#!/bin/sh\nexec ${npm.command} "$@"\n`, { mode: 0o755 });
  return { PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}`,
    npm_config_cache: path.join(workspaceRoot, 'command-cache'), npm_config_update_notifier: 'false' };
}
export const commandUsesNpm = (command) => /(?:^|[\s;&|])npm(?:\s|$)/.test(command);
