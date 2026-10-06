import {mkdtemp,mkdir,writeFile,readdir,lstat,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {buildCapsule} from '../src/capsule.js';
import {packCapsule} from '../src/portable.js';
const root=await mkdtemp(path.join(os.tmpdir(),'reprocapsule-measure-'));
const prior=process.env.TMPDIR;const temp=path.join(root,'temp');await mkdir(temp);process.env.TMPDIR=temp;
let peak=0,samples=0,busy=false;
async function bytes(dir) {let total=0;for(const e of await readdir(dir,{withFileTypes:true}).catch(()=>[])){const p=path.join(dir,e.name);try{total+=e.isDirectory()?await bytes(p):e.isFile()?(await lstat(p)).size:0;}catch{}}return total;}
const timer=setInterval(async()=>{if(busy)return;busy=true;peak=Math.max(peak,await bytes(temp));samples++;busy=false;},20);
try {
 const repo=path.join(root,'repo');await mkdir(repo);
 await writeFile(path.join(repo,'app.cjs'),"throw new Error('PERFORMANCE_TARGET');\n");
 for(let i=0;i<100;i++)await writeFile(path.join(repo,`unused-${i}.txt`),'noise'.repeat(100));
 const cacheDir=path.join(root,'cache'),results=[];
 for(const name of ['cold','cached']) {
  const start=performance.now();const r=await buildCapsule({repo,command:'node app.cjs',output:path.join(root,name),cacheDir,converge:true});
  results.push({name,wallMs:Math.round(performance.now()-start),...r.manifest.reduction,rounds:r.manifest.convergence.rounds.length});
 }
 const packed=await packCapsule({capsule:path.join(root,'cached'),output:path.join(root,'sample.rcap.gz')});
 clearInterval(timer);while(busy)await new Promise(r=>setTimeout(r,5));
 const report={runtime:process.version,platform:process.platform,scope:'Single controlled 101-file sample; 20 ms sampled temporary file bytes, not exact high-water disk allocation or general throughput.',results,temporaryDisk:{sampledPeakBytes:peak,samples,intervalMs:20},packed,parallelEvaluation:false};
 await writeFile(process.argv[2],JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report));
} finally {clearInterval(timer);while(busy)await new Promise(r=>setTimeout(r,5));if(prior===undefined)delete process.env.TMPDIR;else process.env.TMPDIR=prior;await rm(root,{recursive:true,force:true});}
