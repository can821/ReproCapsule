import {readFile,writeFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {createWorkspace} from './workspace.js';
import {discoverNpm,npmInstall,npmEnvironment} from './package-manager.js';
import {runCommand} from './runner.js';
import {createPredicate,matchesPredicate} from './predicate.js';
import {ReproError} from './errors.js';

export async function orderedExperiment({values,evaluate,maxExperiments=30}) {
 if (!Array.isArray(values) || values.length<2 || values.length>100 || new Set(values).size!==values.length || !Number.isSafeInteger(maxExperiments) || maxExperiments<1 || maxExperiments>100) throw new ReproError('INVALID_ARGUMENTS','Provide 2–100 distinct ordered values and a 1–100 experiment budget.');
 const evaluated=[];
 for (const value of values.slice(0,maxExperiments)) {
  const result=await evaluate(value);
  if (!['PASS','FAIL','OTHER FAILURE','SETUP FAILURE','INCONCLUSIVE'].includes(result.status)) throw new ReproError('INVALID_EXPERIMENT','Unknown experiment status.');
  evaluated.push({value,...result});
 }
 const boundaries=[];
 for(let i=1;i<evaluated.length;i++) if(evaluated[i-1].status==='PASS' && evaluated[i].status==='FAIL') boundaries.push({passing:evaluated[i-1].value,failing:evaluated[i].value});
 return {evaluated,boundaries,firstTestedFailingValue:evaluated.find(e=>e.status==='FAIL')?.value ?? null,
  complete:evaluated.length===values.length,meaning:'Adjacent tested PASS→FAIL values in the supplied order; not causality, monotonicity, or a claim about untested versions.'};
}
export async function monotonicExperiment({values,evaluate,maxExperiments=30}) {
 if(!Array.isArray(values)||values.length<2||values.length>100||new Set(values).size!==values.length||!Number.isSafeInteger(maxExperiments)||maxExperiments<1||maxExperiments>100)throw new ReproError('INVALID_ARGUMENTS','Invalid ordered values or experiment budget.');
 const evaluated=[];let status='BUDGET EXHAUSTED',boundary=null;
 const observe=async index=>{
  if(evaluated.length>=maxExperiments)return null;
  const result=await evaluate(values[index]);evaluated.push({value:values[index],...result});return result.status;
 };
 let low=0,high=values.length-1;
 const first=await observe(low),last=await observe(high);
 if(first!==null&&last!==null){
  if(first!=='PASS'||last!=='FAIL')status='INVALID OR UNTESTABLE ENDPOINTS';
  else {
   status='SEARCHING';
   while(high-low>1){
    const mid=Math.floor((low+high)/2),outcome=await observe(mid);
    if(outcome===null){status='BUDGET EXHAUSTED';break;}
    if(outcome==='PASS')low=mid;else if(outcome==='FAIL')high=mid;else {status='AMBIGUOUS';break;}
   }
   if(status==='SEARCHING'){
    const left=await observe(low),right=await observe(high);
    status=left===null||right===null?'BUDGET EXHAUSTED':left==='PASS'&&right==='FAIL'?'FOUND':'AMBIGUOUS';
    if(status==='FOUND')boundary={passing:values[low],failing:values[high]};
   }
  }
 }
 return {status,evaluated,boundaries:boundary?[boundary]:[],firstTestedFailingValue:boundary?.failing??null,complete:status==='FOUND',
  meaning:'Binary boundary search under the explicit user-supplied monotonic ordering assumption; adjacent values rechecked in fresh experiments. Untested versions are not proven; no causality claim.'};
}
export async function dependencyBoundary({repo,command,dependency,values,matcher,matchStderr,exitCode,maxExperiments=30,monotonic=false,...options}) {
 const predicate=createPredicate({matcher,matchStderr,exitCode});
 if(predicate.type==='strict') throw new ReproError('INVALID_ARGUMENTS','Dependency experiments require an explicit target matcher.');
 if(typeof dependency!=='string' || !/^(?:@[a-z0-9_.-]+\/)?[a-z0-9_.-]+$/i.test(dependency) || !Array.isArray(values) || values.some(v=>typeof v!=='string' || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?$/i.test(v))) throw new ReproError('INVALID_ARGUMENTS','Use exact dependency versions, not tags or ranges.');
 const workspace=await createWorkspace(repo),started=Date.now();let installs=0,executions=0;
 try {
  const original=JSON.parse(await readFile(path.join(workspace.snapshot,'package.json'),'utf8'));
  const section=['dependencies','devDependencies','optionalDependencies'].find(s=>Object.hasOwn(original[s] ?? {},dependency));
  if(!section || original.workspaces) throw new ReproError('INVALID_ARGUMENTS','Choose an existing direct dependency of a non-workspace npm project.');
  const npm=await discoverNpm({npmPath:options.npmPath,cwd:workspace.snapshot});
  const result=await (monotonic?monotonicExperiment:orderedExperiment)({values,maxExperiments,evaluate:async value=>{
   const cwd=await workspace.materialize(workspace.files),pkg=structuredClone(original);
   pkg[section][dependency]=value;
   await writeFile(path.join(cwd,'package.json'),JSON.stringify(pkg,null,2)+'\n');
   await rm(path.join(cwd,'package-lock.json'),{force:true});
   try {
    installs++;
    await npmInstall({cwd,npm,updateLock:true,timeoutMs:options.installTimeoutMs ?? 60000,offline:options.offline ?? false,allowInstallScripts:options.allowInstallScripts ?? false});
   } catch(error) {
    if(!['INSTALL_FAILED','INSTALL_TIMEOUT','INSTALL_OUTPUT_LIMIT','INVALID_LOCKFILE'].includes(error.code)) throw error;
    return {status:'SETUP FAILURE',reason:error.code};
   }
   // Two repetitions for each classification; disagreement remains inconclusive.
   const outcomes=[];
   for(let i=0;i<2;i++) {
    executions++;
    const r=await runCommand({cwd,command,timeoutMs:options.timeoutMs ?? 10000,env:await npmEnvironment(npm,workspace.root)});
    outcomes.push(matchesPredicate(predicate,null,r,cwd)?'FAIL':r.timedOut||r.outputExceeded||r.signal?'INCONCLUSIVE':r.exitCode===0?'PASS':'OTHER FAILURE');
   }
   return {status:outcomes[0]===outcomes[1]?outcomes[0]:'INCONCLUSIVE',observations:outcomes};
  }});
  return {...result,dependency,predicate,installs,executions,elapsedMs:Date.now()-started,runtime:process.version,scope:'One exact direct npm dependency; transitive resolution may differ. Repetitions share the installed candidate; versions use separate copied candidates. No global runtime changes.'};
 } finally {await workspace.cleanup();}
}
