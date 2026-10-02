import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, symlink, access } from 'node:fs/promises';
import path from 'node:path';
import { createWorkspace, validateOutput, copyFiles } from '../src/workspace.js';
import { temporary, fingerprint } from './helpers.js';

test('workspace excludes secrets, VCS, modules and symlinks without changing source', async (t) => {
  const dir = await temporary(t), source = path.join(dir, 'source');
  await mkdir(source);
  for (const file of ['main.js', '.env', '.env.local', '.npmrc', 'private.key', 'credentials.json', '.git/config', 'node_modules/pkg/index.js', 'src/extra.js']) {
    await mkdir(path.dirname(path.join(source, file)), { recursive: true });
    await writeFile(path.join(source, file), 'example');
  }
  await symlink('/etc/passwd', path.join(source, 'external-link'));
  const before = await fingerprint(source);
  const workspace = await createWorkspace(source);
  const tempRoot = workspace.root;
  try {
    assert.deepEqual(workspace.files, ['main.js', 'src/extra.js']);
    assert.equal(workspace.exclusions.length, 8);
    await workspace.materialize(['main.js']);
    await writeFile(path.join(workspace.candidate, 'main.js'), 'modified');
    await writeFile(path.join(workspace.candidate, 'generated.txt'), 'side effect');
    await workspace.materialize(['main.js']);
    assert.equal(await readFile(path.join(workspace.candidate, 'main.js'), 'utf8'), 'example');
    await assert.rejects(access(path.join(workspace.candidate, 'generated.txt')));
    assert.equal(await fingerprint(source), before);
  } finally { await workspace.cleanup(); }
  await assert.rejects(access(tempRoot));
});

test('output cannot overwrite existing paths or enter source through symlinks', async (t) => {
  const root = await temporary(t), repo = path.join(root, 'repo');
  await mkdir(repo);
  await symlink(repo, path.join(root, 'alias'));
  await assert.rejects(validateOutput(repo, path.join(repo, 'out')), { code: 'UNSAFE_OUTPUT' });
  await assert.rejects(validateOutput(repo, path.join(root, 'alias/out')), { code: 'UNSAFE_OUTPUT' });
  await assert.rejects(validateOutput(repo, root), { code: 'OUTPUT_EXISTS' });
  assert.match(await validateOutput(repo, path.join(root, 'new/out')), /new\/out$/);
});

test('copying rejects traversal paths', async (t) => {
  const root = await temporary(t);
  await assert.rejects(copyFiles(root, root, ['../escape']), { code: 'UNSAFE_PATH' });
});
