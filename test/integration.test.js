import {quote} from '../src/package-manager.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, access, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildCapsule } from '../src/capsule.js';
import { failureSignature, sameFailure } from '../src/failure-signature.js';
import { runCommand } from '../src/runner.js';
import { temporary, fingerprint } from './helpers.js';

const fixture = fileURLToPath(new URL('./fixtures/broken-parser', import.meta.url));
const cli = fileURLToPath(new URL('../bin/reprocapsule.js', import.meta.url));

test('CLI reduces real fixture, preserves exact failure and never changes source', async (t) => {
  const root = await temporary(t), output = path.join(root, 'capsule with spaces');
  const before = await fingerprint(fixture);
  const cliResult = spawnSync(process.execPath, [cli, 'reduce', '--repo', fixture, '--command', 'node test/repro.js', '--out', output], { encoding: 'utf8', timeout: 30000 });
  assert.equal(cliResult.status, 0, cliResult.stderr);
  assert.match(cliResult.stdout, /Failure preserved/);
  const manifest = JSON.parse(await readFile(path.join(output, 'capsule.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.reduction.originalFileCount, 26);
  assert.equal(manifest.reduction.originalCandidateCount, 24);
  assert.equal(manifest.reduction.finalFileCount, 6);
  assert.equal(manifest.reduction.finalCandidateCount, 4);
  assert.deepEqual(manifest.retainedFiles, ['data/profile.json', 'package-lock.json', 'package.json', 'src/parser.js', 'src/schema.js', 'test/repro.js']);
  assert.equal(manifest.failurePreserved, true);
  const observed = await runCommand({ command: 'node ./reproduce.cjs', cwd: output });
  assert.equal(sameFailure(manifest.failureSignature, failureSignature(observed, { roots: [output, await realpath(output)] })), true);
  assert.equal(await fingerprint(fixture), before);
  for (const excluded of ['.env.example', 'node_modules', '.git']) await assert.rejects(access(path.join(output, excluded)));
  assert.equal((await readFile(path.join(output, 'capsule.json'), 'utf8')).includes('not-a-real-secret'), false);
});

test('pipeline detects success and unstable baselines without leaving an output', async (t) => {
  const root = await temporary(t), source = path.join(root, 'repo');
  await mkdir(source);
  await writeFile(path.join(source, 'app.cjs'), 'console.error(String(Math.random())); process.exit(1);');
  await assert.rejects(buildCapsule({ repo: source, command: 'node app.cjs', output: path.join(root, 'unstable') }), { code: 'UNSTABLE_BASELINE' });
  await assert.rejects(buildCapsule({ repo: source, command: 'node -e "process.exit(0)"', output: path.join(root, 'success') }), { code: 'INVALID_BASELINE' });
  assert.deepEqual((await readdir(root)).sort(), ['repo']);
});

test('pipeline rejects missing dependencies instead of reducing a setup error', async (t) => {
  const root = await temporary(t), source = path.join(root, 'repo');
  await mkdir(source);
  await writeFile(path.join(source, 'app.cjs'), 'require("./missing.cjs")');
  await assert.rejects(buildCapsule({ repo: source, command: 'node app.cjs', output: path.join(root, 'output') }), { code: 'INVALID_BASELINE' });
});

test('command writes cannot contaminate later attempts or the exported capsule', async (t) => {
  const root = await temporary(t), source = path.join(root, 'repo');
  await mkdir(source);
  await writeFile(path.join(source, 'app.cjs'), `const fs = require('node:fs');
    if(fs.existsSync('generated')) process.exit(0);
    fs.writeFileSync('generated','side effect');
    fs.writeFileSync(__filename,'changed');
    console.error('TypeError: intentional fixture'); process.exit(1);`);
  await writeFile(path.join(source, 'unused.txt'), 'unneeded');
  const before = await fingerprint(source);
  const { output, manifest } = await buildCapsule({ repo: source, command: 'node app.cjs', output: path.join(root, 'capsule') });
  assert.deepEqual(manifest.retainedFiles, ['app.cjs']);
  assert.equal(await fingerprint(source), before);
  await assert.rejects(access(path.join(output, 'generated')));
  assert.equal(await readFile(path.join(output, 'app.cjs'), 'utf8'), await readFile(path.join(source, 'app.cjs'), 'utf8'));
  const replay = await runCommand({ cwd: root, command: `node ${quote(path.join(output,'reproduce.cjs'))}` });
  assert.equal(sameFailure(manifest.failureSignature, failureSignature(replay, { roots: [await realpath(output)] })), true);
});

test('generated metadata must not change the failure; invalid output is removed', async (t) => {
  const root = await temporary(t), source = path.join(root, 'repo');
  await mkdir(source);
  await writeFile(path.join(source, 'app.cjs'), `const fs = require('node:fs'); console.error(fs.existsSync('capsule.json') ? 'different error' : 'target error'); process.exit(1);`);
  const output = path.join(root, 'capsule');
  await assert.rejects(buildCapsule({ repo: source, command: 'node app.cjs', output }), { code: 'CAPSULE_VERIFICATION_FAILED' });
  await assert.rejects(access(output));
});

test('capsule builder refuses reserved filenames and existing output', async (t) => {
  const root = await temporary(t), source = path.join(root, 'repo');
  await mkdir(source);
  await writeFile(path.join(source, 'capsule.json'), '{}');
  await assert.rejects(buildCapsule({ repo: source, command: 'exit 1', output: path.join(root, 'capsule') }), { code: 'RESERVED_FILENAME' });
  const existing = path.join(root, 'existing');
  await mkdir(existing);
  await writeFile(path.join(existing, 'keep.txt'), 'untouched');
  await assert.rejects(buildCapsule({ repo: fixture, command: 'node test/repro.js', output: existing }), { code: 'OUTPUT_EXISTS' });
  assert.equal(await readFile(path.join(existing, 'keep.txt'), 'utf8'), 'untouched');
});

test('CLI provides help and rejects unknown or invalid arguments', () => {
  assert.equal(spawnSync(process.execPath, [cli, '--help']).status, 0);
  for (const args of [[], ['reduce', '--unknown'], ['reduce', '--repo', fixture, '--command', 'node test/repro.js', '--timeout-ms', 'NaN']]) {
    assert.equal(spawnSync(process.execPath, [cli, ...args]).status, 1);
  }
});
