# ReproCapsule

Turn a failing JavaScript/TypeScript project into a smaller, independently verifiable bug reproduction, with evidence to help investigate it.

For developers reporting bugs, library/framework maintainers, open-source contributors, QA/test engineers and support engineers. When a failing project contains too much unrelated code to share or investigate, ReproCapsule removes tested parts while checking that the intended failure still occurs.

**One measured example:** a historical Day.js objectSupport regression went from **448 files to 5** and reproduced the same strict failure in a fresh copy. This is one historical result, not a guaranteed reduction ratio.

## Run it

Use Node 22 or 24 and npm 9+ on Ubuntu/Linux or macOS. GitHub source installation and a locally packed tarball were each tested in fresh directories, including reduction, verification and a portable round-trip. Nothing is published to npm; `private: true` remains enabled.

```sh
git clone https://github.com/can821/ReproCapsule.git
cd ReproCapsule
npm ci --ignore-scripts
node bin/reprocapsule.js reduce --repo /path/to/broken-project --command 'node repro.cjs' --out /tmp/reprocapsule-case
node bin/reprocapsule.js verify /tmp/reprocapsule-case
```

The command is yours: `node repro.cjs`, `npm test`, or a compiler/build command. Include required builds in that command. Controlled tests cover Node script failures, npm tests and TypeScript builds; this is not a claim of Jest, Vitest or Playwright compatibility.

Output must be new and outside the input project. Start with a trusted project; **ReproCapsule is not a sandbox**. npm may be supplied using `--npm-path` or `REPROCAPSULE_NPM`.

## Compatibility

| Platform | Node 24 | Node 22 |
|---|---|---|
| Ubuntu/Linux | Remote CI verified | Remote CI verified |
| macOS | Remote CI verified | Remote CI verified |
| Windows | Unsupported | Unsupported |

