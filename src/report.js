import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectCapsule } from './verify.js';
import { validateOutput } from './workspace.js';
import { ReproError } from './errors.js';
import builtin from './reporters/builtin.js';

export async function reportCapsule({ capsule, output, format = 'html', plugin }) {
  const destination = await validateOutput(capsule,output);
  const { manifest:m } = await inspectCapsule(capsule);
  // Versioned plain-data boundary: no evaluator, paths, process handles or source text.
  const report = { schemaVersion:1, tool:m.tool, command:m.command, failurePredicate:m.failurePredicate, failureSignature:m.failureSignature,
    environment:m.environment, reduction:m.reduction, dependencies:m.dependencies, workspaces:m.workspaces ?? null,
    inputReduction:m.inputReduction ?? null, sourceReduction:m.sourceReduction ?? null, explanations:m.explanations ?? null, minimality:m.minimality ?? null, diagnostics:m.diagnostics ?? null,
    integrity:{status:'PASS',payloadFiles:Object.keys(m.fileHashes).length,execution:'NOT RUN; use verify for fresh reproduction'},
    limitations:['Commands and plugins execute with user permissions, not in a sandbox.','No source text or environment values are included by this report model. Review recorded commands before sharing.','No causal or globally minimal claim. Unsupported/uncollected evidence is not inferred.'] };
  let reporter = builtin;
  if (plugin) {
    try { reporter=(await import(pathToFileURL(path.resolve(plugin)).href)).default; }
    catch { throw new ReproError('INVALID_PLUGIN','Cannot load explicitly selected reporter plugin.'); }
  }
  if (reporter?.apiVersion!==1 || typeof reporter.name!=='string' || !Array.isArray(reporter.formats) || !reporter.formats.includes(format) || typeof reporter.render!=='function') throw new ReproError('INVALID_PLUGIN','Reporter requires apiVersion 1, name, formats and render(report, {format}).');
  const rendered = await reporter.render(structuredClone(report),{format});
  if(typeof rendered!=='string' || Buffer.byteLength(rendered)>8*1024*1024)throw new ReproError('INVALID_PLUGIN','Reporter output must be text up to 8 MiB.');
  await mkdir(path.dirname(destination),{recursive:true});
  await writeFile(destination,rendered,{flag:'wx',mode:0o600});
  return {success:true,output:destination,format,reporter:reporter.name,integrity:'PASS',execution:'NOT RUN'};
}
