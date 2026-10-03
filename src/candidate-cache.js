import { mkdir, readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { ReproError } from './errors.js';
import { digest } from './integrity.js';
import { writeCheckpoint } from './checkpoint.js';

const reasons = new Set(['failure-preserved', 'target-eliminated', 'module-resolution-failure', 'failure-changed']);
export function validOutcome(value) {
  return value?.conclusive === true && typeof value.matches === 'boolean' && reasons.has(value.reason) &&
    (value.matches === (value.reason === 'failure-preserved'));
}
export function environmentIdentity(environment = process.env) {
  // A single digest of the complete environment, never individual values or keys.
  return digest(JSON.stringify(Object.entries(environment).sort(([a], [b]) => a.localeCompare(b))));
}
export async function persistentCache(directory, context) {
  const scope = digest(JSON.stringify(context));
  const root = directory ? path.join(directory, 'reprocapsule-cache-v1', scope) : null;
  if (root) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    for (const folder of [directory, path.dirname(root), root]) {
      try { await mkdir(folder, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const stat = await lstat(folder);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ReproError('UNSAFE_CACHE', 'Persistent cache directories must not be symbolic links.');
    }
  }
  return {
    scope,
    async get(key) {
      if (!root) return undefined;
      try {
        const file = path.join(root, `${digest(key)}.json`), stat = await lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) return undefined;
        const record = JSON.parse(await readFile(file, 'utf8'));
        const data = { schemaVersion: 1, scope, key: digest(key), outcome: record.outcome };
        if (record.schemaVersion !== 1 || record.scope !== scope || record.key !== data.key ||
            !validOutcome(record.outcome) || record.checksum !== digest(JSON.stringify(data))) return undefined;
        return { matches: record.outcome.matches, conclusive: true, reason: record.outcome.reason };
      } catch (error) {
        if (error.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
        throw error;
      }
    },
    async set(key, outcome) {
      if (!root || !validOutcome(outcome)) return;
      const data = { schemaVersion: 1, scope, key: digest(key), outcome: { matches: outcome.matches, conclusive: true, reason: outcome.reason } };
      await writeCheckpoint(path.join(root, `${data.key}.json`), { ...data, checksum: digest(JSON.stringify(data)) });
    },
  };
}
