# Additional historical functional cases

Two projects extend the existing corpus to five bugs across four independent projects.

- Zod 3.23.0 → 3.23.1: the documented default generic regression makes a previously accepted `ZodType` consumer fail a real TypeScript 5.8.3 build. The buggy diagnostic is the intended target, not an unrelated compile failure. The fixed version compiles. This exercises the published declaration contract, not a build of Zod's entire upstream repository.
- markdown-it 12.3.0 → 12.3.1: upstream issue #830 and its added fixture document incorrect rendering of a tab-indented list continuation. The probe executes the real multi-file parser and compares the upstream expected HTML.

`cases.json` pins upstream revisions, official registry archives, SHA-512 integrity and every support package. Production package contents are unchanged; development setup is replaced by local pinned archives and an upstream-derived probe. The TypeScript compiler is included as a local npm dependency, so the resulting capsule requires no personal compiler path. No downloaded third-party source is committed.

Run preparation with `python3 corpus/expanded/prepare.py work/expanded-source`, then `node scripts/expanded-proof.js work/expanded-source work/expanded-results`. Both destinations must be new. Preparation downloads registry archives; installation and reduction use offline npm with scripts disabled.

The recorded Zod case completes file reduction (54→9 files, 1→1 dependency, 45 reduction executions). markdown-it reaches the explicit 60-execution budget (66→62 files, 5→5 dependencies): this is a **verified partial reduction**, not completed minimisation. Both fixed releases pass and both reduced buggy capsules pass fresh verification. Timings in `results.json` are single local samples, not throughput guarantees. Full upstream development suites are not claimed.
