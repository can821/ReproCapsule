import {quote} from '../src/package-manager.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile} from 'node:fs/promises';
import {temporary,fingerprint} from './helpers.js';
import {compareExecutions} from '../src/compare.js';
test('passing comparison separates executed files, retains mapped stack evidence, and preserves inputs',async t=>{
 const root=await temporary(t),repo=path.join(root,'repo');await mkdir(repo);
 await writeFile(path.join(repo,'app.cjs'),"require('./shared.cjs');\nif(process.argv[2] === 'fail') require('./fault.cjs');\n");
 await writeFile(path.join(repo,'shared.cjs'),'module.exports = 1;\n');
 await writeFile(path.join(repo,'fault.cjs'),"throw new Error('TARGET');\n");
 const before=await fingerprint(repo),r=await compareExecutions({repo,command:'node app.cjs fail',passingCommand:'node app.cjs pass'});
 assert.deepEqual(r.failingOnly,['fault.cjs']);assert.deepEqual(r.shared,['app.cjs','shared.cjs']);
 assert.equal(r.failing.stack.locations[0].file,'fault.cjs');assert.equal(await fingerprint(repo),before);
 await assert.rejects(compareExecutions({repo,command:'node app.cjs fail',passingCommand:'node app.cjs fail'}),{code:'INVALID_COMPARISON'});
});
test('region evidence separates branches and conservatively refuses changed-source alignment',async t=>{
 const root=await temporary(t),repo=path.join(root,'repo');await mkdir(repo);
 await writeFile(path.join(repo,'app.cjs'),"function failure() {\n throw new Error('REGION_TARGET');\n}\nfunction passing() {\n return 42;\n}\nif(process.argv[2]==='fail') failure(); else passing();\n");
 const r=await compareExecutions({repo,command:'node app.cjs fail',passingCommand:'node app.cjs pass'});
 assert.ok(r.differential.failingOnly.find(r=>r.file==='app.cjs').lines.includes(2));
 assert.ok(r.differential.passingOnly.find(r=>r.file==='app.cjs').lines.includes(5));
 const {differentialCoverage}=await import('../src/coverage.js');
 assert.equal(differentialCoverage([{file:'a',sourceHash:'x',lines:[1]}],[{file:'a',sourceHash:'y',lines:[1]}]).uncompared.length,1);
});
test('real compiled TypeScript coverage maps executed regions back to retained source',async t=>{
 const root=await temporary(t),repo=path.join(root,'repo');await mkdir(repo);
 await writeFile(path.join(repo,'app.ts'),"declare const process: {argv: string[]};\nfunction failure(): never {\n throw new Error('TS_REGION_TARGET');\n}\nfunction passing(): number {\n return 42;\n}\nif(process.argv[2]==='fail') failure(); else passing();\n");
 const parser=process.env.REPROCAPSULE_TYPESCRIPT||path.resolve('node_modules/typescript/lib/typescript.js');
 const build=`node ${quote(path.join(path.dirname(parser),'tsc.js'))} app.ts --sourceMap --outDir dist --strict --noEmitOnError --target es2022 && node dist/app.js`;
 const r=await compareExecutions({repo,command:build+' fail',passingCommand:build+' pass'});
 assert.ok(r.failing.coverage.find(c=>c.file==='app.ts').sourceMapped);
 assert.ok(r.differential.failingOnly.find(c=>c.file==='app.ts').lines.includes(3));
 assert.ok(r.differential.passingOnly.find(c=>c.file==='app.ts').lines.includes(6));
});
