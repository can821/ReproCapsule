import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { temporary, fingerprint } from './helpers.js';
import { buildCapsule } from '../src/capsule.js';
import { verifyCapsule } from '../src/verify.js';
import { resumeOptions } from '../src/checkpoint.js';
import { createWorkspace } from '../src/workspace.js';
import { detectPackageManager } from '../src/package-manager.js';
const repo=fileURLToPath(new URL('./fixtures/npm-workspaces',import.meta.url));

test('npm workspace groups reduce with local dependency closure and independent clean installs',async t=>{
 const root=await temporary(t),before=await fingerprint(repo);
 const r=await buildCapsule({repo,command:'npm test',output:path.join(root,'capsule'),offline:true,audit:true});
 assert.equal(r.manifest.workspaces.originalCount,4);assert.equal(r.manifest.workspaces.finalCount,2);
 assert.deepEqual(r.manifest.workspaces.retained.map(w=>w.name),['@capsule/app','@capsule/core']);
 assert.equal(r.manifest.retainedFiles.some(f=>f.includes('/unused/')||f.includes('/extra/')),false);
 const pkg=JSON.parse(await readFile(path.join(r.output,'package.json')));
 const lock=JSON.parse(await readFile(path.join(r.output,'package-lock.json')));
 assert.deepEqual(pkg.workspaces,['packages/app','packages/core']);assert.deepEqual(lock.packages[''].workspaces,pkg.workspaces);
 assert.equal((await verifyCapsule({capsule:r.output,offline:true})).verified,true);
 assert.equal(await fingerprint(repo),before);
});
test('workspace budget checkpoint resumes safely and explicit keep protects a workspace',async t=>{
 const root=await temporary(t),checkpoint=path.join(root,'state.json');
 const partial=await buildCapsule({repo,command:'npm test',output:path.join(root,'partial'),checkpoint,offline:true,maxRuns:5,keep:['packages/unused']});
 assert.equal(partial.manifest.reduction.complete,false);
 const resumed=await buildCapsule({...await resumeOptions(checkpoint),output:path.join(root,'resumed')});
 assert.equal(resumed.manifest.workspaces.finalCount,3);
 assert.ok(resumed.manifest.retainedFiles.includes('packages/unused/notes.txt'));
 assert.equal(resumed.verification.verified,true);
});
test('unsupported workspace patterns and stale workspace locks are rejected',async t=>{
 const w=await createWorkspace(repo);t.after(()=>w.cleanup());const cwd=await w.materialize(w.files);
 const pkg=JSON.parse(await readFile(path.join(cwd,'package.json')));
 for(const pattern of ['../external','packages/**','packages/{app,core}']){
  await writeFile(path.join(cwd,'package.json'),JSON.stringify({...pkg,workspaces:[pattern]}));
  await assert.rejects(detectPackageManager(cwd,w.files),{code:'UNSUPPORTED_PACKAGE_MANAGER'});
 }
 await writeFile(path.join(cwd,'package.json'),JSON.stringify(pkg));
 const lock=JSON.parse(await readFile(path.join(cwd,'package-lock.json')));lock.packages['packages/app'].dependencies={};
 await writeFile(path.join(cwd,'package-lock.json'),JSON.stringify(lock));
 await assert.rejects(detectPackageManager(cwd,w.files),{code:'INVALID_LOCKFILE'});
});
