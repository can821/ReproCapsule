import {nodeCommand} from './helpers.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { temporary } from './helpers.js';
import { persistentCache, environmentIdentity } from '../src/candidate-cache.js';
import { buildCapsule } from '../src/capsule.js';
import { resumeOptions } from '../src/checkpoint.js';

const valid = { matches: false, conclusive: true, reason: 'failure-changed' };
test('disk outcomes are scope-bound, corruption checked, and never retain raw environment or uncertain results', async (t) => {
  const root = await temporary(t), scope = { source: 'one', environment: environmentIdentity({ TEST_SECRET: 'private-test-value' }) };
  const linked = path.join(root, 'linked');
  await mkdir(linked);
  await symlink(root, path.join(linked, 'reprocapsule-cache-v1'), process.platform==='win32'?'junction':'dir');
  await assert.rejects(persistentCache(linked, scope), { code: 'UNSAFE_CACHE' });
  const a = await persistentCache(root, scope);
  await a.set('candidate', valid);
  const b = await persistentCache(root, scope);
  assert.deepEqual(await b.get('candidate'), valid);
  assert.equal(await (await persistentCache(root, { ...scope, source: 'two' })).get('candidate'), undefined);
  assert.equal(await (await persistentCache(root, { ...scope, environment: environmentIdentity({ TEST_SECRET: 'changed' }) })).get('candidate'), undefined);
  for (const reason of ['timeout', 'INSTALL_FAILED', 'output-limit']) await b.set(reason, { matches: false, conclusive: false, reason });
  const folder = path.join(root, 'reprocapsule-cache-v1', a.scope);
  const records = await readdir(folder);
  assert.equal(records.length, 1);
  const file = path.join(folder, records[0]), text = await readFile(file, 'utf8');
  assert.equal(text.includes('private-test-value'), false);
  const record = JSON.parse(text); record.outcome.matches = true;
  await writeFile(file, JSON.stringify(record));
  assert.equal(await b.get('candidate'), undefined);
});

test('resume reuses actual prior-session outcomes but independently rechecks the final state', async (t) => {
  const root = await temporary(t), repo = path.join(root, 'repo'), checkpoint = path.join(root, 'progress.json');
  await mkdir(repo);
  for (const name of ['a', 'b', 'c', 'd']) await writeFile(path.join(repo, name), name);
  const command = nodeCommand(`const fs=require("node:fs");fs.readFileSync("a");fs.readFileSync("d");console.error("target");process.exit(1)`);
  await buildCapsule({ repo, command, output: path.join(root, 'partial'), checkpoint, cacheDir: path.join(root, 'cache'), maxRuns: 6 });
  const result = await buildCapsule({ ...await resumeOptions(checkpoint), output: path.join(root, 'finished'), audit: true });
  assert.ok(result.manifest.reduction.persistentCacheHits >= 2);
  assert.deepEqual(result.manifest.retainedFiles, ['a', 'd']);
  assert.equal(result.manifest.minimality.status, 'PASS');
  assert.equal(result.manifest.minimality.reproductionRuns, 2);
  assert.equal(result.verification.verified, true);
});

test('persistent cache cannot write into the source or output capsule', async (t) => {
  const root = await temporary(t), repo = path.join(root, 'repo'), output = path.join(root, 'out');
  await mkdir(repo);
  await assert.rejects(buildCapsule({ repo, output, command: 'exit 1', cacheDir: path.join(repo, 'cache') }), { code: 'UNSAFE_OUTPUT' });
  await assert.rejects(buildCapsule({ repo, output, command: 'exit 1', cacheDir: path.join(output, 'cache') }), { code: 'INVALID_ARGUMENTS' });
});
