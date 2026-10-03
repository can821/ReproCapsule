import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { temporary, fingerprint } from './helpers.js';
import { buildCapsule } from '../src/capsule.js';
import { verifyFix } from '../src/verify-fix.js';

async function fixture(t) {
  const root = await temporary(t), repo = path.join(root, 'source'), capsule = path.join(root, 'capsule');
  await mkdir(repo);
  await writeFile(path.join(repo, 'app.cjs'), 'throw new TypeError("target bug");\n');
  await buildCapsule({ repo, command: 'node app.cjs', output: capsule });
  const before = await fingerprint(capsule);
  return { root, capsule, before };
}
const replacement = (line) => `diff --git a/app.cjs b/app.cjs\n--- a/app.cjs\n+++ b/app.cjs\n@@ -1 +1 @@\n-throw new TypeError("target bug");\n+${line}\n`;
async function check(f, text, extra = {}) {
  const patch = path.join(f.root, 'fix.patch');
  await writeFile(patch, text);
  const result = await verifyFix({ capsule: f.capsule, patch, ...extra });
  assert.equal(await fingerprint(f.capsule), f.before);
  return result;
}
test('fix verification distinguishes removed, unchanged and different target failures in fresh copies', async (t) => {
  const f = await fixture(t);
  const removed = await check(f, replacement('process.exitCode = 0;'));
  assert.equal(removed.status, 'TARGET FAILURE REMOVED'); assert.equal(removed.broaderTests, 'NOT PROVIDED'); assert.equal(removed.success, true);
  assert.equal((await check(f, replacement('throw new TypeError("target bug");'))).status, 'TARGET FAILURE STILL PRESENT');
  assert.equal((await check(f, replacement('throw new Error("different");'))).status, 'DIFFERENT FAILURE INTRODUCED');
  const broader = await check(f, replacement('process.exitCode = 0;'), { testCommand: 'node -e "process.exit(1)"' });
  assert.equal(broader.status, 'TARGET FAILURE REMOVED'); assert.equal(broader.broaderTests, 'FAIL'); assert.equal(broader.success, false);
  assert.equal((await check(f, replacement('process.exitCode = 0;'), { testCommand: 'node -e "process.exit(0)"' })).broaderTests, 'PASS');
});
test('unsafe/malformed patches are rejected before execution; timeouts remain inconclusive', async (t) => {
  const f = await fixture(t);
  for (const patch of ['not a patch', replacement('0;').replaceAll('app.cjs', '../outside.cjs'),
    'diff --git a/leak b/leak\nnew file mode 120000\n--- /dev/null\n+++ b/leak\n@@ -0,0 +1 @@\n+/tmp/outside\n']) {
    assert.equal((await check(f, patch)).status, 'PATCH APPLICATION FAILED');
  }
  assert.equal((await check(f, replacement('setInterval(() => {}, 1000);'), { timeoutMs: 200 })).status, 'INCONCLUSIVE');
});

test('patched npm capsules receive independent offline clean installs', async (t) => {
  const { fileURLToPath } = await import('node:url');
  const root = await temporary(t), capsule = path.join(root, 'capsule');
  await buildCapsule({ repo: fileURLToPath(new URL('./fixtures/npm-dependencies', import.meta.url)), output: capsule, command: 'npm test', offline: true, maxRuns: 4 });
  const before = await fingerprint(capsule), patch = path.join(root, 'fix.patch');
  await writeFile(patch, 'diff --git a/repro.cjs b/repro.cjs\n--- a/repro.cjs\n+++ b/repro.cjs\n@@ -4 +4 @@\n-parse(prepare(input));\n+process.exitCode = 0;\n');
  const result = await verifyFix({ capsule, patch, offline: true });
  assert.equal(result.baseline.install, 'pass');
  assert.equal(result.status, 'TARGET FAILURE REMOVED');
  assert.equal(await fingerprint(capsule), before);
});
