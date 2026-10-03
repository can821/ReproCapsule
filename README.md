# ReproCapsule

Reduce a failing Node.js/npm repository into a smaller, independently verifiable reproduction capsule. Node.js 24+, macOS/Linux; npm 9+ when packages are needed. No external runtime library dependencies. Tested on macOS with Node 24.19.0 and npm 10.9.2.

```sh
node bin/reprocapsule.js reduce --repo ./broken-app --command 'npm test' --out ./capsule
node bin/reprocapsule.js verify ./capsule
node --test test/*.test.js
```

Output must be a new directory outside the source repository. npm must exist on PATH, or be supplied with `--npm-path /path/to/npm-cli.js` / `REPROCAPSULE_NPM`. The tool never downloads npm itself. Tests require npm; local package fixtures run offline.

## Reduction and fresh verification

1. Snapshot allowed source files without `.git`, `node_modules`, known secret files or symlinks.
2. Detect the npm project, validate root lock declarations, and use fresh `npm ci --ignore-scripts` installations in temporary copies. Lockfiles 2/3 are supported; yarn, pnpm, shrinkwrap and workspaces are rejected.
3. Confirm the same failure in at least two independent clean runs.
4. Remove file groups with a ddmin-inspired strategy. Protect manifests, locks, requested paths and currently needed local package assets.
5. Reduce top-level declarations across `dependencies`, `devDependencies`, `optionalDependencies`. Preserve peers. npm updates the lock with `install --package-lock-only --ignore-scripts`; a fresh `npm ci` must then succeed. No handwritten transitive resolver.
6. Revisit files made unnecessary by dependency removal. Verify the reduced input again.
7. Generate the capsule with SHA-256 file hashes and metadata; copy that finished capsule into another temporary directory, install from scratch, and reproduce the failure. Only then report `CAPSULE VERIFIED`.

The default predicate remains full normalized stdout/stderr plus nonzero exit code, hashed with SHA-256. ANSI colors, workspace paths/file URLs and narrowly recognized timing fields are normalized. Error messages and stack locations remain significant. Success, timeouts, signals and truncated output never match. Missing-module/setup errors cannot establish a baseline.

`--match-stderr 'target message' [--exit-code 1]` deliberately chooses a broader user-defined predicate. Variable diagnostics may then be accepted if that predicate stays true. `--baseline-runs 3` strengthens the repetition check; disagreement stops reduction.

The reducer seeks small phase-local sets. Only a passing `--audit-minimality` certifies 1-minimality with respect to the audited file/dependency candidate set. Protected/control files and JSON transformations are outside that certificate; no global minimum is claimed.

## Controls

| Option | Meaning |
| --- | --- |
| `--command-timeout N` / `--timeout-ms N` | Per-command milliseconds; default 10000 |
| `--install-timeout-ms N` | Milliseconds for one lock-update/install operation; default 60000 |
| `--allow-install-scripts` | Explicit lifecycle-script opt-in; OFF by default, including verify |
| `--offline` | npm offline mode; used by local fixture tests |
| `--max-runs N` | Total reproduction runs, reserving baseline runs and two final verifications |
| `--max-time N` | Reduction deadline in seconds; baseline and mandatory final verification may extend wall time |
| `--keep config/runtime.json` | Protect exact relative file/directory; repeatable |
| `--json` | Structured reduce/verify result, without progress text |

Budget exhaustion exports the best state only after mandatory verification, marks it `PARTIAL`, and makes no minimality claim. A failed final verification produces no capsule. npm installs have separate timeouts and are not counted as reproduction runs. Repeated complete candidate outcomes are cached in memory; optional persistent caching is described below. Keys include files, dependencies, selected input content, command and predicate; transient failures/timeouts are not cached. Final checks always bypass the cache. Checkpoint/resume is available as described below.

## Actual measured demos

```sh
node bin/reprocapsule.js reduce --repo test/fixtures/broken-parser --command 'node test/repro.js' --out work/file-final --json
node bin/reprocapsule.js reduce --repo test/fixtures/npm-dependencies --command 'npm test' --out work/npm-final --offline --json
node bin/reprocapsule.js verify work/npm-final --offline --json
```

Use a different output path if one already exists.

| Measure | File-only fixture | npm fixture |
| --- | --- | --- |
| Eligible project files | 26 → 6 | 14 → 6 |
| Top-level dependency declarations | 0 → 0 | 5 → 2 |
| Reproduction executions | 33 | 22 |
| Cached candidate results reused | 3 | 0 |
| Elapsed on test machine | 840 ms | 5864 ms |
| Fresh install | Not required | PASS, offline |
| Same failure / original unchanged | PASS / PASS | PASS / PASS |

