import test from 'node:test';
import assert from 'node:assert/strict';
import { localiseStack } from '../src/localisation.js';
import { buildCapsule } from '../src/capsule.js';
import { temporary } from './helpers.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

test('stack ranking maps file URLs, ignores external/internal/dependency frames, and deduplicates', () => {
  const result = { stdout: '', stderr: `TypeError: target
    at internal (node:internal/foo:1:2)
    at pkg (/tmp/project/node_modules/pkg/index.js:8:4)
    at parse (file:///tmp/project/src/with%20space.js:7:11)
    at run (/tmp/project/test/repro.js:4:8)
    at external (/tmp/other/outside.js:1:1)
    at parse (file:///tmp/project/src/with%20space.js:7:11)` };
  const ranked = localiseStack(result, '/tmp/project', ['src/with space.js', 'test/repro.js', 'node_modules/pkg/index.js']);
  assert.deepEqual(ranked.locations.map(({ file, line }) => [file, line]), [['src/with space.js', 7], ['test/repro.js', 4]]);
  assert.equal(ranked.locations[0].stackDepth, 2);
  assert.equal(localiseStack({ stdout: '', stderr: 'just an error' }, '/tmp/project', []).status, 'INSUFFICIENT EVIDENCE');
});

test('real fixture ranks the known failing source line without fixture-specific logic or extra runs', async (t) => {
  const root = await temporary(t), repo = fileURLToPath(new URL('./fixtures/broken-parser', import.meta.url));
  const { manifest } = await buildCapsule({ repo, output: path.join(root, 'capsule'), command: 'node test/repro.js' });
  assert.equal(manifest.diagnostics.locations[0].file, 'src/parser.js');
  assert.equal(manifest.diagnostics.locations[0].line, 5);
  assert.equal(manifest.reduction.reproductionAttempts, 33);
  assert.equal(manifest.diagnostics.locations[0].evidence.includes('top-project-stack-frame'), true);
});
