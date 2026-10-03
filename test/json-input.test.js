import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCapsule } from '../src/capsule.js';
import { resumeOptions, readCheckpoint } from '../src/checkpoint.js';
import { temporary, fingerprint } from './helpers.js';
import { verifyCapsule } from '../src/verify.js';
const repo = fileURLToPath(new URL('./fixtures/json-input', import.meta.url));

test('structured input shrinks substantially, stays valid JSON, and independently reproduces the same error', async (t) => {
  const root = await temporary(t), output = path.join(root, 'capsule'), before = await fingerprint(repo);
  const { manifest } = await buildCapsule({ repo, output, command: 'node repro.cjs', reduceInput: 'request.json', audit: true });
  const reduced = JSON.parse(await readFile(path.join(output, 'request.json')));
  assert.deepEqual(reduced, { items: [{ kind: 'trigger', payload: { enabled: true } }] });
  assert.ok(manifest.inputReduction.finalBytes < manifest.inputReduction.originalBytes / 20);
  assert.equal(manifest.inputReduction.complete, true);
  assert.equal(manifest.minimality.status, 'PASS');
  assert.equal(manifest.explanations.files['request.json'].classification, 'PROTECTED');
  assert.equal(await fingerprint(repo), before);
  assert.equal((await verifyCapsule({ capsule: output })).verified, true);
});

test('input budget persists value-free edit recipes and resume reconstructs the accepted input', async (t) => {
  const root = await temporary(t), checkpoint = path.join(root, 'checkpoint.json');
  const partial = await buildCapsule({ repo, output: path.join(root, 'partial'), checkpoint, command: 'node repro.cjs', reduceInput: 'request.json', inputMaxRuns: 2 });
  assert.equal(partial.manifest.reduction.terminationReason, 'input-max-runs');
  const saved = await readCheckpoint(checkpoint);
  assert.equal(saved.state.phase, 'input');
  assert.ok(saved.state.input.operations.length > 0);
  const text = await readFile(checkpoint, 'utf8');
  assert.equal(text.includes('Synthetic JSON request'), false);
  assert.equal(text.includes('irrelevant data'), false);
  const resumed = await buildCapsule({ ...await resumeOptions(checkpoint), output: path.join(root, 'resumed'), inputMaxRuns: 200 });
  assert.equal(resumed.manifest.inputReduction.complete, true);
  assert.equal(resumed.verification.verified, true);
});

test('JSON reduction rejects invalid input and does not silently reformat byte-sensitive input', async (t) => {
  const root = await temporary(t), source = path.join(root, 'repo');
  await mkdir(source);
  const bytes = '{ "value": 1 }\n';
  await writeFile(path.join(source, 'input.json'), bytes);
  await writeFile(path.join(source, 'app.cjs'), `const s=require('node:fs').readFileSync('input.json','utf8'); if(s===${JSON.stringify(bytes)}){console.error('target');process.exit(1)}`);
  const result = await buildCapsule({ repo: source, output: path.join(root, 'out'), command: 'node app.cjs', reduceInput: 'input.json' });
  assert.equal(await readFile(path.join(result.output, 'input.json'), 'utf8'), bytes);
  await writeFile(path.join(source, 'input.json'), '{broken');
  await assert.rejects(buildCapsule({ repo: source, output: path.join(root, 'invalid'), command: 'node app.cjs', reduceInput: 'input.json' }), { code: 'INVALID_INPUT' });
});
