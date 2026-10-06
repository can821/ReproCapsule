import {readdir,readFile,stat,realpath} from 'node:fs/promises';
import path from 'node:path';import {fileURLToPath} from 'node:url';
import {digest} from './integrity.js';import {ReproError} from './errors.js';
import {mapExecutedLines} from './source-maps.js';
export function executedLines(text,functions) {
 const ranges=functions.flatMap(f=>f.ranges ?? []).filter(r=>Number.isInteger(r.startOffset)&&Number.isInteger(r.endOffset)&&r.startOffset>=0&&r.endOffset<=text.length&&r.startOffset<r.endOffset);
 if(ranges.length>5000)throw new ReproError('EVIDENCE_LIMIT','Coverage range limit exceeded.');
 const points=[...new Set(ranges.flatMap(r=>[r.startOffset,r.endOffset]))].sort((a,b)=>a-b),lines=new Set();
 const starts=[0];for(let i=0;i<text.length;i++)if(text[i]==='\n')starts.push(i+1);
 const lineAt=offset=>{let lo=0,hi=starts.length;while(lo+1<hi){const mid=(lo+hi)>>1;if(starts[mid]<=offset)lo=mid;else hi=mid;}return lo+1;};
 for(let i=0;i<points.length-1;i++){
  const start=points[i],end=points[i+1];
  const covering=ranges.filter(r=>r.startOffset<=start&&r.endOffset>=end).sort((a,b)=>(a.endOffset-a.startOffset)-(b.endOffset-b.startOffset));
  if(!covering.length||covering[0].count<=0)continue;
  for(let line=lineAt(start);line<=lineAt(end-1);line++)if(text.slice(starts[line-1],starts[line]??text.length).trim())lines.add(line);
 }
 return [...lines].sort((a,b)=>a-b);
}
export async function collectCoverage(directory,cwd,files) {
 const entries=await readdir(directory),byFile=new Map();
 for(const file of files.filter(f=>/\.[cm]?[jt]sx?$/.test(f))) {
  const full=path.join(cwd,file);if((await stat(full).catch(()=>null))?.size<=2*1024*1024)byFile.set(file,{file,sourceHash:digest(await readFile(full)),lines:new Set(),sourceMapped:false});
 }
 if(entries.length>1000)throw new ReproError('EVIDENCE_LIMIT','Too many coverage files.');
 for(const entry of entries.filter(n=>n.endsWith('.json'))){
  const full=path.join(directory,entry);if((await stat(full)).size>16*1024*1024)throw new ReproError('EVIDENCE_LIMIT','Coverage output exceeds limit.');
  const data=JSON.parse(await readFile(full,'utf8'));
  for(const script of data.result??[]){
   if(!script.url?.startsWith('file:'))continue;
   const file=await realpath(fileURLToPath(script.url)).catch(()=>null);if(!file)continue;
   const relative=path.relative(cwd,file);if(relative.startsWith('..')||path.isAbsolute(relative)||relative.split(path.sep).includes('node_modules'))continue;
   if((await stat(file)).size>2*1024*1024)continue;
   const text=await readFile(file,'utf8'),lines=executedLines(text,script.functions??[]);
   for(const location of await mapExecutedLines(cwd,file,lines,files)){
    let record=byFile.get(location.file);
    if(!record){record={file:location.file,sourceHash:digest(await readFile(path.join(cwd,location.file))),lines:new Set(),sourceMapped:false};byFile.set(location.file,record);}
    record.lines.add(location.line);record.sourceMapped ||= location.mapped;
   }
  }
 }
 return [...byFile.values()].sort((a,b)=>a.file<b.file?-1:a.file>b.file?1:0).map(r=>({...r,lines:[...r.lines].sort((a,b)=>a-b)}));
}
export function differentialCoverage(failing,passing) {
 const failed=new Map(failing.map(r=>[r.file,r])),passed=new Map(passing.map(r=>[r.file,r]));
 const result={failingOnly:[],passingOnly:[],shared:[],uncompared:[]};
 for(const file of [...new Set([...failed.keys(),...passed.keys()])].sort()){
  const f=failed.get(file),p=passed.get(file);
  if(!(f?.lines.length||p?.lines.length))continue;
  if(!f||!p){result.uncompared.push({file,reason:'source-absent-in-one-input',failingLines:f?.lines??[],passingLines:p?.lines??[]});continue;}
  if(f&&p&&f.sourceHash!==p.sourceHash){result.uncompared.push({file,reason:'source-content-changed',failingLines:f.lines,passingLines:p.lines});continue;}
  const fl=new Set(f?.lines??[]),pl=new Set(p?.lines??[]);
  for(const [key,lines] of [['failingOnly',[...fl].filter(n=>!pl.has(n))],['passingOnly',[...pl].filter(n=>!fl.has(n))],['shared',[...fl].filter(n=>pl.has(n))]])if(lines.length)result[key].push({file,lines,sourceMapped:Boolean(f?.sourceMapped||p?.sourceMapped)});
 }
 return {...result,meaning:'Lines intersecting positive innermost V8 ranges, with optional line-start source-map origins. Compare only identical source contents. Changed files remain unaligned; no causal or statement-coverage certainty.'};
}
