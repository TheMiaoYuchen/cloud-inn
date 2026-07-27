# Phase 3 Desktop Smoke

## Recorded environment

- macOS: `26.5.2`
- Architecture: `arm64`
- Native smoke source commit: `a962e77576da350510385e2faf50ef5564e3ad4d`
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
| Quit/reopen native app restoration | PASS | In the debug app, manual settlement advanced day 16 to day 17. After closing and relaunching the app, day 17, cash `¥551,840`, the daily report and the recorded checkpoint were restored. |
| Visual-provider failure isolation | PASS / N/A native outage | The current desktop build uses `PlaceholderVisualProvider`, so a live API outage cannot be induced until API Nebula integration lands. The controlled provider-error integration tests pass and verify that a retryable visual error is persisted without rejecting or changing operations/economics. |

The native persistence gate is complete. Repeat the live visual-outage check when the API Nebula provider replaces the placeholder in a later phase.

## Native smoke procedure

1. Open `Cloud Inn.app` or mount the recorded DMG and launch the app.
2. Initialize operations, settle at least one day, then quit the process and reopen it; confirm the day, cash and report are restored. **PASS on the recorded build.**
3. After API Nebula integration, run without the provider/network and request a visual; confirm a readable retryable error while operations and settlement remain available. **Deferred because this build uses the local placeholder provider.**
