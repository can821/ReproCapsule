import { failureSignature, sameFailure } from './failure-signature.js';
import { ReproError } from './errors.js';

export function validateMatcher(node, depth = 0) {
  if (!node || typeof node !== 'object' || Array.isArray(node) || depth > 8) throw new ReproError('INVALID_ARGUMENTS','Invalid matcher tree.');
  if (node.all || node.any) {
    const keys = Object.keys(node), children = node.all ?? node.any;
    if (keys.length !== 1 || !Array.isArray(children) || children.length < 1 || children.length > 16) throw new ReproError('INVALID_ARGUMENTS','ALL/ANY requires 1–16 conditions.');
    children.forEach(child => validateMatcher(child,depth+1)); return node;
  }
  if (node.field === 'exitCode') {
    if (Object.keys(node).sort().join() !== 'equals,field' || !Number.isInteger(node.equals) || node.equals < 1 || node.equals > 255) throw new ReproError('INVALID_ARGUMENTS','Invalid failing exit code.');
  } else {
    if (!['stderr','stdout','exception','stack'].includes(node.field) || Object.keys(node).sort().join() !== 'contains,field' || typeof node.contains !== 'string' || !node.contains.trim() || node.contains.length > 4096) throw new ReproError('INVALID_ARGUMENTS','Text matcher needs field and nonempty contains text.');
  }
  return node;
}
export function createPredicate({ matchStderr, exitCode, matcher } = {}) {
  if (matcher !== undefined) {
    if (matchStderr !== undefined || exitCode !== undefined) throw new ReproError('INVALID_ARGUMENTS','Choose matcher or legacy stderr options.');
    return {type:'composite',matcher:validateMatcher(matcher),userDefined:true};
  }
  if (matchStderr === undefined) {
    if (exitCode !== undefined) throw new ReproError('INVALID_ARGUMENTS', '--exit-code requires --match-stderr.');
    return { type: 'strict' };
  }
  if (typeof matchStderr !== 'string' || !matchStderr.trim() || (exitCode !== undefined && (!Number.isInteger(exitCode) || exitCode < 1 || exitCode > 255))) throw new ReproError('INVALID_ARGUMENTS','Explicit stderr matching needs nonempty text and a failing exit code (1–255).');
  return { type:'stderr-contains',text:matchStderr,exitCode:exitCode ?? 1,userDefined:true };
}
function match(node, result) {
  if (node.all) return node.all.every(child => match(child,result));
  if (node.any) return node.any.some(child => match(child,result));
  if (node.field === 'exitCode') return result.exitCode === node.equals;
  const output = `${result.stderr}\n${result.stdout}`;
  const value = node.field === 'exception' ? output.split('\n').filter(line => /^[\w.$]*(?:Error|Exception)(?:\s*\[[^\]]+\])?:/.test(line)).join('\n')
    : node.field === 'stack' ? output.split('\n').filter(line => /^\s*at\s/.test(line)).join('\n') : result[node.field];
  return value.includes(node.contains);
}
export function matchesPredicate(predicate, expected, result, cwd) {
  const actual = failureSignature(result,{roots:[cwd]});
  if (predicate.type === 'strict') return sameFailure(expected,actual);
  if (!actual || /(?:ERR_MODULE_NOT_FOUND|Cannot find module|MODULE_NOT_FOUND|ERR_TEST_FAILURE.*no tests)/.test(`${result.stderr}\n${result.stdout}`) || result.exitCode === 126 || result.exitCode === 127) return false;
  if (predicate.type === 'composite') return match(predicate.matcher,result);
  return result.exitCode === predicate.exitCode && result.stderr.includes(predicate.text);
}
