import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../src/runner.js';

const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
const node = (code) => `${quote(process.execPath)} -e ${quote(code)}`;

test('runner captures output, status and requested working directory', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'runner-'));
  try {
    const result = await runCommand({ cwd, command: node('console.log(process.cwd()); console.error("problem"); process.exit(7)') });
    assert.equal(result.exitCode, 7);
    assert.match(result.stdout, /runner-/);
    assert.equal(result.stderr, 'problem\n');
    assert.equal(result.timedOut, false);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('runner times out and kills a child process group', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'runner-'));
  try {
    const code = `const {spawn} = require('node:child_process'); const fs = require('node:fs');
      const child = spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], {stdio:'inherit'});
      fs.writeFileSync('child.pid', String(child.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`;
    const result = await runCommand({ cwd, command: node(code), timeoutMs: 800 });
    assert.equal(result.timedOut, true);
    assert.ok(result.durationMs < 5000);
    const pid = Number(await readFile(path.join(cwd, 'child.pid'), 'utf8'));
    let alive = true;
    for (let i = 0; i < 30 && alive; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      try { process.kill(pid, 0); } catch (error) { assert.equal(error.code, 'ESRCH'); alive = false; }
    }
    assert.equal(alive, false, 'descendant must be terminated');
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('runner bounds captured output', async () => {
  const result = await runCommand({ cwd: os.tmpdir(), command: node('process.stdout.write("x".repeat(100000))'), maxOutputBytes: 1000 });
  assert.equal(result.outputExceeded, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 1000);
});

test('runner reports startup errors and rejects invalid limits', async () => {
  await assert.rejects(runCommand({ cwd: '/does-not-exist-reprocapsule', command: 'node -v' }), { code: 'COMMAND_START_FAILED' });
  await assert.rejects(runCommand({ cwd: os.tmpdir(), command: 'node -v', timeoutMs: 0 }), { code: 'INVALID_LIMIT' });
});
