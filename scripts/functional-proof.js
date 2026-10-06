import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { buildCapsule } from '../src/capsule.js';
import { runCommand } from '../src/runner.js';
import { failureSignature } from '../src/failure-signature.js';
import { verifyCapsule } from '../src/verify.js';
import { inventory, createWorkspace } from '../src/workspace.js';
import { fileHashes } from '../src/integrity.js';
const [prepared, output] = process.argv.slice(2).map(p => path.resolve(p));
const cases = JSON.parse(await readFile(new URL('../corpus/functional/cases.json', import.meta.url)));
await mkdir(output, { recursive: false });
const results = [];
for (const c of cases) {
  const repo = path.join(prepared, c.id, 'buggy'), fixed = path.join(prepared, c.id, 'fixed');
  const files = (await inventory(repo)).files;
  const before = await fileHashes(repo, files);
  const command = 'node probe.cjs';
  // Probes execute only in fresh copies, including the known fixed control.
  const fixedFiles = (await inventory(fixed)).files;
  const fixedBefore = await fileHashes(fixed, fixedFiles);
  async function probe(source) {
    const workspace = await createWorkspace(source);
    try {
      const cwd = await workspace.materialize(workspace.files);
      const result = await runCommand({cwd, command, timeoutMs: 10000});
      return {result, signature: failureSignature(result, {roots:[cwd]})};
    } finally { await workspace.cleanup(); }
  }
  const passing = (await probe(fixed)).result;
  assert.equal(passing.exitCode, 0, c.id + ' fixed version must pass');
  const failing = await probe(repo);
  assert.equal(failing.result.exitCode, 1, c.id + ' buggy version must fail');
  const signature = failing.signature;
  assert.ok(signature);
  const reduced = await buildCapsule({repo, command, output:path.join(output,c.id), keep:['LICENSE'], audit:true});
  assert.equal(reduced.manifest.failureSignature.digest, signature.digest);
  const fresh = await verifyCapsule({capsule:reduced.output});
  assert.equal(fresh.verified,true);
  assert.deepEqual((await inventory(repo)).files,files);
  assert.deepEqual(await fileHashes(repo,files),before);
  assert.deepEqual((await inventory(fixed)).files,fixedFiles);
  assert.deepEqual(await fileHashes(fixed,fixedFiles),fixedBefore);
  const m = reduced.manifest;
  results.push({id:c.id, package:c.package, upstream:c.reference, buggy:c.buggy, fixed:c.fixed,
    fixCommit:c.fixCommit,fixLocation:c.fixLocation,command,targetFailure:{strategy:signature.strategy,digest:signature.digest,exitCode:1},
    runtime:m.environment,packageManager:'npm distribution; no runtime dependencies/install required',
    adaptation:'Published production files unchanged; removed development dependencies/scripts; added upstream-derived assertion probe. Not a complete upstream development checkout.',
    files:{before:m.reduction.originalFileCount,after:m.reduction.finalFileCount},dependencies:{before:0,after:0},
    input:'Fixed upstream-derived probe; input reduction not requested',source:'Production source bytes unchanged; source reduction not requested',
    reduction:m.reduction,elapsedMs:reduced.elapsedMs,executionCount:m.reduction.reproductionAttempts+3,
    fixedPass:true,freshVerification:fresh,originalUnchanged:true,retainedFiles:m.retainedFiles,diagnostics:m.diagnostics});
  await writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2)+'\n');
  console.log(JSON.stringify({id:c.id,files:results.at(-1).files,runs:results.at(-1).executionCount,elapsedMs:reduced.elapsedMs,verified:fresh.verified}));
}
