import {readFile,writeFile,mkdir,lstat,rm} from 'node:fs/promises';
import {gzipSync,gunzipSync} from 'node:zlib';
import path from 'node:path';
import {digest} from './integrity.js';
import {inspectCapsule} from './verify.js';
import {validateOutput} from './workspace.js';
import {ReproError} from './errors.js';
const limit=64*1024*1024;
function allowed(name) {
 return typeof name==='string' && name.length>0 && !name.includes('\\') && !path.isAbsolute(name) && name.split('/').every(p=>p && p!=='.' && p!=='..' && !['.git','node_modules','.cache','coverage','work','tooling','checkpoints','tmp','.env'].includes(p) && !p.startsWith('.env.') && !/^checkpoint.*\.json$/.test(p));
}
function portableText(bytes) {
 // Refuse local personal paths instead of rewriting source or silently changing identity.
 if (/(?:\/Users\/|\/home\/|[A-Z]:\\Users\\)/.test(bytes.toString('utf8'))) throw new ReproError('NONPORTABLE_CAPSULE','Payload contains a personal absolute path.');
}
async function loadArchive(file) {
 try {
  const st=await lstat(file);
  if(!st.isFile() || st.isSymbolicLink() || st.size>limit) throw new Error('archive size/type');
  const envelope=JSON.parse(gunzipSync(await readFile(file),{maxOutputLength:limit}));
  if(envelope.format!=='reprocapsule-gzip-json' || envelope.version!==1 || !Array.isArray(envelope.files) || envelope.files.length>10000 || digest(JSON.stringify(envelope.files))!==envelope.integrity) throw new Error('archive schema/integrity');
  const names=new Set();let total=0;
  for(const f of envelope.files) {
   if(!allowed(f.path) || names.has(f.path) || typeof f.data!=='string' || ![0o644,0o755].includes(f.mode)) throw new Error('entry');
   names.add(f.path);
   const bytes=Buffer.from(f.data,'base64'); total+=bytes.length;
   if(total>32*1024*1024 || bytes.toString('base64')!==f.data || digest(bytes)!==f.sha256) throw new Error('entry integrity/size');
   portableText(bytes);
  }
  if(!names.has('capsule.json')) throw new Error('missing manifest');
  return envelope;
 } catch(error) { if(error.code==='NONPORTABLE_CAPSULE')throw error;throw new ReproError('INVALID_ARCHIVE','Archive is corrupt, oversized, or unsupported.'); }
}
export async function packCapsule({capsule,output}) {
 const {payload}=await inspectCapsule(capsule);
 const destination=await validateOutput(capsule,output),files=[];let total=0;
 for(const name of [...payload,'capsule.json'].sort()) {
  if(!allowed(name)) throw new ReproError('NONPORTABLE_CAPSULE','Capsule contains local/generated working data.');
  const bytes=await readFile(path.join(capsule,name));total+=bytes.length;
  if(total>32*1024*1024)throw new ReproError('NONPORTABLE_CAPSULE','Portable payload exceeds 32 MiB.');
  portableText(bytes);
  files.push({path:name,mode:(await lstat(path.join(capsule,name))).mode & 0o111 ? 0o755 : 0o644,sha256:digest(bytes),data:bytes.toString('base64')});
 }
 const encoded=gzipSync(JSON.stringify({format:'reprocapsule-gzip-json',version:1,integrity:digest(JSON.stringify(files)),files}));
 await writeFile(destination,encoded,{flag:'wx'});
 return {format:'reprocapsule-gzip-json',version:1,files:files.length,payloadBytes:total,archiveBytes:encoded.length};
}
export async function inspectArchive(file) {
 const archive=await loadArchive(file);
 const manifest=JSON.parse(Buffer.from(archive.files.find(f=>f.path==='capsule.json').data,'base64'));
 return {format:archive.format,version:archive.version,integrity:'PASS',files:archive.files.map(f=>({path:f.path,bytes:Buffer.from(f.data,'base64').length})),runtime:manifest.environment,command:manifest.command,pairedOracle:manifest.pairedOracle ?? null,failurePredicate:manifest.failurePredicate,reproductionPolicy:manifest.reproductionPolicy ?? null,meaning:'Archive integrity checked; commands have not been executed.'};
}
export async function unpackCapsule({archive,output}) {
 const envelope=await loadArchive(archive),destination=await validateOutput(path.resolve(archive),output);
 await mkdir(destination);let complete=false;
 try {
  for(const f of envelope.files) {
   const target=path.join(destination,f.path);await mkdir(path.dirname(target),{recursive:true});
   await writeFile(target,Buffer.from(f.data,'base64'),{flag:'wx',mode:f.mode});
  }
  await inspectCapsule(destination);complete=true;
  return {unpacked:true,integrity:'PASS',files:envelope.files.length};
 } finally {if(!complete)await rm(destination,{recursive:true,force:true});}
}
