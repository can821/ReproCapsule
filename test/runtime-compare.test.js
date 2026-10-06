import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {mkdir,writeFile,chmod} from 'node:fs/promises';
import {temporary,fingerprint} from './helpers.js';
import {compareRuntimes} from '../src/runtime-compare.js';
test('existing runtime and explicit controlled wrapper preserve fresh classified observations',async t=>{
 const root=await temporary(t),repo=path.join(root,'repo');await mkdir(repo);
 await writeFile(path.join(repo,'probe.cjs'),"if(process.env.RUNTIME_PROBE==='fail')throw new Error('RUNTIME_TARGET');\n");
 const wrapper=path.join(root,'wrapper');await writeFile(wrapper,`#!/bin/sh\nexport RUNTIME_PROBE=fail\nexec '${process.execPath.replaceAll("'","'\\''")}' "$@"\n`);await chmod(wrapper,0o755);
 const before=await fingerprint(repo);
 const r=await compareRuntimes({repo,script:'probe.cjs',runtimes:[process.execPath,wrapper,path.join(root,'absent')],matchStderr:'Error: RUNTIME_TARGET'});
 assert.deepEqual(r.evaluated.map(e=>e.status),['PASS','FAIL','SETUP FAILURE']);assert.equal(r.executions,4);assert.deepEqual(r.boundaries,[{passing:'runtime-1',failing:'runtime-2'}]);assert.equal(await fingerprint(repo),before);
 assert.ok(!JSON.stringify(r).includes(root));
});
test('runtime comparison rejects implicit targets and unsafe script selections',async()=>{
 await assert.rejects(compareRuntimes({runtimes:[process.execPath],script:'probe.cjs'}),{code:'INVALID_ARGUMENTS'});
 await assert.rejects(compareRuntimes({runtimes:[process.execPath],script:'../probe.cjs',matchStderr:'TARGET'}),{code:'INVALID_ARGUMENTS'});
});
