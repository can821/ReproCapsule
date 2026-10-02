import { createHash } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';

export function normalizeOutput(value, { roots = [] } = {}) {
  let text = stripVTControlCharacters(value).replaceAll('\r\n', '\n');
  for (const root of [...new Set(roots)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(root).join('<workspace>');
  }
  // Normalize only recognized timing metadata, never arbitrary numbers or paths.
  return text.split('\n').map((line) => line
    .replace(/^(\s*(?:#\s*)?duration_ms:\s*)[\d.]+\s*$/, '$1<duration>')
    .replace(/^(# duration_ms )[\d.]+\s*$/, '$1<duration>')
    .replace(/^(\s*timestamp:\s*)\d{4}-\d{2}-\d{2}T[\d:.]+Z\s*$/, '$1<timestamp>')
    .trimEnd()).join('\n').trim();
}

export function failureSignature(result, options) {
  if (result.timedOut || result.outputExceeded || result.signal ||
      !Number.isInteger(result.exitCode) || result.exitCode <= 0) return null;
  const stdout = normalizeOutput(result.stdout, options);
  const stderr = normalizeOutput(result.stderr, options);
  // An empty exit-1 result is not enough evidence to identify a bug.
  if (!stdout && !stderr) return null;
  const evidence = { exitCode: result.exitCode, stdout, stderr };
  return {
    version: 1,
    strategy: 'normalized-transcript-sha256',
    digest: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
    ...evidence,
  };
}

export function sameFailure(expected, actual) {
  return Boolean(expected && actual && expected.version === actual.version &&
    expected.strategy === actual.strategy && expected.digest === actual.digest);
}
