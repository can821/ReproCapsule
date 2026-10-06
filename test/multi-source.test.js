import test from 'node:test';import assert from 'node:assert/strict';
import path from 'node:path';import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {temporary,fingerprint} from './helpers.js';import {buildCapsule} from '../src/capsule.js';import {resumeOptions} from '../src/checkpoint.js';
async function fixture(t,ts=false) {
 const root=await temporary(t),repo=path.join(root,'repo');await mkdir(repo);
 const ext=ts?'ts':'cjs';
 const main=ts?"import {fail} from './helper';\nconst unused = 123;\nfail();\n":"const {fail} = require('./helper.cjs');\nconst unused = 123;\nfail();\n";
 const helper=ts?"export function fail(): never {\n const noise = 42;\n throw new Error('MULTI_TARGET');\n}\n":"exports.fail = function fail() {\n const noise = 42;\n throw new Error('MULTI_TARGET');\n};\n";
 await writeFile(path.join(repo,`app.${ext}`),main);await writeFile(path.join(repo,`helper.${ext}`),helper);await writeFile(path.join(repo,'spare.cjs'),'module.exports=1;\n');
 let command='node app.cjs';
 if(ts){const parser=process.env.REPROCAPSULE_TYPESCRIPT || path.resolve('node_modules/typescript/lib/typescript.js');command=`node '${path.join(path.dirname(parser),'tsc.js')}' app.ts helper.ts --outDir dist --noEmitOnError --strict --target es2022 --module commonjs && node dist/app.js`;}
 return {root,repo,command,reduceSourceAll:true,sourceParser:process.env.REPROCAPSULE_TYPESCRIPT,...(ts?{matcher:{all:[{field:'exitCode',equals:1},{field:'exception',contains:'Error: MULTI_TARGET'}]}}:{})};
}
for(const ts of [false,true])test(`multi-file ${ts?'TypeScript real build':'JavaScript strict target'} reduces both files and converges`,async t=>{
 const f=await fixture(t,ts),before=await fingerprint(f.repo);const r=await buildCapsule({...f,output:path.join(f.root,'out'),converge:true});
 assert.equal(r.verification.verified,true);assert.equal(r.manifest.convergence.stable,true);assert.equal(r.manifest.sourceReduction.filesReduced,2);
 for(const file of r.manifest.retainedFiles){const text=await readFile(path.join(r.output,file),'utf8');assert.ok(!text.includes('unused'));assert.ok(!text.includes('noise'));}
 assert.equal(await fingerprint(f.repo),before);t.diagnostic(JSON.stringify(r.manifest.sourceReduction));
});
test('multi-file budget checkpoints resume accepted recipes with the same target',async t=>{
 const f=await fixture(t),checkpoint=path.join(f.root,'progress.json');
 const partial=await buildCapsule({...f,checkpoint,sourceMaxRuns:1,output:path.join(f.root,'partial')});assert.equal(partial.manifest.reduction.terminationReason,'source-max-runs');
 const saved=JSON.parse(await readFile(checkpoint));assert.equal(saved.state.sourceInput.mode,'multiple');
 const r=await buildCapsule({...await resumeOptions(checkpoint),sourceMaxRuns:100,output:path.join(f.root,'resumed')});
 assert.equal(r.verification.verified,true);assert.equal(r.manifest.sourceReduction.filesReduced,2);
});
