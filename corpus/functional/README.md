# Historical functional regressions

Three independently documented bugs in two projects: Day.js objectSupport null parsing, Day.js duration getters, and object-inspect quote escaping. Each pinned buggy npm distribution fails an upstream-derived assertion; its pinned fixed distribution passes the same assertion. SHA-512 archive integrity is checked before preparation. These are published distributions, not complete upstream development checkouts. Production code remains unchanged; only development dependencies/scripts are removed and a probe is added. No third-party source is tracked.

Run `python3 corpus/functional/prepare.py work/functional-source` then `node scripts/functional-proof.js work/functional-source work/functional-results` using new output paths. Preparation requires registry access; reproduction requires only Node. The proof uses strict normalized transcript equality, retains licenses, audits eligible file removals, independently verifies each reduced capsule, and confirms source hashes are unchanged.

`results.json` records one measured macOS/Node run. It does not establish application-wide compatibility, source minimization, or cross-platform support. Execution counts include the initial buggy/fixed probes, all reduction executions, and an additional fresh verification. Elapsed time covers capsule construction and its built-in verification only.
