import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildCapsule } from './capsule.js';
import { verifyCapsule } from './verify.js';
import { resumeOptions } from './checkpoint.js';
import { ReproError } from './errors.js';

const help = `ReproCapsule — reduce and independently verify failing npm projects

  reprocapsule reduce --repo PATH --command 'node test/repro.js' --out PATH
  reprocapsule verify CAPSULE
  reprocapsule resume CHECKPOINT --out NEW_PATH

Options:
  --timeout-ms N / --command-timeout N  Command timeout in milliseconds (10000)
  --install-timeout-ms N               npm timeout per installation (60000)
  --npm-path PATH                     Existing npm executable or npm-cli.js
  --allow-install-scripts              Explicit opt-in; default ignores scripts
  --offline                           npm offline mode (local fixture packages)
  --baseline-runs N                   Clean baseline repetitions, 2–100 (2)
  --match-stderr TEXT [--exit-code N]   Explicit broader failure predicate
  --max-runs N                        Total reproduction budget, including 2 final runs
  --max-time N                        Reduction deadline in seconds; final verification extra
  --audit-minimality                  Fresh single-removal audit within the run budget
  --reduce-input PATH                 Minimise one selected JSON file
  --input-max-runs N                  Limit JSON candidate evaluations (200)
  --cache-dir PATH                    Opt-in scoped persistent candidate outcomes
  --checkpoint PATH                   Atomic progress file outside source/output
  --keep RELATIVE_PATH                Protect a file/directory; repeatable
  --json                              Machine-readable result
  --help                              Show help

Node.js 24+, npm 9+ for external packages, macOS/Linux. Trusted local commands;
NOT a sandbox. Installs occur only in copied workspaces; scripts default OFF.
Output must be new and outside the source. Final verification always uses a fresh copy.
`;

