import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';
import { runCommand } from './runner.js';
import { failureSignature, sameFailure } from './failure-signature.js';
import { createWorkspace, copyFiles, isControlFile, validateOutput } from './workspace.js';
import { reduceFiles } from './reducer.js';
import { ReproError } from './errors.js';

function infrastructureFailure(result) {
  return result.exitCode === 126 || result.exitCode === 127 ||
    /(?:Error \[ERR_MODULE_NOT_FOUND\]|Error: Cannot find module |code: ['"]MODULE_NOT_FOUND['"]|npm error code ENOENT)/.test(`${result.stderr}\n${result.stdout}`);
}

export async function buildCapsule({ repo, command, output, timeoutMs = 10_000, onProgress = () => {} }) {
  const started = performance.now();
  const destination = await validateOutput(repo, output);
  const workspace = await createWorkspace(repo);
  let outputCreated = false;
  try {
    if (workspace.files.includes('capsule.json') || workspace.files.includes('reproduce.sh') || workspace.files.includes('README.reprocapsule.md')) {
      throw new ReproError('RESERVED_FILENAME', 'Source uses a reserved capsule filename: capsule.json, reproduce.sh or README.reprocapsule.md.');
    }
    const protectedFiles = workspace.files.filter(isControlFile);
    const candidates = workspace.files.filter((file) => !isControlFile(file));
    let reproductionAttempts = 0;
    async function observe(files, cwd) {
      cwd ??= await workspace.materialize(files);
      reproductionAttempts++;
      const result = await runCommand({ command, cwd, timeoutMs });
      return { result, signature: failureSignature(result, { roots: [cwd] }) };
    }
    const first = await observe(workspace.files);
    if (!first.signature || infrastructureFailure(first.result)) {
      const reason = first.result.timedOut ? 'command timed out' : first.result.outputExceeded ? 'output limit exceeded' : first.result.exitCode === 0 ? 'command succeeded' : infrastructureFailure(first.result) ? 'missing module, command or package setup' : 'no identifiable normal failure';
      throw new ReproError('INVALID_BASELINE', `Cannot establish a safe baseline: ${reason}. V1 copies no dependencies or secrets and performs no installs.`);
    }
    const confirmation = await observe(workspace.files);
    if (!sameFailure(first.signature, confirmation.signature)) {
      throw new ReproError('UNSTABLE_BASELINE', 'Two clean baseline runs produced different failure signatures.');
    }
    onProgress({ phase: 'baseline', candidates: candidates.length });
    const reduction = await reduceFiles(candidates, async (retained) => {
      const observed = await observe([...protectedFiles, ...retained]);
      return sameFailure(first.signature, observed.signature);
    }, { onProgress: (event) => onProgress({ phase: 'reduction', ...event }) });
    const retained = [...protectedFiles, ...reduction.retained].sort();
    // Final verification uses fresh source bytes, never command-mutated candidate files.
    const final = await observe(retained);
    if (!sameFailure(first.signature, final.signature)) {
      throw new ReproError('FINAL_VERIFICATION_FAILED', 'The reduced file set did not reproduce reliably.');
    }
    const manifest = {
      schemaVersion: 1,
      tool: { name: 'reprocapsule', version: '0.1.0' },
      command,
      failureSignature: {
        version: first.signature.version, strategy: first.signature.strategy,
        digest: first.signature.digest, exitCode: first.signature.exitCode,
      },
      environment: { node: process.version, platform: process.platform, osRelease: os.release(), arch: process.arch },
      reduction: {
        originalFileCount: workspace.files.length,
        finalFileCount: retained.length,
        originalCandidateCount: candidates.length,
        finalCandidateCount: reduction.retained.length,
        reductionPercentage: Number(((workspace.files.length - retained.length) / Math.max(1, workspace.files.length) * 100).toFixed(2)),
        candidateAttempts: reduction.attempts,
        acceptedReductions: reduction.accepted,
        reproductionAttempts: 0,
        durationBeforePackageVerificationMs: 0,
        guarantee: '1-minimal removable file set for a deterministic predicate; control files protected',
      },
      retainedFiles: retained,
      protectedFiles,
      exclusions: workspace.exclusions,
      dependencies: { status: 'not-reduced', installationPerformed: false },
      failurePreserved: true,
    };
    // Exclusive mkdir refuses to replace any existing user output.
    await mkdir(path.dirname(destination), { recursive: true });
    await mkdir(destination);
    outputCreated = true;
    await copyFiles(workspace.snapshot, destination, retained);
    const readmeName = retained.includes('README.md') ? 'README.reprocapsule.md' : 'README.md';
    const generatedFiles = ['capsule.json', readmeName, 'reproduce.sh'];
    manifest.generatedFiles = generatedFiles;
    const readme = `# Reproduction capsule\n\nGenerated by ReproCapsule 0.1.0.\n\nFrom this directory, run:\n\n    sh ./reproduce.sh\n\nExpected exit code: ${first.signature.exitCode} (failure is intentional).\n\nNode: ${process.version}; platform: ${process.platform}/${process.arch}.\n\nOriginal trusted command (JSON string):\n\n    ${JSON.stringify(command)}\n\nSame-failure digest and retained files are recorded in capsule.json.\nNo dependencies were installed or reduced. No node_modules are included.\nThis is a copied workspace, not a security sandbox. Review the command before running.\n`;
    // Run the exact trusted command without interpolating a repository path into it.
    const quoted = `'${command.replaceAll("'", "'\\''")}'`;
    const script = `#!/bin/sh\ncd -- "$(dirname -- "$0")" || exit 1\nexec /bin/sh -c ${quoted}\n`;
    manifest.reduction.reproductionAttempts = reproductionAttempts + 1;
    manifest.reduction.durationBeforePackageVerificationMs = Math.round(performance.now() - started);
    const serializedManifest = JSON.stringify(manifest, null, 2) + '\n';
    async function writeMetadata() {
      await writeFile(path.join(destination, readmeName), readme);
      await writeFile(path.join(destination, 'reproduce.sh'), script, { mode: 0o755 });
      await writeFile(path.join(destination, 'capsule.json'), serializedManifest);
    }
    await writeMetadata();
    // Verify the packaged directory, including generated metadata. Remove any writes
    // made by the command afterwards so only the verified input file set is shipped.
    const packaged = await observe(retained, destination);
    if (!sameFailure(first.signature, packaged.signature)) {
      throw new ReproError('CAPSULE_VERIFICATION_FAILED', 'The packaged capsule produced a different failure.');
    }
    await rm(destination, { recursive: true, force: true });
    await mkdir(destination);
    await copyFiles(workspace.snapshot, destination, retained);
    await writeMetadata();
    onProgress({ phase: 'complete', output: destination });
    return { output: destination, manifest };
  } catch (error) {
    if (outputCreated) await rm(destination, { recursive: true, force: true });
    throw error;
  } finally { await workspace.cleanup(); }
}
