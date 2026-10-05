import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { reduceFiles } from './reducer.js';
import { ReproError } from './errors.js';
const require = createRequire(import.meta.url);

export async function loadSourceInput(root, files, file, parserPath, saved) {
  if (!file) return null;
  if (!files.includes(file) || !/\.[cm]?[jt]sx?$/.test(file) || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new ReproError('INVALID_INPUT','Source reduction requires one existing relative JavaScript/TypeScript file.');
  let ts;
  try { ts=require(parserPath ? path.resolve(parserPath) : 'typescript'); }
  catch { throw new ReproError('SOURCE_PARSER_UNAVAILABLE','Install TypeScript for this tool or explicitly supply --source-parser PATH to an existing typescript.js.'); }
  if(typeof ts.createSourceFile!=='function' || typeof ts.version!=='string')throw new ReproError('SOURCE_PARSER_UNAVAILABLE','Selected parser must expose the TypeScript compiler API.');
  const original=await readFile(path.join(root,file),'utf8');
  if(Buffer.byteLength(original)>1024*1024)throw new ReproError('INVALID_INPUT','Source reduction is bounded to 1 MiB per selected file.');
  const parse=text=>ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true);
  const tree=parse(original);
  if(tree.parseDiagnostics.length)throw new ReproError('INVALID_INPUT','Selected source does not parse.');
  const spans=tree.statements.map(node=>[node.getFullStart(),node.getEnd()]);
  const all=spans.map((_,index)=>String(index));
  if(saved && (saved.file!==file || saved.parserVersion!==ts.version || !Array.isArray(saved.retained) || new Set(saved.retained).size!==saved.retained.length || saved.retained.some(i=>!all.includes(i))))throw new ReproError('CHECKPOINT_INCOMPATIBLE','Source recipe or parser version changed.');
  let retained=saved?.retained??all;
  const render=ids=>{
    const keep=new Set(ids);let result='',offset=0;
    for(let i=0;i<spans.length;i++){
      const [start,end]=spans[i];result+=original.slice(offset,start);
      // AST-selected spans only. Preserve newlines so strict stack positions stay stable.
      result+=keep.has(String(i))?original.slice(start,end):[...original.slice(start,end)].filter(c=>c==='\n'||c==='\r').join('');offset=end;
    }
    return result+original.slice(offset);
  };
  const state={file,parserVersion:ts.version,retained:[...retained]};
  const value={file,state,content:render(retained),metrics:{file,parser:'TypeScript',parserVersion:ts.version,originalBytes:Buffer.byteLength(original),originalStatements:all.length},
    async reduce(preserves,{shouldStop,maxAttempts=100,onAccepted=async()=>{}}={}) {
      if(!Number.isSafeInteger(maxAttempts)||maxAttempts<1)throw new ReproError('INVALID_ARGUMENTS','Source run limit must be a positive integer.');
      let attempts=0,parseRejections=0;
      const reduced=await reduceFiles(retained,async ids=>{
        attempts++;const text=render(ids);
        if(Buffer.byteLength(text)>=Buffer.byteLength(value.content) || parse(text).parseDiagnostics.length){parseRejections++;return false;}
        return preserves(text);
      },{shouldStop:()=>shouldStop?.()??(attempts>=maxAttempts?'source-max-runs':null),onAccepted:async ids=>{
        retained=ids;state.retained=[...ids];value.content=render(ids);await onAccepted();
      }});
      return {...value.metrics,finalBytes:Buffer.byteLength(value.content),finalStatements:retained.length,attempts,parseRejections,acceptedReductions:reduced.accepted,complete:reduced.complete,terminationReason:reduced.terminationReason,
        scope:'AST top-level statement deletion only; no nested/expression/global minimality claim; builds must be part of the reproduction command'};
    }};
  return value;
}
