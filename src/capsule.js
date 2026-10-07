import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { repetitionPolicy, repeatEvaluation } from './repetition.js';
import { performance } from 'node:perf_hooks';
import { runCommand } from './runner.js';
import { failureSignature } from './failure-signature.js';
import { createWorkspace, copyFiles, isControlFile, validateOutput } from './workspace.js';
import { reduceFiles } from './reducer.js';
import { ReproError } from './errors.js';
import { detectPackageManager, discoverNpm, npmInstall, selectDependencies, localReferences, writePackageSelection, quote, npmEnvironment, commandUsesNpm } from './package-manager.js';
import { createPredicate, matchesPredicate } from './predicate.js';
import { fileHashes, snapshotId } from './integrity.js';
import { verifyCapsule } from './verify.js';
import { workspaceSelection, inWorkspace } from './workspaces.js';
import { ReductionBudget } from './budget.js';
import { localiseWithSourceMaps } from './source-maps.js';
import { loadSourceSelection } from './source-input.js';
import { loadJsonInput } from './json-input.js';
import { persistentCache, environmentIdentity } from './candidate-cache.js';
import { outcomeOf, retainedExplanations, auditMinimality } from './evidence.js';
import { checkpointPath, writeCheckpoint, toolVersion } from './checkpoint.js';

