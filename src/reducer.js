// Complement-based ddmin: reject whole chunks, then refine to individual removals.
// For deterministic predicates this reaches a 1-minimal set, not a global minimum.
export async function reduceFiles(files, preserves, { onProgress = () => {} } = {}) {
  let retained = [...files].sort(), partitions = 2;
  let attempts = 0, accepted = 0;
  while (retained.length) {
    const size = Math.ceil(retained.length / partitions);
    let reduced = false;
    for (let start = 0; start < retained.length; start += size) {
      const candidate = retained.slice(0, start).concat(retained.slice(start + size));
      attempts++;
      if (await preserves(candidate)) {
        retained = candidate;
        accepted++;
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
  return { retained, attempts, accepted };
}
