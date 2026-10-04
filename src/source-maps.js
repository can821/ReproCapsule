import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SourceMap } from 'node:module';
import { localiseStack } from './localisation.js';

const limit = 2 * 1024 * 1024;
const inside = (root, file) => { const rel = path.relative(root, file); return rel && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`); };
async function boundedRead(root, file) {
  const resolved = await realpath(file);
  if (!inside(root, resolved) || !(await stat(resolved)).isFile() || (await stat(resolved)).size > limit) throw new Error('unsupported map path/size');
  return readFile(resolved, 'utf8');
}
async function loadMap(root, generated) {
  const text = await boundedRead(root, generated);
  const refs = [...text.matchAll(/\/\/[#@]\s*sourceMappingURL=([^\s]+)/g)];
  const ref = refs.at(-1)?.[1];
  if (!ref) return null;
  let payload, base = path.dirname(generated);
  if (ref.startsWith('data:application/json;base64,')) {
    payload = JSON.parse(Buffer.from(ref.slice('data:application/json;base64,'.length), 'base64').toString('utf8'));
  } else {
    if (/^[a-z]+:/i.test(ref) || path.isAbsolute(ref)) return null;
    const mapFile = path.resolve(base, decodeURIComponent(ref));
    payload = JSON.parse(await boundedRead(root, mapFile)); base = path.dirname(mapFile);
  }
  if (payload.version !== 3 || payload.sections || !Array.isArray(payload.sources) || typeof payload.mappings !== 'string') return null;
  const sourceRoot = payload.sourceRoot ?? '';
  if (typeof sourceRoot !== 'string' || /^[a-z]+:/i.test(sourceRoot) || path.isAbsolute(sourceRoot)) return null;
  const sources = payload.sources.map(source => {
    if (typeof source !== 'string' || /^[a-z]+:/i.test(source) || path.isAbsolute(source)) throw new Error('external source');
    const absolute = path.resolve(base, sourceRoot, source);
    if (!inside(root, absolute)) throw new Error('external source');
    return absolute;
  });
  return new SourceMap({ version: 3, sources, names: payload.names ?? [], mappings: payload.mappings });
}

export async function localiseWithSourceMaps(result, cwd, retainedFiles, explanations) {
  const root = await realpath(cwd), allowed = new Set(retainedFiles), maps = new Map(), origins = new Map();
  async function transform(text) {
    const lines = [];
    for (const line of text.split('\n')) {
      const match = line.match(/^\s*at (?:.*? \()?(.+):(\d+):(\d+)\)?\s*$/);
      if (!match) { lines.push(line); continue; }
      let rewritten = line;
      try {
        let generated = match[1].replace(/^async /, '');
        if (generated.startsWith('file:')) generated = fileURLToPath(generated);
        if (!path.isAbsolute(generated)) throw new Error('outside');
        generated = await realpath(generated);
        if (!inside(root, generated)) throw new Error('outside');
        rewritten = `    at ${generated}:${match[2]}:${match[3]}`;
        const file = path.relative(root, generated).split(path.sep).join('/');
        if (file.split('/').includes('node_modules')) throw new Error('dependency');
        if (!maps.has(generated)) maps.set(generated, await loadMap(root, generated).catch(() => null));
        const original = maps.get(generated)?.findOrigin(Number(match[2]), Number(match[3]));
        if (original?.fileName) {
          const source = path.relative(root, original.fileName).split(path.sep).join('/');
          if (allowed.has(source) && inside(root, await realpath(original.fileName))) {
            const position = `${source}:${original.lineNumber}:${original.columnNumber}`;
            origins.set(position, { file, line: Number(match[2]), column: Number(match[3]) });
            rewritten = `    at ${original.fileName}:${original.lineNumber}:${original.columnNumber}`;
          }
        }
      } catch { /* Missing, malformed or unsupported maps are only absent evidence. */ }
      lines.push(rewritten);
    }
    return lines.join('\n');
  }
  const mapped = { ...result, stderr: await transform(result.stderr), stdout: await transform(result.stdout) };
  const diagnostics = localiseStack(mapped, root, retainedFiles, explanations);
  diagnostics.sourceMaps = { supported: 'bounded local v3 sidecar/base64 maps; retained project sources only', mappedLocations: 0 };
  diagnostics.meaning = 'Project-local stack evidence, optionally mapped to retained original sources; not proof of root cause. No coverage or passing comparison collected.';
  for (const location of diagnostics.locations) {
    const generated = origins.get(`${location.file}:${location.line}:${location.column}`);
    if (generated) { location.generated = generated; location.evidence.push('source-map-original-location'); diagnostics.sourceMaps.mappedLocations++; }
  }
  return diagnostics;
}
