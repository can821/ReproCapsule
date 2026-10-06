import { ReproError } from './errors.js';
export class ReductionBudget {
  constructor({ maxRuns = Infinity, maxTimeMs = Infinity, baselineRuns = 2, finalRuns = 2 } = {}) {
    if (!Number.isSafeInteger(baselineRuns) || baselineRuns < 2 || baselineRuns > 100 ||
        (maxRuns !== Infinity && (!Number.isSafeInteger(maxRuns) || maxRuns < baselineRuns + finalRuns)) ||
        (maxTimeMs !== Infinity && (!Number.isSafeInteger(maxTimeMs) || maxTimeMs < 1))) {
      throw new ReproError('INVALID_ARGUMENTS', 'Baseline runs must be 2–100; max-runs must reserve baseline + reserved final runs; max-time-ms must be positive.');
    }
    if (!Number.isSafeInteger(finalRuns) || finalRuns < 2 || finalRuns > 200) throw new ReproError('INVALID_ARGUMENTS','Invalid verification reservation.');
    this.finalRuns = finalRuns; this.maxRuns = maxRuns; this.maxTimeMs = maxTimeMs;
    this.started = Date.now(); this.runs = 0;
  }
  reason() {
    if (this.runs >= this.maxRuns - this.finalRuns) return 'max-runs';
    if (Date.now() - this.started >= this.maxTimeMs) return 'max-time';
    return null;
  }
  remaining(timeout) { return Math.max(1, Math.min(timeout, this.maxTimeMs - (Date.now() - this.started))); }
  exhausted(reason = this.reason()) {
    const error = new ReproError('BUDGET_EXHAUSTED', 'Reduction budget exhausted.'); error.reason = reason; return error;
  }
}
