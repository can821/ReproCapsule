import test from 'node:test';
import assert from 'node:assert/strict';
import {createPredicate,matchesPredicate} from '../src/predicate.js';
import {observeReproduction} from '../src/observe.js';
import {buildCapsule} from '../src/capsule.js';
import {temporary} from './helpers.js';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const matcher={all:[{field:'exitCode',equals:1},{field:'exception',contains:'TypeError: TARGET'},{any:[{field:'stack',contains:'app.cjs:2'},{field:'stdout',contains:'named assertion'}]}]};
test('ALL/ANY preserves named target and rejects unrelated failures and malformed predicates',()=>{
 const p=createPredicate({matcher}),r={exitCode:1,stderr:'TypeError: TARGET\n    at /tmp/app.cjs:2:1',stdout:'',signal:null};
 assert.equal(matchesPredicate(p,null,r,'/tmp'),true);
 for(const changed of [{exitCode:0},{stderr:'SyntaxError: TARGET'},{stderr:"Error: Cannot find module TARGET"},{stderr:'TypeError: OTHER\n    at /tmp/app.cjs:2:1'},{timedOut:true},{signal:'SIGTERM'}]) assert.equal(matchesPredicate(p,null,{...r,...changed},'/tmp'),false);
 for(const bad of [{all:[]},{any:[{}]},{field:'stdout',contains:''},{field:'exitCode',equals:0}]) assert.throws(()=>createPredicate({matcher:bad}),{code:'INVALID_ARGUMENTS'});
});
test('controlled intermittent observations count fresh runs and composite capsules verify',async t=>{
 const root=await temporary(t),repo=path.join(root,'repo'),counter=path.join(root,'counter');await mkdir(repo);
 await writeFile(counter,'0');
 await writeFile(path.join(repo,'app.cjs'),`const fs=require('node:fs');const file=process.argv[2];const n=Number(fs.readFileSync(file));fs.writeFileSync(file,String(n+1));if(n%2===0)throw new TypeError('TARGET');\n`);
 const m={all:[{field:'exitCode',equals:1},{field:'exception',contains:'TypeError: TARGET'}]};
 const r=await observeReproduction({repo,command:`node app.cjs '${counter}'`,runs:6,matcher:m});
 assert.equal(r.matching,3);assert.equal(r.observedReproductionRate,0.5);assert.deepEqual(r.outcomes,['TARGET','PASS','TARGET','PASS','TARGET','PASS']);
 await writeFile(path.join(repo,'app.cjs'),"throw new TypeError('TARGET');\n");
 const capsule=await buildCapsule({repo,command:'node app.cjs',output:path.join(root,'out'),matcher:m});assert.equal(capsule.verification.verified,true);
});
