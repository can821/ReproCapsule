import { spawn } from 'node:child_process';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { ReproError } from './errors.js';

export async function runCommand({ command, cwd, timeoutMs = 10_000, maxOutputBytes = 1_048_576, env = {} }) {
  if (process.platform === 'win32') {
    throw new ReproError('UNSUPPORTED_PLATFORM', 'V1 requires macOS or Linux for process-group cleanup.');
  }
  if (typeof command !== 'string' || !command.trim()) {
    throw new ReproError('INVALID_COMMAND', 'A non-empty trusted shell command is required.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647 ||
      !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new ReproError('INVALID_LIMIT', 'Timeout and output limit must be positive integers within supported bounds.');
  }
  const started = performance.now();
  return new Promise((resolve, reject) => {
    // The command itself is explicitly trusted input; never append paths or flags to it.
    const child = spawn(command, {
      cwd, shell: '/bin/sh', detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env, ...env,
        PATH: `${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? process.env.PATH ?? ''}`,
        NO_COLOR: '1', FORCE_COLOR: '0',
      },
    });
    const stdout = [], stderr = [];
    let bytes = 0, timedOut = false, outputExceeded = false, interrupted = false;
    const killGroup = (signal) => {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); }
      catch (error) { if (error.code !== 'ESRCH') child.kill(signal); }
    };
    let escalation;
    const stop = () => {
      killGroup('SIGTERM');
      escalation ??= setTimeout(() => killGroup('SIGKILL'), 100);
    };
    const interrupt = () => { interrupted = true; stop(); };
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    const detach = () => { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); };
    const timer = setTimeout(() => { timedOut = true; stop(); }, timeoutMs);
    const capture = (target) => (chunk) => {
      const remaining = Math.max(0, maxOutputBytes - bytes);
      if (remaining) target.push(chunk.subarray(0, remaining));
      bytes += chunk.length;
      if (bytes > maxOutputBytes && !outputExceeded) { outputExceeded = true; stop(); }
    };
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.once('error', (cause) => {
      detach(); clearTimeout(timer); clearTimeout(escalation); killGroup('SIGKILL');
      reject(new ReproError('COMMAND_START_FAILED', 'Could not start the reproduction command.', { cause }));
    });
    child.once('close', (exitCode, signal) => {
      // Also reap background descendants when the shell exited before them.
      killGroup('SIGKILL');
      detach(); clearTimeout(timer); clearTimeout(escalation);
      if (interrupted) { reject(new ReproError('INTERRUPTED', 'Execution interrupted; resume from the last accepted checkpoint.')); return; }
      resolve({
        exitCode, signal, timedOut, outputExceeded,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Math.round(performance.now() - started),
      });
    });
  });
}
