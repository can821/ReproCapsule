import test from 'node:test';
import assert from 'node:assert/strict';
import { failureSignature, sameFailure } from '../src/failure-signature.js';
const result = (stderr, extra = {}) => ({ exitCode: 1, signal: null, timedOut: false, outputExceeded: false, stdout: '', stderr, ...extra });

test('same error matches across workspace paths, ANSI and explicit timing metadata', () => {
  const a = failureSignature(result('\x1b[31mTypeError: bad value\x1b[0m\n at /tmp/a/src/parser.js:4:2\ntimestamp: 2026-10-02T10:01:22.003Z\n# duration_ms 12.32'), { roots: ['/tmp/a'] });
  const b = failureSignature(result('TypeError: bad value\n at /tmp/b/src/parser.js:4:2\ntimestamp: 2026-10-02T10:01:25.777Z\n# duration_ms 500'), { roots: ['/tmp/b'] });
  assert.equal(sameFailure(a, b), true);
});

test('different failure, location, numeric message and exit code do not match', () => {
  const original = failureSignature(result('TypeError: value 42\n at src/parser.js:4:2'));
  for (const changed of [result("Error: Cannot find module './parser.js'"), result('TypeError: value 43\n at src/parser.js:4:2'), result('TypeError: value 42\n at src/other.js:4:2'), result('TypeError: value 42\n at src/parser.js:4:2', { exitCode: 2 })]) {
    assert.equal(sameFailure(original, failureSignature(changed)), false);
  }
});

test('success, timeout, signal, truncated and empty failures are never signatures', () => {
  for (const extra of [{ exitCode: 0 }, { timedOut: true }, { signal: 'SIGTERM' }, { outputExceeded: true }, { stderr: '' }]) {
    assert.equal(failureSignature(result('Error: bug', extra)), null);
  }
  assert.equal(sameFailure(null, null), false);
});

test('unexpected output changes are conservatively rejected', () => {
  assert.equal(sameFailure(failureSignature(result('Error: bug', { stdout: 'seed=123' })), failureSignature(result('Error: bug', { stdout: 'seed=456' }))), false);
});
