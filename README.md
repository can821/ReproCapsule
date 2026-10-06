# ReproCapsule

ReproCapsule reduces failing Node.js/npm projects into smaller, independently verifiable reproduction capsules while preserving the target failure.

**Status: advanced alpha (0.5.0-alpha.1).** Three historical functional bugs in two independent libraries are verified locally. Complete independent application validation and remote platform verification remain limited.

## Quick start

Node 24+, npm 9+, macOS/Linux implementation. Only macOS was exercised locally; the Ubuntu/macOS Node 24 workflow is prepared, not yet remotely verified.

```sh
npm ci --ignore-scripts
node bin/reprocapsule.js reduce --repo ./broken-project --command 'npm test' --out ./capsule
node bin/reprocapsule.js verify ./capsule
npm test
```

Output must be new and outside the source. npm may be supplied with `--npm-path /path/to/npm-cli.js` or `REPROCAPSULE_NPM`. This tool never installs system software. Package remains private; npm publication has not occurred. No LICENSE has been selected (`UNLICENSED`).

## Working capabilities

- Chunk-based file reduction and top-level npm dependency reduction; npm owns lockfile regeneration and fresh installs.
- Repeated baseline verification, strict normalized failure signatures, or explicit `--match-stderr TEXT [--exit-code N]`.
- Atomic checkpoint/resume, scoped persistent candidate cache, run/time/install budgets, JSON CLI output.
- Retained-item explanations and optional fresh single-removal file/dependency audit.
- Explicit JSON input minimisation and opt-in AST source reduction.
- Flat npm workspace membership reduction, dependency-closure checks, clean final verification and resume.
- Stack evidence, bounded local source maps, native Git bisect and isolated supplied-patch verification.
- Integrity-checked offline HTML/Markdown reports and explicitly selected local reporter plugins.

```sh
node bin/reprocapsule.js reduce --repo ./project --command 'npm test' --out ./small --checkpoint ./progress.json --cache-dir ./cache --audit-minimality
node bin/reprocapsule.js resume ./progress.json --out ./continued
node bin/reprocapsule.js reduce --repo ./project --command 'node repro.cjs' --out ./json-case --reduce-input request.json
node bin/reprocapsule.js reduce --repo ./project --command 'npm test' --out ./source-case --reduce-source src/parser.ts
node bin/reprocapsule.js bisect --repo ./project --good GOOD_REF --bad BAD_REF --command 'npm test'
node bin/reprocapsule.js verify-fix ./capsule --patch ./fix.patch --test-command 'npm test'
node bin/reprocapsule.js report ./capsule --out ./report.html
node bin/reprocapsule.js report ./capsule --out ./issue.md --format markdown
node bin/reprocapsule.js report ./capsule --out ./summary.json --format json --plugin ./examples/plugins/summary.mjs
```

### TypeScript and source reduction

The project's command must build and run its reproduction (for example `tsc -p tsconfig.json && node dist/repro.js`). Tested with TypeScript 5.8.3. The tool does not replace a compiler or claim tsx/ts-node/Jest/Vitest compatibility.

`--reduce-source PATH` selects one JS/TS file. TypeScript's parser selects top-level and nested statement lists, function bodies, and class members; candidates must parse and preserve the accepted failure. Newlines remain to avoid gratuitous strict stack changes. No regex-based source rewriting, expression simplification or global-minimum claim. Builds must be part of the reproduction command. `--source-max-runs` defaults to 100. Source content is not put in checkpoints; AST selection recipes are reconstructed against the unchanged snapshot. `--converge --max-rounds 5` reruns enabled stages until a full round accepts no change, the shared budget is exhausted, or the round limit is reached. Resume preserves the current round. This is convergence over enabled operations, not global minimality. File/dependency audits are reported independently; workspace/input/source remain NOT AUDITED.

