import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
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
import { ReductionBudget } from './budget.js';

function infrastructureFailure(result) {
  return result.exitCode === 126 || result.exitCode === 127 ||
    /(?:Error \[ERR_MODULE_NOT_FOUND\]|Error: Cannot find module |code: ['"]MODULE_NOT_FOUND['"]|npm error code ENOENT)/.test(`${result.stderr}\n${result.stdout}`);
}
const under = (file, dir) => file === dir || file.startsWith(`${dir}/`);

export async function buildCapsule({ repo, command, output, timeoutMs = 10_000, onProgress = () => {},
  npmPath, installTimeoutMs = 60_000, allowInstallScripts = false, offline = false,
  baselineRuns = 2, matchStderr, exitCode, maxRuns = Infinity, maxTimeMs = Infinity, keep = [] }) {
  const started = performance.now();
  const budget = new ReductionBudget({ maxRuns, maxTimeMs, baselineRuns });
  const predicate = createPredicate({ matchStderr, exitCode });
  const destination = await validateOutput(repo, output);
  const workspace = await createWorkspace(repo);
  let outputCreated = false;
  try {
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
    const manager = await detectPackageManager(workspace.snapshot, workspace.files);
    const npm = manager.needsInstall ? await discoverNpm({ npmPath, cwd: workspace.snapshot }) : null;
    const commandNpm = npm ?? (commandUsesNpm(command) ? await discoverNpm({ npmPath, cwd: workspace.snapshot }) : null);
    const commandEnv = commandNpm ? await npmEnvironment(commandNpm, workspace.root) : {};
    const sourceSnapshotId = snapshotId(await fileHashes(workspace.snapshot, workspace.files));
    const protectedFiles = workspace.files.filter((file) => isControlFile(file) || keep.some((entry) => under(file, entry)));
    const candidates = workspace.files.filter((file) => !protectedFiles.includes(file));
    const originalDependencies = manager.ids;
    let retainedDependencies = [...originalDependencies], retained = [...workspace.files];
    const packageStates = new Map(), cache = new Map();
    let cacheHits = 0, installCount = 0, attempts = 0, accepted = 0;
    let dependencyAttempts = 0, dependencyAccepted = 0, terminationReason = 'complete';
    const packageKey = (ids) => JSON.stringify([...ids].sort());
    if (npm) packageStates.set(packageKey(originalDependencies), {
      pkg: await readFile(path.join(workspace.snapshot, 'package.json'), 'utf8'),
      lock: await readFile(path.join(workspace.snapshot, 'package-lock.json'), 'utf8'),
    });
    async function applyPackage(cwd, ids) {
      const state = packageStates.get(packageKey(ids));
      if (state) {
        await writeFile(path.join(cwd, 'package.json'), state.pkg);
        await writeFile(path.join(cwd, 'package-lock.json'), state.lock);
      } else await writePackageSelection(cwd, manager.pkg, ids);
      return Boolean(state);
    }
    async function observe(files, ids, reduction = false) {
      if (reduction && budget.reason()) throw budget.exhausted();
      const cwd = await workspace.materialize(files);
      if (npm) {
        const knownLock = await applyPackage(cwd, ids);
        try {
          installCount++;
          await npmInstall({ cwd, npm, updateLock: !knownLock, timeoutMs: reduction ? budget.remaining(installTimeoutMs) : installTimeoutMs, allowInstallScripts, offline });
        } catch (error) {
          if (reduction && budget.reason() === 'max-time') throw budget.exhausted('max-time');
          throw error;
        }
        if (!knownLock) packageStates.set(packageKey(ids), {
          pkg: await readFile(path.join(cwd, 'package.json'), 'utf8'),
          lock: await readFile(path.join(cwd, 'package-lock.json'), 'utf8'),
        });
      }
      if (reduction && budget.reason()) throw budget.exhausted();
      budget.runs++;
      const result = await runCommand({ command, cwd, env: commandEnv, timeoutMs: reduction ? budget.remaining(timeoutMs) : timeoutMs });
      if (reduction && result.timedOut && budget.reason() === 'max-time') throw budget.exhausted('max-time');
      return { result, signature: failureSignature(result, { roots: [cwd] }), cwd };
    }
    const first = await observe(retained, retainedDependencies);
    if (!first.signature || infrastructureFailure(first.result) || !matchesPredicate(predicate, first.signature, first.result, first.cwd)) {
      const reason = first.result.timedOut ? 'command timed out' : first.result.outputExceeded ? 'output limit exceeded' : first.result.exitCode === 0 ? 'command succeeded' : infrastructureFailure(first.result) ? 'missing module, command or package setup' : 'no matching normal failure';
      throw new ReproError('INVALID_BASELINE', `Cannot establish a safe baseline: ${reason}.`);
    }
    for (let run = 1; run < baselineRuns; run++) {
      const observed = await observe(retained, retainedDependencies);
      if (!matchesPredicate(predicate, first.signature, observed.result, observed.cwd)) {
        throw new ReproError('UNSTABLE_BASELINE', 'NON-DETERMINISTIC BASELINE: clean runs disagree under the selected failure predicate.');
      }
    }
    onProgress({ phase: 'baseline', candidates: candidates.length, baselineRuns, predicate: predicate.type });
    async function preserves(files, ids) {
      const key = JSON.stringify([[...files].sort(), [...ids].sort(), command, predicate]);
      if (cache.has(key)) { cacheHits++; return cache.get(key); }
      let observed;
      try { observed = await observe(files, ids, true); }
      catch (error) {
        // A candidate that cannot install is not a preserving candidate. Do not cache
        // potentially transient installation failures or timeouts.
        if (['INSTALL_FAILED', 'INVALID_LOCKFILE', 'INSTALL_TIMEOUT', 'INSTALL_OUTPUT_LIMIT'].includes(error.code)) return false;
        throw error;
      }
      const matches = matchesPredicate(predicate, first.signature, observed.result, observed.cwd);
      if (!observed.result.timedOut && !observed.result.outputExceeded && !observed.result.signal) cache.set(key, matches);
      return matches;
    }
    async function reduceProjectFiles() {
      const localPaths = npm ? localReferences(selectDependencies(manager.pkg, retainedDependencies)) : [];
      const fixed = retained.filter((file) => protectedFiles.includes(file) || localPaths.some((entry) => under(file, entry)));
      const removable = retained.filter((file) => !fixed.includes(file));
      const reduction = await reduceFiles(removable, (files) => preserves([...fixed, ...files], retainedDependencies), {
        shouldStop: () => budget.reason(), onProgress: (event) => onProgress({ phase: 'reduction', ...event }),
      });
      retained = [...fixed, ...reduction.retained].sort();
      attempts += reduction.attempts; accepted += reduction.accepted;
      if (!reduction.complete) terminationReason = reduction.terminationReason;
    }
    await reduceProjectFiles();
    if (npm && terminationReason === 'complete') {
      const reduction = await reduceFiles(retainedDependencies, (ids) => preserves(retained, ids), {
        shouldStop: () => budget.reason(), onProgress: (event) => onProgress({ phase: 'dependencies', ...event }),
      });
      retainedDependencies = reduction.retained;
      dependencyAttempts = reduction.attempts; dependencyAccepted = reduction.accepted;
      attempts += reduction.attempts; accepted += reduction.accepted;
      if (!reduction.complete) terminationReason = reduction.terminationReason;
      // Removing a local dependency can make its tarball/source files removable.
      if (terminationReason === 'complete' && reduction.accepted) await reduceProjectFiles();
    }
    const final = await observe(retained, retainedDependencies);
    if (!matchesPredicate(predicate, first.signature, final.result, final.cwd)) {
      throw new ReproError('FINAL_VERIFICATION_FAILED', 'The reduced file set did not reproduce reliably.');
    }
    const signature = first.signature;
    const manifest = {
      schemaVersion: 1, tool: { name: 'reprocapsule', version: '0.2.0' }, command,
      failurePredicate: predicate,
      failureSignature: { version: signature.version, strategy: signature.strategy, digest: signature.digest, exitCode: signature.exitCode },
      sourceSnapshotId,
      environment: { node: process.version, npm: commandNpm?.version ?? null, platform: process.platform, osRelease: os.release(), arch: process.arch },
      reduction: {
        originalFileCount: workspace.files.length, finalFileCount: retained.length,
        originalCandidateCount: candidates.length, finalCandidateCount: retained.filter((file) => !protectedFiles.includes(file)).length,
        reductionPercentage: Number(((workspace.files.length - retained.length) / Math.max(1, workspace.files.length) * 100).toFixed(2)),
        candidateAttempts: attempts, acceptedReductions: accepted, reproductionAttempts: budget.runs + 1,
        cacheHits, installCount: installCount + (npm ? 1 : 0), baselineRuns,
        durationBeforePackageVerificationMs: Math.round(performance.now() - started), terminationReason,
        complete: terminationReason === 'complete',
        guarantee: terminationReason === 'complete' ? 'phase-local 1-minimal sets for a deterministic predicate; protected files and peers retained; no global minimum claim' : 'PARTIAL: best verified state; no minimality claim',
      },
      budget: { maxRuns: Number.isFinite(maxRuns) ? maxRuns : null, maxTimeMs: Number.isFinite(maxTimeMs) ? maxTimeMs : null, finalVerificationReservedRuns: 2 },
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
    const readmeName = retained.includes('README.md') ? 'README.reprocapsule.md' : 'README.md';
    manifest.generatedFiles = ['capsule.json', readmeName, 'reproduce.sh'];
    const installInstruction = npm ? `First run npm ci${allowInstallScripts ? '' : ' --ignore-scripts'} (scripts ${allowInstallScripts ? 'explicitly enabled' : 'disabled'}).\n` : '';
    await writeFile(path.join(destination, readmeName), `# Reproduction capsule\n\n${terminationReason === 'complete' ? 'Reduction completed.' : 'PARTIAL reduction: ' + terminationReason}\n\n${installInstruction}Then run sh ./reproduce.sh from this directory.\nExpected failing exit code: ${signature.exitCode}.\nFailure predicate: ${predicate.type}${predicate.type === 'strict' ? '' : ' (explicit user choice; broader than transcript equality)'}.\n\nUse reprocapsule verify PATH for independent fresh-copy verification.\nCommands are trusted local input, NOT sandboxed. Review before executing.\nNo node_modules are shipped. Environment values and raw command output are not recorded.\n`);
    await writeFile(path.join(destination, 'reproduce.sh'), `#!/bin/sh\ncd -- "$(dirname -- "$0")" || exit 1\nexec /bin/sh -c ${quote(command)}\n`, { mode: 0o755 });
    manifest.fileHashes = await fileHashes(destination, [...retained, readmeName, 'reproduce.sh']);
    await writeFile(path.join(destination, 'capsule.json'), JSON.stringify(manifest, null, 2) + '\n');
    // Verification copies the finished capsule, installs from scratch, and never
    // trusts the node_modules or process-written files from any reduction attempt.
    const verification = await verifyCapsule({ capsule: destination, npm, npmPath, timeoutMs, installTimeoutMs, allowInstallScripts, offline });
    budget.runs++;
    const elapsedMs = Math.round(performance.now() - started);
    onProgress({ phase: 'complete', output: destination, terminationReason });
    return { output: destination, manifest, verification, elapsedMs };
  } catch (error) {
    if (outputCreated) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally { await workspace.cleanup(); }
}
