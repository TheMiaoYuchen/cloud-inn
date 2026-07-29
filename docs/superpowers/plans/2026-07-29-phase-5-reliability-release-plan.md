# Cloud Inn Phase 5 Reliability and macOS Release Implementation Plan

**Goal:** Complete Version 1 with recoverable native saves, transactional assets, secure optional image generation and a release-ready macOS package.

**Architecture:** Pure TypeScript keeps game and queue intent independent of infrastructure. Rust owns SQLite, filesystem, archive, Keychain and network trust boundaries. Native commands return bounded metadata and stable error codes. Browser tests use deterministic adapters and never claim Keychain or native filesystem coverage.

**Design:** `docs/superpowers/specs/2026-07-29-phase-5-reliability-release-design.md`

## Standing constraints

- Preserve `.DS_Store` and `初步设想.md`.
- Do not remove branches, worktrees, saves or backups without explicit deletion approval.
- No token getter, token logging, raw provider-response logging or Base64 persistence.
- No arbitrary frontend-provided app-data path.
- Import always creates a new save and never overwrites.
- Domain modules cannot import Tauri, SQLite, HTTP, Keychain or filesystem code.
- Every Critical/Important review finding requires a regression and focused rerun.
- Commit in small tested slices; rebuild native bundles after the last code fix.

## Task 1: Freeze contracts, limits and failure language

**Files**

- Create `app/src/domain/reliability/reliabilityTypes.ts`
- Create `app/src/domain/reliability/reliabilityTypes.test.ts`
- Create `app/src/application/ports/ReliabilityPort.ts`
- Create `app/src/application/playerError.ts`
- Create `app/src/application/playerError.test.ts`
- Create `app/src-tauri/src/keychain.rs`
- Create `app/src-tauri/src/redaction.rs`
- Modify `app/src-tauri/src/lib.rs`
- Modify `app/src-tauri/Cargo.toml`
- Modify `app/src-tauri/capabilities/default.json`
- Modify `app/src-tauri/tauri.conf.json`

- [ ] Reuse the existing branded `SaveId`; define `RecoveryId`, `AssetId`, `GenerationJobId`, archive version, job states, asset metadata and the five-state provider credential health projection.
- [ ] Freeze limits from the design: names, recovery count, prompts, reference/result bytes, response bytes and archive bounds.
- [ ] Freeze credential input at 1-4096 UTF-8 bytes; reject empty, NUL/control and leading/trailing whitespace without trimming, normalization or error echo.
- [ ] Define generate-before-send confirmation, daily request ceiling and explicit opt-in automatic 1K fallback preferences.
- [ ] Define stable native error codes grouped by save, migration, recovery, archive, asset, Keychain, provider and network.
- [ ] Map every code to “what happened / what is safe / next action”; keep technical detail optional.
- [ ] Implement bundle/environment-isolated Keychain service/account selection with a mock backend and no token getter.
- [ ] Reduce the main-window capability allowlist to the commands/plugins actually required and install a restrictive baseline CSP with no web-provider origin; allow the read-only `cloudinn-asset:` scheme only for images, and keep development-only origins in the smoke/dev config.
- [ ] Install panic/error/log redaction before commands run; secret wrappers expose no sensitive `Debug`/`Display`.
- [ ] Add exhaustive serialization, forbidden-field and sentinel scans across errors, logs, IPC fixtures and browser storage.
- [ ] Run focused TypeScript/Rust tests, typecheck, Clippy, format and `git diff --check`.
- [ ] Commit: `feat: define secure phase five contracts`

## Task 2: Add schema v7 and migration-safe open

**Files**

- Create `app/src-tauri/migrations/007_reliability.sql`
- Modify `app/src-tauri/src/persistence.rs`
- Create `app/src-tauri/src/reliability.rs`
- Modify `app/src-tauri/src/lib.rs`
- Modify `app/src-tauri/Cargo.toml`

