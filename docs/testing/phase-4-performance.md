# Phase 4 Performance Gate

Measured on 2026-07-29 on the local macOS development machine. Budgets are fixed acceptance gates and must not be loosened automatically in response to a slow run.

## Results

| Gate | Budget | Measured |
| --- | ---: | ---: |
| Warm one-day settlement | < 100 ms | 2.77 ms |
| Thirty-day replay | < 2,000 ms | 76.94 ms |
| Selected-floor flow projection | < 100 ms | 0.60 ms |
| Browser save | < 1,000 ms | 4.70 ms |
| Browser load | < 1,000 ms | 1.04 ms |
| Projected sprites | <= 150 | 41 |
| RAF delta p95 after warmup | <= 33 ms | 9.90 ms (1,141 samples) |
| Pixi animation evidence | Positive traveled distance | 1,203 ticks; 68,193.27 world units; `107.56,288.80` to `104.90,286.41` |
| WebKit process RSS delta | < 200 MB | Pending Task 13 native smoke |

Playwright does not expose a reliable WebKit renderer-process RSS metric. The browser gate therefore does not substitute JavaScript heap estimates for process RSS; the native measurement remains explicitly pending for Task 13.

## Reproduction

Run from `app/`:

```bash
npm test -- src/domain/flows src/canvas src/testing/phase4Performance.test.ts
npm test
npm run typecheck
VITE_CLOUD_INN_E2E=true npm run build
npm run test:e2e -- e2e/phase4-render-performance.spec.ts --config playwright.performance.config.ts
```

To print the unit measurements used in this record:

```bash
PHASE4_PERF_REPORT=1 npx vitest run src/testing/phase4Performance.test.ts --reporter=verbose --disableConsoleIntercept
```

The dedicated Playwright configuration always builds and serves the production preview on port 4174. It never uses the Vite development server. The browser scenario mounts one selected floor, asserts one Pixi canvas and at most 150 projected sprites, then performs fixed pan/zoom input for ten seconds. It discards the first 60 animation frames before calculating p95. The same trace reads ticker-backed position and cumulative-distance probes, asserts more than 100 animation ticks, and requires positive sprite travel. Cumulative distance avoids relying on the oscillation ending at a different phase.
