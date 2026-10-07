# Focused portability validation

Starting main: `fe69e9eaf3e7b6528977a497c6c2d69942d2645c` (documentation-only successor to the released commit). Working tree was clean; fast-forward only. Version remains `0.6.0-beta.1`, MIT, `private: true`. Existing release/tag is unchanged.

## Local runtime evidence

| Check | Node 24.19.0 / macOS arm64 | Node 22.23.3 / macOS arm64 |
|---|---|---|
| Baseline core tests | 96 pass, 0 fail, 0 skip; 22.128 s | 96 pass, 0 fail, 0 skip; 23.614 s |
| Real TypeScript proof | Existing release proof; final sprint check recorded separately | PASS, 7 → 6 files, source 339 → 231 bytes, 24 executions, 17.303 s |
| Checkpoint/resume, interruption/process cleanup, portable verification | Included in core suite | Included in core suite |
| npm pack --dry-run | PASS | PASS |

Node 22 came from the official `v22.23.3` macOS arm64 archive; its SHA256 matched the official SHASUMS256 file. The unpacked runtime is local ignored tooling, not a global installation. Node 24 baseline used npm 10.9.2; Node 22 uses bundled npm 10.9.9. No production compatibility shim was needed. The audit covered child_process, SourceMap.findOrigin, fs promises, AbortSignal, URL/path operations, signals and the node:test runner. Engine metadata permits >=22 only after these local checks. Ubuntu/macOS × Node 22/24 and historical validation passed [CI run 37555478122](https://github.com/can821/ReproCapsule/actions/runs/37555478122) on commit `052e9dad233aac13ec7071bc0975b428a05114db`.

## Windows: blocked execution contract, not supported

No mocked-win32 success is presented as support. No Windows CI success is claimed. Existing Windows rejection remains intact. This is an implementation-scope decision after inspection, not a claim that Windows support is impossible:

- `src/runner.js`: explicit Windows rejection, `/bin/sh`, detached POSIX process groups, negative-PID SIGTERM/SIGKILL and background-descendant cleanup.
- `src/package-manager.js`: POSIX quoting, `command -v`, shell executable discovery and a generated `#!/bin/sh` npm shim. `.cmd` discovery, `%`/`!`/quote handling and case-insensitive PATH need a coherent Windows command contract.
- `src/git.js` and `src/runtime-compare.js`: shell-quoted executable arguments; Git uses `/dev/null` configuration paths.
- `src/capsule.js`: generated `reproduce.sh` and `sh` instructions are part of current capsule metadata/integrity, so replacing just the process launcher does not provide a working portable Windows reproduction.
- `src/workspace.js`, integrity/checkpoint tests: permission bits participate in source snapshots. Windows chmod cannot be assumed to preserve POSIX executable-bit semantics. Symlink tests need real Windows privileges/junction behavior, not skipped safety assertions.
- Internal inventories use slash-separated relative names and canonical output checks; stack/source maps use platform path/URL APIs. These are useful foundations, but do not establish Windows case, drive, UNC, symlink or archive round-trip compatibility.

Node documents different Windows detached/signal and batch-file behavior ([Node 22 child_process](https://nodejs.org/download/release/v22.23.3/docs/api/child_process.html)). Windows [taskkill /T](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/taskkill) targets a process and its descendants; it is not itself evidence that the existing post-shell-exit POSIX cleanup contract is preserved. A credible implementation needs an explicit Windows process-tree lifecycle and real timeout/interruption/orphan tests alongside shell/npm/capsule changes. That exceeds a narrow compatibility correction; the existing rejection is retained rather than shipping an unverified cleanup path. No previously supported CI platform was removed.

## Installation actually exercised

On Node 24.19.0, a fresh clone of public main at the starting commit successfully ran `npm ci --ignore-scripts` and the CLI. A tarball built with `npm pack` from the local checkout installed in a separate clean consumer with `npm install --ignore-scripts /absolute/path/to/reprocapsule-0.6.0-beta.1.tgz`. Both installations reduced a controlled failing Node script project, independently verified it, and completed pack → inspect → fresh unpack → verify. Source hashes remained unchanged. No global installation or npm publication occurred.

For source installation, use the README commands. For a local tarball, run `npm pack` in the checkout, then install the resulting absolute tarball path in a separate npm project with `npm install --ignore-scripts /absolute/path/to/reprocapsule-0.6.0-beta.1.tgz`; invoke `node node_modules/reprocapsule/bin/reprocapsule.js --help` there. AST reduction additionally needs the optional TypeScript parser (source checkout `npm ci` includes it). No Git-based npx command is claimed tested. A locally built tarball reflects its checkout: retaining beta.1 metadata does not make untagged changes part of the existing beta.1 release. Record the source commit when sharing it.

## Outstanding gates

- Four-combination remote matrix: PASS, including Node 22 on both operating systems.
- Windows remains unsupported; six-combination portability success is not achieved.
- No successful independent external-project validation is recorded here; this runtime evidence is not external-user validation.
- No new tag/release or npm publication is authorized by this sprint. beta.2 readiness depends on the remaining evidence, not the metadata change alone.

## Final local gate

Clean npm ci followed by Node 24.19.0 core tests: 96 passed, 0 failed, 0 skipped, 22.279 s. Real TypeScript source proof: 7 → 6 files, 339 → 231 source bytes, 24 executions, 16.293 s, fresh verification and source-map check passed. Final dry pack: 38 entries, 55,405 compressed bytes; no work/test/node_modules artifacts. Both clean installations reduced 11 → 1 files in 13 executions (296 ms each), then verified the fresh unpacked capsule. Checkpoint/resume and interruption checks are included in the full suite. [Machine-readable measurements](portability-results.json).
