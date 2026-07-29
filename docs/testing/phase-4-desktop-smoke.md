# Phase 4 Desktop Smoke

## Environment

- Smoke started: 2026-07-29T13:03:37+08:00
- Initial Task 13 evidence recorded: 2026-07-29T13:55:27+08:00
- Final-review exact-SHA rebuild completed: 2026-07-29T22:11:15+08:00
- Final evidence updated: 2026-07-29T22:12:18+08:00
- System: macOS 26.5.2 (25F84), arm64, Darwin 25.5.0
- Source branch: `codex/phase-4-content-scale`
- Task 13 starting commit: `2a39887217aa301c66bf6c59a140d664e16cda1e`
- Final code commit: `c9a5488288fd9d2313f325162e1606e343bdc6f0`
- The final app and DMG were rebuilt from that exact commit after all independent-review fixes.
- Product: `Cloud Inn Phase 4 Smoke`
- Bundle identifier: `com.cloudinn.game.phase4-smoke`
- Isolated data directory: `/Users/miaoyuchen/Library/Application Support/com.cloudinn.game.phase4-smoke`
- The isolated data directory did not exist when the smoke began, so there was no prior user data to back up or overwrite.

## Bundles

- App: `/Users/miaoyuchen/Documents/Cloud Inn/.worktrees/phase-4-content-scale/app/src-tauri/target/debug/bundle/macos/Cloud Inn Phase 4 Smoke.app`
- DMG: `/Users/miaoyuchen/Documents/Cloud Inn/.worktrees/phase-4-content-scale/app/src-tauri/target/debug/bundle/dmg/Cloud Inn Phase 4 Smoke_0.1.0_aarch64.dmg`
- Database: `/Users/miaoyuchen/Library/Application Support/com.cloudinn.game.phase4-smoke/saves/save-1/save.sqlite3`
- App executable timestamp: `2026-07-29T22:10:55+0800`
- App executable SHA-256: `023d3defb7cde88cda98f4069df161d45cd9654f623fb7f31f58dfc3a51650dc`
- DMG timestamp: `2026-07-29T22:11:15+0800`
- DMG SHA-256: `d03f29098fedeac64047c9fba032a4713a55db49fd89f116083cbf70181ee02c`

The final debug app and DMG were built with:

```bash
cd app
npm run tauri -- build --debug --bundles app,dmg --ci --no-sign --config src-tauri/tauri.phase4-smoke.conf.json
```

## Phase 3 Upgrade

- Resolved Phase 3 final commit: `b8111c0a9cc12ea03bd8c1ac82c820f5d5669e7e`
- A temporary owned worktree was created at `/tmp/cloud-inn-phase3-worktree-1R2vhB`.
- The Phase 3 app used the absolute Phase 4 smoke configuration as a read-only build input, then created a real native SQLite save through visible UI.
- Before upgrade: revision 8, phase `open`, day 0, cash 53,600,000 cents, four room rows, and an operations envelope.
- Phase 3 database backup: `/tmp/cloud-inn-phase3-save-20260729-131552.sqlite3`
- Phase 3 SHA-256: `ec1f9542efbdba98e981687f4db6b7dccfd15e993318672e985708417f24c167`
- The backup hash matched the source database.
- Only the owned temporary Phase 3 worktree was removed. No other worktree, branch, or user file was removed.

The final Phase 4 app opened that same SQLite save, initialized content scale through visible UI, preserved the four legacy rooms, cash, operations history, and advanced revision, then quit and reopened successfully.

## Native Acceptance

Visible production UI verified:

- Phase 4 initialization preserved the legacy financial state and created the vertical tower.
- Copying the four-room floor reached exactly 120 real rooms.
- Tower navigation showed 39 purchased floors and 120 rooms.
- An All-Day Dining recommended layout was placed on floor 5 after day 16.
- The floor 5 workspace showed one facility and the visible `本层聚合流动图` static flow rendering with `全日餐厅`.
- The facility operations panel saved an international-luxury/premium, 30-seat, breakfast-dinner policy and enabled the restaurant.
- A manual day settlement advanced day 16 to day 17 and produced seven facility visits.
- Quit/reopen restored 120 rooms, one operating facility, its policy, one facility result, 17 daily reports, and day 17.

Final reopened SQLite state:

- revision 55
- current day 17
- cash 8,755,000 cents
- facility `facility:floor:5:all-day-dining`: `operating`, enabled
- facility results: one, day 17, seven visits
- operations reports: 17, last report day 17
- final database SHA-256: `aad2926e83dc1896df3d2d7bd8abca34fdfc96b80f68ede55c38ba2061dcbe11`

The initial native placement failure exposed `经营存档数据损坏`. A RED browser regression and a RED Rust/SQLite round-trip demonstrated that persistence incorrectly required the latest historical report cash to equal current cash after later construction. The fix keeps the report's arithmetic, day, and reputation checks while allowing legitimate post-settlement spending. Both focused regressions passed before the rebuilt native retry.

## Memory

The Task 13 exact-SHA bundle at `e66ed284bffd4366b500e8da2133d907a69fc23c` and the exact isolated database path were measured with a fixed five-second stabilization:

| Snapshot | RSS |
| --- | ---: |
| Phase 4 baseline with four rooms | 114,496 KB |
| Phase 4 maximum fixture with 120 rooms | 115,824 KB |
| Delta | 1,328 KB (1.30 MiB) |
| Budget | < 200 MB |

Result: PASS.

The final-review exact-SHA rebuild was then launched against the same isolated 120-room save, quit and reopened through visible native UI. Both launches restored 39 purchased floors, 120 rooms, one facility and ¥46,500 cash. The save revision advanced from 63 to 65 through the normal startup checkpoint sequence. Its stabilized maximum-fixture main-process RSS was 121,744 KB (118.89 MiB), which is itself below the 200 MB delta budget.

The 120-room database used for the maximum snapshot was backed up at `/tmp/cloud-inn-phase4-120-room-20260729-132656.sqlite3` with SHA-256 `53a5b4cae9ad62a05d53425242a9ed85836f09a764d0961c618e379131e7c55c`. The Phase 3 backup was temporarily restored for the baseline and the matching 120-room backup was restored afterward. Sampling covered only the main app process from the same bundle.

## Automated Gate

Final Task 13 verification runs:

- TypeScript typecheck: PASS
- Vitest: PASS, 65 files and 1,380 tests
- Production build: PASS; only the existing Vite chunk-size warning
- Full Playwright: PASS, six scenarios
- Browser Phase 4 acceptance: PASS; it visibly selects and restores the real `Tea-smoked duck` restaurant signature and `Cloud restoration` Spa package
- Reload restoration proof: PASS; visible UI/accessibility values cover exact floors, rooms, six facilities, cash, deterministic revision transition, floor identities, selected content, Spa operating state and report categories; the post-action persisted envelope additionally deep-compares all 30 daily reports, four weekly reports and one monthly close before and after reload
- Production-preview performance: 41 sprites, p95 9.20 ms across 1,141 samples, PASS
- Rust tests: PASS, 65 tests, including exact raw revision/operations/Phase 2/latest-report preservation after a rejected Phase 4 initialization of a native Phase 3 row
- Clippy with `-D warnings`: PASS
- Rust format check: PASS
- `git diff --check`: PASS

Independent final reviews completed at Critical 0 / Important 0 / Minor 0 with Ready = Yes. Phase 5 work, merge and branch cleanup remain under controller ownership.