- [ ] Add failing tests for v6→v7, repeated open, a forced migration error and pre-migration backup integrity.
- [ ] Add save schema v7 tables `save_metadata`, `assets`, `asset_references`, `generation_jobs`, `asset_write_intents`, `recovery_points` and `runtime_session`, plus application-wide provider-control schema v1 tables `provider_preferences`, `provider_attempts` and `provider_send_grants`, with JSON/size/status/timestamp constraints and indexes.
- [ ] Add adversarial NULL fixtures for every SQLite state/timestamp/outcome CHECK so three-valued logic cannot admit an invalid sent/terminal attempt.
- [ ] Seed provider-control preferences only on first initialization with ceiling 10, confirmation on and automatic fallback off; later missing/corrupt singleton fails closed. New/imported saves never create a separate budget.
- [ ] Bootstrap under an app-root lock: allow missing control DB creation only when no save exists or all saves are pre-v7; publish/fsync control before any v7 save. Missing control with any v7/unreadable save fails closed. Test pre/post-publish crashes and simulated control deletion.
- [ ] Use monotonic `preferences_revision` CAS; the writable DTO contains only ceiling/confirmation/auto-fallback, so IPC can never lower `last_quota_day` or rewrite ledger-derived usage.
- [ ] Set fixed `application_id`/`user_version`; retain `schema_migrations` only as audit and keep game schema separate.
- [ ] Split read-only inspect, create and current open; acquire a per-save lock before any mutation.
- [ ] Online-backup the old database, clone to staging, run all pending migrations and records on the clone, then run strict schema-object, integrity, foreign-key, game and asset validation.
- [ ] Close/fsync and journal an atomic old-or-new database switch with no active WAL/SHM connection; every failpoint leaves the original byte-identical or the new database complete.
- [ ] Add the durable job state machine, coordinator/lease epoch, request fingerprint and response-ambiguity fields before any provider work.
- [ ] Add monotonic `job_revision`; every job transition and player command uses CAS+increment, never `updated_at_ms`. Test stale commands across retry, restore and adoption.
- [ ] Prove the Phase 4 `save-1` remains loadable without directory/ID re-key while new/imported saves use backend UUIDs.
- [ ] Run Rust focused/full tests, Clippy, format and diff check.
- [ ] Commit: `feat: add recoverable phase five migration`

## Task 3: Implement named saves and native save catalog

**Files**

- Modify `app/src-tauri/src/reliability.rs`
- Modify `app/src-tauri/src/lib.rs`
- Create `app/src/infrastructure/tauri/TauriReliabilityPort.ts`
- Create `app/src/infrastructure/tauri/TauriReliabilityPort.test.ts`
- Create `app/src/infrastructure/browser/BrowserReliabilityPort.ts`

- [ ] Test NFC/grapheme name normalization, control rejection, allowed duplicates, deterministic default names and invalid directory entries.
- [ ] Implement list/create/rename/open metadata APIs without a second catalog database; unknown load IDs must not create directories.
- [ ] Generate bounded internal UUID save IDs in Rust; display names never enter paths and may duplicate.
- [ ] Keep validated legacy IDs such as `save-1` loadable; UUID generation applies only to create/import.
- [ ] Return bounded summaries only; never expose absolute paths.
- [ ] Keep browser adapter explicit and deterministic for UI tests.
- [ ] Prove rename cannot change save ID/path or game revision.
- [ ] Run focused TypeScript/Rust gates and full typecheck.
- [ ] Commit: `feat: manage named local saves`

## Task 4: Add 20-point recovery and crash failpoints

**Files**

- Create `app/src-tauri/src/recovery.rs`
- Create `app/src-tauri/src/bin/save_failpoint_helper.rs`
- Modify `app/src-tauri/src/persistence.rs`
- Modify `app/src-tauri/src/lib.rs`

