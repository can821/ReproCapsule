#!/usr/bin/env node
import { main } from '../src/cli.js';

try { await main(); }
catch (error) {
  // Do not echo reproduction output, command strings or captured environment values.
  const known = error.name === 'ReproError';
  console.error(`ReproCapsule [${error.code ?? 'ERROR'}]: ${known ? error.message : 'Operation failed. Check paths, access and CLI options; see --help.'}`);
  process.exitCode = 1;
}
