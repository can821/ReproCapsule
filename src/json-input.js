import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { reduceFiles } from './reducer.js';
import { ReproError } from './errors.js';
import { isControlFile } from './workspace.js';
import { digest } from './integrity.js';
const serialize = (value) => JSON.stringify(value) + '\n';
const container = (value) => value !== null && typeof value === 'object';
const keys = (value) => Object.keys(value);

export function jsonStatistics(value) {
  const counts = { objects: 0, properties: 0, arrays: 0, elements: 0 };
  const stack = [{ value, depth: 0 }];
  while (stack.length) {
    const { value: item, depth } = stack.pop();
    if (depth > 64) throw new ReproError('INVALID_INPUT', 'JSON input nesting must be at most 64 levels.');
    if (!container(item)) continue;
    const values = Object.values(item);
    if (Array.isArray(item)) { counts.arrays++; counts.elements += values.length; }
    else { counts.objects++; counts.properties += values.length; }
    for (const child of values) stack.push({ value: child, depth: depth + 1 });
  }
  return counts;
}
function nodeAt(root, indices) {
  let node = root;
  for (const index of indices) {
    if (!container(node) || !Number.isSafeInteger(index) || index < 0 || index >= keys(node).length) throw new ReproError('INVALID_CHECKPOINT', 'Invalid JSON edit path.');
    node = node[keys(node)[index]];
  }
  return node;
}
function apply(root, operation) {
  if (operation.kind === 'format') return;
  if (operation.kind !== 'remove' || !Array.isArray(operation.path) || !Array.isArray(operation.indices)) throw new ReproError('INVALID_CHECKPOINT', 'Invalid JSON edit operation.');
  const node = nodeAt(root, operation.path);
  if (!container(node)) throw new ReproError('INVALID_CHECKPOINT', 'JSON edit needs a container.');
  const names = keys(node), indices = operation.indices;
  if (new Set(indices).size !== indices.length || indices.some((index) => !Number.isSafeInteger(index) || index < 0 || index >= names.length)) throw new ReproError('INVALID_CHECKPOINT', 'Invalid JSON removal indices.');
  if (Array.isArray(node)) for (const index of [...indices].sort((a, b) => b - a)) node.splice(index, 1);
  else for (const index of indices) delete node[names[index]];
}
export async function loadJsonInput(snapshot, files, file, saved) {
  if (!file) {
    if (saved) throw new ReproError('INVALID_CHECKPOINT', 'Unexpected input edit state.');
    return null;
  }
  if (typeof file !== 'string' || path.isAbsolute(file) || file.split(/[\\/]/).includes('..') || !files.includes(file) || isControlFile(file) || !file.endsWith('.json')) throw new ReproError('INVALID_INPUT', '--reduce-input requires an allowed non-control JSON file inside the repository.');
  const original = await readFile(path.join(snapshot, file), 'utf8');
  if (Buffer.byteLength(original) > 16 * 1024 * 1024) throw new ReproError('INVALID_INPUT', 'JSON input is limited to 16 MiB.');
  let parsed;
  try { parsed = JSON.parse(original); } catch { throw new ReproError('INVALID_INPUT', 'Selected input is not valid JSON.'); }
  const originalStatistics = jsonStatistics(parsed);
  let operations = saved?.operations ?? [];
  if (saved && saved.file !== file || !Array.isArray(operations) || operations.length > 100_000) throw new ReproError('INVALID_CHECKPOINT', 'Invalid saved input state.');
  let root = structuredClone(parsed);
  for (const operation of operations) apply(root, operation);
  let content = operations.length ? serialize(root) : original;
  return {
    file,
    get content() { return content; },
    get identity() { return digest(content); },
    get state() { return { file, operations }; },
    get metrics() { return { file, originalBytes: Buffer.byteLength(original), finalBytes: Buffer.byteLength(content), originalStructure: originalStatistics, finalStructure: jsonStatistics(root) }; },
    async reduce(preserves, { shouldStop = () => null, onAccepted = async () => {}, maxAttempts = 200 } = {}) {
      if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) throw new ReproError('INVALID_ARGUMENTS', 'Input attempt limit must be positive.');
      let attempts = 0, accepted = 0, terminationReason = 'complete';
      const stop = () => shouldStop() || (attempts >= maxAttempts ? 'input-max-runs' : null);
      async function testCandidate(value) {
        const reason = stop();
        if (reason) { const error = new ReproError('BUDGET_EXHAUSTED', 'Input reduction budget exhausted.'); error.reason = reason; throw error; }
        const text = serialize(value);
        if (Buffer.byteLength(text) >= Buffer.byteLength(content)) return false;
        attempts++;
        return preserves(text);
      }
      async function accept(value, edits) {
        root = value; operations = edits; content = serialize(root); accepted++;
        await onAccepted({ attempts, accepted });
      }
      async function visit(indices) {
        const base = structuredClone(root), baseOperations = [...operations], node = nodeAt(base, indices);
        if (!container(node) || !keys(node).length) return;
        const all = keys(node).map((_, index) => String(index));
        const operationFor = (retained) => ({ kind: 'remove', path: indices, indices: all.filter((id) => !retained.includes(id)).map(Number) });
        const candidateFor = (retained) => { const value = structuredClone(base); apply(value, operationFor(retained)); return value; };
        const result = await reduceFiles(all, (retained) => testCandidate(candidateFor(retained)), {
          shouldStop: stop,
          onAccepted: async (retained) => accept(candidateFor(retained), [...baseOperations, operationFor(retained)]),
        });
        if (!result.complete) { terminationReason = result.terminationReason; return; }
        const current = nodeAt(root, indices);
        for (let index = 0; index < keys(current).length; index++) {
          if (terminationReason !== 'complete') return;
          if (container(current[keys(current)[index]])) await visit([...indices, index]);
        }
      }
      try {
        if (!operations.length && await testCandidate(root)) await accept(root, [{ kind: 'format' }]);
        let previous;
        do { previous = accepted; await visit([]); } while (terminationReason === 'complete' && previous !== accepted);
      } catch (error) {
        if (error.code !== 'BUDGET_EXHAUSTED') throw error;
        terminationReason = error.reason;
      }
      return { ...this.metrics, attempts, acceptedReductions: accepted, terminationReason, complete: terminationReason === 'complete' };
    },
  };
}
