import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCapsule } from '../src/capsule.js';
import { auditMinimality } from '../src/evidence.js';
import { temporary } from './helpers.js';
import { resumeOptions } from '../src/checkpoint.js';
const fixture = fileURLToPath(new URL('./fixtures/broken-parser', import.meta.url));

test('final singleton evidence explains required and control files without extra runs', async (t) => {
  const root = await temporary(t);
  const { manifest } = await buildCapsule({ repo: fixture, output: path.join(root, 'out'), command: 'node test/repro.js' });
  assert.equal(manifest.explanations.files['package.json'].classification, 'CONTROL');
  assert.equal(manifest.explanations.files['src/parser.js'].classification, 'REQUIRED');
  assert.equal(manifest.explanations.files['src/parser.js'].reason, 'module-resolution-failure');
  assert.equal(manifest.minimality.status, 'NOT PROVEN');
});

test('fresh audit proves only eligible single removals; user protection stays explicit', async (t) => {
  const root = await temporary(t), repo = path.join(root, 'repo');
  await mkdir(repo);
  await writeFile(path.join(repo, 'app.cjs'), 'console.error("target");process.exit(1)');
  await writeFile(path.join(repo, 'kept.txt'), 'protected');
  const { manifest } = await buildCapsule({ repo, output: path.join(root, 'out'), command: 'node app.cjs', keep: ['kept.txt'], audit: true });
  assert.equal(manifest.explanations.files['kept.txt'].classification, 'PROTECTED');
  assert.equal(manifest.explanations.files['app.cjs'].origin, 'fresh-audit');
  assert.equal(manifest.minimality.status, 'PASS');
  assert.equal(manifest.minimality.auditedCandidates, 1);
  assert.equal(manifest.minimality.reproductionRuns, 1);
});

test('budget audit is partial, untested evidence stays honest, and resume reruns the audit', async (t) => {
  const root = await temporary(t), checkpoint = path.join(root, 'state.json');
  const partial = await buildCapsule({ repo: fixture, checkpoint, output: path.join(root, 'partial'), command: 'node test/repro.js', audit: true, maxRuns: 4 });
  assert.equal(partial.manifest.minimality.status, 'PARTIAL');
  assert.equal(partial.manifest.explanations.files['src/parser.js'].classification, 'UNTESTED');
  const resumed = await buildCapsule({ ...await resumeOptions(checkpoint), output: path.join(root, 'resumed') });
  assert.equal(resumed.manifest.minimality.status, 'PASS');
  assert.equal(resumed.manifest.minimality.individuallyRequired, 4);
});

test('audit never certifies inconclusive installs or a still-preserving single removal', async () => {
  const base = { files: ['a'], dependencies: [], protectedFiles: [], shouldStop: () => null };
  for (const outcome of [{ matches: false, conclusive: false, reason: 'INSTALL_FAILED' }, { matches: true, conclusive: true, reason: 'failure-preserved' }]) {
    const result = await auditMinimality({ ...base, evaluate: async () => outcome });
    assert.equal(result.metadata.status, 'NOT PROVEN');
    assert.equal(result.metadata.individuallyRequired, 0);
  }
});