export function cliExitCode(error) {
  if (error.code === 'INVALID_BASELINE') return 3;
  if (error.code === 'UNSTABLE_BASELINE') return 4;
  if (['CAPSULE_VERIFICATION_FAILED', 'FINAL_VERIFICATION_FAILED', 'INTEGRITY_FAILED', 'INVALID_CAPSULE'].includes(error.code)) return 5;
  if (['NPM_UNAVAILABLE', 'INVALID_LOCKFILE', 'INVALID_PACKAGE', 'UNSUPPORTED_PACKAGE_MANAGER', 'EXTERNAL_DEPENDENCY', 'INSTALL_FAILED', 'INSTALL_TIMEOUT', 'INSTALL_OUTPUT_LIMIT'].includes(error.code)) return 6;
  return 1; // Existing CLI input/error exit code is retained for compatibility.
}
export async function main(args = process.argv.slice(2)) {
  const stringNames = ['repo', 'command', 'out', 'timeout-ms', 'command-timeout', 'install-timeout-ms', 'npm-path', 'baseline-runs', 'match-stderr', 'exit-code', 'max-runs', 'max-time', 'checkpoint', 'cache-dir', 'reduce-input', 'input-max-runs'];
  const options = Object.fromEntries(stringNames.map((name) => [name, { type: 'string' }]));
  for (const name of ['help', 'json', 'allow-install-scripts', 'offline', 'audit-minimality']) options[name] = { type: 'boolean' };
  options.keep = { type: 'string', multiple: true };
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options });
  if (values.help) { console.log(help); return; }
  const positive = (key, fallback) => {
    if (values[key] === undefined) return fallback;
    const value = Number(values[key]);
    if (!Number.isSafeInteger(value) || value < 1 || value > 2_147_483_647) throw new ReproError('INVALID_ARGUMENTS', `--${key} must be a positive integer up to 2147483647.`);
    return value;
  };
  const common = {
    timeoutMs: positive('command-timeout', positive('timeout-ms', 10_000)),
    installTimeoutMs: positive('install-timeout-ms', 60_000),
    npmPath: values['npm-path'], allowInstallScripts: values['allow-install-scripts'] ?? false, offline: values.offline ?? false,
  };
  if (positionals[0] === 'verify' && positionals.length === 2) {
    const result = await verifyCapsule({ capsule: path.resolve(positionals[1]), ...common });
    if (values.json) console.log(JSON.stringify(result));
    else console.log(`ReproCapsule verification\nIntegrity: PASS\nInstall: ${result.install === 'pass' ? 'PASS' : 'NOT REQUIRED'}\nFailure reproduction: PASS\nCAPSULE VERIFIED`);
    return result;
  }
  const resuming = positionals[0] === 'resume' && positionals.length === 2;
  if (!resuming && (positionals.length !== 1 || positionals[0] !== 'reduce' || !values.repo || !values.command?.trim())) {
    throw new ReproError('INVALID_ARGUMENTS', 'Use reduce --repo PATH --command COMMAND [--out PATH], or verify CAPSULE. See --help.');
  }
  const restored = resuming ? await resumeOptions(positionals[1], { allowInstallScripts: common.allowInstallScripts }) : {};
  const result = await buildCapsule({
    repo: values.repo ? path.resolve(values.repo) : undefined, command: values.command, output: path.resolve(values.out ?? './repro-capsule-output'), ...common,
    baselineRuns: positive('baseline-runs', 2), matchStderr: values['match-stderr'], exitCode: values['exit-code'] === undefined ? undefined : positive('exit-code'),
    maxRuns: positive('max-runs', Infinity), maxTimeMs: positive('max-time', Infinity) * 1000, keep: values.keep ?? [], checkpoint: values.checkpoint, audit: values['audit-minimality'] ?? false, cacheDir: values['cache-dir'], reduceInput: values['reduce-input'], inputMaxRuns: positive('input-max-runs', 200),
    ...restored,
    inputMaxRuns: positive('input-max-runs', restored.inputMaxRuns ?? 200),
    audit: values['audit-minimality'] ?? restored.audit ?? false,
    cacheDir: values['cache-dir'] ?? restored.cacheDir,
    onProgress(event) {
      if (values.json) return;
      if (event.phase === 'baseline') console.log(`Baseline failure confirmed (${event.baselineRuns} clean runs; ${event.predicate}${event.predicate === 'strict' ? '' : ', explicit user definition'})\n${event.candidates} candidate files\nReducing...`);
      if (event.phase === 'reduction') console.log(`  ${event.retained} removable files retained`);
      if (event.phase === 'input') console.log(`  JSON input: ${event.bytes} bytes`);
      if (event.phase === 'dependencies') console.log(`  ${event.retained} top-level dependency declarations retained`);
    },
  });
  const counts = result.manifest.reduction, deps = result.manifest.dependencies;
  const summary = { success: true, capsule: result.output, verified: result.verification.verified, complete: counts.complete,
    files: { before: counts.originalFileCount, after: counts.finalFileCount }, dependencies: { before: deps.originalCount, after: deps.finalCount },
    runs: counts.reproductionAttempts, cacheHits: counts.cacheHits, cacheMisses: counts.cacheMisses, persistentCacheHits: counts.persistentCacheHits, elapsedMs: result.elapsedMs,
    diagnostics: result.manifest.diagnostics, inputReduction: result.manifest.inputReduction, minimality: result.manifest.minimality, terminationReason: counts.terminationReason, failureDigest: result.manifest.failureSignature.digest };
  if (values.json) console.log(JSON.stringify(summary));
  else console.log(`Failure preserved\nProject files: ${counts.originalFileCount} -> ${counts.finalFileCount} (${counts.reductionPercentage}% reduction)\nDependencies: ${deps.originalCount} -> ${deps.finalCount}\nRuns: ${counts.reproductionAttempts}; cache hits: ${counts.cacheHits}; elapsed: ${result.elapsedMs} ms\n${counts.complete ? 'CAPSULE VERIFIED' : 'PARTIAL CAPSULE VERIFIED: ' + counts.terminationReason}\nCapsule created at ${result.output}`);
  if (!values.json) {
    for (const location of result.manifest.diagnostics.locations.slice(0, 3)) console.log(`Stack evidence: ${location.file}:${location.line}:${location.column}`);
  }
  if (!values.json && result.manifest.minimality.requested) console.log(`Minimality audit: ${result.manifest.minimality.status}`);
  if (!counts.complete) process.exitCode = 7;
  return summary;
}
