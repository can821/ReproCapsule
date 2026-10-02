#!/usr/bin/env node
import { main, cliExitCode } from '../src/cli.js';

try { await main(); }
catch (error) {
  const message = error.name === 'ReproError' ? error.message : 'Operation failed. Check paths, access and CLI options; see --help.';
  const code = cliExitCode(error);
  if (process.argv.includes('--json')) console.log(JSON.stringify({ success: false, code: error.code ?? 'ERROR', message, exitCode: code }));
  else console.error(`ReproCapsule [${error.code ?? 'ERROR'}]: ${message}`);
  process.exitCode = code;
}
