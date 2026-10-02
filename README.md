# ReproCapsule

Reduce a failing Node.js/JavaScript project into a smaller reproduction, preserving a conservative failure signature. Local prototype; no runtime dependencies. Requires Node.js 24+ and macOS/Linux.

```sh
node bin/reprocapsule.js reduce --repo ./broken-app --command 'node test/repro.js' --out ./capsule
node --test test/*.test.js
```

The reproduction command is trusted local shell input. Only run commands and repositories you trust.
