import { createWorkspace } from './workspace.js';
import { executeProject } from './project-runner.js';
import { createPredicate, matchesPredicate } from './predicate.js';
import { ReproError } from './errors.js';
export async function observeReproduction({repo,command,runs=10,matcher,matchStderr,exitCode,...options}) {
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > 100) throw new ReproError('INVALID_ARGUMENTS','Observation runs must be 1–100.');
  const predicate = createPredicate({matcher,matchStderr,exitCode});
  if (predicate.type === 'strict') throw new ReproError('INVALID_ARGUMENTS','Intermittent observations require an explicit target matcher.');
  const workspace = await createWorkspace(repo), outcomes=[];
  try {
    for (let i=0;i<runs;i++) {
      const cwd=await workspace.materialize(workspace.files);
      try {
        const {result}=await executeProject(workspace,cwd,workspace.files,{...options,command});
        outcomes.push(matchesPredicate(predicate,null,result,cwd) ? 'TARGET' : result.timedOut || result.outputExceeded || result.signal ? 'INCONCLUSIVE' : result.exitCode === 0 ? 'PASS' : 'OTHER FAILURE');
      } catch(error) {
        if (!['INSTALL_FAILED','INSTALL_TIMEOUT','INSTALL_OUTPUT_LIMIT'].includes(error.code)) throw error;
        outcomes.push('SETUP FAILURE');
      }
    }
    const matching=outcomes.filter(o=>o==='TARGET').length;
    return {runs,matching,observedReproductionRate:matching/runs,outcomes,predicate,meaning:'Observed reproduction rate in bounded fresh executions, not probability. Reduction still requires stable baselines; this command does not certify intermittent candidate reductions.'};
  } finally {await workspace.cleanup();}
}
