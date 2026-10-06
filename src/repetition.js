import {ReproError} from './errors.js';
export function repetitionPolicy(runs,threshold) {
 if(runs===undefined){if(threshold!==undefined)throw new ReproError('INVALID_ARGUMENTS','match-threshold requires repeat-runs.');return null;}
 if(!Number.isSafeInteger(runs)||runs<2||runs>100||!Number.isFinite(threshold??1)||(threshold??1)<=0||(threshold??1)>1)throw new ReproError('INVALID_ARGUMENTS','repeat-runs must be 2–100; match-threshold must be >0 and <=1.');
 return {mode:'repeated',runs,threshold:threshold??1,minMatches:Math.ceil(runs*(threshold??1))};
}
export async function repeatEvaluation(observe,matches,policy) {
 let matching=0,conclusive=true,representative=null;const outcomes=[];
 for(let run=0;run<policy.runs;run++){
  const observed=await observe(),r=observed.result;
  const uncertain=r.timedOut||r.outputExceeded||r.signal;
  if(uncertain)conclusive=false;
  const match=!uncertain&&matches(observed);
  if(match){matching++;representative??=observed;}
  outcomes.push(match?'TARGET':uncertain?'INCONCLUSIVE':r.exitCode===0?'PASS':'OTHER FAILURE');
 }
 return {matches:conclusive&&matching>=policy.minMatches,conclusive,representative,
  evidence:{matching,total:policy.runs,observedReproductionRate:matching/policy.runs,requiredMatches:policy.minMatches,outcomes}};
}
