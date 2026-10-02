// Complement-based ddmin: reject whole chunks, then refine to individual removals.
// For deterministic predicates this reaches a 1-minimal set, not a global minimum.
export async function reduceFiles(files, preserves, { onProgress = () => {}, shouldStop = () => null, onAccepted = async () => {} } = {}) {
  let retained = [...files].sort(), partitions = 2;
  let attempts = 0, accepted = 0;
  while (retained.length) {
    const size = Math.ceil(retained.length / partitions);
    let reduced = false;
    for (let start = 0; start < retained.length; start += size) {
      const candidate = retained.slice(0, start).concat(retained.slice(start + size));
      const reason = shouldStop();
      if (reason) return { retained, attempts, accepted, complete: false, terminationReason: reason };
      attempts++;
      let preserved;
      try { preserved = await preserves(candidate); }
      catch (error) {
        if (error.code === 'BUDGET_EXHAUSTED') return { retained, attempts, accepted, complete: false, terminationReason: error.reason };
        throw error;
      }
      if (preserved) {
        retained = candidate;
        accepted++;
        await onAccepted([...retained], { attempts, accepted });
        onProgress({ retained: retained.length, attempts, accepted });
        partitions = Math.max(2, partitions - 1);
        reduced = true;
        break;
      }
    }
    if (reduced) continue;
    if (partitions >= retained.length) break;
    partitions = Math.min(retained.length, partitions * 2);
  }
  return { retained, attempts, accepted, complete: true, terminationReason: 'complete' };
}