TypeScript is a development dependency and optional peer. If it is unavailable to the tool, supply `--source-parser /path/to/typescript/lib/typescript.js` (trusted local module); no automatic download occurs. Local v3 sidecar/base64 source maps are bounded to 2 MiB and mapped only to retained project sources. Remote, indexed and escaping maps are ignored. [Node SourceMap API](https://nodejs.org/download/release/v24.18.0/docs/api/module.html#sourcemapfindoriginlinenumber-columnnumber).

### npm workspaces

Supported scope: flat named/versioned packages selected by explicit relative directories or terminal `/*` patterns, root lockfile v2/v3, normal npm version-range references between packages. Required local dependency edges cannot be silently replaced from the registry. Whole unused workspaces are removed before file/dependency phases. Workspace dependency declarations themselves are preserved. Nested roots, complex globs, workspace-local file/link/workspace protocols, yarn and pnpm remain unsupported. Workspace minimality is NOT AUDITED.

### Evidence and limits

REQUIRED means necessary for this tested reproduction, not that a file contains the bug. The optional audit certifies only single removals in its tested file/dependency set, excluding protected/control files; not workspace/input/source/global minimality. Default signature hashes normalized full stdout/stderr and nonzero exit status. Different messages/stack positions are significant. Timeouts, signals and truncated output do not match. Explicit stderr predicates deliberately broaden acceptance.

`--max-runs`, `--max-time` (seconds), `--timeout-ms` and `--install-timeout-ms` bound work; mandatory final verification may extend the reduction deadline. Partial results are exported only after verification. Cache entries exclude raw output/environment values and bind to a whole-environment fingerprint, but cannot model changing external services. Baseline, audit and final checks stay fresh. Older tool-version checkpoints are rejected; existing capsule directories remain verifiable. Source recipes now use version 2. SIGINT/SIGTERM during a running child command stops its process group; resume starts from the last accepted checkpoint. SIGKILL can leave temporary directories and cannot run cleanup.

Reports inspect integrity without executing the recorded command and do not embed source. Reporter contract: default export `{apiVersion:1,name,formats,render(report,{format})}` returning text up to 8 MiB. The plain-data report model has schemaVersion 1. This is a reporter-only plugin foundation, not a general adapter framework.

## Measured evidence

**84 automated tests passed, 0 failed, 0 skipped** on macOS arm64 / Node 24.19.0 / npm 10.9.2. Single-run timings below are fixture measurements, not universal performance promises.

| Case | Measured result |
|---|---|
| Earlier file fixture | 26 → 6 files |
| Earlier npm fixture | 5 → 2 dependencies |
| JSON fixture | 21,813 → 58 bytes |
| Earlier synthetic 2,000-file case | 2,000 → 2 files; about 4.26 s |
| Flat workspace fixture | 4 → 2 workspaces, fresh install and resume verified |
| JS AST fixture | 18 → 2 top-level statements; unchanged strict failure |
| TS compiled/source-reduced fixture | 339 → 265 source bytes; 4 → 3 statements; 20 executions, 12.489 s |

The TS result rebuilt with real `tsc`, verified independently, and mapped `dist/parser.js:7:25` to `src/parser.ts:2:24`. Strict emitted-stack matching conservatively limited further reductions.

Five independent published production distributions were tested: ms 6→5 files, semver 54→49, fast-json-stable-stringify 20→5, minimist 26→5, JSON5 22→9. These use authored negative-input probes, **not claimed historical upstream bugs or full upstream development suites**. Development manifests were explicitly adapted; production code stayed unchanged. Upstream commit metadata, licenses, integrity hashes, results and limitations are in [corpus/README.md](corpus/README.md). Third-party source is not committed.

## Security and remaining scope

**Not a sandbox.** Commands, selected parser/reporter modules and opted-in lifecycle scripts execute with user permissions, including access to network/external files. Installs occur in copies; lifecycle scripts default OFF. `.git`, `node_modules`, symlinks and known secret filenames are excluded. Filename filtering is not a secret-content scanner. Review command metadata before sharing. Hashes detect corruption, not malicious replacement of both content and metadata. No telemetry, automatic source upload or LLM integration.

No browser reproduction, additional package managers, range-level source-map coverage comparison, automated runtime-version search, or probabilistic intermittent reduction. Intermittent observation does not relax the reducer's stable baseline requirement. Git/dependency boundaries and patch results are evidence, not proof of causation or a complete fix. Node 22 is not declared supported. Remote CI has not been run in this task; no push, tag, release or npm publish was performed.

## Historical evidence and new workflows

[Historical functional cases](corpus/functional/README.md) pin three upstream bugs: Day.js objectSupport null handling (448→5 files), Day.js duration getters (448→5), and object-inspect quote escaping (35→5). Each buggy version fails and the fixed version passes the same upstream-derived probe. Each reduced capsule reproduces the strict failure in a fresh copy. These are adapted published distributions, not full upstream application checkouts.

Deep source examples: JS 177→107 bytes, 9→5 AST units (strict transcript); TS 187→127 bytes, 8→5 AST units (real tsc build plus explicit target message because emitted stack lines move). Builds must be included in the command. A historical object-inspect source run reduced 19,000→9,239 bytes (350→150 AST units) while preserving the strict failure. It hit the 180-candidate source budget: verified partial reduction, not a source minimum.

```sh
node bin/reprocapsule.js compare --repo ./failing --command 'node probe.cjs' --passing-repo ./passing --passing-command 'node probe.cjs' --capsule ./capsule
node bin/reprocapsule.js observe --repo ./project --command 'node probe.cjs' --matcher ./matcher.json --runs 10
node bin/reprocapsule.js dependency-boundary --repo ./project --command 'node probe.cjs' --dependency example --versions 1.0.0,1.1.0 --matcher ./matcher.json
node bin/reprocapsule.js pack ./capsule --out ./case.rcap.gz
node bin/reprocapsule.js inspect ./case.rcap.gz
node bin/reprocapsule.js unpack ./case.rcap.gz --out ./fresh
node bin/reprocapsule.js verify ./fresh
```

An explicit matcher JSON may be `{"all":[{"field":"exitCode","equals":1},{"field":"exception","contains":"TypeError: target"}]}`. Conditions support nested `all`/`any`, exit-code equality, and substring checks on stdout, stderr, exception or stack lines. The strict transcript predicate remains the default. Trees are bounded in depth and branching. Timeouts, truncated output and missing-module failures cannot satisfy explicit matchers. Use a narrow target; an overly broad substring is user-defined evidence, not exact error identity.

Comparison uses Node's native V8 coverage to identify executed project files plus mapped stack locations. It does not compare coverage offsets across revisions. In the historical object-inspect case, the known fix file is shared execution, not uniquely suspicious. A matching strict capsule can supply retained files/source units. `observe` reports an observed reproduction rate, not probability. Dependency experiments test supplied exact versions in their supplied order, report adjacent PASS→FAIL observations and separate setup/unrelated failures. Transitive versions can change; versions use isolated copies, while the two repetitions within one version share its installation.

Portable format v1 is gzip-compressed JSON with base64 file payloads and SHA-256 integrity. Maximum payload is 32 MiB (64 MiB expanded envelope); it refuses personal absolute paths and local working artifacts instead of rewriting source. Inspect/unpack do not execute commands; verify performs fresh preparation/execution. The historical object-inspect round-trip had 27,405 payload bytes and a 13,321-byte archive. Runtime requirements are recorded, not bundled. This format does not sign authorship.

[Performance evidence](docs/performance-current.json): one controlled 101→1-file case took 573 ms / 19 executions cold, 145 ms / 4 executions cached, with two rounds. Temporary bytes peaked at a sampled 100,078 bytes at 20 ms intervals; this is not exact allocated-disk high-water usage. No parallel evaluation was added. See [milestone audit](docs/milestone-audit.json) for measured scope and limitations.
