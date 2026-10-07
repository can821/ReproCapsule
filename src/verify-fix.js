import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createWorkspace, inventory } from './workspace.js';
import { verifyCapsule } from './verify.js';
import { executeProject } from './project-runner.js';
import { git } from './git.js';
import { matchesPredicate } from './predicate.js';
import { runCommand } from './runner.js';
import { fileHashes } from './integrity.js';
import { ReproError } from './errors.js';

export async function verifyFix({ capsule, patch, testCommand, ...execution }) {
  if (!capsule || !patch || testCommand !== undefined && !testCommand.trim()) throw new ReproError('INVALID_ARGUMENTS', 'verify-fix requires a capsule and patch; optional test command must be nonempty.');
  const bytes = await readFile(patch);
  if (bytes.length > 4 * 1024 * 1024) throw new ReproError('INVALID_ARGUMENTS', 'Patch exceeds 4 MiB limit.');
  const workspace = await createWorkspace(capsule);
  try {
    const cwd = await workspace.materialize(workspace.files);
    if (JSON.parse(await readFile(path.join(cwd,'capsule.json'),'utf8')).pairedOracle) throw new ReproError('UNSUPPORTED_PAIRED_FIX','Patch verification of paired capsules is not supported; verify both controls explicitly.');
    if (JSON.parse(await readFile(path.join(cwd,'capsule.json'),'utf8')).reproductionPolicy) throw new ReproError('UNSUPPORTED_REPEATED_FIX','Patch verification currently requires a deterministic capsule; a single passing sample cannot prove intermittent target removal.');
    const baseline = await verifyCapsule({ capsule: cwd, ...execution });
    // Freeze verified metadata before applying an untrusted patch to the copy.
    const manifest = JSON.parse(await readFile(path.join(cwd, 'capsule.json'), 'utf8'));
    const generated = await fileHashes(cwd, manifest.generatedFiles);
    const patchPath = path.join(workspace.root, 'proposal.patch');
    await writeFile(patchPath, bytes);
    await git(cwd, ['init', '--quiet']);
    const failed = (reason) => ({ success: false, status: 'PATCH APPLICATION FAILED', reason, baseline, broaderTests: 'NOT RUN' });
    for (const args of [['apply', '--check', '--', patchPath], ['apply', '--', patchPath]]) {
      if ((await git(cwd, args, { allowFailure: true })).exitCode !== 0) return failed('Patch cannot be safely applied to the verified copy.');
    }
    const info = await inventory(cwd);
    if (info.exclusions.some((entry) => entry.path !== '.git')) return failed('Patch introduced excluded files, symlinks or special files.');
    try {
      const current = await fileHashes(cwd, manifest.generatedFiles);
      if (Object.keys(generated).some((file) => generated[file] !== current[file])) return failed('Generated capsule metadata/instructions must not be patched.');
    } catch { return failed('Patch removed generated capsule metadata/instructions.'); }
    let observed;
    try { observed = await executeProject(workspace, cwd, info.files, { ...execution, command: manifest.command }); }
    catch (error) {
      if (!['INSTALL_FAILED', 'INSTALL_TIMEOUT', 'INSTALL_OUTPUT_LIMIT', 'INVALID_LOCKFILE', 'INVALID_PACKAGE', 'EXTERNAL_DEPENDENCY', 'UNSUPPORTED_PACKAGE_MANAGER'].includes(error.code)) throw error;
      return { success: false, status: 'INCONCLUSIVE', reason: error.code, baseline, broaderTests: 'NOT RUN' };
    }
    const normal = !observed.result.timedOut && !observed.result.outputExceeded && !observed.result.signal;
    const status = !normal ? 'INCONCLUSIVE' : observed.result.exitCode === 0 ? 'TARGET FAILURE REMOVED' :
      matchesPredicate(manifest.failurePredicate, manifest.failureSignature, observed.result, cwd) ? 'TARGET FAILURE STILL PRESENT' : 'DIFFERENT FAILURE INTRODUCED';
    let broaderTests = testCommand ? 'NOT RUN' : 'NOT PROVIDED';
    if (testCommand && status === 'TARGET FAILURE REMOVED') {
      const result = await runCommand({ cwd, command: testCommand, env: observed.env, timeoutMs: execution.timeoutMs ?? 10_000 });
      broaderTests = result.timedOut || result.outputExceeded || result.signal ? 'INCONCLUSIVE' : result.exitCode === 0 ? 'PASS' : 'FAIL';
    }
    return { success: status === 'TARGET FAILURE REMOVED' && ['PASS', 'NOT PROVIDED'].includes(broaderTests), status, baseline, broaderTests,
      meaning: 'Evidence about these commands only; does not prove the bug is completely fixed.' };
  } finally { await workspace.cleanup(); }
}
