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
