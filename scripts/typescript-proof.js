// Explicit network preparation; all installs occur in a copied workspace.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createWorkspace, copyFiles, inventory } from '../src/workspace.js';
import { discoverNpm, npmInstall } from '../src/package-manager.js';
import { buildCapsule } from '../src/capsule.js';
import { verifyCapsule } from '../src/verify.js';
import { fileHashes, snapshotId } from '../src/integrity.js';
const output = path.resolve(process.argv[2] ?? 'work/typescript-proof');
await mkdir(output);
const tool = { name: 'typescript', version: '5.8.3', commit: '68cead182cc24afdc3f1ce7c8ff5853aba14b65a', license: 'Apache-2.0',
  url: 'https://registry.npmjs.org/typescript/-/typescript-5.8.3.tgz', integrity: 'sha512-p1diW6TqL9L07nNxvRMM7hMMw4c5XOo/1ibL4aAIGmSAt9slTE1Xgw5KWuof2uTOvCg9BY7ZRi+GaF+7sfgPeQ==' };
const response = await fetch(tool.url, { signal: AbortSignal.timeout(30_000) });
if (!response.ok) throw new Error('TypeScript download failed');
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.length > 8*1024*1024 || `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== tool.integrity) throw new Error('TypeScript integrity mismatch');
const workspace = await createWorkspace('test/fixtures/typescript');
const source = path.join(output,'source');
try {
  const cwd = await workspace.materialize(workspace.files);
  await mkdir(path.join(cwd,'vendor'));
  await writeFile(path.join(cwd,'vendor/typescript.tgz'), bytes);
  const pkg = JSON.parse(await readFile(path.join(cwd,'package.json')));
  pkg.devDependencies.typescript='file:vendor/typescript.tgz';
  await writeFile(path.join(cwd,'package.json'), JSON.stringify(pkg,null,2)+'\n');
  const npm=await discoverNpm({cwd});
  await npmInstall({cwd,npm,updateLock:true,offline:true});
  await copyFiles(cwd,source,(await inventory(cwd)).files);
} finally { await workspace.cleanup(); }
const info = await inventory(source), before = snapshotId({hashes:await fileHashes(source,info.files),modes:info.modes});
const result = await buildCapsule({repo:source,command:'npm test',output:path.join(output,'capsule'),offline:true,audit:true,maxRuns:60});
const verify=await verifyCapsule({capsule:result.output,offline:true});
const after = await inventory(source), unchanged=before===snapshotId({hashes:await fileHashes(source,after.files),modes:after.modes});
const top=result.manifest.diagnostics.locations[0];
if(!verify.verified || !unchanged || top?.file!=='src/parser.ts' || top.line!==2 || !top.generated)throw new Error('TypeScript/source-map proof failed');
const evidence={tool,runtime:process.version,command:'npm test',reduction:result.manifest.reduction,dependencies:result.manifest.dependencies,
 diagnostics:result.manifest.diagnostics,verify,sourceUnchanged:unchanged,elapsedMs:result.elapsedMs};
await writeFile(path.join(output,'results.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify({before:evidence.reduction.originalFileCount,after:evidence.reduction.finalFileCount,runs:evidence.reduction.reproductionAttempts,elapsedMs:evidence.elapsedMs,top,verified:verify.verified}));
