import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {temporary} from './helpers.js';
import {buildCapsule} from '../src/capsule.js';
import {resumeOptions} from '../src/checkpoint.js';
async function fixture(t) {
 const root=await temporary(t),repo=path.join(root,'repo');await mkdir(repo);
 await writeFile(path.join(repo,'app.cjs'),"require('./extra.cjs');\nthrow new Error('TARGET');\n");
 await writeFile(path.join(repo,'extra.cjs'),'module.exports = 42;\n');
 return {root,repo,command:'node app.cjs',reduceSource:'app.cjs',sourceParser:process.env.REPROCAPSULE_TYPESCRIPT,converge:true};
}
test('convergence revisits files after source deletion then proves a no-change round',async t=>{
 const f=await fixture(t),r=await buildCapsule({...f,output:path.join(f.root,'out'),audit:true});
 assert.equal(r.manifest.convergence.stable,true);
 assert.equal(r.manifest.convergence.rounds.length,3);
 assert.deepEqual(r.manifest.retainedFiles,['app.cjs']);
 assert.equal(r.manifest.domainAudit.files,'PASS');assert.equal(r.manifest.domainAudit.source,'NOT AUDITED');
 assert.equal(r.verification.verified,true);
});
test('hard round limit is partial and resume continues from retained state',async t=>{
 const f=await fixture(t),checkpoint=path.join(f.root,'checkpoint.json');
 const partial=await buildCapsule({...f,checkpoint,maxRounds:1,output:path.join(f.root,'partial')});
 assert.equal(partial.manifest.reduction.complete,false);assert.equal(partial.manifest.reduction.terminationReason,'max-rounds');
 const resumed=await buildCapsule({...await resumeOptions(checkpoint),maxRounds:5,output:path.join(f.root,'resumed')});
 assert.equal(resumed.manifest.convergence.rounds.length,3);assert.equal(resumed.manifest.convergence.stable,true);assert.deepEqual(resumed.manifest.retainedFiles,['app.cjs']);
});
