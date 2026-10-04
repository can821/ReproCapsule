import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { temporary, fingerprint } from './helpers.js';
import { buildCapsule } from '../src/capsule.js';
import { reportCapsule } from '../src/report.js';

async function capsule(t) {
 const root=await temporary(t),repo=path.join(root,'repo'),output=path.join(root,'capsule');await mkdir(repo);
 await writeFile(path.join(repo,'app.cjs'),'console.error("target");process.exit(1)');
 await buildCapsule({repo,output,command:'node app.cjs'});return {root,output};
}
test('HTML/Markdown reports inspect integrity without executing recorded commands or changing capsule',async t=>{
 const {root,output}=await capsule(t),metadata=path.join(output,'capsule.json');
 const m=JSON.parse(await readFile(metadata));m.command='touch SHOULD_NOT_EXIST; <script>alert("x")</script>';await writeFile(metadata,JSON.stringify(m));
 const before=await fingerprint(output);
 for(const format of ['html','markdown']){
  const file=path.join(root,`report.${format}`);await reportCapsule({capsule:output,output:file,format});
  const text=await readFile(file,'utf8');assert.ok(text.includes('NOT RUN'));
  if(format==='html'){assert.equal(text.includes('<script>'),false);assert.ok(text.includes('&lt;script&gt;'));assert.ok(text.includes('Content-Security-Policy'));}
 }
 assert.equal(await fingerprint(output),before);
});
test('explicit external reporter receives versioned data and emits its supported format',async t=>{
 const {root,output}=await capsule(t),file=path.join(root,'summary.json');
 const r=await reportCapsule({capsule:output,output:file,format:'json',plugin:'examples/plugins/summary.mjs'});
 assert.equal(r.reporter,'example-summary');assert.equal(JSON.parse(await readFile(file)).schemaVersion,1);
 await assert.rejects(reportCapsule({capsule:output,output:path.join(root,'bad'),format:'html',plugin:'examples/plugins/summary.mjs'}),{code:'INVALID_PLUGIN'});
});
test('reports reject corrupted inputs, overwrites and output inside the capsule',async t=>{
 const {root,output}=await capsule(t),file=path.join(root,'report.html');
 await reportCapsule({capsule:output,output:file});
 await assert.rejects(reportCapsule({capsule:output,output:file}),{code:'OUTPUT_EXISTS'});
 await assert.rejects(reportCapsule({capsule:output,output:path.join(output,'report.html')}),{code:'UNSAFE_OUTPUT'});
 await writeFile(path.join(output,'app.cjs'),'tampered');
 await assert.rejects(reportCapsule({capsule:output,output:path.join(root,'bad.html')}),{code:'INTEGRITY_FAILED'});
});
