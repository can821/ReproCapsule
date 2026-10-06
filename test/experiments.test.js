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
