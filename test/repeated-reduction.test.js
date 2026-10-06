import test from 'node:test';import assert from 'node:assert/strict';
import path from 'node:path';import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {temporary} from './helpers.js';import {buildCapsule} from '../src/capsule.js';import {resumeOptions} from '../src/checkpoint.js';import {verifyCapsule} from '../src/verify.js';import {repeatEvaluation,repetitionPolicy} from '../src/repetition.js';
test('bounded repeat thresholds reject unrelated and below-threshold outcomes',async()=>{
 for(const [sequence,expected] of [[[true,true,true,true],true],[[false,false,false,false],false],[[true,false,true,false],true],[[false,false,true,false],false]]){
  let i=0;const r=await repeatEvaluation(async()=>({result:{exitCode:1,stdout:'',stderr:'',target:sequence[i++]}}),o=>o.result.target,repetitionPolicy(4,0.5));
  assert.equal(r.matches,expected);assert.equal(r.evidence.total,4);
 }
 assert.throws(()=>repetitionPolicy(0,0.5));assert.throws(()=>repetitionPolicy(4,0));
});
async function fixture(t){
 const root=await temporary(t),repo=path.join(root,'repo'),counter=path.join(root,'counter');await mkdir(repo);await writeFile(counter,'0');
 await writeFile(path.join(repo,'app.cjs'),`const fs=require('node:fs');const p=process.argv[2];const n=Number(fs.readFileSync(p));fs.writeFileSync(p,String(n+1));if(n%2===0)throw new TypeError('REPEAT_TARGET');\n`);
 await writeFile(path.join(repo,'unused.txt'),'unused');
 return {root,repo,command:`node app.cjs '${counter}'`,repeatRuns:4,matchThreshold:0.5,matcher:{all:[{field:'exitCode',equals:1},{field:'exception',contains:'TypeError: REPEAT_TARGET'}]}};
}
test('intermittent candidates shrink, consume fresh batches, and verify the recorded threshold',async t=>{
 const f=await fixture(t),r=await buildCapsule({...f,output:path.join(f.root,'out')});
 assert.deepEqual(r.manifest.retainedFiles,['app.cjs']);assert.equal(r.manifest.repetitionEvidence.baseline.matching,2);
 assert.equal(r.manifest.repetitionEvidence.final.total,4);assert.equal(r.verification.repetitionEvidence.matching,2);assert.equal(r.manifest.reduction.cacheHits,0);
 assert.ok(r.manifest.repetitionEvidence.candidates.some(c=>c.accepted&&c.matching===2));
 assert.equal((await verifyCapsule({capsule:r.output})).verified,true);
 await assert.rejects(buildCapsule({...f,matchThreshold:0.75,output:path.join(f.root,'below')}),{code:'INVALID_BASELINE'});
});
test('intermittent budget reserves both final batches and resume preserves policy',async t=>{
 const f=await fixture(t),checkpoint=path.join(f.root,'progress.json');
 const r=await buildCapsule({...f,checkpoint,maxRuns:17,output:path.join(f.root,'partial')});
 assert.equal(r.manifest.reduction.complete,false);assert.ok(r.manifest.reduction.reproductionAttempts<=17);assert.equal(r.manifest.budget.finalVerificationReservedRuns,8);
 const saved=JSON.parse(await readFile(checkpoint));assert.equal(saved.config.repeatRuns,4);assert.equal(saved.config.matchThreshold,0.5);
 const resumed=await buildCapsule({...await resumeOptions(checkpoint),output:path.join(f.root,'resumed')});
 assert.deepEqual(resumed.manifest.retainedFiles,['app.cjs']);assert.equal(resumed.verification.repetitionEvidence.total,4);
});