- [ ] Add RED tests for explicit construction/settlement/visual-adoption reasons, first point, exact rotation, corrupted point rejection and monotonic restore.
- [ ] Serialize all save/file writes through `WriteCoordinator`; before a marked commit, build and fsync a hidden immutable pre-image package for exact revision `r-1` with Online Backup plus referenced assets.
- [ ] Commit revision `r` and an outbox row containing `origin_commit_revision=r`, `restore_revision=r-1` and the immutable package hash/path in the same transaction.
- [ ] Promote the existing package idempotently after commit or startup; never recreate it from a later active database. Transaction failure leaves only a quarantinable orphan.
- [ ] Define package identity as the hash of the sorted canonical payload-record stream and manifest identity as the hash of exact manifest bytes.
- [ ] Keep hidden packages outside the count; rotate only after promotion to ready. Test fail-after-commit followed by another commit attempt and prove adjacent recovery contents remain distinct.
- [ ] Keep the newest 20 ready automatic points; metadata/queue/pricing/checkpoints do not consume them and pre-upgrade/pre-restore points are separate.
- [ ] Rotate only the 20 automatic points. Never auto-delete pre-upgrade/pre-restore/player backups or quarantined active databases; collect only proven app-owned temporary/orphan asset material after the defined age/size limits and a complete outbox/lease/GC-root scan.
- [ ] Before any restore candidate transform/swap, create, verify and fsync a protected pre-restore package of the frozen current DB and its assets; failure aborts without active-state mutation.
- [ ] Restore only opaque listed IDs: pause writes/jobs, close connections, validate and build a staging clone that replaces authoritative game content/assets while preserving current metadata, recovery catalog, runtime and job ambiguity control state; keep provider preferences/attempts/quota usage untouched and verify/materialize/fsync every recovered asset into the active tree before swap.
- [ ] Rebuild asset references, acquire the exclusive send/restore permit, expire incompatible issued grants first, bump the coordinator epoch, revoke old leases, require epoch/status/fingerprint CAS on pre-send and late worker results, reconcile jobs to `superseded`/confirmation states, prohibit automatic network resumption, assign `currentRevision + 1`, swap without stale WAL/SHM, fsync and reopen. A cross-DB crash may conservatively require reconfirmation but never preserves stale authorization.
- [ ] Define asset GC roots as active DB + every retained/pre-upgrade recovery DB + non-terminal jobs/staging; scan failure deletes nothing and candidates are quarantined first.
- [ ] Terminate the helper at staging, backup, transaction, commit and cleanup failpoints plus pre-restore-durable/candidate-transform/pre-swap/post-swap/pre-reopen failpoints; assert exact old-or-new state and usable pre-restore protection.
- [ ] Run Rust full gates and repeat the crash matrix.
- [ ] Commit: `feat: add rotating recovery points`

## Task 5: Build the transactional asset store

**Files**

- Create `app/src-tauri/src/assets.rs`
- Modify `app/src-tauri/src/persistence.rs`
- Modify `app/src-tauri/src/lib.rs`
- Modify `app/src/domain/game/state.ts`
- Modify browser and Rust validators

- [ ] Add failing byte-limit, MIME-sniff, dimension, hash, duplicate-content, missing-file and interrupted-write tests.
- [ ] Stream to same-volume app staging, validate JPEG/PNG/WebP magic/decoder/dimensions/pixels, hash the exact stored decoded file bytes and sync.
- [ ] Persist `staging-asset`, atomically rename into the content-addressed tree, sync the directory, then insert asset/reference rows and CAS the job to `ready-for-review`.
- [ ] Persist every temp/final path, operation ID, expected hash, MIME, size and dimensions in `asset_write_intents`; startup reconciliation must use those durable rows rather than directory guesses.
- [ ] Persist dynamic `assetId` rather than arbitrary paths; retain bundled `/visuals/` only as a separate placeholder namespace.
- [ ] Make job ID + request fingerprint retries idempotent after a successful DB commit but lost IPC response.
- [ ] Reconcile staging/final crash points and quarantine corrupt or grace-period orphan files using the complete GC root set.
- [ ] Render a safe missing-asset projection instead of failing the hotel load.
- [ ] Register a read-only `cloudinn-asset://<asset-id>` native protocol that accepts no paths, resolves through the same-save registry and verifies hash/MIME/size; test traversal, query override, cross-save access and packaged CSP rendering.
- [ ] Run focused/full TypeScript and Rust gates.
- [ ] Commit: `feat: store generated assets transactionally`

## Task 6: Export and import `.cloudinn`

**Files**

