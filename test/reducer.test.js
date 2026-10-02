import test from 'node:test';
import assert from 'node:assert/strict';
import { reduceFiles } from '../src/reducer.js';

test('chunk reducer retains interacting necessary files and removes irrelevant files', async () => {
  const files = Array.from({ length: 24 }, (_, i) => `file-${String(i).padStart(2, '0')}`);
  const required = ['file-03', 'file-13', 'file-21'];
  const predicate = async (candidate) => required.every((file) => candidate.includes(file));
  const a = await reduceFiles(files, predicate), b = await reduceFiles(files, predicate);
  assert.deepEqual(a.retained, required);
  assert.deepEqual(a, b);
  assert.ok(a.accepted < 21, 'removals must include chunks, not only individual files');
  for (const file of a.retained) assert.equal(await predicate(a.retained.filter((value) => value !== file)), false);
});

test('reducer handles empty, wholly irrelevant and wholly required sets', async () => {
  assert.deepEqual((await reduceFiles([], async () => true)).retained, []);
  assert.deepEqual((await reduceFiles(['a', 'b'], async () => true)).retained, []);
  assert.deepEqual((await reduceFiles(['a', 'b'], async (files) => files.length === 2)).retained, ['a', 'b']);
});

test('reducer propagates oracle errors instead of accepting uncertainty', async () => {
  await assert.rejects(reduceFiles(['a', 'b'], async () => { throw new Error('runner unavailable'); }), /runner unavailable/);
});
