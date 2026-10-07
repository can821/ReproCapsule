import path from 'node:path';
import {access} from 'node:fs/promises';
import {constants} from 'node:fs';
import {createWorkspace} from './workspace.js';
import {discoverNpm,npmInstall,npmEnvironment,quote} from './package-manager.js';
import {runCommand} from './runner.js';
import {createPredicate,matchesPredicate} from './predicate.js';
import {ReproError} from './errors.js';
export async function compareRuntimes({repo,script,runtimes,matcher,matchStderr,exitCode,...options}) {
 const predicate=createPredicate({matcher,matchStderr,exitCode});
 if(predicate.type==='strict'||!Array.isArray(runtimes)||!runtimes.length||runtimes.length>10||runtimes.some(r=>typeof r!=='string'||!path.isAbsolute(r))||typeof script!=='string'||path.isAbsolute(script)||script.split(/[\\/]/).includes('..'))throw new ReproError('INVALID_ARGUMENTS','Provide an explicit target, relative Node script, and 1–10 existing absolute runtime executable paths.');
 const workspace=await createWorkspace(repo),evaluated=[];let executions=0,installs=0;
 try {
  if(!workspace.files.includes(script))throw new ReproError('INVALID_ARGUMENTS','Runtime script must be a retained project file.');
  for(const [index,runtime] of runtimes.entries()) {
   const item={value:`runtime-${index+1}`};
   try {await access(runtime,constants.X_OK);}catch {evaluated.push({...item,status:'SETUP FAILURE',reason:'UNAVAILABLE_RUNTIME'});continue;}
   const version=await runCommand({cwd:workspace.snapshot,command:`${quote(runtime)} --version`,timeoutMs:options.timeoutMs??10000});
   if(version.exitCode!==0||version.timedOut||version.outputExceeded||version.signal||!/^v\d+\.\d+\.\d+\s*$/.test(version.stdout)){evaluated.push({...item,status:'SETUP FAILURE',reason:'INVALID_NODE_VERSION'});continue;}
   item.version=version.stdout.trim();const outcomes=[];
   for(let i=0;i<2;i++){
    const cwd=await workspace.materialize(workspace.files);let env={};
    if(workspace.files.includes('package.json')){
     try {const npm=await discoverNpm({cwd,npmPath:options.npmPath});installs++;await npmInstall({cwd,npm,offline:options.offline??false,allowInstallScripts:options.allowInstallScripts??false,timeoutMs:options.installTimeoutMs??60000});env=await npmEnvironment(npm,workspace.root);}
     catch(error){if(!['INSTALL_FAILED','INSTALL_TIMEOUT','INSTALL_OUTPUT_LIMIT','INVALID_LOCKFILE'].includes(error.code))throw error;outcomes.push('SETUP FAILURE');break;}
    }
    const result=await runCommand({cwd,command:`${quote(runtime)} ${quote(script)}`,timeoutMs:options.timeoutMs??10000,env});executions++;
    outcomes.push(matchesPredicate(predicate,null,result,cwd)?'FAIL':result.timedOut||result.outputExceeded||result.signal?'INCONCLUSIVE':result.exitCode===0?'PASS':'OTHER FAILURE');
   }
   evaluated.push({...item,status:outcomes[0]==='SETUP FAILURE'?'SETUP FAILURE':outcomes[0]===outcomes[1]?outcomes[0]:'INCONCLUSIVE',observations:outcomes});
  }
  const boundaries=[];for(let i=1;i<evaluated.length;i++)if(evaluated[i-1].status==='PASS'&&evaluated[i].status==='FAIL')boundaries.push({passing:evaluated[i-1].value,failing:evaluated[i].value});
  return {evaluated,boundaries,executions,installs,scope:'Explicit existing Node executables or trusted wrappers; two fresh copies per runtime. npm preparation uses the host toolchain. Child processes may use the host runtime. No downloads or global runtime changes; observed adjacent values, not causal version attribution.'};
 }finally{await workspace.cleanup();}
}
