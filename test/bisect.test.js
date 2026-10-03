import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { temporary, fingerprint } from './helpers.js';
import { git } from '../src/git.js';
import { bisectRegression } from '../src/bisect.js';

async function history(t, versions) {
  const root = await temporary(t), repo = path.join(root, 'history'); await mkdir(repo);
  await git(repo, ['init', '-b', 'main']);
  const commits = [];
  for (let i = 0; i < versions.length; i++) {
    await writeFile(path.join(repo, 'app.cjs'), versions[i]);
    await writeFile(path.join(repo, 'version.txt'), String(i));
    await git(repo, ['add', '.']);
    await git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', `revision ${i}`]);
    commits.push((await git(repo, ['rev-parse', 'HEAD'])).stdout.trim());
  }
  return { repo, commits };
}
const good = 'process.exit(0)\n';
const bad = 'console.error("TypeError: target regression");process.exit(1)\n';

test('native bisect identifies known regression and preserves dirty source worktree and branch', async (t) => {
  const { repo, commits } = await history(t, [good, good, bad, bad, bad]);
  await writeFile(path.join(repo, 'app.cjs'), 'uncommitted source work');
  await writeFile(path.join(repo, 'untracked.txt'), 'keep me');
  const before = await fingerprint(repo), branch = (await git(repo, ['branch', '--show-current'])).stdout;
  const result = await bisectRegression({ repo, good: commits[0], bad: commits[4], command: 'node app.cjs' });
  assert.equal(result.status, 'FOUND');
  assert.equal(result.firstTestedBadCommit, commits[2]);
  assert.equal(await fingerprint(repo), before);
  assert.equal((await git(repo, ['branch', '--show-current'])).stdout, branch);
});

test('untestable middle commit yields ambiguity, and run budgets never fabricate a culprit', async (t) => {
  const { repo, commits } = await history(t, [good, 'console.error("unrelated setup error");process.exit(2)', bad]);
  const result = await bisectRegression({ repo, good: commits[0], bad: commits[2], command: 'node app.cjs' });
  assert.equal(result.status, 'AMBIGUOUS');
  assert.ok(result.evaluated.some((entry) => entry.classification === 'skip'));
  const budgeted = await bisectRegression({ repo, good: commits[0], bad: commits[2], command: 'node app.cjs', maxRuns: 3 });
  assert.equal(budgeted.status, 'BUDGET EXHAUSTED');
  assert.equal(budgeted.firstTestedBadCommit, undefined);
});
