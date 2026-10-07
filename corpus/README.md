# Independent compatibility corpus

These five pinned npm distributions contain independently developed production code. Tiny authored negative-input probes exercise genuine upstream exceptions. **They are not historical upstream bug reproductions or complete upstream development repositories.** Development dependencies/scripts are removed from the prepared copy; production source stays unchanged. Every case records that adaptation, upstream commit, license and SHA-512 archive integrity. No third-party source is committed here.

```sh
python3 corpus/prepare.py work/corpus-source
node scripts/corpus.js work/corpus-source work/corpus-results
```

Preparation downloads only pinned official-registry archives and rejects links/traversal. Execution is explicit, trusted local code, not sandboxed. The reducer uses isolated copies and protects upstream license files. The authored harness is `node probe.cjs`; no upstream development test suite or network service runs. Completed capsules are independently verified and source hashes/modes rechecked. Choose new paths for each run.

The checked-in result file contains measured evidence, not universal performance claims. These synthetic compatibility probes complement the separate historical-regression corpora; they are not external-user validation or evidence of broad application/build-tool compatibility.
