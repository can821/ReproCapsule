import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { temporary, fingerprint } from './helpers.js';
import { createWorkspace } from '../src/workspace.js';
import { detectPackageManager, discoverNpm, npmInstall, dependencyIds, selectDependencies, quote } from '../src/package-manager.js';
const fixture = fileURLToPath(new URL('./fixtures/npm-dependencies', import.meta.url));

async function copied(t) {
  const workspace = await createWorkspace(fixture);
  t.after(() => workspace.cleanup());
  const cwd = await workspace.materialize(workspace.files);
  return { workspace, cwd, npm: await discoverNpm({ cwd }) };
}

test('detects no manager, npm, unsupported managers and mismatched root declarations', async (t) => {
  const root = await temporary(t);
  assert.equal((await detectPackageManager(root, [])).kind, 'none');
  await writeFile(path.join(root, 'package.json'), '{"name":"empty"}');
  assert.equal((await detectPackageManager(root, ['package.json'])).kind, 'npm');
  for (const packageManager of ['yarn@4.0.0', 'pnpm@9.0.0']) {
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ packageManager }));
    await assert.rejects(detectPackageManager(root, ['package.json']), { code: 'UNSUPPORTED_PACKAGE_MANAGER' });
  }
  const { cwd, workspace } = await copied(t);
  const info = await detectPackageManager(cwd, workspace.files);
  assert.equal(info.ids.length, 5);
  const pkg = JSON.parse(await readFile(path.join(cwd, 'package.json')));
  delete pkg.dependencies['@repro/helper'];
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify(pkg));
  await assert.rejects(detectPackageManager(cwd, workspace.files), { code: 'INVALID_LOCKFILE' });
});

test('npm availability, external file dependencies, and workspace projects are explicit errors', async (t) => {
  const root = await temporary(t);
  await assert.rejects(discoverNpm({ cwd: root, npmPath: path.join(root, 'nonexistent') }), { code: 'NPM_UNAVAILABLE' });
  await writeFile(path.join(root, 'package.json'), '{"dependencies":{"outside":"file:../outside"}}');
  await assert.rejects(detectPackageManager(root, ['package.json']), { code: 'EXTERNAL_DEPENDENCY' });
  await writeFile(path.join(root, 'package.json'), '{"workspaces":["packages/*"]}');
  await assert.rejects(detectPackageManager(root, ['package.json']), { code: 'UNSUPPORTED_PACKAGE_MANAGER' });
});

test('dependency selection includes all three sections and always retains peers', () => {
  const pkg = { dependencies: { a: '1' }, devDependencies: { b: '1' }, optionalDependencies: { c: '1' }, peerDependencies: { peer: '1' } };
  assert.equal(dependencyIds(pkg).length, 3);
  const selected = selectDependencies(pkg, ['dependencies:a']);
  assert.deepEqual(selected.peerDependencies, { peer: '1' });
  assert.deepEqual(selected.devDependencies, {});
  assert.deepEqual(selected.optionalDependencies, {});
  assert.deepEqual(pkg.devDependencies, { b: '1' });
});

test('real isolated npm ci is offline, leaves source unchanged, and rejects incomplete locks', async (t) => {
  const before = await fingerprint(fixture);
  const { cwd, npm } = await copied(t);
  const result = await npmInstall({ cwd, npm, offline: true });
  assert.equal(result.success, true);
  await access(path.join(cwd, 'node_modules/@repro/parser/index.cjs'));
  assert.equal(await fingerprint(fixture), before);
  const lock = JSON.parse(await readFile(path.join(cwd, 'package-lock.json')));
  delete lock.packages['node_modules/@repro/parser'];
  await writeFile(path.join(cwd, 'package-lock.json'), JSON.stringify(lock));
  await assert.rejects(npmInstall({ cwd, npm, offline: true }), { code: 'INVALID_LOCKFILE' });
});

test('lifecycle scripts are disabled unless explicitly opted in', async (t) => {
  const { cwd, npm } = await copied(t);
  const pkg = JSON.parse(await readFile(path.join(cwd, 'package.json')));
  pkg.scripts.postinstall = `node -e "require('node:fs').writeFileSync('script-ran','yes')"`;
  await writeFile(path.join(cwd, 'package.json'), JSON.stringify(pkg));
  await npmInstall({ cwd, npm, offline: true });
  await assert.rejects(access(path.join(cwd, 'script-ran')));
  await npmInstall({ cwd, npm, offline: true, allowInstallScripts: true });
  assert.equal(await readFile(path.join(cwd, 'script-ran'), 'utf8'), 'yes');
});

test('install timeout and failure have distinct structured error codes', async (t) => {
  const root = await temporary(t), fake = path.join(root, 'installer.cjs');
  const npm = { command: `${quote(process.execPath)} ${quote(fake)}` };
  await writeFile(fake, 'setInterval(()=>{},1000)');
  await assert.rejects(npmInstall({ cwd: root, npm, timeoutMs: 100 }), { code: 'INSTALL_TIMEOUT' });
  await writeFile(fake, 'console.error("fixture installation failure");process.exit(1)');
  await assert.rejects(npmInstall({ cwd: root, npm }), { code: 'INSTALL_FAILED' });
});
