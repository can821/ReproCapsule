import { failureSignature, sameFailure } from './failure-signature.js';
import { ReproError } from './errors.js';

export function createPredicate({ matchStderr, exitCode } = {}) {
  if (matchStderr === undefined) {
    if (exitCode !== undefined) throw new ReproError('INVALID_ARGUMENTS', '--exit-code requires --match-stderr.');
    return { type: 'strict' };
  }
  if (typeof matchStderr !== 'string' || !matchStderr.trim() || (exitCode !== undefined && (!Number.isInteger(exitCode) || exitCode < 1 || exitCode > 255))) {
    throw new ReproError('INVALID_ARGUMENTS', 'Explicit stderr matching needs nonempty text and a failing exit code (1–255).');
  }
  return { type: 'stderr-contains', text: matchStderr, exitCode: exitCode ?? 1, userDefined: true };
}
export function matchesPredicate(predicate, expected, result, cwd) {
  const actual = failureSignature(result, { roots: [cwd] });
  if (predicate.type === 'strict') return sameFailure(expected, actual);
  return Boolean(actual && result.exitCode === predicate.exitCode && result.stderr.includes(predicate.text));
}
