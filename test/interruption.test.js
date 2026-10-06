import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {runCommand} from '../src/runner.js';
import {failureSignature} from '../src/failure-signature.js';
import {temporary} from './helpers.js';
test('SIGINT during execution cleans up and yields an explicit interruption',async t=>{
 const cwd=await temporary(t);
 const runner=new URL('../src/runner.js',import.meta.url).href;
 const source=`import {runCommand} from ${JSON.stringify(runner)};setTimeout(()=>process.kill(process.pid,'SIGINT'),150);try {await runCommand({cwd:process.cwd(),command:"node -e 'setInterval(()=>{},1000)'",timeoutMs:5000});process.exitCode=1;} catch(e) {console.log(e.code);}`;
 const child=spawn(process.execPath,['--input-type=module','-e',source],{cwd});let output='';child.stdout.on('data',b=>output+=b);
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
 assert.equal(code,0);assert.match(output,/INTERRUPTED/);
});
test('terminated child is never accepted as a normal target failure',async t=>{
 const cwd=await temporary(t),r=await runCommand({cwd,command:"node -e 'process.kill(process.pid,\"SIGTERM\")'"});
 assert.notEqual(r.exitCode,0);
 // Shell may represent a signal as 128+signal with diagnostic text. It must not match a normal exit-1 target.
 assert.notEqual(failureSignature(r)?.exitCode,1);
});
