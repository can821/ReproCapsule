# ReproCapsule

ReproCapsule reduces failing Node.js/npm projects into smaller, independently verifiable reproduction capsules while preserving the target failure.

**Status: advanced alpha (0.4.0).** Primary remaining validation: complete independent applications and historical bugs, beyond the measured production-package compatibility probes. Not production-ready or a universal root-cause detector.

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

`--reduce-source PATH` selects one JS/TS file. TypeScript's parser selects top-level statement spans; candidates must parse and preserve the accepted failure. Newlines remain to avoid gratuitous strict stack changes. No regex-based source rewriting, nested/expression reduction or global-minimum claim. Builds must be part of the reproduction command. `--source-max-runs` defaults to 100. Source content is not put in checkpoints; AST selection recipes are reconstructed against the unchanged snapshot. File/dependency phases are not rerun after source/input changes; no fixpoint guarantee.

TypeScript is a development dependency and optional peer. If it is unavailable to the tool, supply `--source-parser /path/to/typescript/lib/typescript.js` (trusted local module); no automatic download occurs. Local v3 sidecar/base64 source maps are bounded to 2 MiB and mapped only to retained project sources. Remote, indexed and escaping maps are ignored. [Node SourceMap API](https://nodejs.org/download/release/v24.18.0/docs/api/module.html#sourcemapfindoriginlinenumber-columnnumber).

### npm workspaces

Supported scope: flat named/versioned packages selected by explicit relative directories or terminal `/*` patterns, root lockfile v2/v3, normal npm version-range references between packages. Required local dependency edges cannot be silently replaced from the registry. Whole unused workspaces are removed before file/dependency phases. Workspace dependency declarations themselves are preserved. Nested roots, complex globs, workspace-local file/link/workspace protocols, yarn and pnpm remain unsupported. Workspace minimality is NOT AUDITED.

### Evidence and limits

REQUIRED means necessary for this tested reproduction, not that a file contains the bug. The optional audit certifies only single removals in its tested file/dependency set, excluding protected/control files; not workspace/input/source/global minimality. Default signature hashes normalized full stdout/stderr and nonzero exit status. Different messages/stack positions are significant. Timeouts, signals and truncated output do not match. Explicit stderr predicates deliberately broaden acceptance.

`--max-runs`, `--max-time` (seconds), `--timeout-ms` and `--install-timeout-ms` bound work; mandatory final verification may extend the reduction deadline. Partial results are exported only after verification. Cache entries exclude raw output/environment values and bind to a whole-environment fingerprint, but cannot model changing external services. Baseline, audit and final checks stay fresh. 0.3 checkpoints are incompatible with the new 0.4 tool version; existing capsules remain verifiable.

Reports inspect integrity without executing the recorded command and do not embed source. Reporter contract: default export `{apiVersion:1,name,formats,render(report,{format})}` returning text up to 8 MiB. The plain-data report model has schemaVersion 1. This is a reporter-only plugin foundation, not a general adapter framework.

## Measured evidence

**71 automated tests passed, 0 failed, 0 skipped** on macOS arm64 / Node 24.19.0 / npm 10.9.2. Single-run timings below are fixture measurements, not universal performance promises.

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

No browser/Playwright reproduction, Docker, source-map coverage comparison, environment minimisation/bisect, flaky mode, composite predicates, iterative fixpoint, pack/unpack CLI, local dashboard or IDE extension. Git bisect and patch results are evidence, not proof of causation or a complete fix. Remote CI is not yet green because publication has not completed. The next milestone is independent application/historical-bug validation and remote platform verification, not another breadth expansion.
