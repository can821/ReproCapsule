import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { temporary, fingerprint } from './helpers.js';
import { buildCapsule } from '../src/capsule.js';
import { resumeOptions } from '../src/checkpoint.js';
import { verifyCapsule } from '../src/verify.js';
import { loadSourceInput } from '../src/source-input.js';
const sourceParser=process.env.REPROCAPSULE_TYPESCRIPT;
async function fixture(t) {
 const root=await temporary(t),repo=path.join(root,'source');await mkdir(repo);
 const text=Array.from({length:16},(_,i)=>`function irrelevant${i}() { return ${i}; }`).join('\n')+'\nfunction failure(value) { return value.name.trim(); }\nfailure({});\n';
 await writeFile(path.join(repo,'app.cjs'),text);return {root,repo,text};
}
test('AST-selected source shrinks while exact failure and original bytes remain intact',async t=>{
 const {root,repo,text}=await fixture(t),before=await fingerprint(repo);
 const r=await buildCapsule({repo,command:'node app.cjs',output:path.join(root,'out'),reduceSource:'app.cjs',sourceParser});
 assert.equal(r.manifest.sourceReduction.originalStatements,18);assert.equal(r.manifest.sourceReduction.finalStatements,2);
 assert.ok(r.manifest.sourceReduction.finalBytes<Buffer.byteLength(text)/4);
 assert.equal((await verifyCapsule({capsule:r.output})).verified,true);assert.equal(await fingerprint(repo),before);
});
test('source budget checkpoints store AST selection recipes and resume the same failure',async t=>{
 const {root,repo}=await fixture(t),checkpoint=path.join(root,'checkpoint.json');
 const r=await buildCapsule({repo,command:'node app.cjs',output:path.join(root,'partial'),reduceSource:'app.cjs',sourceParser,sourceMaxRuns:1,checkpoint});
 assert.equal(r.manifest.reduction.terminationReason,'source-max-runs');
 assert.equal((await readFile(checkpoint,'utf8')).includes('function failure'),false);
 const resumed=await buildCapsule({...await resumeOptions(checkpoint),output:path.join(root,'final'),sourceMaxRuns:100});
 assert.equal(resumed.manifest.sourceReduction.finalStatements,2);assert.equal(resumed.verification.verified,true);
});
test('source parser rejects malformed source and incompatible saved parser identities',async t=>{
 const {repo}=await fixture(t);
 await assert.rejects(loadSourceInput(repo,['app.cjs'],'app.cjs',sourceParser,{file:'app.cjs',parserVersion:'different',retained:[]}),{code:'CHECKPOINT_INCOMPATIBLE'});
 await writeFile(path.join(repo,'app.cjs'),'function broken(');
 await assert.rejects(loadSourceInput(repo,['app.cjs'],'app.cjs',sourceParser),{code:'INVALID_INPUT'});
});
test('hierarchical JS reduction removes nested statements and class members while preserving exact failure', async t => {
 const root=await temporary(t),repo=path.join(root,'source');await mkdir(repo);
 const text=`class Example {
 unused() { return 123; }
 run() {
  const noise = 42;
  if (true) {
   const nestedNoise = 99;
   throw new Error('DEEP_TARGET');
  }
 }
}
new Example().run();
`;
 await writeFile(path.join(repo,'app.cjs'),text);
 const r=await buildCapsule({repo,command:'node app.cjs',output:path.join(root,'out'),reduceSource:'app.cjs',sourceParser});
 const reduced=await readFile(path.join(r.output,'app.cjs'),'utf8');
 assert.ok(!reduced.includes('unused'));assert.ok(!reduced.includes('noise'));assert.ok(!reduced.includes('nestedNoise'));
 assert.ok(reduced.includes('DEEP_TARGET'));assert.ok(r.manifest.sourceReduction.finalAstUnits<r.manifest.sourceReduction.originalAstUnits);
 assert.equal(r.verification.verified,true);
 t.diagnostic(JSON.stringify(r.manifest.sourceReduction));
});
test('nested TypeScript reduction executes a real compiler and rejects invalid build candidates',async t=>{
 const root=await temporary(t),repo=path.join(root,'source');await mkdir(repo);
 const text=`class Example {
 unused(): number { return 123; }
 run(): never {
  const message: string = 'TS_TARGET';
  const noise: number = 42;
  throw new Error(message);
 }
}
new Example().run();
`;
 await writeFile(path.join(repo,'app.ts'),text);
 const parser=sourceParser || path.resolve('node_modules/typescript/lib/typescript.js');
 const compiler=path.join(path.dirname(parser),'tsc.js');
 const command=`node '${compiler.replaceAll("'", "'\\''")}' app.ts --outDir dist --noEmitOnError --strict --target es2022 && node dist/app.js`;
 const r=await buildCapsule({repo,command,output:path.join(root,'out'),reduceSource:'app.ts',sourceParser,matchStderr:'Error: TS_TARGET'});
 const reduced=await readFile(path.join(r.output,'app.ts'),'utf8');
 assert.ok(!reduced.includes('unused'));assert.ok(!reduced.includes('noise'));assert.ok(reduced.includes('const message'));
 assert.equal(r.verification.verified,true);assert.ok(r.manifest.sourceReduction.rejections.targetChanged>0);
 t.diagnostic(JSON.stringify({bytes:[text.length,reduced.length],attempts:r.manifest.sourceReduction.attempts,units:[r.manifest.sourceReduction.originalAstUnits,r.manifest.sourceReduction.finalAstUnits]}));
});
test('source attempt limit applies even when global budget callback returns null',async t=>{
 const {repo}=await fixture(t);const value=await loadSourceInput(repo,['app.cjs'],'app.cjs',sourceParser);
 const r=await value.reduce(async()=>false,{maxAttempts:1,shouldStop:()=>null});
 assert.equal(r.attempts,1);assert.equal(r.terminationReason,'source-max-runs');
});
