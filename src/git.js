import { runCommand } from './runner.js';
import { quote } from './package-manager.js';
import { ReproError } from './errors.js';
export async function git(cwd, args, { timeoutMs = 30_000, allowFailure = false } = {}) {
  const result = await runCommand({ cwd, command: ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'submodule.recurse=false', ...args].map(quote).join(' '), timeoutMs,
    env: { ...Object.fromEntries(Object.keys(process.env).filter((key) => key.startsWith('GIT_')).map((key) => [key, undefined])), LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' } });
  if (result.timedOut || result.outputExceeded || result.signal || !allowFailure && result.exitCode !== 0) throw new ReproError('GIT_FAILED', 'Local Git operation failed or exceeded its limits.');
  return result;
}
