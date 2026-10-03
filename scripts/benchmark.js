import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCapsule } from '../src/capsule.js';
import { fileHashes } from '../src/integrity.js';
import { inventory } from '../src/workspace.js';

const work = fileURLToPath(new URL('../work/', import.meta.url));
await mkdir(work, { recursive: true });
const root = await mkdtemp(path.join(work, 'benchmark-'));
const results = [];
for (const size of [100, 500, 2000]) {
  const repo = path.join(root, `source-${size}`);
  await mkdir(repo);
  await writeFile(path.join(repo, 'app.cjs'), 'const value=require("./trigger.json");if(value.fail){console.error("TypeError: benchmark target");process.exit(1)}\n');
  await writeFile(path.join(repo, 'trigger.json'), '{"fail":true}\n');
  for (let i = 0; i < size - 2; i++) await writeFile(path.join(repo, `noise-${String(i).padStart(4, '0')}.txt`), `irrelevant ${i}\n`);
  const files = (await inventory(repo)).files, before = await fileHashes(repo, files);
  const { manifest, elapsedMs, verification } = await buildCapsule({ repo, command: 'node app.cjs', output: path.join(root, `capsule-${size}`) });
  const row = { size, candidates: manifest.reduction.originalCandidateCount, retainedFiles: manifest.reduction.finalFileCount,
    runs: manifest.reduction.reproductionAttempts, cacheHits: manifest.reduction.cacheHits, acceptedReductions: manifest.reduction.acceptedReductions,
    elapsedMs, verified: verification.verified, sourceUnchanged: JSON.stringify(before) === JSON.stringify(await fileHashes(repo, files)) };
  results.push(row); console.log(JSON.stringify(row));
}
await writeFile(path.join(root, 'results.json'), JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2) + '\n');
console.log(`Evidence: ${root}/results.json`);
