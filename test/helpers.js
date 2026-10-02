import { mkdtemp, rm, readdir, readFile, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
export async function temporary(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'reprocapsule-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}
export async function fingerprint(root) {
  const hash = createHash('sha256');
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const file = path.join(dir, name), stat = await lstat(file);
      hash.update(path.relative(root, file));
      hash.update(String(stat.mode));
      if (stat.isDirectory()) await walk(file);
      else if (stat.isFile()) hash.update(await readFile(file));
    }
  }
  await walk(root);
  return hash.digest('hex');
}