- Create `app/src-tauri/src/archive.rs`
- Modify `app/src-tauri/src/lib.rs`
- Modify `app/src-tauri/Cargo.toml`
- Extend `ReliabilityPort`

- [ ] Add RED round-trip tests with a database and multiple assets.
- [ ] Add malicious fixtures for traversal, backslash/NUL/Unicode paths, absolute paths, symlinks, case collisions, duplicate/directory entries, ZIP64/zip bombs, compression-ratio/CPU bounds, missing/extra files, bad hashes, future versions and insufficient space.
- [ ] Export under a per-save read lease from snapshot through asset/archive completion, using a sanitized portable clone with recovery/runtime/lease/staging and non-terminal job state removed; never include provider-control, select assets from that frozen clone, validate the temporary sibling and atomically rename.
- [ ] Make `manifest.json` hash payload entries only and record the completed ZIP hash separately.
- [ ] `inspect_import` copies the selected archive to sealed app-owned staging, validates strict allowlisted entries, and returns a single-use/session-bound/15-minute token tied to path+SHA-256; open its database read-only with `trusted_schema=OFF`, extensions disabled and an exact allowed object set.
- [ ] `import_save` consumes and rehashes those exact staged bytes, never reopens the user path, allocates a fresh ID, and transactionally re-keys only enumerated relational columns and known JSON `$.saveId` fields.
- [ ] Strip machine-local state, map compatible non-terminal/sent jobs to player-confirmation states with no automatic network, assert no source ID remains in structured references, repeat full validation, close/fsync and publish with rename-no-replace.
- [ ] Prove existing save directories and Keychain material remain byte-identical.
- [ ] Run archive-focused fuzz/property tests and full Rust gates.
- [ ] Commit: `feat: export and import cloudinn saves`

## Task 7: Audit Keychain isolation and global redaction

**Files**

- Extend `TauriReliabilityPort`

- [ ] Re-run fake and real isolated-smoke Keychain status/set/delete/locked/unavailable tests; production Keychain entries must remain unchanged.
- [ ] Confirm no token getter/capability exists and transient inputs are cleared.
- [ ] Expand redaction tests to headers, Bearer variants, compact keys, private keys, Base64/data URIs, nested provider errors and existing raw `console.error` sites.
- [ ] Scan database/WAL, recovery, export, logs, UI diagnostics, panic fixture and support bundle for sentinel secrets.
- [ ] Run Rust/TypeScript full gates.
- [ ] Commit: `feat: secure provider credentials`

## Task 8: Implement API Nebula adapter and limits

**Files**

- Create `app/src-tauri/src/provider.rs`
- Modify `app/src-tauri/src/lib.rs`
- Modify `app/src-tauri/Cargo.toml`
- Create provider request/response fixtures

- [ ] Add a local mock server; tests must make no external paid request.
- [ ] Validate runtime models via `GET /v1/models`; cache at most 15 minutes and invalidate on model-not-found.
- [ ] Implement bounded `generateContent` for `gemini-3.1-flash-image`, extracting `inlineData` without logging it.
- [ ] Implement explicit 1K-compatible fallback to `gemini-2.5-flash-image`.
- [ ] Refuse silent 2K/4K downgrade.
- [ ] Fix the HTTPS origin, reject origin-changing redirects, and enforce resolution-aware prompt/reference/decompressed-response/Base64/decoded-byte/parts/pixel limits while streaming.
- [ ] Classify authentication, safety, malformed response, network, 408, 429 and 5xx errors.
- [ ] Mark an in-flight crash/timeout with possible billing as `needs-retry-confirmation`; do not auto-retry it.
- [ ] Verify current official model names before final native smoke; runtime list remains authoritative.
- [ ] Run provider focused/full Rust gates.
- [ ] Commit: `feat: integrate bounded image provider`

## Task 9: Persist and recover the offline generation queue

**Files**

- Create `app/src/domain/visualJobs/visualJob.ts`
- Create `app/src/domain/visualJobs/visualJob.test.ts`
- Create `app/src/application/VisualJobService.ts`
- Modify `app/src/application/ports/ReliabilityPort.ts`
- Modify `app/src/infrastructure/tauri/TauriReliabilityPort.ts`
- Modify `app/src/infrastructure/tauri/TauriReliabilityPort.test.ts`
- Modify `app/src/infrastructure/browser/BrowserReliabilityPort.ts`
- Modify `app/src-tauri/src/reliability.rs`
- Modify `app/src-tauri/src/lib.rs`

