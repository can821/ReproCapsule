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

For deterministic predicates the algorithm seeks phase-local 1-minimal sets, not a global minimum. Protected local package assets and control files are outside that claim.

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

Budget exhaustion exports the best state only after mandatory verification, marks it `PARTIAL`, and makes no minimality claim. A failed final verification produces no capsule. npm installs have separate timeouts and are not counted as reproduction runs. Repeated complete candidate outcomes are cached in memory for this run, keyed by files, dependencies, command and predicate; transient failures/timeouts are not cached. Final checks always bypass the cache. Checkpoint/resume is available as described below.

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

The old fixture still retains the same four removable files plus two protected package files, with the same signature; caching saves three of the original 36 executions. One dummy `.env.example` is excluded. The npm fixture uses five tiny, self-contained local tarballs: two required packages and unused production/development/optional packages. Three declarations and their unused tarballs are removed. npm owns lockfile regeneration. All **37 tests pass**, including the unchanged original 22.

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

Resume starts the unfinished phase from the best retained set; completed phases are skipped. Cache outcomes are deliberately not carried across environments. Each invocation gets fresh run/time budgets and records prior reproduction counts separately. Concurrent writers to the same checkpoint are unsupported. Source changes to deliberately excluded files (e.g. .env) are outside the snapshot. A valid checkpoint is progress evidence, not an independently verified capsule.

Next milestone: retained-item explanations and an optional budgeted 1-minimality audit.
