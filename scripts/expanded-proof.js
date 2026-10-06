import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {discoverNpm,npmInstall} from '../src/package-manager.js';
import {runCommand} from '../src/runner.js';
import {buildCapsule} from '../src/capsule.js';
import {verifyCapsule} from '../src/verify.js';
import {inventory} from '../src/workspace.js';
import {fileHashes} from '../src/integrity.js';
import {failureSignature} from '../src/failure-signature.js';
const [prepared,output]=process.argv.slice(2).map(p=>path.resolve(p));
const cases=JSON.parse(await readFile(new URL('../corpus/expanded/cases.json',import.meta.url)));
await mkdir(output);const results=[];
for(const c of cases) {
 const repo=path.join(prepared,c.id,'buggy'),fixed=path.join(prepared,c.id,'fixed');
 const npm=await discoverNpm({cwd:repo});
 for(const cwd of [repo,fixed])await npmInstall({cwd,npm,updateLock:true,offline:true});
 const passing=await runCommand({cwd:fixed,command:c.command});assert.equal(passing.exitCode,0,passing.stdout+passing.stderr);
 const failing=await runCommand({cwd:repo,command:c.command});assert.ok(failing.exitCode>0);const signature=failureSignature(failing,{roots:[repo]});
 if(c.id==='zod-default-generic')assert.match(failing.stdout,/Type 'unknown' is not assignable to type 'string'/);
 else assert.match(failing.stderr,/ERR_ASSERTION/);
 console.log(JSON.stringify({case:c.id,preflight:'PASS',failingExit:failing.exitCode}));
 const files=(await inventory(repo)).files,before=await fileHashes(repo,files);
 const result=await buildCapsule({repo,command:c.command,output:path.join(output,c.id),offline:true,maxRuns:60,maxTimeMs:120000,keep:files.filter(f=>/^license(?:\.|$)/i.test(f))});
 const fresh=await verifyCapsule({capsule:result.output,offline:true});assert.equal(fresh.verified,true);
 assert.equal(result.manifest.failureSignature.digest,signature.digest);assert.deepEqual(await fileHashes(repo,files),before);
 const m=result.manifest;
 results.push({id:c.id,project:c.buggy.name,upstream:c.reference,buggy:c.buggy,fixed:c.fixed,fixCommit:c.fixCommit??null,fixLocation:c.fixLocation,runtime:m.environment,command:c.command,
 targetFailure:{strategy:'strict normalized transcript',digest:signature.digest,exitCode:failing.exitCode},files:{before:m.reduction.originalFileCount,after:m.reduction.finalFileCount},dependencies:{before:m.dependencies.originalCount,after:m.dependencies.finalCount},sourceReduction:null,inputReduction:null,
 reduction:m.reduction,elapsedMs:result.elapsedMs,executionCount:m.reduction.reproductionAttempts+3,freshVerification:fresh,originalUnchanged:true,retainedFiles:m.retainedFiles,
 adaptation:'Published production files unchanged; development scripts/dependencies replaced by pinned local dependency archives and upstream-derived probe. Zod checks a real tsc diagnostic contract; markdown-it executes its multi-file parser. Not full upstream test suites.'});
 await writeFile(path.join(output,'results.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify({case:c.id,files:results.at(-1).files,runs:m.reduction.reproductionAttempts,complete:m.reduction.complete,elapsedMs:result.elapsedMs}));
}