The published [`v0.6.0-beta.1`](https://github.com/can821/ReproCapsule/releases/tag/v0.6.0-beta.1) remains unchanged. Current main commit `052e9dad233aac13ec7071bc0975b428a05114db` passed Ubuntu/macOS × Node 22/24 core tests, real TypeScript proof and package checks, plus the historical job in [CI run 37555478122](https://github.com/can821/ReproCapsule/actions/runs/37555478122). The engine range is >=22; other Node majors are not implied to have been tested.

See [portability audit and installation evidence](docs/portability-validation.md), [historical regressions](#historical-regressions-and-advanced-workflows), and [security and limitations](#security-and-remaining-scope). External-user validation remains outstanding. MIT licensed; Copyright (c) 2026 Can Yilmaz.

## Where it fits

Manual reduction remains useful when you already know what can be removed. ReproCapsule automates tested removal attempts and fresh verification across a JS/TS project, then packages the reproduction. `git bisect` searches revisions; it complements this project reduction. Generic delta debugging/ddmin and source reducers such as C-Reduce and Perses are related approaches, not inventions of this project. No comparative speed or minimality advantage is claimed; see [related work](#related-work).

## Scope

**Core beta workflow:** reduce a failing project, preserve the target failure, resume interrupted work, verify the resulting capsule, and optionally pack/unpack it for transfer.

**Advanced beta tooling:** Git bisect, passing/failing comparison, patch verification, intermittent-failure observation/reduction, dependency-boundary experiments, runtime comparison and reporter plugins. These provide bounded debugging evidence; they are not root-cause, causality or complete-fix proofs.

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

`--reduce-source PATH` selects one JS/TS file; `--reduce-source-all` processes retained eligible JS/TS files sequentially in deterministic order. Declaration files are excluded; limits are 256 eligible files and 1 MiB per source. The source budget is shared: an early file can consume it. Metrics identify measured files, and convergence may remove newly unnecessary files in later rounds. TypeScript's parser selects top-level and nested statement lists, function bodies, and class members; candidates must parse and preserve the accepted failure. Newlines remain to avoid gratuitous strict stack changes. No regex-based source rewriting, expression simplification or global-minimum claim. Builds must be part of the reproduction command. `--source-max-runs` defaults to 100. Source content is not put in checkpoints; AST selection recipes are reconstructed against the unchanged snapshot. `--converge --max-rounds 5` reruns enabled stages until a full round accepts no change, the shared budget is exhausted, or the round limit is reached. Resume preserves the current round. This is convergence over enabled operations, not global minimality. File/dependency audits are reported independently; workspace/input/source remain NOT AUDITED.

TypeScript is a development dependency and optional peer. If it is unavailable to the tool, supply `--source-parser /path/to/typescript/lib/typescript.js` (trusted local module); no automatic download occurs. Local v3 sidecar/base64 source maps are bounded to 2 MiB and mapped only to retained project sources. Remote, indexed and escaping maps are ignored. [Node SourceMap API](https://nodejs.org/download/release/v24.18.0/docs/api/module.html#sourcemapfindoriginlinenumber-columnnumber).

### npm workspaces

Supported scope: flat named/versioned packages selected by explicit relative directories or terminal `/*` patterns, root lockfile v2/v3, normal npm version-range references between packages. Required local dependency edges cannot be silently replaced from the registry. Whole unused workspaces are removed before file/dependency phases. Workspace dependency declarations themselves are preserved. Nested roots, complex globs, workspace-local file/link/workspace protocols, yarn and pnpm remain unsupported. Workspace minimality is NOT AUDITED.

### Evidence and limits

REQUIRED means necessary for this tested reproduction, not that a file contains the bug. The optional audit certifies only single removals in its tested file/dependency set, excluding protected/control files; not workspace/input/source/global minimality. Default signature hashes normalized full stdout/stderr and nonzero exit status. Different messages/stack positions are significant. Timeouts, signals and truncated output do not match. Explicit stderr predicates deliberately broaden acceptance.

`--max-runs`, `--max-time` (seconds), `--timeout-ms` and `--install-timeout-ms` bound work; mandatory final verification may extend the reduction deadline. Partial results are exported only after verification. Cache entries exclude raw output/environment values and bind to a whole-environment fingerprint, but cannot model changing external services. Baseline, audit and final checks stay fresh. Older tool-version checkpoints are rejected; existing capsule directories remain verifiable. Source recipes now use version 2. SIGINT/SIGTERM during a running child command stops its process group; resume starts from the last accepted checkpoint. SIGKILL can leave temporary directories and cannot run cleanup.

Reports inspect integrity without executing the recorded command and do not embed source. Reporter contract: default export `{apiVersion:1,name,formats,render(report,{format})}` returning text up to 8 MiB. The plain-data report model has schemaVersion 1. This is a reporter-only plugin foundation, not a general adapter framework.

## Measured evidence

The measurements below were recorded locally on macOS arm64 / Node 24.19.0 / npm 10.9.2. They are fixture-specific measurements, not universal performance promises. Release CI status is reported once in the status section above.

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

### Compatibility probes: authored negative inputs

Five independent published production distributions were tested with authored negative-input probes: ms 6→5 files, semver 54→49, fast-json-stable-stringify 20→5, minimist 26→5, JSON5 22→9. These are **synthetic compatibility probes, not historical upstream bug reproductions and not full upstream development suites**. Development manifests were explicitly adapted; production code stayed unchanged. Upstream commit metadata, licenses, integrity hashes, results and limitations are in [corpus/README.md](corpus/README.md). Third-party source is not committed.

## Security and remaining scope

**Not a sandbox.** Commands, selected parser/reporter modules, explicitly selected plugins and opted-in lifecycle scripts execute with user permissions, including access to network/external files. Installs occur in copies; lifecycle scripts default OFF. `.git`, `node_modules`, symlinks and known secret filenames are excluded. Filename filtering is not a secret-content scanner. Do not run untrusted projects, commands or plugins as though ReproCapsule were an isolation boundary. Review command metadata before sharing. Hashes detect corruption, not malicious replacement of both content and metadata. No telemetry, automatic source upload or LLM integration.

No browser reproduction or additional package managers. Runtime comparison accepts existing explicit executable paths; its original comparison evidence used one actual Node version and controlled wrappers. The new Node 22/24 core checks do not establish a real runtime-regression boundary. Intermittent reduction requires explicit opt-in and a target matcher; it makes no probability claim. Git/dependency boundaries and patch results are evidence, not proof of causation or a complete fix.

### Current gaps and next validation targets

- No external-user validation has been completed yet.
- Windows, yarn, pnpm and Bun remain unsupported.
- No Docker/container sandbox is provided; untrusted projects or plugins should not be executed directly.
- Candidate evaluation is sequential; parallel evaluation is not implemented.
- There is no apples-to-apples benchmark against other reducers yet.
- No broad framework compatibility or external-user validation is claimed.

### GitHub Actions usage today

ReproCapsule does not ship a first-party GitHub Action. A workflow can use the source checkout directly:

```yaml
name: ReproCapsule reproduction
on: workflow_dispatch

jobs:
  reduce:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v5
        with:
          path: project
      - uses: actions/checkout@v5
        with:
          repository: can821/ReproCapsule
          ref: v0.6.0-beta.1
          path: reprocapsule
      - uses: actions/setup-node@v5
        with:
          node-version: '24'
      - run: npm ci --ignore-scripts
        working-directory: reprocapsule
      - name: Reduce and verify
        run: |
          node reprocapsule/bin/reprocapsule.js reduce \
            --repo project \
            --command 'npm test' \
            --out "$RUNNER_TEMP/reprocapsule-case"
          node reprocapsule/bin/reprocapsule.js verify "$RUNNER_TEMP/reprocapsule-case"
```

This executes the reproduction command with the GitHub runner's permissions; it is **not** isolation.

## Related work

ReproCapsule does not claim to invent program reduction. It combines existing reduction/debugging ideas with npm-project structure, failure verification, project-level packaging and debugging evidence.

- [Delta Debugging / ddmin](https://www.debuggingbook.org/html/DeltaDebugger.html) is a generic approach for minimizing failure-inducing inputs.
- [C-Reduce](https://github.com/csmith-project/creduce) is a mature C/C++ test-case reducer driven by an interestingness test.
- [Perses](https://github.com/uw-pluverse/perses) is a syntax-directed, language-agnostic program reducer and includes JavaScript support.
- [git bisect](https://git-scm.com/docs/git-bisect) searches history for the change that introduced a property; ReproCapsule's project reduction is complementary rather than a replacement.

No direct performance/minimality comparison against these tools has been completed yet.

## Historical regressions and advanced workflows

The historical cases below are separate from the synthetic compatibility probes above.

| Historical case | Measured file result | Reduction status |
|---|---:|---|
| Day.js objectSupport null handling | 448 → 5 | complete; audited candidate set |
| Day.js duration getters | 448 → 5 | complete; audited candidate set |
| object-inspect quote escaping | 35 → 5 | complete; audited candidate set |
| Zod TypeScript declaration regression | 54 → 9 | complete run; no global-minimum claim |
| markdown-it tab/list regression | 66 → 62 | **partial**; stopped at 60-run budget |

Each buggy version fails and the pinned fixed version passes the same upstream-derived probe. Reduced capsules reproduce the target failure in fresh copies. These are adapted published distributions, not full upstream application checkouts. Details are in [historical functional cases](corpus/functional/README.md) and [expanded historical evidence](corpus/expanded/results.json).

Deep source examples: JS 177→107 bytes, 9→5 AST units (strict transcript); TS 187→127 bytes, 8→5 AST units (real tsc build plus explicit target message because emitted stack lines move). Builds must be included in the command. The later historical object-inspect source run reduced 19,000→1,968 bytes at a 250-source-candidate limit; later files were not reached. This is a verified partial reduction, not a source minimum.

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

Comparison uses Node's native V8 coverage to identify executed project files, nonblank lines intersecting innermost executed ranges, and mapped stack locations. Failing-only, passing-only and shared regions are aligned only for identical source hashes. Changed sources remain explicitly unaligned. TypeScript mappings use line-start origins, not exact expression coverage. Historical object-inspect executed regions overlap the known fix area in both versions; overlap does not establish causality. A matching strict capsule can supply retained files/source units. `observe` reports an observed reproduction rate, not probability. Dependency experiments test supplied exact versions in their supplied order, report adjacent PASS→FAIL observations and separate setup/unrelated failures. Transitive versions can change; versions use isolated copies, while the two repetitions within one version share its installation.

Portable format v1 is gzip-compressed JSON with base64 file payloads and SHA-256 integrity. Maximum payload is 32 MiB (64 MiB expanded envelope); it refuses personal absolute paths and local working artifacts instead of rewriting source. Inspect/unpack do not execute commands; verify performs fresh preparation/execution. The historical object-inspect round-trip had 27,405 payload bytes and a 13,321-byte archive. Runtime requirements are recorded, not bundled. This format does not sign authorship.

[Performance evidence](docs/performance-current.json): one controlled 101→1-file case took 573 ms / 19 executions cold, 145 ms / 4 executions cached, with two rounds. Temporary bytes peaked at a sampled 100,078 bytes at 20 ms intervals; this is not exact allocated-disk high-water usage. No parallel evaluation was added. See [milestone audit](docs/milestone-audit.json) for measured scope and limitations.

## Beta engineering evidence

[Expanded historical evidence](corpus/expanded/results.json) contains the detailed Zod and markdown-it measurements. Zod completed a 54 → 9 file reduction. markdown-it reached only 66 → 62 files before its 60-run budget was exhausted, so it is intentionally treated as limited evidence rather than a headline reduction result. These adapted published libraries are not full application or upstream-suite validation.

Multi-file tests reduce two JS sources from 157 → 120 bytes and two TS sources from 146 → 109 bytes with a real compiler command; both reach a no-change round. The historical object-inspect production source reaches 19,000 → 1,968 bytes at a 250-source-candidate limit; later files were not reached. No global minimum is claimed.

`--repeat-runs 4 --match-threshold 0.5 --matcher matcher.json` requires at least two matching observations in each fresh four-run batch. Default reduction stays deterministic. Every observation consumes execution/time budgets and prepares a fresh copy. Repeated mode disables candidate caching and minimality audits; checkpoint/resume preserves policy and accepted state. A controlled alternating case reduced 2 → 1 files with 2/4 matching observations and 24 total executions. The rate is observed frequency, not probability. `verify-fix` currently refuses repeated capsules.

Dependency search retains sequential ordered experiments. Opt-in `--monotonic` assumes the supplied sequence is PASS→FAIL, searches by bisection, then independently rechecks adjacent values. Setup failures remain ambiguous. The real object-inspect supplied fixed→buggy order used four installations/eight executions in 2.210 seconds; it does not locate the historical introduction.

`runtime-compare --repo ./project --script repro.cjs --runtimes runtimes.json --matcher matcher.json` accepts a JSON array of 1–10 absolute executable paths (including trusted wrappers). It reports two fresh observations per available runtime. npm preparation and child-process runtime resolution use the host toolchain; this is bounded top-level Node-script comparison, not full toolchain isolation. No runtime is installed or globally switched.

[Portable final evidence](docs/beta-portable-proof.json) verifies fresh unpack/install/run for a two-source JS reduction, Zod, markdown-it and object-inspect. Archives were respectively 4,789; 4,289,652; 159,734; and 7,963 bytes in this run. Format v1 remains unchanged. [Programme measurements](docs/beta-progress.json) record scope and limitations. Checkpoint tests cover interruption, stale temporary workspaces, changed source/runtime, malformed state, and cache validation.