function infrastructureFailure(result) {
  return result.exitCode === 126 || result.exitCode === 127 ||
    /(?:Error \[ERR_MODULE_NOT_FOUND\]|Error: Cannot find module |code: ['"]MODULE_NOT_FOUND['"]|npm error code ENOENT)/.test(`${result.stderr}\n${result.stdout}`);
}
const under = (file, dir) => file === dir || file.startsWith(`${dir}/`);

export async function buildCapsule({ repo, command, output, timeoutMs = 10_000, onProgress = () => {},
  npmPath, installTimeoutMs = 60_000, allowInstallScripts = false, offline = false,
  baselineRuns = 2, passingCommand, repeatRuns, matchThreshold, matchStderr, exitCode, matcher, maxRuns = Infinity, maxTimeMs = Infinity, keep = [], checkpoint, resumeState, audit = false, cacheDir, reduceInput, inputMaxRuns = 200, reduceSource, reduceSourceAll = false, sourceParser, sourceMaxRuns = 100, converge = false, maxRounds = 5 }) {
  if (typeof converge !== 'boolean' || !Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 100) throw new ReproError('INVALID_ARGUMENTS', 'maxRounds must be 1–100.');
  const started = performance.now();
  const repetition = repetitionPolicy(repeatRuns,matchThreshold);
  if (passingCommand !== undefined && (typeof passingCommand !== 'string' || !passingCommand.trim() || repetition)) throw new ReproError('INVALID_ARGUMENTS', 'Paired mode requires a nonempty passing command and deterministic observations.');
  const paired = passingCommand !== undefined;
  if (resumeState && (resumeState.config.passingCommand ?? null) !== (passingCommand ?? null)) throw new ReproError('CHECKPOINT_INCOMPATIBLE','Paired policy changed; start a new reduction.');
  const verificationRuns = paired ? 2 : repetition?.runs ?? 1;
  const budget = new ReductionBudget({ maxRuns, maxTimeMs, baselineRuns:paired ? baselineRuns * 2 : repetition?.runs ?? baselineRuns, finalRuns:2*verificationRuns });
  const predicate = createPredicate({ matchStderr, exitCode, matcher });
  if (repetition && (predicate.type === 'strict' || audit || cacheDir)) throw new ReproError('INVALID_ARGUMENTS','Repeated reduction requires an explicit target matcher; deterministic audit and candidate cache must be disabled.');
  const repetitionEvidence = repetition ? {baseline:null,candidates:[],final:null,priorCandidateBatches:resumeState?.state.repetition?.candidates?.length ?? 0,meaning:'Current-session observed rates, not probability; candidate batches use fresh copies and are never cached.'} : null;
  const destination = await validateOutput(repo, output);
  const checkpointFile = checkpoint ? await checkpointPath(repo, checkpoint, destination, Boolean(resumeState)) : null;
  const cacheDirectory = cacheDir ? path.dirname(await checkpointPath(repo, path.join(cacheDir, '.location-check'), destination, true)) : null;
  const workspace = await createWorkspace(repo);
  let outputCreated = false, passingWorkspace;
  try {
    if (paired) passingWorkspace = await createWorkspace(repo);
    if (workspace.files.some((file) => ['capsule.json', 'reproduce.sh', 'README.reprocapsule.md'].includes(file))) {
      throw new ReproError('RESERVED_FILENAME', 'Source uses a reserved capsule filename: capsule.json, reproduce.sh or README.reprocapsule.md.');
    }
    keep = keep.map((file) => {
      if (typeof file !== 'string' || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new ReproError('INVALID_ARGUMENTS', '--keep must stay inside the repository.');
      return path.posix.normalize(file).replace(/\/$/, '');
    });
    for (const file of keep) {
      if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..') || !workspace.files.some((candidate) => under(candidate, file))) {
        throw new ReproError('INVALID_ARGUMENTS', '--keep needs an existing, allowed repository-relative file or directory.');
      }
    }
    const sourceSnapshotId = snapshotId({ hashes: await fileHashes(workspace.snapshot, workspace.files), modes: workspace.modes });
    if (resumeState && resumeState.sourceSnapshotId !== sourceSnapshotId) throw new ReproError('SOURCE_CHANGED', 'REFUSE RESUME: source snapshot changed.');
    const manager = await detectPackageManager(workspace.snapshot, workspace.files);
    const npm = manager.needsInstall ? await discoverNpm({ npmPath, cwd: workspace.snapshot }) : null;
    const commandNpm = npm ?? ((commandUsesNpm(command) || paired && commandUsesNpm(passingCommand)) ? await discoverNpm({ npmPath, cwd: workspace.snapshot }) : null);
    const commandEnv = commandNpm ? await npmEnvironment(commandNpm, workspace.root) : {};
    const runtime = { node: process.version, npm: commandNpm?.version ?? null, platform: process.platform, arch: process.arch };
    if (resumeState && JSON.stringify(runtime) !== JSON.stringify(resumeState.runtime)) throw new ReproError('CHECKPOINT_INCOMPATIBLE', 'Runtime changed; start a new reduction.');
    const input = await loadJsonInput(workspace.snapshot, workspace.files, reduceInput, resumeState?.state.input);
    if (reduceSource && reduceSourceAll) throw new ReproError('INVALID_ARGUMENTS','Choose single-file or automatic multi-file source reduction.');
    const sourceInput = await loadSourceSelection(workspace.snapshot, workspace.files, reduceSourceAll || reduceSource, sourceParser, resumeState?.state.sourceInput);
    let sourceMetrics = sourceInput ? { ...sourceInput.metrics, finalBytes: sourceInput.bytes(), finalStatements: sourceInput.state.retained?.length ?? null, complete: resumeState?.state.phase === 'done', attempts: 0, acceptedReductions: 0, terminationReason: 'not-run-this-session' } : null;
    let inputMetrics = input ? { ...input.metrics, attempts: 0, acceptedReductions: 0, complete: resumeState?.state.phase === 'done', terminationReason: 'not-run-this-session' } : null;
    let protectedFiles = workspace.files.filter((file) => isControlFile(file) || file === input?.file || file === sourceInput?.file || keep.some((entry) => under(file, entry)));
    const candidates = workspace.files.filter((file) => !protectedFiles.includes(file));
    const originalDependencies = manager.ids;
    let retainedDependencies = [...originalDependencies], retained = [...workspace.files];
    const workspaces = manager.workspaces ?? [];
    let workspaceMetrics = { originalCount: workspaces.length, finalCount: workspaces.length, attempts: 0, acceptedReductions: 0, scope: 'flat npm workspace membership; workspace dependency declarations preserved', minimality: 'NOT AUDITED' };
    let phase = resumeState?.state.phase ?? (workspaces.length ? 'workspaces' : 'files');
    if (resumeState) {
      retained = resumeState.state.files;
      retainedDependencies = resumeState.state.dependencies;
      protectedFiles = protectedFiles.filter(file => !workspaces.some(w => inWorkspace(file,w.path) && !retained.includes(`${w.path}/package.json`)) || keep.some(entry => under(file,entry)) || file === input?.file || file === sourceInput?.file);
      if (new Set(retained).size !== retained.length || new Set(retainedDependencies).size !== retainedDependencies.length ||
          retained.some((file) => !workspace.files.includes(file)) || retainedDependencies.some((id) => !originalDependencies.includes(id)) ||
          protectedFiles.some((file) => !retained.includes(file))) throw new ReproError('INVALID_CHECKPOINT', 'Checkpoint items are inconsistent with the source/protection policy.');
    }
    const convergence = resumeState?.state.convergence ?? { enabled:converge, rounds:[], round:1, roundStart:null, stable:false };
    const stateIdentity = () => snapshotId({files:[...retained].sort(),dependencies:[...retainedDependencies].sort(),input:input?.content,source:sourceInput?.content});
    convergence.roundStart ??= stateIdentity();
    const packageStates = new Map(), cache = new Map();
    let cacheHits = 0, cacheMisses = 0, persistentCacheHits = 0, installCount = 0, attempts = 0, accepted = 0;
    let dependencyAttempts = 0, dependencyAccepted = 0, terminationReason = 'complete';
    const packageKey = (ids, files = retained) => JSON.stringify([[...ids].sort(),workspaces.filter(w => files.includes(`${w.path}/package.json`)).map(w => w.path)]);
    if (npm) packageStates.set(packageKey(originalDependencies,workspace.files), {
      pkg: await readFile(path.join(workspace.snapshot, 'package.json'), 'utf8'),
      lock: await readFile(path.join(workspace.snapshot, 'package-lock.json'), 'utf8'),
    });
    async function applyPackage(cwd, ids, files = retained) {
      const state = packageStates.get(packageKey(ids,files));
      if (state) {
        await writeFile(path.join(cwd, 'package.json'), state.pkg);
        await writeFile(path.join(cwd, 'package-lock.json'), state.lock);
      } else await writeFile(path.join(cwd, 'package.json'), JSON.stringify(workspaceSelection(selectDependencies(manager.pkg,ids),workspaces,files),null,2)+'\n');
      return Boolean(state);
    }
    async function observeSide(files, ids, reduction = false, inputText = input?.content, sourceText = sourceInput?.content, passing = false) {
      if (reduction && budget.reason()) throw budget.exhausted();
      const cwd = await (passing ? passingWorkspace : workspace).materialize(files);
      if (input && files.includes(input.file)) await writeFile(path.join(cwd, input.file), inputText);
      if (sourceInput) await sourceInput.apply(cwd,files,sourceText);
      if (npm) {
        const knownLock = await applyPackage(cwd, ids, files);
        try {
          installCount++;
          await npmInstall({ cwd, npm, updateLock: !knownLock, timeoutMs: reduction ? budget.remaining(installTimeoutMs) : installTimeoutMs, allowInstallScripts, offline });
        } catch (error) {
          if (reduction && budget.reason() === 'max-time') throw budget.exhausted('max-time');
          throw error;
        }
        if (!knownLock) packageStates.set(packageKey(ids,files), {
          pkg: await readFile(path.join(cwd, 'package.json'), 'utf8'),
          lock: await readFile(path.join(cwd, 'package-lock.json'), 'utf8'),
        });
      }
      if (reduction && budget.reason()) throw budget.exhausted();
      budget.runs++;
      const result = await runCommand({ command: passing ? passingCommand : command, cwd, env: commandEnv, timeoutMs: reduction ? budget.remaining(timeoutMs) : timeoutMs });
      if (reduction && result.timedOut && budget.reason() === 'max-time') throw budget.exhausted('max-time');
      return { result, signature: failureSignature(result, { roots: [cwd] }), cwd };
    }
    async function observe(files, ids, reduction = false, inputText = input?.content, sourceText = sourceInput?.content) {
      const bad = await observeSide(files, ids, reduction, inputText, sourceText);
      if (paired) {
        const good = await observeSide(files, ids, reduction, inputText, sourceText, true);
        bad.passingPassed = good.result.exitCode === 0 && !good.result.signal && !good.result.timedOut && !good.result.outputExceeded;
      }
      return bad;
    }
    const batch = async (files,ids,reduction=false,inputText=input?.content,sourceText=sourceInput?.content) => repeatEvaluation(
      ()=>observe(files,ids,reduction,inputText,sourceText),
      observed=>matchesPredicate(predicate,null,observed.result,observed.cwd)&&!infrastructureFailure(observed.result),repetition);
    let first;
    if(repetition){
      const baseline=await batch(retained,retainedDependencies);
      if(!baseline.matches)throw new ReproError('INVALID_BASELINE','Repeated baseline did not meet its target threshold.');
      first=baseline.representative;repetitionEvidence.baseline=baseline.evidence;
    } else first=await observe(retained, retainedDependencies);
    if (paired && !first.passingPassed) throw new ReproError('INVALID_BASELINE','Passing command did not pass in a fresh copy.');
    if (!first.signature || infrastructureFailure(first.result) || !matchesPredicate(predicate, first.signature, first.result, first.cwd)) {
      const reason = first.result.timedOut ? 'command timed out' : first.result.outputExceeded ? 'output limit exceeded' : first.result.exitCode === 0 ? 'command succeeded' : infrastructureFailure(first.result) ? 'missing module, command or package setup' : 'no matching normal failure';
      throw new ReproError('INVALID_BASELINE', `Cannot establish a safe baseline: ${reason}.`);
    }
    if (resumeState && !matchesPredicate(predicate, resumeState.acceptedFailure, first.result, first.cwd)) throw new ReproError('CHECKPOINT_FAILURE_CHANGED', 'REFUSE RESUME: retained state no longer matches its accepted failure.');
    for (let run = 1; !repetition && run < baselineRuns; run++) {
      const observed = await observe(retained, retainedDependencies);
      if (paired && !observed.passingPassed || !matchesPredicate(predicate, first.signature, observed.result, observed.cwd)) {
        throw new ReproError('UNSTABLE_BASELINE', 'NON-DETERMINISTIC BASELINE: clean runs disagree under the selected failure predicate.');
      }
    }
    const acceptedFailure = { version: first.signature.version, strategy: first.signature.strategy, digest: first.signature.digest, exitCode: first.signature.exitCode };
    const diskCache = await persistentCache(cacheDirectory, { toolVersion, sourceSnapshotId, runtime, command, passingCommand:passingCommand ?? null, predicate, acceptedFailure,
      timeoutMs, installTimeoutMs, allowInstallScripts, offline, environment: environmentIdentity(), reduceInput, reduceSource, reduceSourceAll, sourceParserVersion: sourceInput?.state.parserVersion });
    async function persist(status = 'running', progress = {}) {
      if (!checkpointFile) return;
      await writeCheckpoint(checkpointFile, {
        schemaVersion: 1, toolVersion, source: workspace.source, sourceSnapshotId, runtime,
        config: { command, passingCommand, timeoutMs, installTimeoutMs, baselineRuns, repeatRuns, matchThreshold, matchStderr, exitCode, matcher, keep, allowInstallScripts, offline, audit, cacheDir: cacheDirectory, reduceInput, inputMaxRuns, reduceSource, reduceSourceAll, sourceParser, sourceMaxRuns, converge, maxRounds },
        acceptedFailure, failurePredicate: predicate, state: { files: retained, dependencies: retainedDependencies, phase, input: input?.state, sourceInput: sourceInput?.state, convergence, repetition:repetitionEvidence },
        counters: { reproductionAttempts: (resumeState?.counters.reproductionAttempts ?? 0) + budget.runs,
          candidateAttempts: attempts + (progress.attempts ?? 0), acceptedReductions: accepted + (progress.accepted ?? 0) },
        budget: { maxRuns: Number.isFinite(maxRuns) ? maxRuns : null, maxTimeMs: Number.isFinite(maxTimeMs) ? maxTimeMs : null },
        cachePolicy: cacheDirectory ? 'scope-validated-persistent-outcomes' : 'run-local-only', status, updatedAt: new Date().toISOString(),
      });
    }
    await persist();
    onProgress({ phase: 'baseline', candidates: candidates.length, baselineRuns:repetition?.runs ?? baselineRuns, predicate: predicate.type });
    const candidateKey = (files, ids, inputText = input?.content, sourceText = sourceInput?.content) => JSON.stringify([[...files].sort(), [...ids].sort(), command, passingCommand ?? null, predicate, inputText === undefined ? null : snapshotId(inputText), sourceText === undefined ? null : snapshotId(sourceText)]);
    async function evaluate(files, ids, fresh = false, inputText = input?.content, sourceText = sourceInput?.content) {
      if(repetition){
        try {
          const observed=await batch(files,ids,true,inputText,sourceText);
          repetitionEvidence.candidates.push({candidate:snapshotId(candidateKey(files,ids,inputText,sourceText)),...observed.evidence,accepted:observed.matches});
          return {matches:observed.matches,conclusive:observed.conclusive,reason:observed.matches?'failure-preserved':'failure-changed'};
        } catch(error){
          if(['INSTALL_FAILED','INVALID_LOCKFILE','INSTALL_TIMEOUT','INSTALL_OUTPUT_LIMIT'].includes(error.code))return {matches:false,conclusive:false,reason:error.code};
          throw error;
        }
      }
      const key = candidateKey(files, ids, inputText, sourceText);
      if (!fresh && cache.has(key)) { cacheHits++; return cache.get(key); }
      if (!fresh) {
        const saved = await diskCache.get(key);
        if (saved) { cacheHits++; persistentCacheHits++; cache.set(key, saved); return saved; }
        cacheMisses++;
      }
      let observed;
      try { observed = await observe(files, ids, true, inputText, sourceText); }
      catch (error) {
        if (['INSTALL_FAILED', 'INVALID_LOCKFILE', 'INSTALL_TIMEOUT', 'INSTALL_OUTPUT_LIMIT'].includes(error.code)) return { matches: false, conclusive: false, reason: error.code };
        throw error;
      }
      const outcome = outcomeOf(observed.result, matchesPredicate(predicate, first.signature, observed.result, observed.cwd) && (!paired || observed.passingPassed));
      if (outcome.conclusive) { cache.set(key, outcome); await diskCache.set(key, outcome); }
      return outcome;
    }
    const preserves = async (files, ids) => (await evaluate(files, ids)).matches;
    async function reduceProjectFiles() {
      const localPaths = npm ? localReferences(selectDependencies(manager.pkg, retainedDependencies)) : [];
      const fixed = retained.filter((file) => protectedFiles.includes(file) || localPaths.some((entry) => under(file, entry)));
      const removable = retained.filter((file) => !fixed.includes(file));
      const reduction = await reduceFiles(removable, (files) => preserves([...fixed, ...files], retainedDependencies), {
        shouldStop: () => budget.reason(), onProgress: (event) => onProgress({ phase: 'reduction', ...event }),
        onAccepted: async (files, progress) => { retained = [...fixed, ...files].sort(); await persist('running', progress); },
      });
      retained = [...fixed, ...reduction.retained].sort();
      attempts += reduction.attempts; accepted += reduction.accepted;
      if (!reduction.complete) terminationReason = reduction.terminationReason;
    }
    while (true) {
    if (converge && convergence.round > maxRounds) { terminationReason = 'max-rounds'; break; }
    if (phase === 'workspaces') {
      const active = workspaces.filter(w => retained.includes(`${w.path}/package.json`));
      const fixed = active.filter(w => keep.some(entry => under(w.path,entry) || under(entry,w.path)) || input && under(input.file,w.path) || sourceInput && under(sourceInput.file,w.path)).map(w => w.path);
      const selectedFiles = paths => retained.filter(file => !active.some(w => under(file,w.path) && !paths.includes(w.path)));
      const reduction = await reduceFiles(active.map(w => w.path).filter(dir => !fixed.includes(dir)), async paths => preserves(selectedFiles([...fixed,...paths]),retainedDependencies), {
        shouldStop: () => budget.reason(),
        onAccepted: async paths => { retained = selectedFiles([...fixed,...paths]); await persist(); },
      });
      workspaceMetrics.attempts = reduction.attempts; workspaceMetrics.acceptedReductions = reduction.accepted;
      attempts += reduction.attempts; accepted += reduction.accepted;
      protectedFiles = protectedFiles.filter(file => retained.includes(file));
      if (!reduction.complete) terminationReason = reduction.terminationReason;
      else phase = 'files';
      await persist(terminationReason === 'complete' ? 'running' : 'partial');
    }
    if (phase === 'files') {
      await reduceProjectFiles();
      if (terminationReason === 'complete') phase = npm ? 'dependencies' : input ? 'input' : sourceInput ? 'source' : 'done';
      await persist(terminationReason === 'complete' ? 'running' : 'partial');
    }
    if (phase === 'dependencies' && terminationReason === 'complete') {
      const reduction = await reduceFiles(retainedDependencies, (ids) => preserves(retained, ids), {
        shouldStop: () => budget.reason(), onProgress: (event) => onProgress({ phase: 'dependencies', ...event }),
        onAccepted: async (ids, progress) => { retainedDependencies = ids; await persist('running', progress); },
      });
      retainedDependencies = reduction.retained;
      dependencyAttempts = reduction.attempts; dependencyAccepted = reduction.accepted;
      attempts += reduction.attempts; accepted += reduction.accepted;
      if (!reduction.complete) terminationReason = reduction.terminationReason;
      else phase = 'cleanup';
      await persist(terminationReason === 'complete' ? 'running' : 'partial');
    }
    if (phase === 'cleanup' && terminationReason === 'complete') {
      await reduceProjectFiles();
      if (terminationReason === 'complete') phase = input ? 'input' : sourceInput ? 'source' : 'done';
      await persist(terminationReason === 'complete' ? 'running' : 'partial');
    }
    if (phase === 'input' && terminationReason === 'complete') {
      inputMetrics = await input.reduce(async (text) => (await evaluate(retained, retainedDependencies, false, text)).matches, {
        shouldStop: () => budget.reason(), maxAttempts: inputMaxRuns,
        onAccepted: async () => { await persist(); onProgress({ phase: 'input', bytes: input.metrics.finalBytes }); },
      });
      if (inputMetrics.complete) phase = sourceInput ? 'source' : 'done';
      else terminationReason = inputMetrics.terminationReason;
      await persist(terminationReason === 'complete' ? 'running' : 'partial');
    }
    if (phase === 'source' && terminationReason === 'complete') {
      sourceMetrics = await sourceInput.reduce(async text => (await evaluate(retained, retainedDependencies, false, input?.content, text)).matches, {
        retainedFiles:retained, shouldStop: () => budget.reason(), maxAttempts: sourceMaxRuns, onAccepted: async () => { await persist(); },
      });
      if (sourceMetrics.complete) phase = 'done'; else terminationReason = sourceMetrics.terminationReason;
      await persist(terminationReason === 'complete' ? 'running' : 'partial');
    }
    if (!converge || phase !== 'done' || terminationReason !== 'complete') break;
    const end = stateIdentity();
    convergence.rounds.push({round:convergence.round,changed:end !== convergence.roundStart,files:retained.length,dependencies:retainedDependencies.length,inputBytes:input ? Buffer.byteLength(input.content) : null,sourceBytes:sourceInput ? sourceInput.bytes(retained) : null,runs:budget.runs});
    if (end === convergence.roundStart) { convergence.stable = true; await persist(); break; }
    convergence.round++; convergence.roundStart = end;
    phase = workspaces.length ? 'workspaces' : 'files';
    if (convergence.round > maxRounds) { terminationReason = 'max-rounds'; await persist('partial'); break; }
    await persist();
    if (budget.reason()) { terminationReason = budget.reason(); break; }
    }
    const localPaths = npm ? localReferences(selectDependencies(manager.pkg, retainedDependencies)) : [];
    const fixed = retained.filter((file) => protectedFiles.includes(file) || localPaths.some((entry) => under(file, entry)));
    const auditStartRuns = budget.runs;
    const auditResult = audit ? await auditMinimality({ files: retained, dependencies: retainedDependencies, protectedFiles: fixed,
      evaluate: (files, ids) => evaluate(files, ids, true), shouldStop: () => budget.reason() }) :
      { metadata: { requested: false, status: 'NOT PROVEN', level: 'not-audited' }, evidence: {} };
    auditResult.metadata.reproductionRuns = budget.runs - auditStartRuns;
    function domainAuditStatus(prefix, expected, enabled = true) {
      if (!audit || !enabled) return 'NOT AUDITED';
      const observations = Object.entries(auditResult.evidence).filter(([id]) => id.startsWith(prefix)).map(([,value]) => value);
      return observations.length === expected && observations.every(value => value.conclusive && !value.matches) ? 'PASS' : 'PARTIAL';
    }
    if (auditResult.metadata.terminationReason) terminationReason = auditResult.metadata.terminationReason;
    const explanations = retainedExplanations({ files: retained, dependencies: retainedDependencies,
      control: retained.filter(isControlFile), protectedFiles: fixed, peerNames: Object.keys(manager.pkg?.peerDependencies ?? {}),
      lookup: (files, ids) => cache.get(candidateKey(files, ids)), auditEvidence: auditResult.evidence });
    let final;
    if(repetition){
      const checked=await batch(retained,retainedDependencies);
      if(!checked.matches)throw new ReproError('FINAL_VERIFICATION_FAILED','Repeated final state no longer meets the threshold.');
      final=checked.representative;repetitionEvidence.final=checked.evidence;
    } else final=await observe(retained,retainedDependencies);
    if (paired && !final.passingPassed || !matchesPredicate(predicate, first.signature, final.result, final.cwd)) {
      throw new ReproError('FINAL_VERIFICATION_FAILED', 'The reduced file set did not reproduce reliably.');
    }
    const signature = first.signature;
    workspaceMetrics.finalCount = workspaces.filter(w => retained.includes(`${w.path}/package.json`)).length;
    workspaceMetrics.retained = workspaces.filter(w => retained.includes(`${w.path}/package.json`)).map(w => ({path:w.path,name:w.name}));
    const manifest = {
      schemaVersion: 1, tool: { name: 'reprocapsule', version: toolVersion }, command,
      pairedOracle: paired ? {version:1,passingCommand,passingOracle:'normal-exit-zero',preparation:'fresh copy and same selected npm manifest before each command'} : null,
      failurePredicate: predicate, reproductionPolicy:repetition, repetitionEvidence,
      failureSignature: { version: signature.version, strategy: signature.strategy, digest: signature.digest, exitCode: signature.exitCode },
      sourceSnapshotId, convergence: {...convergence, roundStart:undefined, scope:'No-change round over enabled reductions; no global minimality claim'},
      domainAudit: {files:domainAuditStatus('file:',retained.filter(file => !fixed.includes(file)).length), dependencies:domainAuditStatus('dependency:',retainedDependencies.length,Boolean(npm)), workspaces:'NOT AUDITED', input:'NOT AUDITED', source:'NOT AUDITED'}, workspaces: workspaceMetrics, diagnostics: await localiseWithSourceMaps(final.result, final.cwd, retained, explanations), inputReduction: inputMetrics, sourceReduction: sourceMetrics, explanations, minimality: auditResult.metadata,
      continuation: { resumed: Boolean(resumeState), priorReproductionAttempts: resumeState?.counters.reproductionAttempts ?? 0 },
      environment: { node: process.version, npm: commandNpm?.version ?? null, platform: process.platform, osRelease: os.release(), arch: process.arch },
      reduction: {
        originalFileCount: workspace.files.length, finalFileCount: retained.length,
        originalCandidateCount: candidates.length, finalCandidateCount: retained.filter((file) => !protectedFiles.includes(file)).length,
        reductionPercentage: Number(((workspace.files.length - retained.length) / Math.max(1, workspace.files.length) * 100).toFixed(2)),
        candidateAttempts: attempts, acceptedReductions: accepted, reproductionAttempts: budget.runs + verificationRuns,
        cacheHits, cacheMisses, persistentCacheHits, installCount: installCount + (npm ? verificationRuns : 0), baselineRuns:paired ? baselineRuns*2 : repetition?.runs ?? baselineRuns,
        durationBeforePackageVerificationMs: Math.round(performance.now() - started), terminationReason,
        complete: terminationReason === 'complete',
        guarantee: terminationReason === 'complete' ? (auditResult.metadata.status === 'PASS' ? '1-minimal with respect to the audited candidate set; no global minimum claim' : 'reduction complete; 1-minimality not certified without a passing audit') : 'PARTIAL: best verified state; no minimality claim',
      },
      budget: { maxRuns: Number.isFinite(maxRuns) ? maxRuns : null, maxTimeMs: Number.isFinite(maxTimeMs) ? maxTimeMs : null, finalVerificationReservedRuns: 2*verificationRuns },
      retainedFiles: retained, protectedFiles, userProtectedPaths: keep, exclusions: workspace.exclusions,
      dependencies: { status: npm ? 'reduced' : 'not-required', installationPerformed: Boolean(npm), originalCount: originalDependencies.length, finalCount: retainedDependencies.length,
        retained: retainedDependencies, original: originalDependencies, attempts: dependencyAttempts, acceptedReductions: dependencyAccepted,
        peerDependencies: manager.pkg?.peerDependencies ?? {}, allowInstallScripts, offline },
      failurePreserved: true,
    };
    await mkdir(path.dirname(destination), { recursive: true });
    await mkdir(destination); outputCreated = true;
    await copyFiles(workspace.snapshot, destination, retained);
    if (npm) await applyPackage(destination, retainedDependencies);
    if (input) await writeFile(path.join(destination, input.file), input.content);
    if (sourceInput) await sourceInput.apply(destination,retained);
    const readmeName = retained.includes('README.md') ? 'README.reprocapsule.md' : 'README.md';
    manifest.generatedFiles = ['capsule.json', readmeName, 'reproduce.sh'];
    const installInstruction = npm ? `First run npm ci${allowInstallScripts ? '' : ' --ignore-scripts'} (scripts ${allowInstallScripts ? 'explicitly enabled' : 'disabled'}).\n` : '';
    await writeFile(path.join(destination, readmeName), `# Reproduction capsule\n\n${terminationReason === 'complete' ? 'Reduction completed.' : 'PARTIAL reduction: ' + terminationReason}\n\n${installInstruction}Then run sh ./reproduce.sh from this directory.\nExpected failing exit code: ${signature.exitCode}.${repetition ? ` Repeated verification requires ${repetition.minMatches}/${repetition.runs} matching observations; a single run may pass.` : ''}\nFailure predicate: ${predicate.type}${predicate.type === 'strict' ? '' : ' (explicit user choice; broader than transcript equality)'}.\n\n${paired ? 'Paired capsule: verify rechecks the target failure AND a fresh exit-zero passing command. reproduce.sh runs only the failing side.\n' : ''}Use reprocapsule verify PATH for independent fresh-copy verification.\nCommands are trusted local input, NOT sandboxed. Review before executing.\nNo node_modules are shipped. Environment values and raw command output are not recorded.\n`);
    await writeFile(path.join(destination, 'reproduce.sh'), `#!/bin/sh\ncd -- "$(dirname -- "$0")" || exit 1\nexec /bin/sh -c ${quote(command)}\n`, { mode: 0o755 });
    manifest.fileHashes = await fileHashes(destination, [...retained, readmeName, 'reproduce.sh']);
    await writeFile(path.join(destination, 'capsule.json'), JSON.stringify(manifest, null, 2) + '\n');
    // Verification copies the finished capsule, installs from scratch, and never
    // trusts the node_modules or process-written files from any reduction attempt.
    const verification = await verifyCapsule({ capsule: destination, npm, npmPath, timeoutMs, installTimeoutMs, allowInstallScripts, offline });
    budget.runs+=verificationRuns;
    await persist(terminationReason === 'complete' ? 'complete' : 'partial');
    const elapsedMs = Math.round(performance.now() - started);
    onProgress({ phase: 'complete', output: destination, terminationReason });
    return { output: destination, manifest, verification, elapsedMs };
  } catch (error) {
    if (outputCreated) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally { await passingWorkspace?.cleanup(); await workspace.cleanup(); }
}
