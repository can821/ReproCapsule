import { spawn } from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import { performance } from 'node:perf_hooks';
import { ReproError } from './errors.js';

export async function runCommand({ command, cwd, timeoutMs = 10_000, maxOutputBytes = 1_048_576, env = {} }) {
  const windows = process.platform === 'win32';
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
    const child = spawn(windows?process.execPath:command, windows?[fileURLToPath(new URL('./windows-command.js',import.meta.url)),command]:[], {
      cwd, shell: windows ? false : '/bin/sh', detached: !windows, windowsHide: true,
      stdio: windows ? ['ignore','pipe','pipe','ipc'] : ['ignore', 'pipe', 'pipe'],
      env: {
        ...Object.fromEntries(Object.entries({...process.env,...env}).filter(([key])=>key.toUpperCase()!=='PATH')),
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
    let escalation, cleanup, commandOutcome;
    const killTree = () => cleanup ??= new Promise((done) => {
      if (!child.pid) return done();
      const killer = spawn(path.join(process.env.SystemRoot || 'C:\\Windows','System32','taskkill.exe'), ['/pid',String(child.pid),'/T','/F'], {windowsHide:true,stdio:'ignore'});
      const limit=setTimeout(()=>{killer.kill();done(new Error('taskkill timeout'));},5000);
      killer.once('error',error=>{clearTimeout(limit);done(error);});
      killer.once('close',code=>{clearTimeout(limit);done(code===0?null:new Error('taskkill failed'));});
    });
    const stop = () => {
      if(windows){
        killTree().then(error=>{if(error){child.stdout.destroy();child.stderr.destroy();child.kill();detach();clearTimeout(timer);reject(new ReproError('PROCESS_CLEANUP_FAILED','Windows process tree cleanup could not be confirmed.'));}});
        return;
      }
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
    if(windows)child.on('message',outcome=>{commandOutcome=outcome;stop();});
    child.stdout.on('data', capture(stdout));
    child.stderr.on('data', capture(stderr));
    child.once('error', (cause) => {
      detach(); clearTimeout(timer); clearTimeout(escalation); if(!windows)killGroup('SIGKILL');
      reject(new ReproError('COMMAND_START_FAILED', 'Could not start the reproduction command.', { cause }));
    });
    child.once('close', async (exitCode, signal) => {
      // Also reap background descendants when the shell exited before them.
      if(!windows)killGroup('SIGKILL');
      if(windows && cleanup && await cleanup){detach();clearTimeout(timer);reject(new ReproError('PROCESS_CLEANUP_FAILED','Windows process tree cleanup could not be confirmed.'));return;}
      detach(); clearTimeout(timer); clearTimeout(escalation);
      if (interrupted) { reject(new ReproError('INTERRUPTED', 'Execution interrupted; resume from the last accepted checkpoint.')); return; }
      if(commandOutcome?.startFailed){reject(new ReproError('COMMAND_START_FAILED','Could not start the reproduction command.'));return;}
      if(commandOutcome){exitCode=commandOutcome.exitCode;signal=commandOutcome.signal;}
      resolve({
        exitCode, signal, timedOut, outputExceeded,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        durationMs: Math.round(performance.now() - started),
      });
    });
  });
}