- [ ] Test every legal/illegal state transition and bounded attempts; reuse Task 1's single `JobStatus` union across service and all adapters.
- [ ] Add typed enqueue/list/retry/fallback-choice/cancel/send-confirm/adoption-confirm/preferences APIs to `ReliabilityPort`, Tauri and deterministic browser adapters; preferences updates accept a narrow writable DTO plus expected monotonic revision.
- [ ] Make fallback choice the narrow `'compatible-1k'` enum; native validates job revision/status, 1K compatibility, extra paid-call confirmation and quota, and rejects 2K/4K without mutation.
- [ ] Persist job request/status/model/error code without token, prompt diagnostics or raw response.
- [ ] Reserve every primary/retry/fallback network attempt in the application-wide `provider_attempts`; as the final pre-I/O gate, hold an epoch-scoped shared send permit and CAS current coordinator epoch + lease epoch/status/fingerprint + reservation before `sent` and transport handoff. Restore takes the exclusive permit before epoch bump.
- [ ] Bind each send grant to exactly one next attempt sequence + save/job revision + model + request fingerprint + effective day; consume it atomically with reservation. Crash reuse keeps the same attempt, while every later retry/fallback requires a new grant.
- [ ] Enforce at most one `issued` grant per save/job/sequence with a partial unique index; test old-day issued → expired → same-sequence new-day grant while retaining immutable history.
- [ ] When confirmation is disabled, native issues only a one-attempt policy grant. Automatic-fallback opt-in permits compatible selection but never authorizes a retry chain; explicit fallback choice creates one exact 1K grant.
- [ ] Reuse a proven-unsent reservation only on the same effective day; at a UTC day boundary mark the attempt state `expired-unsent` without fabricating `sent_at_ms`, then reserve against the new day. Test midnight, sleep, forward jump and rollback without over-ceiling sends.
- [ ] Derive daily used count from every ledger row for the effective day regardless of state; terminal outcomes, ambiguity, cancellation and expiration never reduce it.
- [ ] Use expiring native leases; startup requeues only requests proven unsent, while ambiguous sent requests require confirmation.
- [ ] `ready-for-review` requires asset row + matching file hash; adoption validates expected revision and target fingerprint, otherwise marks `superseded`.
- [ ] Move offline work to `waiting-network`; resume only through explicit reachability or player retry.
- [ ] Retry only classified transient errors, at most three attempts with capped backoff.
- [ ] Persist generic `retry-delay` + `next_attempt_at_ms`; retain the exact primary/fallback choice in `selected_model` and the attempt ledger, use a nondecreasing observed wall-clock floor so restart, sleep/wake and clock rollback never accelerate retry, and reuse only proven-unsent reservations.
- [ ] Test fallback 429 → restart/sleep/clock rollback → due retry and prove it remains on fallback without exceeding the request ceiling.
- [ ] Cancellation never changes blueprint/economics and cannot remove an adopted asset.
- [ ] Cancel/supersede/request-change/restore expire incompatible issued grants before the job transition under an exclusive permit; startup cross-DB validation fails closed on any issued-grant mismatch.
- [ ] Keep the native AI coordinator separate from `GameProvider`'s mutation queue; master adoption precedes any focus job that references it.
- [ ] Persist/enforce one application-wide daily request ceiling and confirmation policy with UTC day indexes, monotonic `last_quota_day`, append-only attempt counts and no refunds; show scope/defaults in UI, fail closed on invalid control state, and allow automatic 1K fallback only after explicit opt-in.
- [ ] Run focused/full TypeScript and Rust gates.
- [ ] Commit: `feat: recover visual generation queue`

## Task 10: Add first-run, save manager, design studio and diagnostics UI

**Files**

