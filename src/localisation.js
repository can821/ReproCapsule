import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function localiseStack(result, cwd, retainedFiles, explanations) {
  const allowed = new Set(retainedFiles), locations = new Map();
  let depth = 0;
  for (const line of `${result.stderr}\n${result.stdout}`.split('\n')) {
    if (!/^\s*at\s/.test(line)) continue;
    const stackDepth = depth++;
    const match = line.match(/^\s*at (?:.*? \()?(.+):(\d+):(\d+)\)?\s*$/);
    if (!match) continue;
    let filename = match[1].replace(/^async /, '');
    try { if (filename.startsWith('file:')) filename = fileURLToPath(filename); } catch { continue; }
    if (!path.isAbsolute(filename)) continue;
    const file = path.relative(cwd, filename).split(path.sep).join('/');
    if (!allowed.has(file) || file.split('/').includes('node_modules') || file.startsWith('../')) continue;
    const location = { file, line: Number(match[2]), column: Number(match[3]), stackDepth };
    if (!Number.isSafeInteger(location.line) || location.line < 1 || !Number.isSafeInteger(location.column) || location.column < 1) continue;
    const key = `${file}:${location.line}:${location.column}`;
    if (!locations.has(key)) locations.set(key, location);
  }
  const ranked = [...locations.values()].sort((a, b) => a.stackDepth - b.stackDepth);
  return {
    method: 'project-local-stack-order', status: ranked.length ? 'EVIDENCE AVAILABLE' : 'INSUFFICIENT EVIDENCE',
    meaning: 'Suspicious locations from the accepted failing execution; not proof of root cause. No coverage or passing comparison was collected.',
    locations: ranked.map((location, index) => ({ ...location,
      evidence: [index === 0 ? 'top-project-stack-frame' : 'deeper-project-stack-frame',
        'present-in-accepted-failure-stack', 'retained-file-low-weight',
        ...(explanations?.files?.[location.file]?.classification === 'REQUIRED' ? ['required-for-reproduction-not-proof-of-bug'] : [])],
    })),
  };
}
