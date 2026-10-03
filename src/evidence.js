// Evidence describes necessity for a particular reproduction, never bug ownership.
export function outcomeOf(result, matches) {
  const uncertain = result.timedOut ? 'timeout' : result.outputExceeded ? 'output-limit' : result.signal ? 'signal' : null;
  if (uncertain) return { matches: false, conclusive: false, reason: uncertain };
  const missingModule = /(?:ERR_MODULE_NOT_FOUND|Cannot find module|MODULE_NOT_FOUND)/.test(`${result.stderr}\n${result.stdout}`);
  return { matches, conclusive: true, reason: matches ? 'failure-preserved' : result.exitCode === 0 ? 'target-eliminated' : missingModule ? 'module-resolution-failure' : 'failure-changed' };
}
function explanation(outcome, origin) {
  if (!outcome || !outcome.conclusive) return { classification: 'UNTESTED', reason: outcome?.reason ?? 'no-single-item-evidence', origin: origin ?? 'none' };
  return { classification: outcome.matches ? 'REMOVABLE' : 'REQUIRED', reason: outcome.reason, origin };
}
export function retainedExplanations({ files, dependencies, control, protectedFiles, peerNames = [], lookup, auditEvidence = {} }) {
  const fileEntries = files.map((file) => {
    if (control.includes(file)) return [file, { classification: 'CONTROL', reason: 'package-or-lock-infrastructure' }];
    if (protectedFiles.includes(file)) return [file, { classification: 'PROTECTED', reason: 'user-or-local-package-policy' }];
    const id = `file:${file}`, fresh = auditEvidence[id];
    return [file, explanation(fresh ?? lookup(files.filter((value) => value !== file), dependencies), fresh ? 'fresh-audit' : 'reduction-singleton')];
  });
  const deps = dependencies.map((id) => {
    const fresh = auditEvidence[`dependency:${id}`];
    return [id, explanation(fresh ?? lookup(files, dependencies.filter((value) => value !== id)), fresh ? 'fresh-audit' : 'reduction-singleton')];
  });
  for (const name of peerNames) deps.push([`peerDependencies:${name}`, { classification: 'CONTROL', reason: 'peer-dependencies-preserved' }]);
  return { meaning: 'REQUIRED means needed for this reproduction, not that the item contains the bug.', files: Object.fromEntries(fileEntries), dependencies: Object.fromEntries(deps) };
}

export async function auditMinimality({ files, dependencies, protectedFiles, evaluate, shouldStop }) {
  const items = [
    ...files.filter((file) => !protectedFiles.includes(file)).map((file) => ({ id: `file:${file}`, files: files.filter((value) => value !== file), dependencies })),
    ...dependencies.map((dep) => ({ id: `dependency:${dep}`, files, dependencies: dependencies.filter((value) => value !== dep) })),
  ];
  const evidence = {};
  let terminationReason = null;
  for (const item of items) {
    if ((terminationReason = shouldStop())) break;
    try { evidence[item.id] = await evaluate(item.files, item.dependencies); }
    catch (error) {
      if (error.code !== 'BUDGET_EXHAUSTED') throw error;
      terminationReason = error.reason; break;
    }
  }
  const observations = Object.values(evidence);
  const required = observations.filter((item) => item.conclusive && !item.matches).length;
  const removable = observations.some((item) => item.conclusive && item.matches);
  const status = removable ? 'NOT PROVEN' : terminationReason ? 'PARTIAL' : required === items.length ? 'PASS' : 'NOT PROVEN';
  return {
    metadata: { requested: true, status, level: status === 'PASS' ? '1-minimal' : 'not-proven',
      scope: 'with respect to the tested candidate set; protected/control items excluded; no global minimum claim',
      candidateCount: items.length, auditedCandidates: observations.length, individuallyRequired: required,
      excludedFiles: protectedFiles, terminationReason }, evidence,
  };
}
