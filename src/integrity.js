import { createHash } from 'node:crypto';
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { ReproError } from './errors.js';

export const digest = (value) => createHash('sha256').update(value).digest('hex');
export async function fileHashes(root, files) {
  const hashes = {};
  for (const file of [...files].sort()) {
    if (!file || path.isAbsolute(file) || file.split(/[\\/]/).includes('..')) throw new ReproError('INVALID_CAPSULE', 'Unsafe retained file path.');
    // Reject links in every path component, not just the final file.
    let current = root;
    for (const segment of file.split('/')) {
      current = path.join(current, segment);
      if ((await lstat(current)).isSymbolicLink()) throw new ReproError('INTEGRITY_FAILED', 'Capsule contains a symbolic link.');
    }
    if (!(await lstat(current)).isFile()) throw new ReproError('INTEGRITY_FAILED', 'Expected a regular retained file.');
    hashes[file] = digest(await readFile(current));
  }
  return hashes;
}
export const snapshotId = (hashes) => digest(JSON.stringify(hashes));
