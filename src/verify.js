import { repetitionPolicy, repeatEvaluation } from './repetition.js';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createWorkspace, inventory } from './workspace.js';
import { fileHashes } from './integrity.js';
import { detectPackageManager, discoverNpm, npmInstall, npmEnvironment, commandUsesNpm } from './package-manager.js';
import { runCommand } from './runner.js';
import { matchesPredicate, createPredicate } from './predicate.js';
import { ReproError } from './errors.js';

export async function verifyCapsule({ capsule, npmPath, timeoutMs = 10_000, installTimeoutMs = 60_000, allowInstallScripts = false, offline = false, npm: suppliedNpm }) {
  const { manifest, predicate, payload } = await inspectCapsule(capsule);
  const workspace = await createWorkspace(capsule);
  try {
    if (JSON.stringify([...workspace.files].sort()) !== JSON.stringify([...payload, 'capsule.json'].sort())) {
      throw new ReproError('INTEGRITY_FAILED', 'Capsule contains unrecorded or excluded payload files.');
    }
    const policy=manifest.reproductionPolicy ? repetitionPolicy(manifest.reproductionPolicy.runs,manifest.reproductionPolicy.threshold) : null;
    let install='not-required';
    async function execute(command=manifest.command) {
      const cwd=await workspace.materialize(workspace.files);
      const hashes=await fileHashes(cwd,payload);
      if(Object.entries(hashes).some(([file,hash])=>hash!==manifest.fileHashes[file]))throw new ReproError('INTEGRITY_FAILED','Capsule changed while copying.');
      const manager=await detectPackageManager(cwd,workspace.files);
      const needsInstall=manager.needsInstall||manifest.dependencies?.installationPerformed===true;
      if(needsInstall&&manager.kind!=='npm')throw new ReproError('INVALID_CAPSULE','Install metadata does not match the project.');
      const npm=suppliedNpm??(needsInstall||commandUsesNpm(manifest.command)||commandUsesNpm(manifest.pairedOracle?.passingCommand ?? '')?await discoverNpm({npmPath,cwd}):null);
      const env=npm?await npmEnvironment(npm,workspace.root):{};
      if(needsInstall){await npmInstall({cwd,npm,timeoutMs:installTimeoutMs,allowInstallScripts,offline});install='pass';}
      return {result:await runCommand({cwd,command,timeoutMs,env}),cwd};
    }
    const matches=observed=>matchesPredicate(predicate,manifest.failureSignature,observed.result,observed.cwd);
    let result,repetitionEvidence=null;
    if(policy){
      const repeated=await repeatEvaluation(execute,matches,policy);
      if(!repeated.matches)throw new ReproError('CAPSULE_VERIFICATION_FAILED','Fresh repeated verification did not meet the recorded target threshold.');
      result=repeated.representative.result;repetitionEvidence=repeated.evidence;
    } else {
      const observed=await execute();result=observed.result;
      if(!matches(observed))throw new ReproError('CAPSULE_VERIFICATION_FAILED','CAPSULE INVALID: fresh-copy reproduction differs from the accepted failure.');
    }
    let pairedVerification=null;
    if(manifest.pairedOracle){
      const good=await execute(manifest.pairedOracle.passingCommand);
      if(good.result.exitCode!==0||good.result.signal||good.result.timedOut||good.result.outputExceeded)throw new ReproError('CAPSULE_VERIFICATION_FAILED','Fresh passing control no longer passes.');
      pairedVerification={bad:'PASS',good:'PASS',passingExitCode:0};
    }
    return {...(pairedVerification?{pairedVerification}:{}),success:true,integrity:'pass',install,failure:'pass',verified:true,exitCode:result.exitCode,...(policy?{repetitionEvidence}: {})};
  } finally { await workspace.cleanup(); }
}

export async function inspectCapsule(capsule) {
  let manifest;
  try {
    if ((await lstat(path.join(capsule, 'capsule.json'))).isSymbolicLink()) throw new Error('link');
    manifest = JSON.parse(await readFile(path.join(capsule, 'capsule.json'), 'utf8'));
  } catch { throw new ReproError('INVALID_CAPSULE', 'Cannot read capsule metadata.'); }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.retainedFiles) || !Array.isArray(manifest.generatedFiles) ||
      !manifest.fileHashes || typeof manifest.command !== 'string' || !manifest.command.trim() ||
      !/^[a-f0-9]{64}$/.test(manifest.failureSignature?.digest ?? '')) {
    throw new ReproError('INVALID_CAPSULE', 'Capsule requires integrity metadata from ReproCapsule 0.2+.');
  }
  const predicate = manifest.failurePredicate;
  if (predicate?.type === 'stderr-contains') createPredicate({ matchStderr: predicate.text, exitCode: predicate.exitCode });
  else if (predicate?.type === 'composite') createPredicate({matcher:predicate.matcher});
  else if (predicate?.type !== 'strict') throw new ReproError('INVALID_CAPSULE', 'Unsupported failure predicate.');
  if(manifest.pairedOracle && (manifest.reproductionPolicy || manifest.pairedOracle.version!==1 || manifest.pairedOracle.passingOracle!=='normal-exit-zero' || typeof manifest.pairedOracle.passingCommand!=='string' || !manifest.pairedOracle.passingCommand.trim()))throw new ReproError('INVALID_CAPSULE','Invalid paired oracle.');
  if(manifest.reproductionPolicy){
    const policy=repetitionPolicy(manifest.reproductionPolicy.runs,manifest.reproductionPolicy.threshold);
    if(!policy || manifest.reproductionPolicy.mode!=='repeated' || manifest.reproductionPolicy.minMatches!==policy.minMatches || predicate.type==='strict')throw new ReproError('INVALID_CAPSULE','Invalid repeated verification policy.');
  }
  const payload = [...manifest.retainedFiles, ...manifest.generatedFiles.filter((file) => file !== 'capsule.json')];
  if (payload.some((file) => typeof file !== 'string') || new Set(payload).size !== payload.length || payload.includes('capsule.json') ||
      JSON.stringify(Object.keys(manifest.fileHashes).sort()) !== JSON.stringify([...payload].sort())) {
    throw new ReproError('INVALID_CAPSULE', 'Invalid capsule file inventory.');
  }
  try {
    const actual = await fileHashes(capsule, payload);
    if (Object.entries(actual).some(([file, hash]) => hash !== manifest.fileHashes[file])) throw new Error('mismatch');
  } catch { throw new ReproError('INTEGRITY_FAILED', 'Capsule file hashes do not match.'); }
  const actualInventory = await inventory(capsule);
  if (JSON.stringify([...actualInventory.files].sort()) !== JSON.stringify([...payload, 'capsule.json'].sort()) || actualInventory.exclusions.length) throw new ReproError('INTEGRITY_FAILED', 'Capsule contains unrecorded or excluded payload files.');
  return { manifest, predicate, payload };
}
