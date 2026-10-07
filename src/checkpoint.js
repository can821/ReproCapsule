import { open, readFile, rename, rm, mkdir, lstat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ReproError } from './errors.js';
import { validateOutput } from './workspace.js';

export const toolVersion = '0.6.0-beta.1';
const phases = ['workspaces', 'files', 'dependencies', 'cleanup', 'input', 'source', 'done'];
export async function readCheckpoint(file) {
  let checkpoint;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw new Error('type/size');
    checkpoint = JSON.parse(await readFile(file, 'utf8'));
  } catch { throw new ReproError('INVALID_CHECKPOINT', 'Cannot read a regular, valid checkpoint JSON file.'); }
  if (checkpoint.schemaVersion !== 1 || checkpoint.toolVersion !== toolVersion) throw new ReproError('CHECKPOINT_INCOMPATIBLE', 'Checkpoint/tool version is incompatible.');
  const { config, state, acceptedFailure, runtime } = checkpoint;
  if (typeof checkpoint.source !== 'string' || !path.isAbsolute(checkpoint.source) ||
      !/^[a-f0-9]{64}$/.test(checkpoint.sourceSnapshotId ?? '') ||
      !config || typeof config.command !== 'string' || !config.command.trim() || !Array.isArray(config.keep) ||
      !state || !phases.includes(state.phase) || !Array.isArray(state.files) || !Array.isArray(state.dependencies) ||
      ![...state.files, ...state.dependencies, ...config.keep].every((value) => typeof value === 'string') ||
      !/^[a-f0-9]{64}$/.test(acceptedFailure?.digest ?? '') || !runtime || typeof runtime.node !== 'string') {
    throw new ReproError('INVALID_CHECKPOINT', 'Checkpoint state is incomplete or malformed.');
  }
  for (const key of ['timeoutMs', 'installTimeoutMs', 'baselineRuns']) {
    if (!Number.isSafeInteger(config[key]) || config[key] < 1 || config[key] > 2_147_483_647) throw new ReproError('INVALID_CHECKPOINT', 'Invalid checkpoint execution limits.');
  }
  for (const key of ['allowInstallScripts', 'offline']) {
    if (typeof config[key] !== 'boolean') throw new ReproError('INVALID_CHECKPOINT', 'Invalid checkpoint policy.');
  }
  if (!Number.isSafeInteger(checkpoint.counters?.reproductionAttempts) || checkpoint.counters.reproductionAttempts < 0) throw new ReproError('INVALID_CHECKPOINT', 'Invalid checkpoint counters.');
  if (state.convergence && (typeof state.convergence.enabled !== 'boolean' ||
      !Number.isSafeInteger(state.convergence.round) || state.convergence.round < 1 || state.convergence.round > 101 ||
      !Array.isArray(state.convergence.rounds) || state.convergence.rounds.length > 100 ||
      !/^[a-f0-9]{64}$/.test(state.convergence.roundStart ?? '') || typeof state.convergence.stable !== 'boolean')) {
    throw new ReproError('INVALID_CHECKPOINT', 'Malformed convergence checkpoint.');
  }
  return checkpoint;
}

export async function checkpointPath(repo, requested, output, resuming = false) {
  const file = path.resolve(requested);
  // Reuse canonical path checks even for an existing resume file, by validating
  // a hypothetical new child under its parent. Never write inside the source.
  const target = resuming ? path.join(path.dirname(file), `.reprocapsule-location-${randomUUID()}`) : file;
  const validated = await validateOutput(repo, target);
  const canonical = resuming ? path.join(path.dirname(validated), path.basename(file)) : validated;
  const relative = path.relative(output, canonical);
  if (!relative || !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) throw new ReproError('INVALID_ARGUMENTS', 'Checkpoint must be outside the output capsule.');
  return canonical;
}

export async function writeCheckpoint(file, checkpoint) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(checkpoint, null, 2) + '\n');
    await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, file);
  } finally {
    await handle?.close(); await rm(temporary, { force: true });
  }
}

export async function resumeOptions(file, { allowInstallScripts = false } = {}) {
  const checkpoint = await readCheckpoint(file);
  if (checkpoint.config.allowInstallScripts && !allowInstallScripts) throw new ReproError('CHECKPOINT_SCRIPTS_REQUIRED', 'Resume requires a fresh --allow-install-scripts opt-in for this checkpoint.');
  // Only explicitly supported configuration fields are restored.
  const c = checkpoint.config;
  return { repo: checkpoint.source, command: c.command, passingCommand:c.passingCommand, timeoutMs: c.timeoutMs, installTimeoutMs: c.installTimeoutMs,
    baselineRuns: c.baselineRuns, repeatRuns:c.repeatRuns, matchThreshold:c.matchThreshold, matchStderr: c.matchStderr, exitCode: c.exitCode, matcher:c.matcher, keep: c.keep, audit: c.audit ?? false, cacheDir: c.cacheDir, reduceInput: c.reduceInput, inputMaxRuns: c.inputMaxRuns ?? 200, reduceSource: c.reduceSource, reduceSourceAll:c.reduceSourceAll ?? false, sourceParser: c.sourceParser, sourceMaxRuns: c.sourceMaxRuns ?? 100, converge:c.converge ?? false, maxRounds:c.maxRounds ?? 5,
    allowInstallScripts: c.allowInstallScripts, offline: c.offline,
    checkpoint: file, resumeState: checkpoint };
}
