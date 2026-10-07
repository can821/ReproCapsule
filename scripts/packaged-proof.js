// Exercise the actual distribution in a fresh consumer, including npm's bin shim.
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {discoverNpm,quote} from '../src/package-manager.js';
import {runCommand} from '../src/runner.js';
const root=await mkdtemp(path.join(os.tmpdir(),'reprocapsule-package-'));
try {
 const npm=await discoverNpm({cwd:process.cwd()});
 async function shell(command,cwd){const result=await runCommand({cwd,command,timeoutMs:120000});assert.equal(result.exitCode,0,result.stderr);assert.equal(result.timedOut,false);return result;}
 const packed=await shell(`${npm.command} pack --json --pack-destination ${quote(root)}`,process.cwd());
 const info=JSON.parse(packed.stdout)[0];
 assert.ok(info.files.every(f=>!/^(?:work|node_modules|test|corpus)\/|(?:^|\/)\.npmrc$/.test(f.path)));
 const consumer=path.join(root,'consumer with spaces');await mkdir(consumer);
 await writeFile(path.join(consumer,'package.json'),'{"name":"capsule-consumer","version":"1.0.0","private":true}');
 await shell(`${npm.command} install --ignore-scripts --no-audit --no-fund ${quote(path.join(root,info.filename))}`,consumer);
 await shell(`${npm.command} exec --offline -- reprocapsule --help`,consumer);
 const cli=path.join(consumer,'node_modules/reprocapsule/bin/reprocapsule.js');
 function run(args){const r=spawnSync(process.execPath,[cli,...args],{cwd:consumer,encoding:'utf8',timeout:60000});assert.equal(r.status,0,r.stderr||r.error?.message);return r.stdout;}
 const source=path.join(root,'source with spaces');await mkdir(source);
 await writeFile(path.join(source,'app.cjs'),"if(process.argv[2]==='bad'){console.error('PACKAGED_TARGET');process.exit(1)}\n");
 await writeFile(path.join(source,'noise.txt'),'unnecessary');
 const capsule=path.join(root,'capsule'),archive=path.join(root,'case.rcap.gz'),fresh=path.join(root,'fresh');
 run(['reduce','--repo',source,'--command','node app.cjs bad','--passing-command','node app.cjs good','--out',capsule]);
 run(['verify',capsule]);run(['pack',capsule,'--out',archive]);run(['inspect',archive]);run(['unpack',archive,'--out',fresh]);run(['verify',fresh]);
 const installed=JSON.parse(await readFile(path.join(consumer,'node_modules/reprocapsule/package.json')));
 console.log(JSON.stringify({version:installed.version,node:process.version,platform:process.platform,tarballBytes:info.size,packageFiles:info.files.length,installedHelp:'PASS',pairedReduction:'PASS',freshPortableVerification:'PASS'}));
} finally {await rm(root,{recursive:true,force:true});}
