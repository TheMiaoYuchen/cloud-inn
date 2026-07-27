# Phase 3 Desktop Smoke

## Recorded environment

- macOS: `26.5.2`
- Architecture: `arm64`
- Source commit before this acceptance update: `5d2c721b8a39dd4106b91c75878723a75286f70c`
- Build command: `npm run tauri -- build --debug --bundles app,dmg --ci --no-sign`
- Debug app: `app/src-tauri/target/debug/bundle/macos/Cloud Inn.app`
- Debug DMG: `app/src-tauri/target/debug/bundle/dmg/Cloud Inn_0.1.0_aarch64.dmg`

## Acceptance status

| Check | Status | Evidence |
| --- | --- | --- |
| Debug frontend and Tauri application build | PASS | Build command completed and emitted both recorded bundle paths. |
| Phase 2 hotel to casual operations initialization | PASS | `phase3-operations.spec.ts` drives the visible browser workflow. |
| Six guest segments, pricing explanation and saved manual rate | PASS | Browser verifies all six cards, current rate, and reload. |
| Housekeeping leader and staffing capacity | PASS | Browser saves and reloads `高效清扫` with four staff. |
| Workspace renovation preview and commit | PASS | Browser verifies before/after workspace text, segment reasons, and closure notice. |
| 4x automatic one-day settlement | PASS | Injected 500 ms game-day configuration advances without manual settlement in under five seconds. |
| Offline catch-up cap and duplicate protection | PASS | Browser rewinds only the persisted checkpoint, reloads through `GameProvider`, observes exactly seven catch-up days, then reloads again without day duplication. |
| Day 7 weekly report and day 30 monthly close | PASS | Browser observes week one before continuing and month one at day 30. |
| Quit/reopen native app restoration | NOT RUN | Browser reload persistence passed; native process quit/reopen still requires manual desktop execution. |
| Visual-provider-offline desktop behavior | NOT RUN | Requires a manual native run with the visual provider unavailable; operations must remain usable while the retryable visual error is shown. |

The two `NOT RUN` checks are final desktop gates and must be completed before shipping the DMG.

## Native manual gate

1. Open `Cloud Inn.app` or mount the recorded DMG and launch the app.
2. Initialize operations, settle at least one day, then quit the process and reopen it; confirm the day, cash and report are restored.
3. Run without the visual provider/network and request a visual; confirm a readable retryable error while operations and settlement remain available.
