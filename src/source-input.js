import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { reduceFiles } from './reducer.js';
import { ReproError } from './errors.js';
const require = createRequire(import.meta.url);

export async function loadSourceInput(root, files, file, parserPath, saved) {
  if (!file) return null;
  if (!files.includes(file) || !/\.[cm]?[jt]sx?$/.test(file) || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new ReproError('INVALID_INPUT', 'Source reduction requires one existing relative JavaScript/TypeScript file.');
  let ts;
  try { ts = require(parserPath ? path.resolve(parserPath) : 'typescript'); }
  catch { throw new ReproError('SOURCE_PARSER_UNAVAILABLE', 'Install TypeScript or supply --source-parser PATH.'); }
  if (typeof ts.createSourceFile !== 'function' || typeof ts.version !== 'string') throw new ReproError('SOURCE_PARSER_UNAVAILABLE', 'Selected parser must expose the TypeScript compiler API.');
  const original = await readFile(path.join(root, file), 'utf8');
  if (Buffer.byteLength(original) > 1024 * 1024) throw new ReproError('INVALID_INPUT', 'Source reduction is bounded to 1 MiB per selected file.');
  const parse = text => ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const tree = parse(original);
  if (tree.parseDiagnostics.length) throw new ReproError('INVALID_INPUT', 'Selected source does not parse.');
  const units = [];
  // Only list elements can be deleted: statements and class members. Never remove
  // an obligatory unbraced branch body or rewrite expressions with text patterns.
  function visit(node, parent = null, depth = 0) {
    const list = ts.isSourceFile(node) || ts.isBlock(node) || ts.isModuleBlock(node) || ts.isCaseClause(node) || ts.isDefaultClause(node)
      ? node.statements : ts.isClassDeclaration(node) || ts.isClassExpression(node) ? node.members : null;
    if (list) {
      for (const child of list) {
        const id = String(units.length);
        units.push({ id, start: child.getFullStart(), end: child.getEnd(), parent, depth, kind: ts.SyntaxKind[child.kind] });
        visit(child, id, depth + 1);
      }
    } else ts.forEachChild(node, child => { visit(child, parent, depth); });
  }
  visit(tree);
  const all = units.map(u => u.id);
  if (saved && (saved.recipeVersion !== 2 || saved.file !== file || saved.parserVersion !== ts.version || !Array.isArray(saved.retained) || new Set(saved.retained).size !== saved.retained.length || saved.retained.some(i => !all.includes(i)))) throw new ReproError('CHECKPOINT_INCOMPATIBLE', 'Source recipe or parser version changed; start a new reduction.');
  let retained = saved?.retained ?? all;
  function effective(ids) {
    const keep = new Set(ids), active = new Set();
    for (const unit of units) if (keep.has(unit.id) && (unit.parent === null || active.has(unit.parent))) active.add(unit.id);
    return active;
  }
  function render(ids) {
    const active = effective(ids);
    const removed = units.filter(u => !active.has(u.id) && (u.parent === null || active.has(u.parent))).sort((a,b) => a.start-b.start);
    let text = '', offset = 0;
    for (const u of removed) {
      text += original.slice(offset, u.start);
      text += [...original.slice(u.start, u.end)].filter(c => c === '\n' || c === '\r').join('');
      offset = u.end;
    }
    return text + original.slice(offset);
  }
  const state = { recipeVersion: 2, file, parserVersion: ts.version, retained: [...retained] };
  const topCount = ids => units.filter(u => u.parent === null && effective(ids).has(u.id)).length;
  const value = { file, state, content: render(retained), metrics: { file, parser:'TypeScript', parserVersion:ts.version, originalBytes:Buffer.byteLength(original), originalStatements:tree.statements.length, originalAstUnits:units.length },
    async reduce(preserves, { shouldStop, maxAttempts = 100, onAccepted = async () => {} } = {}) {
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new ReproError('INVALID_ARGUMENTS', 'Source run limit must be a positive integer.');
      let attempts = 0, accepted = 0, complete = true, terminationReason = 'complete';
      const rejections = { parse:0, nonReducing:0, targetChanged:0 };
      const stop = () => shouldStop?.() || (attempts >= maxAttempts ? 'source-max-runs' : null);
      for (let depth = 0; depth <= units.reduce((max,u) => Math.max(max,u.depth),0); depth++) {
        const active = effective(retained);
        const selected = units.filter(u => u.depth === depth && active.has(u.id)).map(u => u.id);
        const fixed = retained.filter(id => !selected.includes(id));
        const result = await reduceFiles(selected, async ids => {
          attempts++;
          const text = render([...fixed,...ids]);
          if (Buffer.byteLength(text) >= Buffer.byteLength(value.content)) { rejections.nonReducing++; return false; }
          if (parse(text).parseDiagnostics.length) { rejections.parse++; return false; }
          const preserved = await preserves(text);
          if (!preserved) rejections.targetChanged++;
          return preserved;
        }, { shouldStop:stop, onAccepted:async ids => {
          retained = [...effective([...fixed,...ids])];
          state.retained = [...retained]; value.content = render(retained);
          await onAccepted();
        }});
        accepted += result.accepted;
        if (!result.complete) { complete = false; terminationReason = result.terminationReason; break; }
      }
      return { ...value.metrics, finalBytes:Buffer.byteLength(value.content), finalStatements:topCount(retained), finalAstUnits:effective(retained).size,
        attempts, parseRejections:rejections.parse, rejections, acceptedReductions:accepted, complete, terminationReason,
        retainedUnits:units.filter(u => effective(retained).has(u.id)).map(u => ({kind:u.kind,start:u.start,end:u.end,depth:u.depth})),
        scope:'Hierarchical AST statement and class-member deletion in one selected file; no expression or global minimum claim; builds must be included in command' };
    }};
  return value;
}

// Selection adapter keeps the established single-file reducer and recipes intact.
export async function loadSourceSelection(root, files, selection, parserPath, saved) {
  if (!selection) return null;
  if (selection !== true) {
    const single = await loadSourceInput(root, files, selection, parserPath, saved);
    single.protectedFiles = [single.file];
    single.bytes = () => Buffer.byteLength(single.content);
    single.apply = async (cwd, retained, text = single.content) => {
      if (retained.includes(single.file)) await writeFile(path.join(cwd,single.file),text);
    };
    return single;
  }
  const eligible = files.filter(f => /\.[cm]?[jt]sx?$/.test(f) && !/\.d\.[cm]?ts$/.test(f)).sort();
  if (eligible.length > 256) throw new ReproError('INVALID_INPUT','Automatic source selection is bounded to 256 JS/TS files.');
  let ts;
  try { ts = require(parserPath ? path.resolve(parserPath) : 'typescript'); }
  catch { throw new ReproError('SOURCE_PARSER_UNAVAILABLE','Install TypeScript or supply --source-parser PATH.'); }
  if (saved && (saved.recipeVersion !== 1 || saved.mode !== 'multiple' || saved.parserVersion !== ts.version || !saved.sources || Object.keys(saved.sources).some(f=>!eligible.includes(f)))) throw new ReproError('CHECKPOINT_INCOMPATIBLE','Multi-file source selection/parser changed.');
  const sources = new Map(), outcomes = new Map(Object.entries(saved?.outcomes ?? {})), state = {outcomes:saved?.outcomes ?? {},recipeVersion:1,mode:'multiple',parserVersion:ts.version,sources:{}};
  for (const file of eligible.filter(f=>saved?.sources[f])) {
    const source = await loadSourceInput(root,files,file,parserPath,saved.sources[file]);
    sources.set(file,source);state.sources[file]=source.state;
  }
  const value = {state,protectedFiles:[],metrics:{mode:'multiple',parser:'TypeScript',parserVersion:ts.version,eligibleFiles:eligible.length},
    get content() {return Object.fromEntries([...sources].sort(([a],[b])=>a.localeCompare(b)).map(([file,source])=>[file,source.content]));},
    bytes(retained=files) {return [...sources].filter(([file])=>retained.includes(file)).reduce((n,[,s])=>n+Buffer.byteLength(s.content),0);},
    async apply(cwd,retained,texts=value.content) {
      for(const [file,text] of Object.entries(texts))if(retained.includes(file))await writeFile(path.join(cwd,file),text);
    },
    async reduce(preserves,{retainedFiles=files,shouldStop,maxAttempts=100,onAccepted=async()=>{}}={}) {
      let attempts=0,accepted=0,complete=true,terminationReason='complete';
      const considered=eligible.filter(f=>retainedFiles.includes(f)), skipped=[];
      for(const file of considered) {
        const stop=shouldStop?.() || (attempts>=maxAttempts?'source-max-runs':null);
        if(stop){complete=false;terminationReason=stop;break;}
        let source=sources.get(file);
        if(!source) {
          try {source=await loadSourceInput(root,files,file,parserPath);}
          catch(error){if(error.code!=='INVALID_INPUT')throw error;skipped.push({file,reason:'unparseable-or-over-file-limit'});continue;}
          sources.set(file,source);state.sources[file]=source.state;
        }
        const result=await source.reduce(text=>preserves({...value.content,[file]:text}),{
          shouldStop,maxAttempts:maxAttempts-attempts,onAccepted});
        const previous=outcomes.get(file);
        const cumulative={...result,attempts:(previous?.attempts ?? 0)+result.attempts,acceptedReductions:(previous?.acceptedReductions ?? 0)+result.acceptedReductions,
          rejections:Object.fromEntries(Object.entries(result.rejections).map(([key,n])=>[key,n+(previous?.rejections?.[key] ?? 0)]))};
        outcomes.set(file,cumulative);state.outcomes[file]=cumulative;
        attempts+=result.attempts;accepted+=result.acceptedReductions;
        if(!result.complete){complete=false;terminationReason=result.terminationReason;break;}
      }
      const perFile=[...outcomes].sort(([a],[b])=>a.localeCompare(b)).filter(([f])=>retainedFiles.includes(f)).map(([,r])=>r);
      return {...value.metrics,filesConsidered:considered.length,filesReduced:perFile.filter(r=>r.finalBytes<r.originalBytes).length,
        originalBytes:perFile.reduce((n,r)=>n+r.originalBytes,0),finalBytes:perFile.reduce((n,r)=>n+r.finalBytes,0),
        measuredFiles:perFile.length,perFile,skipped,attempts:perFile.reduce((n,r)=>n+r.attempts,0),acceptedReductions:perFile.reduce((n,r)=>n+r.acceptedReductions,0),currentPass:{attempts,acceptedReductions:accepted},complete:complete&&skipped.length===0,
        terminationReason:complete&&skipped.length?'source-files-skipped':terminationReason,
        scope:'Deterministic sequential reduction of retained JS/TS files; declaration files excluded; byte totals cover measured files only; no global minimality'};
    }};
  return value;
}
