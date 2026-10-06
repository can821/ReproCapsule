import { mkdtemp, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { git } from './git.js';
import { createWorkspace } from './workspace.js';
import { executeProject } from './project-runner.js';
import { createPredicate, matchesPredicate } from './predicate.js';
import { ReproError } from './errors.js';

// Git 2.55 quotes the bisect term; older Git prints it without quotes.
export function firstBadCommit(stdout) {
  return stdout.match(/(?:^|\n)([a-f0-9]{40,64}) is the first (?:bad|'bad') commit(?:\r?\n|$)/)?.[1] ?? null;
}

export async function bisectRegression({ repo, good, bad, command, maxRuns = 32, maxTimeMs = 120_000, matchStderr, exitCode, ...execution }) {
  if (!repo || !good || !bad || !command?.trim() || !Number.isSafeInteger(maxRuns) || maxRuns < 3 || !Number.isSafeInteger(maxTimeMs) || maxTimeMs < 1) throw new ReproError('INVALID_ARGUMENTS', 'Bisect requires repo/good/bad/command and a budget of at least 3 runs.');
  const source = await realpath(repo), started = Date.now(), evaluated = [];
  const resolve = async (ref) => (await git(source, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).stdout.trim();
  const goodHash = await resolve(good), badHash = await resolve(bad);
  if (goodHash === badHash || (await git(source, ['merge-base', '--is-ancestor', goodHash, badHash], { allowFailure: true })).exitCode !== 0) throw new ReproError('INVALID_ARGUMENTS', 'Good must be a distinct ancestor of bad.');
  const root = await mkdtemp(path.join(os.tmpdir(), 'reprocapsule-bisect-')), clone = path.join(root, 'history');
  const predicate = createPredicate({ matchStderr, exitCode });
  let runs = 0, attempts = 0, expected;
  const remaining = () => Math.max(1, maxTimeMs - (Date.now() - started));
  const outOfBudget = () => attempts >= maxRuns || Date.now() - started >= maxTimeMs;
  const summary = (status, extra = {}) => ({ success: status === 'FOUND', status, good: goodHash, bad: badHash, evaluated,
    reproductionRuns: runs, evaluationAttempts: attempts, elapsedMs: Date.now() - started, failurePredicate: predicate, ...extra });
  async function observe(hash) {
    if (outOfBudget()) throw new ReproError('BISECT_BUDGET', 'Bisect budget exhausted.');
    await git(clone, ['checkout', '--detach', '--force', hash], { timeoutMs: remaining() });
    const workspace = await createWorkspace(clone);
    try {
      const cwd = await workspace.materialize(workspace.files);
      attempts++;
      const observed = await executeProject(workspace, cwd, workspace.files, { ...execution, command, onRun: () => runs++,
        timeoutMs: Math.min(execution.timeoutMs ?? 10_000, remaining()), installTimeoutMs: Math.min(execution.installTimeoutMs ?? 60_000, remaining()) });
      const valid = !observed.result.timedOut && !observed.result.outputExceeded && !observed.result.signal;
      const classification = expected && matchesPredicate(predicate, expected, observed.result, cwd) ? 'bad' : valid && observed.result.exitCode === 0 ? 'good' : 'skip';
      return { ...observed, classification, reason: valid ? classification === 'skip' ? 'different-failure' : 'predicate-result' : 'inconclusive-execution' };
    } catch (error) {
      if (['INSTALL_FAILED', 'INSTALL_TIMEOUT', 'INSTALL_OUTPUT_LIMIT', 'INVALID_LOCKFILE', 'INVALID_PACKAGE', 'UNSUPPORTED_PACKAGE_MANAGER', 'EXTERNAL_DEPENDENCY'].includes(error.code)) return { classification: 'skip', reason: error.code };
      throw error;
    } finally { await workspace.cleanup(); }
  }
  try {
    await git(root, ['clone', '--no-hardlinks', '--no-checkout', '--', source, clone], { timeoutMs: remaining() });
    const baseline = await observe(badHash);
    if (!baseline.signature || !matchesPredicate(predicate, baseline.signature, baseline.result, baseline.cwd)) throw new ReproError('INVALID_BASELINE', 'Bad boundary does not establish a normal matching failure.');
    expected = baseline.signature;
    evaluated.push({ commit: badHash, classification: 'bad', reason: 'baseline' });
    const repeated = await observe(badHash);
    if (repeated.classification !== 'bad') throw new ReproError('UNSTABLE_BASELINE', 'Bad boundary failure is not stable.');
    evaluated.push({ commit: badHash, classification: 'bad', reason: 'baseline-repeat' });
    const boundary = await observe(goodHash);
    if (boundary.classification !== 'good') throw new ReproError('INVALID_BASELINE', 'Good boundary must complete successfully; unrelated errors are untestable.');
    evaluated.push({ commit: goodHash, classification: 'good', reason: 'good-boundary' });
    let result = await git(clone, ['bisect', 'start', badHash, goodHash], { allowFailure: true, timeoutMs: remaining() });
    const seen = new Set();
    while (true) {
      const found = firstBadCommit(result.stdout);
      if (found) return summary('FOUND', { firstTestedBadCommit: found, meaning: 'First tested bad commit identified by native git bisect; not proof of causation.' });
      if (result.exitCode !== 0) {
        if (/only.*skip.*commits left|first bad commit could be any/i.test(result.stdout + result.stderr)) return summary('AMBIGUOUS', { meaning: 'Skipped revisions prevent a unique first bad commit.' });
        throw new ReproError('GIT_FAILED', 'Native git bisect could not continue.');
      }
      if (outOfBudget()) return summary('BUDGET EXHAUSTED');
      const hash = (await git(clone, ['rev-parse', 'HEAD'])).stdout.trim();
      if (seen.has(hash)) return summary('AMBIGUOUS', { meaning: 'Bisect revisited an unresolvable revision.' });
      seen.add(hash);
      const observed = await observe(hash);
      evaluated.push({ commit: hash, classification: observed.classification, reason: observed.reason });
      result = await git(clone, ['bisect', observed.classification], { allowFailure: true, timeoutMs: remaining() });
    }
  } catch (error) {
    if (error.code === 'BISECT_BUDGET') return summary('BUDGET EXHAUSTED');
    throw error;
  } finally { await rm(root, { recursive: true, force: true }); }
}
