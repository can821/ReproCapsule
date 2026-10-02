import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { temporary, fingerprint } from './helpers.js';
import { buildCapsule } from '../src/capsule.js';
import { verifyCapsule } from '../src/verify.js';
import { createPredicate, matchesPredicate } from '../src/predicate.js';
import { failureSignature } from '../src/failure-signature.js';
import { cliExitCode } from '../src/cli.js';
const fixture = fileURLToPath(new URL('./fixtures/npm-dependencies', import.meta.url));
const cli = fileURLToPath(new URL('../bin/reprocapsule.js', import.meta.url));

async function source(t, files) {
  const root = await temporary(t), repo = path.join(root, 'repo');
  await mkdir(repo);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await writeFile(path.join(repo, file), content);
  }
  return { root, repo, output: path.join(root, 'capsule') };
}

test('real npm reduction retains required packages, updates lock, and independently verifies', async (t) => {
  const root = await temporary(t), before = await fingerprint(fixture);
  const output = path.join(root, 'capsule');
  const result = await buildCapsule({ repo: fixture, output, command: 'npm test', offline: true });
  assert.equal(result.manifest.dependencies.originalCount, 5);
  assert.equal(result.manifest.dependencies.finalCount, 2);
  assert.deepEqual(result.manifest.dependencies.retained, ['dependencies:@repro/helper', 'dependencies:@repro/parser']);
  assert.equal(result.manifest.reduction.originalFileCount, 14);
  assert.equal(result.manifest.reduction.finalFileCount, 6);
  assert.equal(result.verification.install, 'pass');
  await assert.rejects(access(path.join(output, 'node_modules')));
  const pkg = JSON.parse(await readFile(path.join(output, 'package.json')));
  const lock = JSON.parse(await readFile(path.join(output, 'package-lock.json')));
  assert.deepEqual(pkg.dependencies, lock.packages[''].dependencies);
  assert.deepEqual(pkg.devDependencies, {});
  assert.deepEqual(pkg.optionalDependencies, {});
  assert.equal(Object.keys(lock.packages).some((name) => name.includes('unused')), false);
  assert.equal(await fingerprint(fixture), before);
  const capsuleBefore = await fingerprint(output);
  const verified = spawnSync(process.execPath, [cli, 'verify', output, '--offline', '--json'], { encoding: 'utf8' });
  assert.equal(verified.status, 0, verified.stderr + verified.stdout);
  assert.equal(JSON.parse(verified.stdout).verified, true);
  assert.equal(await fingerprint(output), capsuleBefore);
  await writeFile(path.join(output, 'profile.json'), '{"displayName":"changed"}');
  const corrupted = spawnSync(process.execPath, [cli, 'verify', output, '--offline', '--json'], { encoding: 'utf8' });
  assert.equal(corrupted.status, 5);
  assert.equal(JSON.parse(corrupted.stdout).code, 'INTEGRITY_FAILED');
});

test('strict predicate remains default; explicit stderr matcher is opt-in and rejects success/timeouts', () => {
  const result = { exitCode: 1, signal: null, timedOut: false, outputExceeded: false, stderr: 'TypeError: target\nrandom=1', stdout: '' };
  const expected = failureSignature(result);
  const changed = { ...result, stderr: 'TypeError: target\nrandom=2' };
  assert.equal(matchesPredicate(createPredicate(), expected, changed, '/tmp'), false);
  const explicit = createPredicate({ matchStderr: 'TypeError: target' });
  assert.equal(matchesPredicate(explicit, expected, changed, '/tmp'), true);
  for (const extra of [{ exitCode: 0 }, { timedOut: true }, { outputExceeded: true }, { stderr: 'other failure' }]) {
    assert.equal(matchesPredicate(explicit, expected, { ...changed, ...extra }, '/tmp'), false);
  }
});

test('configured baseline repetitions catch a later disagreeing run', async (t) => {
  const { root, repo, output } = await source(t, { 'data.txt': 'irrelevant' });
  const counter = path.join(root, 'counter');
  const command = `node -e 'const fs=require("node:fs");const p=${JSON.stringify(counter)};const n=fs.existsSync(p)?Number(fs.readFileSync(p)):0;fs.writeFileSync(p,String(n+1));console.error(n<2?"target":"different");process.exit(1)'`;
  await assert.rejects(buildCapsule({ repo, output, command, baselineRuns: 3 }), { code: 'UNSTABLE_BASELINE' });
  await assert.rejects(access(output));
});

