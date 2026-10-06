import { mkdir } from 'node:fs/promises';
import { collectCoverage, differentialCoverage } from './coverage.js';
import path from 'node:path';
import { createWorkspace } from './workspace.js';
import { executeProject } from './project-runner.js';
import { sameFailure } from './failure-signature.js';
import { localiseWithSourceMaps } from './source-maps.js';
import { ReproError } from './errors.js';
import { inspectCapsule } from './verify.js';

export async function compareExecutions({repo, passingRepo = repo, command, passingCommand, capsule, ...options}) {
  if (!repo || !command || !passingCommand) throw new ReproError('INVALID_ARGUMENTS','compare requires repo, failing command and passing command.');
  async function collect(source, cmd, failure) {
    const workspace = await createWorkspace(source);
    try {
      const coverage = path.join(workspace.root,'coverage'); await mkdir(coverage);
      const cwd = await workspace.materialize(workspace.files);
      const observed = await executeProject(workspace,cwd,workspace.files,{...options,command:cmd,executionEnv:{NODE_V8_COVERAGE:coverage}});
      const r = observed.result;
      if (r.timedOut || r.outputExceeded || r.signal || (failure ? !observed.signature : r.exitCode !== 0)) throw new ReproError('INVALID_COMPARISON','Expected a normal failing execution and a successful passing execution.');
      const regions = await collectCoverage(coverage,cwd,workspace.files);
      const executedFiles = regions.filter(r=>r.lines.length).map(r=>r.file);
      const stack = await localiseWithSourceMaps(r,cwd,workspace.files);
      if (failure) {
        const fresh = await workspace.materialize(workspace.files);
        const repeat = await executeProject(workspace,fresh,workspace.files,{...options,command:cmd});
        if (!sameFailure(observed.signature,repeat.signature)) throw new ReproError('UNSTABLE_BASELINE','Failing comparison is not repeatable.');
      }
      return {exitCode:r.exitCode,executedFiles,coverage:regions,stack,signature:observed.signature ? {digest:observed.signature.digest,strategy:observed.signature.strategy} : null};
    } finally { await workspace.cleanup(); }
  }
  const failing = await collect(repo,command,true), passing = await collect(passingRepo,passingCommand,false);
  let retained = null;
  if (capsule) {
    const {manifest} = await inspectCapsule(capsule);
    if (manifest.failurePredicate.type !== 'strict' || manifest.failureSignature.digest !== failing.signature.digest) throw new ReproError('INVALID_COMPARISON','Retained capsule must match the strict failing execution.');
    retained = {files:manifest.retainedFiles,sourceUnits:manifest.sourceReduction?.perFile?.map(r=>({file:r.file,units:r.retainedUnits})) ?? manifest.sourceReduction?.retainedUnits ?? null};
  }
  return {schemaVersion:1,method:'Node native V8 executed-range lines + mapped stack',failing,passing,differential:differentialCoverage(failing.coverage,passing.coverage),
    failingOnly:failing.executedFiles.filter(f => !passing.executedFiles.includes(f)),
    shared:failing.executedFiles.filter(f => passing.executedFiles.includes(f)),
    passingOnly:passing.executedFiles.filter(f => !failing.executedFiles.includes(f)),retained,
    meaning:'Executed-file and stack evidence only, not root-cause certainty. Paths compare logical files across inputs, not identical source contents. Executed-range lines compare only identical source contents; changed source is explicitly unaligned.'};
}