The old fixture still retains the same four removable files plus two protected package files, with the same signature; caching saves three of the original 36 executions. One dummy `.env.example` is excluded. The npm fixture uses five tiny, self-contained local tarballs: two required packages and unused production/development/optional packages. Three declarations and their unused tarballs are removed. npm owns lockfile regeneration. The original 42-test baseline is preserved; the professionalisation suite adds evidence, JSON, history and patch verification tests (see measured results below).

Six retained project files plus three generated metadata/instruction files make nine capsule files. `capsule.json` records the command, predicate, source snapshot hash, per-file hashes, runtime/npm information, retained dependency declarations, exclusions, metrics and termination reason. Raw output and environment values are not stored. The manifest duration is explicitly measured before final verification; CLI JSON `elapsedMs` includes final verification. File hashes cover retained files and generated instructions, but not the self-referential manifest.

## Verify and exit codes

`verify` validates the recorded inventory and content hashes, then copies the capsule and installs/runs only in that fresh copy. The supplied capsule is not mutated. Hashes detect accidental corruption, not malicious replacement of both files and metadata. Verify executes the recorded trusted command; review capsules before running it. Older 0.1 capsules lack required integrity metadata and must be regenerated.

| Exit | Meaning |
| --- | --- |
| 0 | Completed and verified |
| 1 | Invalid input or unclassified operation error (existing CLI convention) |
| 3 | Baseline does not reproduce |
| 4 | Non-deterministic baseline |
| 5 | Invalid/corrupted capsule or verification failure |
| 6 | Package-manager, lockfile or install failure |
| 7 | Verified partial capsule; reduction budget exhausted |

A reproduction command's failing exit code is separate from the reducer's successful exit code.

## Safety and limitations

Commands and opted-in lifecycle scripts are **trusted local input, NOT sandboxed**. They retain user permissions and can access network, absolute paths and external state. ReproCapsule itself only installs/runs in copied workspaces and never modifies the source. npm installation uses an explicit copied-directory prefix, temporary cache, and empty temporary user/global npm config. Environment variables are inherited, not saved; private registry setups needing excluded config are not supported automatically.

Secret exclusions are filename rules, not a complete content scanner. Never put credentials inline in the recorded command. Local `file:` dependencies must stay inside the repository; external paths and monorepo/workspace orchestration are unsupported. Empty directories and symlinks are not preserved. Keep source files stable while copying; this is not protection against hostile filesystem races.

Offline fixture installs are verified; a broad public-registry/native-addon matrix is not. Installs with disabled scripts may not support native/build-time dependencies; opt in explicitly when trusted. Runtime/OS metadata does not recreate an entire machine. npm's declared `packageManager` is detected, but its exact version is not automatically installed. Windows is unsupported; Linux is implemented but not exercised here. Detached processes can escape a process group; forced termination may leave temporary files. Baseline repetitions do not prove absence of all flakiness. Strict transcript matching can reject otherwise equivalent failures.

## Checkpoint / resume

```sh
node bin/reprocapsule.js reduce --repo ./broken-app --command 'npm test' --out ./partial --checkpoint ./progress.json --max-runs 12
node bin/reprocapsule.js resume ./progress.json --out ./continued --max-runs 100
```

Checkpoint paths must be new and outside source/output. Atomic JSON saves happen after baseline confirmation, each accepted removal, and phase boundaries. An interruption can lose unfinished work, but never requires old temporary directories or node_modules. Resume verifies the filtered source's file inventory/content/modes and exact tool/Node/npm/platform identity, then reconfirms the saved failure in clean copies. Changes refuse resume. Checkpoints are trusted local data containing the recorded command, not environment values or raw diagnostics. Script-enabled checkpoints require a fresh `--allow-install-scripts` opt-in.

Resume starts the unfinished phase from the best retained set; completed phases are skipped. Persistent cache reuse is permitted only when source, runtime, command, predicate and the full environment fingerprint match. Fresh baseline/final/audit runs bypass it. Each invocation gets fresh run/time budgets and records prior reproduction counts separately. Concurrent writers to the same checkpoint are unsupported. Source changes to deliberately excluded files (e.g. .env) are outside the snapshot. A valid checkpoint is progress evidence, not an independently verified capsule.

Measured checkpoint proof: a 12-run npm reduction stopped at 9 files / 3 dependencies with a verified partial capsule. Resume reached 6 files / 2 dependencies in 14 additional runs and passed an independent fresh-install verification. The source remained unchanged. Fresh baseline/final checks add overhead: checkpointing preserves accepted progress, not a promise of fewer total runs for small examples.

