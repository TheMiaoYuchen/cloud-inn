# Phase 3 Desktop Smoke

## Environment

- Host: macOS (recorded with `sw_vers -productVersion`), architecture from `uname -m`.
- Commit under test: `7c70913` (update to the Task 11 commit when running the smoke).
- Expected app artifacts: `app/src-tauri/target/release/bundle/macos/Cloud Inn.app` and `app/src-tauri/target/release/bundle/dmg/Cloud Inn_<version>_aarch64.dmg` (or `x86_64` on Intel).

## Commands

```sh
cd app
npm run tauri build
npm run test:e2e -- e2e/phase3-operations.spec.ts
```

DMG build is intentionally pending for Task 11 unless the local Rust/Tauri toolchain is already installed; record the generated path and checksum when it is run.

## Manual smoke checklist

1. Open the app, load the Phase 2 hotel, visit `运营`, and choose `启用完整经营` with `casual` difficulty.
2. Confirm six guest segments render, save one pricing policy, assign a housekeeping leader, and increase staffing capacity.
3. Preview then commit a room renovation; verify before/after fit, reason text, and closure notice.
4. Start operations, settle one day, then settle through day 7 and confirm the weekly report.
5. Continue through day 30 and confirm the monthly close, cash, reputation, debt, unlocks, leader, renovation, closure, report counts, and checkpoint.
6. Quit and reopen the app. The day-30 close and persisted reports/checkpoint must be restored without a duplicate day.
7. Disable the visual provider or run offline. A readable retryable visual error is expected; operations and settlement remain available.

