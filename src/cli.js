import path from 'node:path';
import { parseArgs } from 'node:util';
import { buildCapsule } from './capsule.js';
import { ReproError } from './errors.js';

const help = `ReproCapsule — reduce a failing Node.js project\n\nUsage:\n  reprocapsule reduce --repo PATH --command 'node test/repro.js' --out PATH\n\nOptions:\n  --timeout-ms N  Per-command timeout (default: 10000)\n  --help         Show this help\n\nRequires Node.js 24+ and macOS/Linux. Commands are trusted local shell input.\nOutput must be new and outside the source repository. No installs or network calls\nare performed by the reducer; the supplied command may have its own side effects.\n`;

export async function main(args = process.argv.slice(2)) {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: {
    repo: { type: 'string' }, command: { type: 'string' }, out: { type: 'string' },
    'timeout-ms': { type: 'string' }, help: { type: 'boolean' },
  } });
  if (values.help) { console.log(help); return; }
  if (positionals.length !== 1 || positionals[0] !== 'reduce' || !values.repo || !values.command?.trim()) {
    throw new ReproError('INVALID_ARGUMENTS', 'Use reduce --repo PATH --command COMMAND [--out PATH]. See --help.');
  }
  const timeoutMs = values['timeout-ms'] === undefined ? 10_000 : Number(values['timeout-ms']);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new ReproError('INVALID_ARGUMENTS', '--timeout-ms must be a positive integer up to 2147483647.');
  }
  const result = await buildCapsule({
    repo: path.resolve(values.repo), command: values.command,
    output: path.resolve(values.out ?? './repro-capsule-output'), timeoutMs,
    onProgress(event) {
      if (event.phase === 'baseline') console.log(`Baseline failure confirmed (2 clean runs)\n${event.candidates} candidate files\nReducing...`);
      if (event.phase === 'reduction') console.log(`  ${event.retained} candidate files retained`);
    },
  });
  const counts = result.manifest.reduction;
  console.log(`Failure preserved\nProject files: ${counts.originalFileCount} -> ${counts.finalFileCount} (${counts.reductionPercentage}% reduction)\nReproduction attempts: ${counts.reproductionAttempts}\nCapsule created at ${result.output}`);
}
