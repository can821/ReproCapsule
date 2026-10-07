# Beta.2 development validation — 2026-10-07

Started on clean `main` at `af435f8a9c1dd4655ccaa63c37864dbe8753795e`. The existing beta.1 release and tag are unchanged. This is a development record, not a beta.2 release declaration. Version remains 0.6.0-beta.1 with `private: true` until all release gates pass.

## Correctness

Commit `2ca2cbd` adds optional paired reduction to the existing reducer. A candidate must preserve the bad target AND a fresh normal exit-zero good control. Focused tests cover broken good controls, unrelated bad failures, eliminated bad failures, cache separation, resume, final and portable verification. Single-failure mode remains supported. Repeated mode and verify-fix do not silently bypass the paired policy; these combinations are explicitly unsupported.

[Independent external-project measurement](paired-external-proof.json) uses tabcat/pw-tsconfig-repro at `b19d0a061941e8af34f0d7558717f80c7370688d`, in a new temporary clone. Bad Playwright 1.62.0 reproduced the exact extends-resolution failure; good 1.61.0 passed. Reduction: 11 → 9 files, 3 → 3 dependencies, 20 executions, 26.367 seconds, complete. Required foo files and dependency were retained. Both sides verified after fresh pack/unpack; original source hashes were unchanged. Archive: 6,832 bytes. The passing command's extra npm install is not included in preparation installCount. This is external-project validation, not external-user validation.

## Local implementation gate

macOS arm64, Node 24.19.0, clean npm ci: full suite **102 passed / 0 failed / 0 skipped**, 22.521 seconds. An additional normal-exit descendant-cleanup regression was then added; focused runner suite **5 passed / 0 failed / 0 skipped**. The resulting suite contains 103 tests; no 103-test remote/full-suite success is claimed yet.

Real TypeScript 5.8.3 proof: 7 → 6 files, source 339 → 231 bytes, 24 executions, 15.869 seconds. Fresh verification and mapped source location passed. Full suite includes JS/TS source reduction, convergence, matching, intermittent observations, Git/dependency/runtime experiment controls, paired correctness, checkpoint/resume, fix verification and portable verification.

Actual npm tarball installed into a new consumer with a space-containing path: npm exec CLI help, paired reduce → verify → pack → inspect → fresh unpack → verify passed on real Node 24.19.0 and Node 22.23.3. The latter artifact contains 39 entries, 57,440 compressed bytes. Source checkout tests are not substituted for this installed-package proof. No global runtime change or npm publication occurred.

## Windows implementation and remaining remote gate

Commit `f45820d` adds cmd execution, explicit npm-cli.js discovery, case-insensitive PATH handling, platform-aware internal argument quoting, a Windows npm shim, portable Node reproduction scripts, Git NUL configuration and archive rejection of drive/stream/device/ambiguous paths. A live supervisor provides a process-tree root until taskkill /T /F completes, including after command exit. This is not a sandbox and cannot control deliberately escaped processes or machine termination. Windows SIGINT handler coverage is an emitted Node event, not proof of identical console signal semantics. Real timeout/output-limit/normal-exit descendant checks are in the Windows matrix.

CI now requests Ubuntu/macOS/Windows × Node 22/24. Each job runs clean install, all tests, real compiler/source-map proof, installed tarball CLI round-trip and npm pack --dry-run. Historical validation remains a separate Ubuntu/Node24 job. No platform tests were disabled. **This new matrix has not run:** normal HTTPS push is blocked by missing Git credentials. The prior Ubuntu/macOS matrix was green at run 37616135733, but is not evidence for the new commit or Windows.

## Publication boundary

No beta.2 version, tag, GitHub release or npm publication has been created. Package ownership/authentication, new remote matrix, final version validation and public-install audit remain release gates. Existing historical evidence in portability-validation.md describes an earlier sprint; it is not the current implementation status. No external-user validation or universal cross-platform shell portability is claimed.

## Distribution and public presentation audit

Final development tarball and dry-run: 39 entries, 58,101 compressed bytes, 193,981 unpacked bytes. Actual archive audit found no working directories, tests/corpus, node_modules, credential config, personal home path or recognizable npm/GitHub token. This pattern check is not a universal secret scanner. MIT license, bin, source modules and README are included. npm registry lookup for reprocapsule returned E404 (not an ownership reservation); npm whoami returned ENEEDAUTH. Nothing was published.

GitHub repository description was updated to “Failure-preserving reduction and verification for reproducible JavaScript/TypeScript bug reports.” Topics: debugging, javascript, reproducible-bugs, typescript. No unverified Windows or release claim was added to public metadata.

To repeat external validation, clone the pinned upstream commit into a new temporary directory, make separate bad/good/source copies, install the pinned manifests in bad, and install `@playwright/test@1.61.0` in good. Check each installed package version. Run `npx --no-install playwright test` in each; use the exact paired commands and ALL matcher recorded in paired-external-proof.json against the pristine source copy. Reduce with maxRuns 60, timeoutMs 30000, maxTimeMs 180000; verify, pack, inspect, unpack into a new path, and verify again. Do not reuse baseline node_modules as source input.
