# ReproCapsule

Reduce a failing Node.js/JavaScript project into a smaller reproduction while preserving a conservative failure signature. Zero runtime dependencies; Node.js 24+, macOS/Linux. Tested on macOS with Node 24.19.0.

```sh
node bin/reprocapsule.js reduce \
  --repo ./broken-app \
  --command 'node test/repro.js' \
  --out ./capsule \
  --timeout-ms 10000

node --test test/*.test.js
```

The output directory must be new and outside the source repository. The default is `./repro-capsule-output`. A nonzero exit code from the generated `sh ./reproduce.sh` is expected: it reproduces the bug. The reducer itself exits 0 on successful packaging.

## How it works

1. Copy allowed files into a temporary snapshot. Never run the command in the source tree.
2. Confirm the baseline twice in independent clean copies. Reject success, timeout, missing-module/setup errors, truncated output and unstable failures.
3. Remove chunks of candidate files using a deterministic, complement-based ddmin strategy. Accept a removal only when its failure signature matches.
4. Refine to individual removals, verify the retained set, and verify again with the generated capsule metadata present.
5. Export original snapshot bytes, excluding writes made by the command. Clean up temporary workspaces on normal completion and handled errors.

The signature compares exit code plus the full normalized stdout/stderr transcript using SHA-256. ANSI codes, known workspace paths (including encoded file URLs), and narrowly recognized timing fields are normalized. Error messages, stack locations and other diagnostic changes stay significant. Unknown variations cause rejection. This is evidence of matching output, not a universal proof of identical semantics.

Package manifests and npm/yarn/pnpm lockfiles are protected during file reduction. For a deterministic command, the result is **1-minimal**: no single remaining candidate file can be removed while keeping the signature. This is not a guarantee of the globally smallest subset.

## Measured fixture demo

```sh
node bin/reprocapsule.js reduce --repo test/fixtures/broken-parser --command 'node test/repro.js' --out work/demo-capsule
sh work/demo-capsule/reproduce.sh
```

Use a new output path for another run. The fixture intentionally throws `TypeError: Cannot read properties of undefined (reading 'trim')` when parsing a profile with a missing display name.

| Measure | Observed result |
| --- | --- |
| Physical fixture files | 27 (one excluded `.env.example`, containing dummy data) |
| Eligible project files | 26 → 6 |
| Removable candidate files | 24 → 4 |
| Project-file reduction | 76.92% |
| Candidate executions / accepted removals | 32 / 7 |
| Total executions in the pipeline | 36 (2 baseline + 32 candidate + 2 verification) |
| Same failure / source unchanged | Both verified |
| Automated tests | 22 passing |

The capsule contains six retained project files plus three generated files: `capsule.json`, `README.md` and `reproduce.sh`. If a source README is retained, instructions go in `README.reprocapsule.md`. The manifest records counts, signature digest, command, runtime/OS metadata, retained files and exclusions. It does not contain raw captured output or environment values. `durationBeforePackageVerificationMs` deliberately excludes the last packaged verification and clean re-export.

## Safety and current limits

- The supplied command is **trusted local `/bin/sh` input**. It runs with your permissions and inherited environment. Workspaces prevent accidental reducer edits to source files; they are not security sandboxes. Commands can access absolute paths, network and external state. Use repository-relative commands, and never pass secrets inline in the command recorded in the capsule.
- `.git`, `node_modules`, `.env*`, common credential/config files, keys, symlinks and special files are excluded. These are filename rules, not a complete secret scanner. Review a capsule before sharing it. Empty directories are not preserved.
- No dependency installation or dependency reduction yet. Current reliable scope is self-contained Node projects or commands whose tools are already available. Setup errors are refused; V1 does not package missing-module bugs as target failures. Secret-dependent reproductions may not work after exclusions.
- Commands must fail deterministically in clean copies. Two baseline runs help detect instability but cannot prove it absent. Random output, unexpected timing formats and environment-sensitive behavior can prevent reduction. The baseline is the sanitized copy, not an execution of the original tree.
- Environment metadata helps diagnosis but does not recreate the full environment. Portability to other machines/OS versions is not guaranteed. macOS verified; Linux process-group support implemented but not tested here; Windows unsupported.
- Timeout defaults to 10 seconds per execution, with process-group termination and a 1 MiB combined output limit. Deliberately detached processes can escape a group. A forcibly killed reducer may leave temporary files. There is no total-run budget/resume yet; reduction can be expensive for large projects.
- Reserved source filenames: `capsule.json`, `reproduce.sh`, `README.reprocapsule.md`. Existing output is never overwritten. Keep the source stable while copying. The tool assumes ordinary trusted local filesystem use, not hostile concurrent filesystem changes.

Next milestone: isolated dependency installation and reduction, with lockfile consistency and the existing failure-preservation tests kept passing.
