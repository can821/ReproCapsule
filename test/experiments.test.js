import test from 'node:test';
import assert from 'node:assert/strict';
import {orderedExperiment,dependencyBoundary} from '../src/experiments.js';
test('ordered experiments report only adjacent observed pass/fail and preserve setup ambiguity',async()=>{
 const statuses=['PASS','SETUP FAILURE','FAIL','PASS','FAIL'];
 const r=await orderedExperiment({values:['a','b','c','d','e'],evaluate:async value=>({status:statuses[value.charCodeAt(0)-97]})});
 assert.deepEqual(r.boundaries,[{passing:'d',failing:'e'}]);assert.equal(r.firstTestedFailingValue,'c');assert.equal(r.complete,true);
 const limited=await orderedExperiment({values:['a','b','c'],maxExperiments:1,evaluate:async()=>({status:'PASS'})});assert.equal(limited.complete,false);assert.deepEqual(limited.boundaries,[]);
});
test('dependency experiments require pinned versions and a target before any mutation',async()=>{
 await assert.rejects(dependencyBoundary({values:['1.0.0','latest'],dependency:'sample',matchStderr:'TARGET'}),{code:'INVALID_ARGUMENTS'});
 await assert.rejects(dependencyBoundary({values:['1.0.0','2.0.0'],dependency:'sample'}),{code:'INVALID_ARGUMENTS'});
});
test('explicit monotonic search tests logarithmically and rechecks adjacent boundary',async()=>{
 const {monotonicExperiment}=await import('../src/experiments.js');
 const values=Array.from({length:32},(_,i)=>String(i));
 const r=await monotonicExperiment({values,evaluate:async value=>({status:Number(value)<13?'PASS':'FAIL'})});
 assert.equal(r.status,'FOUND');assert.deepEqual(r.boundaries,[{passing:'12',failing:'13'}]);assert.ok(r.evaluated.length<=9);
 assert.deepEqual(r.evaluated.slice(-2).map(r=>r.value),['12','13']);
 const ambiguous=await monotonicExperiment({values:['a','b','c'],evaluate:async v=>({status:v==='a'?'PASS':v==='c'?'FAIL':'SETUP FAILURE'})});assert.equal(ambiguous.status,'AMBIGUOUS');assert.deepEqual(ambiguous.boundaries,[]);
 const limited=await monotonicExperiment({values,maxExperiments:2,evaluate:async v=>({status:v==='0'?'PASS':'FAIL'})});assert.equal(limited.status,'BUDGET EXHAUSTED');assert.equal(limited.firstTestedFailingValue,null);
});
