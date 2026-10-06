import path from 'node:path';
import { packCapsule, inspectArchive, unpackCapsule } from './portable.js';
import { dependencyBoundary } from './experiments.js';
import { readFile } from 'node:fs/promises';
import { observeReproduction } from './observe.js';
import { compareExecutions } from './compare.js';
import { parseArgs } from 'node:util';
import { buildCapsule } from './capsule.js';
import { verifyCapsule } from './verify.js';
import { reportCapsule } from './report.js';
import { verifyFix } from './verify-fix.js';
import { bisectRegression } from './bisect.js';
import { resumeOptions } from './checkpoint.js';
import { ReproError } from './errors.js';

const help = `ReproCapsule — reduce and independently verify failing npm projects

  reprocapsule reduce --repo PATH --command 'node test/repro.js' --out PATH
  reprocapsule dependency-boundary --repo PATH --command COMMAND --dependency NAME --versions V1,V2 --matcher FILE
  reprocapsule observe --repo PATH --command COMMAND --matcher FILE [--runs N]
  reprocapsule compare --repo PATH --command FAIL --passing-command PASS [--passing-repo PATH]
  reprocapsule bisect --repo PATH --good REF --bad REF --command COMMAND
  reprocapsule verify-fix CAPSULE --patch FILE [--test-command COMMAND]
  reprocapsule report CAPSULE --out FILE [--format html|markdown] [--plugin PATH]
  reprocapsule pack CAPSULE --out FILE.rcap.gz
  reprocapsule inspect FILE.rcap.gz
  reprocapsule unpack FILE.rcap.gz --out NEW_DIRECTORY
  reprocapsule verify CAPSULE
  reprocapsule resume CHECKPOINT --out NEW_PATH

Options:
  --timeout-ms N / --command-timeout N  Command timeout in milliseconds (10000)
  --install-timeout-ms N               npm timeout per installation (60000)
  --npm-path PATH                     Existing npm executable or npm-cli.js
  --allow-install-scripts              Explicit opt-in; default ignores scripts
  --offline                           npm offline mode (local fixture packages)
  --baseline-runs N                   Clean baseline repetitions, 2–100 (2)
  --matcher FILE                     JSON ALL/ANY conditions for exitCode/stdout/stderr/exception/stack
  --match-stderr TEXT [--exit-code N]   Explicit broader failure predicate
  --max-runs N                        Total reproduction budget, including 2 final runs
  --max-time N                        Reduction deadline in seconds; final verification extra
  --converge [--max-rounds N]          Repeat enabled reductions until unchanged (5 rounds)
  --audit-minimality                  Fresh single-removal audit within the run budget
  --reduce-input PATH                 Minimise one selected JSON file
  --reduce-source PATH                Opt-in hierarchical JS/TS AST source reduction
  --source-parser PATH                Explicit existing TypeScript compiler module
  --source-max-runs N                  Source candidate budget (100)
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
  const stringNames = ['repo', 'command', 'out', 'timeout-ms', 'command-timeout', 'install-timeout-ms', 'npm-path', 'baseline-runs', 'match-stderr', 'exit-code', 'max-runs', 'max-time', 'checkpoint', 'cache-dir', 'reduce-input', 'input-max-runs', 'good', 'bad', 'patch', 'test-command', 'format', 'plugin', 'reduce-source', 'source-parser', 'source-max-runs', 'max-rounds', 'passing-repo', 'passing-command', 'capsule', 'matcher', 'runs', 'dependency', 'versions', 'max-experiments'];
  const options = Object.fromEntries(stringNames.map((name) => [name, { type: 'string' }]));
  for (const name of ['help', 'json', 'allow-install-scripts', 'offline', 'audit-minimality', 'converge']) options[name] = { type: 'boolean' };
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
  if (['pack','inspect','unpack'].includes(positionals[0]) && positionals.length === 2) {
    if (positionals[0] !== 'inspect' && !values.out) throw new ReproError('INVALID_ARGUMENTS','pack/unpack require --out PATH.');
    const result = positionals[0] === 'pack' ? await packCapsule({capsule:positionals[1],output:values.out}) : positionals[0] === 'inspect' ? await inspectArchive(positionals[1]) : await unpackCapsule({archive:positionals[1],output:values.out});
    console.log(JSON.stringify(result)); return result;
  }
  const matcher = values.matcher ? JSON.parse(await readFile(values.matcher,'utf8')) : undefined;
  if (positionals[0] === 'dependency-boundary' && positionals.length === 1) {
    const result = await dependencyBoundary({repo:values.repo,command:values.command,dependency:values.dependency,values:values.versions?.split(','),matcher,matchStderr:values['match-stderr'],maxExperiments:positive('max-experiments',30),...common});
    console.log(JSON.stringify(result)); return result;
  }
  if (positionals[0] === 'observe' && positionals.length === 1) {
    const result = await observeReproduction({repo:values.repo,command:values.command,runs:positive('runs',10),matcher,matchStderr:values['match-stderr'],...common});
    console.log(JSON.stringify(result)); return result;
  }
  if (positionals[0] === 'compare' && positionals.length === 1) {
    const result = await compareExecutions({repo:values.repo,passingRepo:values['passing-repo'],command:values.command,passingCommand:values['passing-command'],capsule:values.capsule,...common});
    console.log(JSON.stringify(result)); return result;
  }
  if (positionals[0] === 'bisect' && positionals.length === 1) {
    const result = await bisectRegression({ repo: values.repo, good: values.good, bad: values.bad, command: values.command, ...common,
      matchStderr: values['match-stderr'], exitCode: values['exit-code'] === undefined ? undefined : positive('exit-code'),
      maxRuns: positive('max-runs', 32), maxTimeMs: positive('max-time', 120) * 1000 });
    console.log(values.json ? JSON.stringify(result) : result.status === 'FOUND' ? `First tested bad commit identified by bisect: ${result.firstTestedBadCommit}` : `Bisect: ${result.status}`);
    if (!result.success) process.exitCode = result.status === 'BUDGET EXHAUSTED' ? 7 : 5;
    return result;
  }
  if (positionals[0] === 'report' && positionals.length === 2) {
    if (!values.out) throw new ReproError('INVALID_ARGUMENTS','report requires --out FILE outside the capsule.');
    const result = await reportCapsule({ capsule: path.resolve(positionals[1]), output: path.resolve(values.out), format: values.format ?? 'html', plugin: values.plugin });
    console.log(values.json ? JSON.stringify(result) : `Report created: ${result.output} (integrity checked; command not executed)`);
    return result;
  }
  if (positionals[0] === 'verify-fix' && positionals.length === 2) {
    const result = await verifyFix({ capsule: path.resolve(positionals[1]), patch: values.patch, testCommand: values['test-command'], ...common });
    console.log(values.json ? JSON.stringify(result) : `${result.status}\nBroader test suite: ${result.broaderTests}`);
    if (!result.success) process.exitCode = 5;
    return result;
  }
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
    baselineRuns: positive('baseline-runs', 2), matcher, matchStderr: values['match-stderr'], exitCode: values['exit-code'] === undefined ? undefined : positive('exit-code'),
    maxRuns: positive('max-runs', Infinity), maxTimeMs: positive('max-time', Infinity) * 1000, keep: values.keep ?? [], checkpoint: values.checkpoint, audit: values['audit-minimality'] ?? false, cacheDir: values['cache-dir'], reduceInput: values['reduce-input'], inputMaxRuns: positive('input-max-runs', 200), reduceSource: values['reduce-source'], sourceParser: values['source-parser'], sourceMaxRuns: positive('source-max-runs', 100), converge:values.converge ?? false, maxRounds:positive('max-rounds',5),
    ...restored,
    inputMaxRuns: positive('input-max-runs', restored.inputMaxRuns ?? 200),
    sourceMaxRuns: positive('source-max-runs', restored.sourceMaxRuns ?? 100),
    maxRounds:positive('max-rounds',restored.maxRounds ?? 5),
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
    convergence:result.manifest.convergence, domainAudit:result.manifest.domainAudit, workspaces: result.manifest.workspaces, diagnostics: result.manifest.diagnostics, inputReduction: result.manifest.inputReduction, sourceReduction: result.manifest.sourceReduction, minimality: result.manifest.minimality, terminationReason: counts.terminationReason, failureDigest: result.manifest.failureSignature.digest };
  if (values.json) console.log(JSON.stringify(summary));
  else console.log(`Failure preserved\nProject files: ${counts.originalFileCount} -> ${counts.finalFileCount} (${counts.reductionPercentage}% reduction)\nDependencies: ${deps.originalCount} -> ${deps.finalCount}\nRuns: ${counts.reproductionAttempts}; cache hits: ${counts.cacheHits}; elapsed: ${result.elapsedMs} ms\n${counts.complete ? 'CAPSULE VERIFIED' : 'PARTIAL CAPSULE VERIFIED: ' + counts.terminationReason}\nCapsule created at ${result.output}`);
  if (!values.json && result.manifest.workspaces.originalCount) console.log(`Workspaces: ${result.manifest.workspaces.originalCount} -> ${result.manifest.workspaces.finalCount}`);
  if (!values.json) {
    for (const location of result.manifest.diagnostics.locations.slice(0, 3)) console.log(`Stack evidence: ${location.file}:${location.line}:${location.column}`);
  }
  if (!values.json && result.manifest.minimality.requested) console.log(`Minimality audit: ${result.manifest.minimality.status}`);
  if (!counts.complete) process.exitCode = 7;
  return summary;
}
