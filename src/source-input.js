import { readFile } from 'node:fs/promises';
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
