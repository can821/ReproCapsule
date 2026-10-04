// Run after: python3 corpus/prepare.py work/corpus-source
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCapsule } from '../src/capsule.js';
import { verifyCapsule } from '../src/verify.js';
import { inventory } from '../src/workspace.js';
import { fileHashes, snapshotId } from '../src/integrity.js';
const cases = JSON.parse(await readFile(new URL('../corpus/cases.json', import.meta.url)));
const source = path.resolve(process.argv[2] ?? 'work/corpus-source');
const output = path.resolve(process.argv[3] ?? 'work/corpus-results');
await mkdir(output, { recursive: false });
const results = [];
for (const entry of cases) {
  const repo = path.join(source, entry.name);
  const original = await inventory(repo);
  const before = snapshotId({ hashes: await fileHashes(repo, original.files), modes: original.modes });
  const keep = original.files.filter(file => /^licen[sc]e(?:\.|$)/i.test(file));
  const started = Date.now();
  let result;
  try {
    const reduced = await buildCapsule({ repo, output: path.join(output, entry.name), command: 'node probe.cjs', keep, audit: true, maxRuns: 250, maxTimeMs: 60_000 });
    const verification = await verifyCapsule({ capsule: reduced.output, offline: true });
    const after = await inventory(repo);
    const unchanged = before === snapshotId({ hashes: await fileHashes(repo, after.files), modes: after.modes });
    result = { ...entry, runtime: process.version, packageManager: 'npm production snapshot; no production dependencies', testRunner: 'node probe.cjs',
      reduction: reduced.manifest.reduction, dependencies: { original: 0, final: 0 }, input: 'not requested', sourceReduction: 'not implemented',
      verification, originalUnchanged: unchanged, localisation: reduced.manifest.diagnostics, minimality: reduced.manifest.minimality,
      elapsedMs: Date.now() - started, success: verification.verified && unchanged && reduced.manifest.reduction.complete };
  } catch (error) { result = { ...entry, success: false, error: { code: error.code, message: error.message }, elapsedMs: Date.now() - started }; }
  results.push(result);
  console.log(JSON.stringify({ project: entry.name, success: result.success, before: result.reduction?.originalFileCount, after: result.reduction?.finalFileCount, runs: result.reduction?.reproductionAttempts, elapsedMs: result.elapsedMs, error: result.error }));
  await writeFile(path.join(output, 'results.json'), JSON.stringify({ schemaVersion: 1, scope: 'Independent production distributions with authored negative-input probes; not historical upstream bugs or full upstream test suites.', results }, null, 2)+'\n');
}
if (results.some(result => !result.success)) process.exitCode = 1;