test('explicit predicate supports variable diagnostics across clean baseline repetitions', async (t) => {
  const { repo, output } = await source(t, { 'run.cjs': 'console.error("target error",Math.random());process.exit(1)' });
  const result = await buildCapsule({ repo, output, command: 'node run.cjs', matchStderr: 'target error', baselineRuns: 3 });
  assert.equal(result.manifest.failurePredicate.userDefined, true);
  assert.equal(result.manifest.reduction.baselineRuns, 3);
  assert.equal((await verifyCapsule({ capsule: output })).verified, true);
});

test('run budget preserves best verified partial state and reserves final verification', async (t) => {
  const { repo, output } = await source(t, { 'run.cjs': 'console.error("target");process.exit(1)', 'unused.txt': 'unused' });
  const result = await buildCapsule({ repo, output, command: 'node run.cjs', maxRuns: 4 });
  assert.equal(result.manifest.reduction.reproductionAttempts, 4);
  assert.equal(result.manifest.reduction.terminationReason, 'max-runs');
  assert.equal(result.manifest.reduction.complete, false);
  assert.match(result.manifest.reduction.guarantee, /PARTIAL/);
  assert.equal(result.verification.verified, true);
});

test('time budget stops reduction but still verifies a partial capsule', async (t) => {
  const { repo, output } = await source(t, { 'run.cjs': 'setTimeout(()=>{console.error("target");process.exit(1)},25)', 'unused': 'unused' });
  const result = await buildCapsule({ repo, output, command: 'node run.cjs', maxTimeMs: 1 });
  assert.equal(result.manifest.reduction.terminationReason, 'max-time');
  assert.equal(result.verification.verified, true);
});

test('repeated candidate configurations hit the in-memory cache', async (t) => {
  const { repo, output } = await source(t, { a: 'required', b: 'unused', c: 'unused', d: 'required' });
  const command = `node -e 'const fs=require("node:fs");fs.readFileSync("a");fs.readFileSync("d");console.error("target");process.exit(1)'`;
  const result = await buildCapsule({ repo, output, command });
  assert.deepEqual(result.manifest.retainedFiles, ['a', 'd']);
  assert.ok(result.manifest.reduction.cacheHits > 0);
  assert.ok(result.manifest.reduction.reproductionAttempts < result.manifest.reduction.candidateAttempts + 4);
});

test('protected directories remain, recorded hashes detect tampering, extra files are refused', async (t) => {
  const { repo, output } = await source(t, { 'run.cjs': 'console.error("target");process.exit(1)', 'config/keep.json': '{}', 'unused': 'unused' });
  const result = await buildCapsule({ repo, output, command: 'node run.cjs', keep: ['./config/'] });
  assert.ok(result.manifest.retainedFiles.includes('config/keep.json'));
  assert.match(result.manifest.fileHashes['config/keep.json'], /^[a-f0-9]{64}$/);
  assert.match(result.manifest.sourceSnapshotId, /^[a-f0-9]{64}$/);
  await writeFile(path.join(output, 'extra.cjs'), 'unexpected');
  await assert.rejects(verifyCapsule({ capsule: output }), { code: 'INTEGRITY_FAILED' });
});

test('JSON mode and partial/invalid input exit codes are stable', async (t) => {
  const { repo, output } = await source(t, { 'run.cjs': 'console.error("target");process.exit(1)', 'unused': 'unused' });
  const result = spawnSync(process.execPath, [cli, 'reduce', '--repo', repo, '--command', 'node run.cjs', '--out', output, '--max-runs', '4', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 7, result.stderr);
  const data = JSON.parse(result.stdout);
  assert.equal(data.verified, true);
  assert.equal(data.complete, false);
  assert.equal(data.runs, 4);
  const invalid = spawnSync(process.execPath, [cli, '--json', '--unknown'], { encoding: 'utf8' });
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).success, false);
  for (const [code, expected] of [['INVALID_BASELINE', 3], ['UNSTABLE_BASELINE', 4], ['CAPSULE_VERIFICATION_FAILED', 5], ['INSTALL_FAILED', 6]]) assert.equal(cliExitCode({ code }), expected);
});
