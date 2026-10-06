import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { temporary, fingerprint } from './helpers.js';
import { git } from '../src/git.js';
import { bisectRegression, firstBadCommit } from '../src/bisect.js';

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

test('Git helper ignores inherited repository redirection and config injection', async (t) => {
  const root = await temporary(t);
  const saved = { GIT_DIR: process.env.GIT_DIR, GIT_CONFIG_COUNT: process.env.GIT_CONFIG_COUNT };
  try {
    process.env.GIT_DIR = path.join(root, 'outside-git');
    process.env.GIT_CONFIG_COUNT = 'invalid';
    await git(root, ['init', '--quiet']);
    assert.equal((await git(root, ['rev-parse', '--absolute-git-dir'])).stdout.trim(), path.join(await import('node:fs/promises').then((fs) => fs.realpath(root)), '.git'));
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('bisect completion accepts Git 2.55 quoted terms and older output without accepting ambiguity', () => {
  const hash = 'a'.repeat(40);
  for (const term of ['bad', "'bad'"]) {
    assert.equal(firstBadCommit(`${hash} is the first ${term} commit\ncommit ${hash}\n`), hash);
  }
  assert.equal(firstBadCommit(`${'b'.repeat(64)} is the first 'bad' commit\n`), 'b'.repeat(64));
  assert.equal(firstBadCommit(`The first 'bad' commit could be any of:\n${hash}\n`), null);
  assert.equal(firstBadCommit(`${hash} is the first 'good' commit\n`), null);
  assert.equal(firstBadCommit(`${hash} is the first bad commit candidate\n`), null);
});