- Create `app/src/pages/FirstRunPage.tsx` and tests
- Create `app/src/pages/SaveManagerPage.tsx` and tests
- Create `app/src/pages/DesignStudioPage.tsx` and tests
- Create `app/src/pages/DiagnosticsPage.tsx` and tests
- Modify router, `AppShell`, styles and provider composition

- [ ] First run creates/selects a named save and makes AI setup clearly optional.
- [ ] Token input is uncontrolled, clears after its one invoke, and is absent from React state/context, DOM and snapshots afterward.
- [ ] Save manager lists/create/rename/export/import/recovery actions; no delete action.
- [ ] Design studio shows durable job/model/fallback states and economic-safety language.
- [ ] Missing assets show a placeholder and recovery guidance.
- [ ] Diagnostics expose only bounded redacted facts and stable codes.
- [ ] Add Playwright flows for first-run skip/setup fake, import/export, offline resume, fallback and missing asset.
- [ ] Run accessibility, typecheck, full Vitest and Playwright.
- [ ] Commit: `feat: expose reliability and diagnostics UI`

## Task 11: Finish the macOS shell

**Files**

- Modify `app/src-tauri/src/lib.rs`
- Modify `app/src-tauri/tauri.conf.json`
- Update `app/src-tauri/icons/`
- Create `docs/testing/phase-5-release-readiness.md`

- [ ] Add standard menus and connect safe save/recovery actions.
- [ ] Test window size/position restore and off-screen clamping.
- [ ] Re-audit and tighten the Task 1 baseline production CSP against the finished UI; keep provider networking native-only.
- [ ] Add a native close handshake while proving SIGKILL recovery remains independent of it.
- [ ] Disable production devtools/raw console-error forwarding and bound diagnostic file size/count/retention.
- [ ] Verify icon sizes and render the `.icns` in the final bundle.
- [ ] Record bundle/version/entitlement/hardened-runtime/Developer-ID/notarization/stapling/update prerequisites.
- [ ] Do not sign, notarize or publish.
- [ ] Build App/DMG and run current-Mac menu/window/Keychain smoke.
- [ ] Commit: `feat: prepare macOS release shell`

## Task 12: Run the Phase 5 exit gate

**Files**

- Create `app/e2e/phase5-reliability.spec.ts`
- Create `docs/testing/phase-5-desktop-smoke.md`
- Create `docs/testing/phase-5-soak.md`
- Create a Phase 5 isolated Tauri smoke config

- [ ] Run typecheck, full Vitest, production build and all Playwright scenarios.
- [ ] Run Rust tests, Clippy, format, archive adversarial suite, secret scan and crash matrix.
- [ ] Migrate a real Phase 4 final SQLite save and reopen it.
- [ ] Force-close during native writes and prove exact old-or-new recovery.
- [ ] Export and import a maximum hotel; deep-compare state and asset hashes under a new save ID.
- [ ] Verify token absence across DB, recovery, exports, logs and diagnostics.
- [ ] Run missing-asset, sleep/wake and offline/online checks.
- [ ] Run a two-hour current-Mac maximum-fixture soak plus accelerated thousands-of-commit stress.
- [ ] Build exact-SHA App/DMG; record hashes, RSS, macOS/architecture and all performed/unperformed checks.
- [ ] Commit: `test: verify phase five reliability`

## Task 13: Independent review, merge and handoff

- [ ] Run an independent specification review against the roadmap, original design and Phase 5 design.
- [ ] Run independent Rust security/persistence, TypeScript/application and UI/accessibility whole-diff reviews.
- [ ] Resolve every Critical/Important with RED→GREEN coverage; repeat until all reviewers return Ready.
- [ ] Re-run the complete gate and rebuild native artifacts after the last code fix.
- [ ] Fast-forward merge into `main`.
- [ ] Run merged typecheck, Vitest and Rust tests.
- [ ] Preserve user-owned untracked files.
- [ ] Leave worktree/branch cleanup pending explicit deletion approval.

## Exit evidence

The final record must include exact commits, test totals, archive manifest/hash results, recovery rotation count, failpoint matrix, secret scan, model-check behavior, App/DMG hashes, native database path, RSS, soak duration and signing/notarization readiness. Any unperformed check is marked explicitly rather than inferred.