## Unreleased professionalisation features

```sh
node bin/reprocapsule.js reduce --repo ./broken-app --command 'node repro.cjs' --out ./small --reduce-input request.json --audit-minimality --cache-dir ./candidate-cache
node bin/reprocapsule.js bisect --repo ./project --good GOOD_REF --bad BAD_REF --command 'npm test' --json
node bin/reprocapsule.js verify-fix ./small --patch ./fix.patch --test-command 'npm test' --json
node scripts/benchmark.js
```

- **Explanations:** every retained file/dependency is CONTROL, PROTECTED, REQUIRED or UNTESTED; an audit can also identify REMOVABLE survivors. REQUIRED means necessary for the tested reproduction, not the location of the bug.
- **Audit:** fresh single deletions of eligible files/declarations. PASS, PARTIAL or NOT PROVEN; bounded by existing budgets and repeated after resume.
- **Persistent cache:** opt-in checksummed records, separate source/runtime/environment namespaces, no raw diagnostics or environment values. Only conclusive outcomes are reusable. The cache is trusted local data, not authenticated; external state and registry changes are not fingerprinted. Final verification remains fresh.
- **JSON input:** one explicit relative JSON path, property/array deletion including nested structures; original untouched. Byte/structure metrics and value-free checkpoint edit recipes. Maximum 16 MiB / depth 64; `--input-max-runs` defaults to 200. No string/number simplification. Files/dependencies are not reduced again after input reduction; the audit can expose remaining removable items.
- **Localisation:** relative Node/V8 stack locations, stack-order ranking, cautious retention evidence. No coverage, source maps, passing-run comparison or root-cause guarantee.
- **Bisect:** native Git in a temporary clone, stable failing boundary twice and successful good boundary, skips unrelated failures. Distinct ancestor boundaries required. FOUND / AMBIGUOUS / BUDGET EXHAUSTED. Defaults: 32 evaluation attempts / 120 seconds; separate actual reproduction count. The first tested bad commit is evidence, not proof of causation. Dirty original branch/worktree remains untouched.
- **Verify-fix:** verified capsules only. Fresh original verification, patch check/application in another copy, clean npm install, frozen original command/predicate. Reports target REMOVED / STILL PRESENT / DIFFERENT FAILURE, PATCH APPLICATION FAILED or INCONCLUSIVE; broader tests PASS / FAIL / NOT PROVIDED / NOT RUN / INCONCLUSIVE. Standard contextual Git patches up to 4 MiB; no symlinks, excluded files or generated-metadata edits. A removed target is not proof of a complete fix. Patches, like reproduction commands, must be trusted before executing patched code.

Regression suite: **60 passed, 0 failed, 0 skipped** (`node --test test/*.test.js`).

### Measured professionalisation evidence

macOS arm64, Node 24.19.0, npm 10.9.2; single samples, not statistical performance claims. All capsule results below passed fresh verification. Original fixtures remained unchanged in automated tests.

| Case | Before → after | Reproduction runs | Elapsed |
| --- | --- | --- | --- |
| File fixture with audit | 26 → 6 files | 37 | 1,155 ms |
| Same fixture, persistent cache + fresh audit | 26 → 6 files | 8 | 242 ms |
| npm fixture, offline + audit | 14 → 6 files; 5 → 2 dependencies | 26 | 6,674 ms |
| JSON input + file audit | 21,813 → 58 bytes | 28 | 595 ms |
| Synthetic 100 files | 100 → 2 | 36 | 907 ms |
| Synthetic 500 files | 500 → 2 | 49 | 1,848 ms |
| Synthetic 2,000 files | 2,000 → 2 | 59 | 4,260 ms |

The cached case reused 29 persisted results; its 8 executions are two baselines, four fresh audit probes and two final verifications. JSON properties fell from 211 to 4 and array elements from 244 to 1; its file audit is not a certificate for minimal JSON. Known fixture stack location `src/parser.js:5:52` ranked first. A five-commit synthetic history identified its third revision. A contextual parser fix removed the target and passed the supplied regression command in an isolated copy.

Synthetic benchmark accepted reductions: 11 / 15 / 19; cache hits: 4 / 3 / 5. No npm dependencies or audit requested there. Serial candidates remain the default; no speculative concurrency/scheduling changes. Peak workspace count was not instrumented.

Current scope remains an advanced alpha: no flaky mode, multiple simultaneous predicates, npm workspaces, tested TypeScript/source maps, pack CLI, CI exporter or public-registry/native-addon compatibility matrix. Package metadata remains private/unreleased; nothing was published. Next milestone: representative real-project compatibility and reliability validation before beta/release preparation.
