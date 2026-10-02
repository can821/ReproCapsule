import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, access, readdir, chmod, stat } from 'node:fs/promises';
import path from 'node:path';
import { temporary, fingerprint } from './helpers.js';
import { buildCapsule } from '../src/capsule.js';
import { readCheckpoint, resumeOptions } from '../src/checkpoint.js';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cli = fileURLToPath(new URL('../bin/reprocapsule.js', import.meta.url));
async function fixture(t) {
  const root = await temporary(t), repo = path.join(root, 'repo'), checkpoint = path.join(root, 'progress.json');
  await mkdir(repo);
  for (const name of ['a', 'b', 'c', 'd']) await writeFile(path.join(repo, name), name);
  const command = `node -e 'const fs=require("node:fs");fs.readFileSync("a");fs.readFileSync("d");console.error("target");process.exit(1)'`;
  return { root, repo, checkpoint, command, output: path.join(root, 'partial') };
}

test('budget checkpoint resumes retained progress with fresh budgets and independent verification', async (t) => {
  const options = await fixture(t), before = await fingerprint(options.repo);
  const partial = await buildCapsule({ ...options, maxRuns: 8 });
  assert.equal(partial.manifest.reduction.complete, false);
  const checkpoint = await readCheckpoint(options.checkpoint);
  assert.ok(checkpoint.state.files.length < 4);
  assert.equal(checkpoint.counters.reproductionAttempts, 8);
  assert.equal(JSON.stringify(checkpoint).includes('node_modules'), false);
  const output = path.join(options.root, 'complete');
  const resumed = spawnSync(process.execPath, [cli, 'resume', options.checkpoint, '--out', output, '--max-runs', '30', '--json'], { encoding: 'utf8' });
  assert.equal(resumed.status, 0, resumed.stderr + resumed.stdout);
  const result = JSON.parse(await readFile(path.join(output, 'capsule.json')));
  assert.deepEqual(result.retainedFiles, ['a', 'd']);
  assert.equal(result.continuation.resumed, true);
  assert.equal(result.continuation.priorReproductionAttempts, 8);
  assert.equal((await readCheckpoint(options.checkpoint)).status, 'complete');
  assert.equal(await fingerprint(options.repo), before);
});

test('accepted progress is atomically saved before an interruption; no stale workspace is needed', async (t) => {
  const options = await fixture(t);
  await assert.rejects(buildCapsule({ ...options, onProgress(event) { if (event.phase === 'reduction') throw new Error('simulated interrupt'); } }), /simulated interrupt/);
  const checkpoint = await readCheckpoint(options.checkpoint);
  assert.ok(checkpoint.state.files.length < 4);
  assert.equal(checkpoint.status, 'running');
  assert.equal((await readdir(options.root)).some((name) => name.endsWith('.tmp')), false);
  await assert.rejects(access(options.output));
  const result = await buildCapsule({ ...await resumeOptions(options.checkpoint), output: path.join(options.root, 'resumed') });
  assert.deepEqual(result.manifest.retainedFiles, ['a', 'd']);
});

test('source edits, runtime mismatch, invalid schema and malformed checkpoints refuse resume', async (t) => {
  const options = await fixture(t);
  await buildCapsule({ ...options, maxRuns: 4 });
  const original = await readFile(options.checkpoint, 'utf8');
  await writeFile(path.join(options.repo, 'b'), 'edited');
  await assert.rejects(buildCapsule({ ...await resumeOptions(options.checkpoint), output: path.join(options.root, 'changed') }), { code: 'SOURCE_CHANGED' });
  await writeFile(path.join(options.repo, 'b'), 'b');
  const mode = (await stat(path.join(options.repo, 'b'))).mode & 0o777;
  await chmod(path.join(options.repo, 'b'), mode ^ 0o100);
  await assert.rejects(buildCapsule({ ...await resumeOptions(options.checkpoint), output: path.join(options.root, 'mode') }), { code: 'SOURCE_CHANGED' });
  await chmod(path.join(options.repo, 'b'), mode);
  const incompatible = JSON.parse(original); incompatible.runtime.node = 'v0.0.0';
  await writeFile(options.checkpoint, JSON.stringify(incompatible));
  await assert.rejects(buildCapsule({ ...await resumeOptions(options.checkpoint), output: path.join(options.root, 'runtime') }), { code: 'CHECKPOINT_INCOMPATIBLE' });
  incompatible.schemaVersion = 99;
  await writeFile(options.checkpoint, JSON.stringify(incompatible));
  await assert.rejects(readCheckpoint(options.checkpoint), { code: 'CHECKPOINT_INCOMPATIBLE' });
  await writeFile(options.checkpoint, '{');
  await assert.rejects(readCheckpoint(options.checkpoint), { code: 'INVALID_CHECKPOINT' });
});

test('checkpoint cannot overwrite user files, enter source, or silently enable install scripts', async (t) => {
  const options = await fixture(t);
  await assert.rejects(buildCapsule({ ...options, checkpoint: path.join(options.repo, 'save.json') }), { code: 'UNSAFE_OUTPUT' });
  await buildCapsule({ ...options, maxRuns: 4 });
  await assert.rejects(buildCapsule({ ...options, output: path.join(options.root, 'new') }), { code: 'OUTPUT_EXISTS' });
  const state = await readCheckpoint(options.checkpoint); state.config.allowInstallScripts = true;
  await writeFile(options.checkpoint, JSON.stringify(state));
  await assert.rejects(resumeOptions(options.checkpoint), { code: 'CHECKPOINT_SCRIPTS_REQUIRED' });
});

test('npm resume rebuilds the reduced lock in fresh workspaces without persisting installed modules', async (t) => {
  const root = await temporary(t), repo = fileURLToPath(new URL('./fixtures/npm-dependencies', import.meta.url));
  const checkpoint = path.join(root, 'npm-progress.json'), before = await fingerprint(repo);
  const partial = await buildCapsule({ repo, checkpoint, output: path.join(root, 'partial'), command: 'npm test', offline: true, maxRuns: 12 });
  assert.equal(partial.manifest.reduction.complete, false);
  const state = await readCheckpoint(checkpoint);
  assert.ok(state.state.dependencies.length < 5);
  assert.equal(state.state.phase, 'dependencies');
  const resumed = await buildCapsule({ ...await resumeOptions(checkpoint), output: path.join(root, 'finished') });
  assert.equal(resumed.manifest.dependencies.finalCount, 2);
  assert.equal(resumed.manifest.reduction.finalFileCount, 6);
  assert.equal(resumed.verification.install, 'pass');
  assert.equal(await fingerprint(repo), before);
});
