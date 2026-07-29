# Cloud Inn Phase 5 Reliability and macOS Release Design

**Date:** 2026-07-29
**Status:** Approved for implementation
**Branch:** `codex/phase-5-reliability-release`

## 1. Outcome

Phase 5 completes Version 1 by making the existing design, building and operations loop safe for long-term local play on macOS.

The phase is complete only when:

- saves have player-visible names, at most 20 player-visible automatic recovery points, and separately protected upgrade/restore backups;
- a forced close during a write restores the previous or the new complete revision, never a partial revision;
- a `.cloudinn` package exports and imports a complete hotel without overwriting an existing save;
- generated images are written atomically and every persisted reference resolves to a verified local asset;
- the API Nebula token lives only in macOS Keychain and cannot appear in saves, exports or diagnostics;
- image jobs survive restart, wait safely while offline, and use explicit primary/fallback rules;
- the packaged app passes migration, missing-asset, crash-recovery, long-run and current-Mac packaging gates;
- signing and notarization prerequisites are documented, while public distribution remains a separate decision.

## 2. Scope and non-goals

### 2.1 In scope

- Native save catalog, names, recovery points, migration backups, integrity checks and repair choices.
- Native asset store, durable generation queue and API Nebula adapter.
- Keychain-backed provider token and structured redacted diagnostics.
- `.cloudinn` archive export/import.
- First-run setup, save manager, queue status, diagnostics and player-facing recovery UI.
- macOS menus, window restoration, icon verification, CSP hardening and release-readiness assessment.

### 2.2 Out of scope

- Accounts, cloud sync, iCloud, multiplayer or shared saves.
- Uploading the hotel database, reports or complete design history to an AI provider.
- Windows packaging.
- Automatic public release, Developer ID purchase, notarization submission or App Store submission.
- Ingredient inventory, individual staff schedules or new Phase 4 content.
- Changing economic outcomes based on model output.

## 3. Trust boundaries

The domain remains provider-agnostic and cannot import Tauri, SQLite, HTTP, Keychain or filesystem APIs.

| Boundary | Trusted responsibility | Forbidden |
| --- | --- | --- |
| TypeScript domain | job intent, prompt structure, adoption choice, economic isolation | tokens, raw provider responses, filesystem paths outside `/visuals/` |
| Application layer | serialize commands, expose durable job projections, map error codes to player language | direct file writes, direct network calls |
| Tauri command layer | validate all IPC input, resolve app-owned paths, map stable error codes | accepting arbitrary save roots or logging request bodies |
| Native persistence | SQLite transactions, migration, snapshots, archive validation | trusting archive paths, hashes or declared sizes |
| Native provider | Keychain lookup, model check, bounded HTTP, response parsing, asset staging | returning the token, logging authorization or raw Base64 |
| Browser fallback | deterministic placeholder and LocalStorage compatibility tests | live API token support or `.cloudinn` filesystem claims |

All player-selected import/export paths are obtained through the native file dialog. Save IDs, asset IDs, job IDs and archive entry paths are validated again in Rust.

## 4. Native data layout

The application data directory uses this layout:

```text
com.cloudinn.game/
  provider-control.sqlite3
  saves/
    <save-id>/
      save.sqlite3
      assets/
        sha256/<hash-prefix>/<sha256>.<ext>
      recoveries/
        <sequence>-r<revision>/
          manifest.json
          save.sqlite3
          assets/
      pre-upgrade/
      staging/
      quarantine/
  imports/
  diagnostics/
    cloud-inn-diagnostics.log
```

Rules:

- `save.sqlite3` is authoritative for game state, save name, asset references and generation jobs.
- `provider-control.sqlite3` is the application-wide authority for provider preferences and the append-only billable-attempt ledger, so creating or switching saves cannot multiply the daily ceiling.
- Dynamic generated images are persisted by `assetId`; Rust resolves them only through the owning save's asset registry. Existing bundled `/visuals/` placeholders remain a separate compatibility namespace.
- Recovery, staging and quarantine paths are never accepted from the frontend.
- Sidecar recovery JSON contains only revision, schema version, timestamp, reason and database SHA-256. It is not authoritative.
- Staging directories older than 24 hours are removable only after proving they are not referenced by an active job.

## 5. SQLite schema and migration

Database schema version 7 adds:

```sql
CREATE TABLE save_metadata (
  save_id TEXT PRIMARY KEY REFERENCES saves(save_id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL,
  renamed_at_ms INTEGER NOT NULL,
  metadata_revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE assets (
  asset_id TEXT PRIMARY KEY,
  relative_path TEXT NOT NULL UNIQUE,
  sha256 TEXT NOT NULL UNIQUE,
  mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/webp')),
  byte_length INTEGER NOT NULL CHECK(byte_length > 0),
  width INTEGER NOT NULL CHECK(width > 0),
  height INTEGER NOT NULL CHECK(height > 0),
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE asset_references (
  owner_kind TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  asset_id TEXT NOT NULL REFERENCES assets(asset_id),
  PRIMARY KEY(owner_kind, owner_id, asset_id)
);

CREATE TABLE generation_jobs (
  job_id TEXT PRIMARY KEY,
  save_id TEXT NOT NULL REFERENCES saves(save_id) ON DELETE CASCADE,
  target_fingerprint TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL CHECK(
    length(request_fingerprint) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  job_revision INTEGER NOT NULL DEFAULT 0 CHECK(job_revision >= 0),
  request_json TEXT NOT NULL CHECK(
    json_valid(request_json)
    AND json_type(request_json) = 'object'
    AND length(CAST(request_json AS BLOB)) <= 262144
  ),
  status TEXT NOT NULL CHECK(status IN (
    'queued','blocked-no-credential','waiting-network','checking-model',
    'running-primary','retry-delay','running-fallback','staging-asset',
    'ready-for-review','adopted','needs-retry-confirmation',
    'needs-player-confirmation','superseded',
    'failed-retryable','failed-terminal','cancelled'
  )),
  selected_model TEXT,
  next_attempt_at_ms INTEGER CHECK(next_attempt_at_ms IS NULL OR next_attempt_at_ms >= 0),
  lease_owner TEXT,
  lease_until_ms INTEGER,
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK(lease_epoch >= 0),
  asset_id TEXT REFERENCES assets(asset_id),
  error_code TEXT,
  response_ambiguous INTEGER NOT NULL DEFAULT 0 CHECK(response_ambiguous IN (0,1)),
  created_at_ms INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  CHECK(
    (status = 'retry-delay' AND next_attempt_at_ms IS NOT NULL)
    OR (status <> 'retry-delay' AND next_attempt_at_ms IS NULL)
  ),
  CHECK(
    (lease_owner IS NULL AND lease_until_ms IS NULL)
    OR (lease_owner IS NOT NULL AND lease_until_ms IS NOT NULL)
  )
);

CREATE TABLE asset_write_intents (
  job_id TEXT PRIMARY KEY REFERENCES generation_jobs(job_id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL UNIQUE,
  temp_relative_path TEXT NOT NULL,
  final_relative_path TEXT NOT NULL,
  expected_sha256 TEXT NOT NULL CHECK(length(expected_sha256) = 64),
  mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/webp')),
  byte_length INTEGER NOT NULL CHECK(byte_length > 0),
  width INTEGER NOT NULL CHECK(width > 0),
  height INTEGER NOT NULL CHECK(height > 0),
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE recovery_points (
  recovery_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('automatic','pre-upgrade','pre-restore')),
  origin_commit_revision INTEGER,
  restore_revision INTEGER NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','ready','failed')),
  relative_path TEXT NOT NULL,
  package_sha256 TEXT NOT NULL CHECK(length(package_sha256) = 64),
  manifest_sha256 TEXT,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE runtime_session (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  session_id TEXT NOT NULL,
  clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0,1)),
  last_durable_revision INTEGER NOT NULL,
  coordinator_epoch INTEGER NOT NULL CHECK(coordinator_epoch >= 0),
  last_observed_wall_ms INTEGER NOT NULL CHECK(last_observed_wall_ms >= 0),
  updated_at_ms INTEGER NOT NULL
);
```

The separate application-wide provider control database uses schema version 1:

```sql
CREATE TABLE provider_preferences (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  preferences_revision INTEGER NOT NULL CHECK(preferences_revision >= 0),
  daily_request_ceiling INTEGER NOT NULL CHECK(daily_request_ceiling BETWEEN 0 AND 100),
  require_send_confirmation INTEGER NOT NULL CHECK(require_send_confirmation IN (0,1)),
  allow_automatic_1k_fallback INTEGER NOT NULL CHECK(allow_automatic_1k_fallback IN (0,1)),
  last_quota_day INTEGER NOT NULL CHECK(last_quota_day >= 0),
  updated_at_ms INTEGER NOT NULL
);

CREATE TABLE provider_attempts (
  attempt_id TEXT PRIMARY KEY,
  save_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  quota_day INTEGER NOT NULL CHECK(quota_day >= 0),
  model TEXT NOT NULL CHECK(length(model) BETWEEN 1 AND 128),
  sequence INTEGER NOT NULL CHECK(sequence > 0),
  state TEXT NOT NULL CHECK(state IN (
    'reserved','sent','outcome-known','outcome-unknown','expired-unsent'
  )),
  reserved_at_ms INTEGER NOT NULL CHECK(reserved_at_ms >= 0),
  sent_at_ms INTEGER,
  completed_at_ms INTEGER,
  outcome_code TEXT CHECK(outcome_code IS NULL OR length(outcome_code) BETWEEN 1 AND 128),
  UNIQUE(save_id, job_id, sequence),
  CHECK(
    (state = 'reserved' AND sent_at_ms IS NULL AND completed_at_ms IS NULL AND outcome_code IS NULL)
    OR (
      state = 'sent'
      AND sent_at_ms IS NOT NULL
      AND sent_at_ms >= reserved_at_ms
      AND completed_at_ms IS NULL
      AND outcome_code IS NULL
    )
    OR (
      state = 'expired-unsent'
      AND sent_at_ms IS NULL
      AND completed_at_ms IS NOT NULL
      AND completed_at_ms >= reserved_at_ms
      AND outcome_code IS NOT NULL
      AND outcome_code = 'expired-unsent'
    )
    OR (
      state IN ('outcome-known','outcome-unknown')
      AND sent_at_ms IS NOT NULL
      AND sent_at_ms >= reserved_at_ms
      AND completed_at_ms IS NOT NULL
      AND completed_at_ms >= sent_at_ms
      AND outcome_code IS NOT NULL
    )
  )
);

CREATE TABLE provider_send_grants (
  grant_id TEXT PRIMARY KEY,
  save_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_revision INTEGER NOT NULL CHECK(job_revision >= 0),
  attempt_sequence INTEGER NOT NULL CHECK(attempt_sequence > 0),
  model TEXT NOT NULL CHECK(length(model) BETWEEN 1 AND 128),
  request_fingerprint TEXT NOT NULL CHECK(
    length(request_fingerprint) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  quota_day INTEGER NOT NULL CHECK(quota_day >= 0),
  source TEXT NOT NULL CHECK(source IN (
    'player-confirmed','confirmation-disabled','player-fallback-choice'
  )),
  state TEXT NOT NULL CHECK(state IN ('issued','consumed','expired')),
  issued_at_ms INTEGER NOT NULL CHECK(issued_at_ms >= 0),
  consumed_attempt_id TEXT UNIQUE REFERENCES provider_attempts(attempt_id),
  consumed_at_ms INTEGER,
  CHECK(
    (state = 'issued' AND consumed_attempt_id IS NULL AND consumed_at_ms IS NULL)
    OR (
      state = 'consumed'
      AND consumed_attempt_id IS NOT NULL
      AND consumed_at_ms IS NOT NULL
      AND consumed_at_ms >= issued_at_ms
    )
    OR (state = 'expired' AND consumed_attempt_id IS NULL AND consumed_at_ms IS NULL)
  )
);

CREATE UNIQUE INDEX provider_send_grants_one_issued_sequence
ON provider_send_grants(save_id, job_id, attempt_sequence)
WHERE state = 'issued';
```

On first initialization only, the control database seeds exactly one preferences row at revision 0 with daily ceiling `10`, `require_send_confirmation=1`, `allow_automatic_1k_fallback=0` and the current effective UTC day. Bootstrap takes an app-root lock and inspects save storage versions: a missing control DB may be created only when there is no save or every existing save is pre-v7. It is built as an app-owned partial, validated, fsynced, atomically renamed and directory-fsynced before any save migrates/publishes to v7. If any v7/unreadable save exists while control is missing, or if an initialized DB has a missing/invalid singleton or failed integrity/schema validation, provider sends fail closed with a stable repair error; state is never silently reset. A crash before publish leaves only a removable owned partial and pre-v7 saves; a crash after publish finds the durable control DB. Creating/importing a save does not create another budget. `attempt_count` is derived from the application-wide ledger rather than cached in a job row.

Migration rules:

1. Inspect the database before mutating it.
2. Set and validate a fixed SQLite `application_id`; use `PRAGMA user_version=7` as the storage version while `schema_migrations` remains an audit log. Game `schemaVersion` remains separate.
3. For an existing database below the current version, obtain a per-save OS file lock and create a consistent SQLite Online Backup plus referenced assets under `pre-upgrade/`.
4. Clone that backup to `upgrade.partial.sqlite3`; never migrate the player's only active database in place.
5. Run all pending migrations and version records on the clone, then run `foreign_key_check`, `integrity_check`, the normal game validator, asset validation and strict schema-object validation.
6. Close and sync the clone and directory, write an upgrade journal, atomically switch databases only while no WAL/SHM connection is active, sync the directory, reopen and validate, then clear the journal.
7. Any migration, validation or failpoint failure discards only owned partial material; the original database remains byte-identical. Startup completes or rolls back an interrupted switch to an exact old-or-new database.
8. Opening the same current database repeatedly is idempotent and creates no extra migration backup.

The migrations also create indexes for job status/lease scans, per-save job history, application-wide quota-day attempt counts, asset-reference roots, recovery rotation and intent reconciliation. Every legal job transition compare-and-sets and increments monotonic `job_revision`; `updated_at_ms` is display/audit data, never a concurrency token. Constraint fixtures include explicit NULL timestamp/outcome attacks because SQLite CHECK expressions must never succeed through three-valued NULL logic. Native open/migrate/restore validation checks row constraints plus cross-database job/attempt consistency; any illegal lease, retry, timestamp or ledger transition blocks sending rather than being repaired into an automatic retry.

New saves receive a default name derived from local creation order, such as `云岫酒店 1`. Names are NFC-normalized, contain 1-40 grapheme clusters after trimming, exclude control characters, may duplicate, and are stored only as display data; paths continue to use validated save IDs. Backend UUIDs are required only for newly created and imported saves. Existing validated IDs such as the real Phase 4 `save-1` remain permanently loadable without a risky directory re-key migration.

## 6. Save catalog and recovery points

Loading, listing and creating are separate. `load_game` opens only an existing database; an unknown ID returns Not Found without creating a directory. Internal save IDs are bounded backend-generated UUIDs, while names are display data only.

`SaveRepository` is split behind catalog, recovery, archive and asset ports and gains:

- `list_saves()`
- `create_save(display_name)`
- `rename_save(save_id, display_name)`
- `delete_save` is deliberately deferred because deletion needs a separate player-confirmed design.
- `list_recovery_points(save_id)`
- `restore_recovery_point(save_id, recovery_id)`

The catalog is produced by scanning validated directories and reading each database's `save_metadata`; there is no second catalog database that could diverge from a save.

All writes for one save pass through a single `WriteCoordinator` and per-save lock. Construction, settlement and visual-adoption commits carry an explicit recovery reason; queue status, metadata, pricing and checkpoints do not consume the 20 meaningful points. A critical commit uses an immutable pre-image outbox:

- while holding the write lock, snapshot the exact current revision `r-1` with SQLite Online Backup, then query that frozen backup—not the subsequently mutable active database—for the exact referenced asset set and hard-link/copy and verify those assets into a hidden same-volume package;
- record `restore_revision=r-1`, package hash/path and the intended `origin_commit_revision=r`; sync the database, assets, manifest and directories before the game transaction. `package_sha256` is the SHA-256 of a deterministic aggregate stream sorted by normalized payload path, with each record encoded as `path NUL sha256 NUL byte_length LF`; `manifest_sha256` hashes the exact manifest bytes;
- the transaction commits revision `r` and its outbox row together; transaction failure leaves only an unreferenced hidden package that startup may quarantine after a grace period;
- after a successful transaction, promote that already immutable package to `ready` without rereading the mutable active database; crash recovery performs the same idempotent promotion;
- a hidden package never appears to the player and never counts toward 20; rotation runs only after promotion, so a failed commit or duplicate replay cannot evict a valid older point;
- only `ready` automatic points count toward the newest 20; upgrade and pre-restore backups are separate;
- restore pauses queue work and new writes and takes the per-save lock. Before validating or transforming the requested candidate, it creates, verifies and fsyncs a protected pre-restore package of the current database plus the asset set selected from that frozen database; any failure aborts restore without changing active state;
- restore then closes connections and validates the candidate. It clones the active database to staging, replaces only authoritative game tables/state and the required asset references from the recovery, preserves current save metadata, recovery catalog, runtime session and generation-job ambiguity control state, and leaves provider preferences, attempts and quota usage untouched, then assigns `currentRevision + 1`;
- before swap, restore enumerates referenced assets from the recovered database, verifies each recovery-package file against path/hash/MIME/size/dimensions, hard-links or copies it into same-volume active content-addressed staging, fsyncs it and publishes it to the active asset tree; the database cannot be swapped while any referenced active file is absent or invalid;
- under the exclusive send/restore permit, restore first idempotently expires every incompatible `issued` grant for the save in provider-control, then increments `runtime_session.coordinator_epoch`, revokes every old lease and stores the new epoch on future claims. Expiring grants before changing job revisions is deliberately conservative: a crash between the two databases can require reconfirmation but can never preserve a stale authorization. Provider completion, asset staging and job transitions require an epoch/status/fingerprint compare-and-set, so an in-flight pre-restore worker cannot publish into restored state. A stale worker may only record the bounded outcome of its already-sent attempt, then must discard the response body;
- restore rebuilds authoritative asset references from the recovered game state. Jobs with a sent/unknown attempt remain `needs-retry-confirmation`; other non-terminal jobs become `needs-player-confirmation`; adopted or reviewable jobs whose target fingerprint/asset is no longer referenced become `superseded`. No restored job may issue network traffic until the player explicitly reopens or confirms it;
- the sanitized restore clone is fully validated, synced and swapped without stale WAL/SHM files; only an unreadable active database may be quarantined and rebuilt from a full verified point;
- asset garbage-collection roots are the active database, all retained/pre-upgrade recovery databases and every non-terminal job/staging record; scan failure deletes nothing, and candidates are quarantined before delayed removal;
- recovery IDs are opaque values returned by Rust, not arbitrary paths.

Crash tests terminate a helper process at deterministic failpoints: staging write, recovery backup, transaction body, transaction commit, asset rename and post-commit cleanup. Restore adds failpoints after the pre-restore package becomes durable, during candidate transformation, immediately before/after swap and before reopen validation. Reopen must yield either the exact old revision or exact new revision, and a failed restore must leave its verified pre-restore package usable.

Retention is explicit: rotate only the 20 ready automatic points. Pre-upgrade, pre-restore, imported saves, quarantined active databases and other player backups are never automatically deleted; duplicate source hashes are reused, and storage pressure asks for a separate player-approved cleanup flow. Failed/pending orphan packages and asset staging material may be removed after 7 days only when absent from the outbox, leases and complete GC root scan. The 30-day/2-GiB oldest-first quarantine cap applies only to app-owned temporary/orphan asset bytes proven unrelated to any save or backup. Cleanup failure is non-destructive and visible in diagnostics.

## 7. Transactional asset store

The native asset pipeline is:

1. Create an app-owned staging directory with an unguessable operation ID.
2. Stream/decode into a new temporary file with a hard byte limit.
3. Detect MIME from bytes; accept JPEG, PNG and WebP only.
4. Decode image dimensions and reject malformed or oversized images.
5. Compute SHA-256 from the exact Base64-decoded PNG/JPEG/WebP file bytes that will be stored, not from a pixel buffer.
6. Sync the file and transactionally put the job in `staging-asset` with only app-owned temporary/final metadata.
7. Atomically rename to `assets/sha256/<prefix>/<sha256>.<ext>` and sync the directory. Existing identical content is reused.
8. Insert the asset row and move the job to `ready-for-review` with an idempotent terminal compare-and-set.
9. Return only `assetId`, MIME, dimensions, size, hash and an opaque `cloudinn-asset://<asset-id>` resolver URL to the application layer.
10. Background completion never mutates GameState. Adoption validates `expectedRevision` and the target design fingerprint, then attaches `assetId` atomically; a changed design makes the job `superseded`.

Startup completes or rolls back every `staging-asset` record. If the final hash is valid it completes the database step; if only the temp file exists it finishes the rename; corrupt material is quarantined. A crash after success but before the IPC response is safe to retry by job ID/request fingerprint. Missing referenced files never crash the UI: the asset is marked missing, a placeholder is shown, and diagnostics offer recovery/import guidance.

`cloudinn-asset` is a native read-only protocol, not Tauri's broad filesystem asset protocol. It accepts one validated opaque asset ID, resolves it through the currently owning save's asset registry, confirms the content-addressed relative path and file hash, applies the stored byte/MIME limit and returns immutable bytes. It accepts no filesystem path, query override or cross-save lookup. The production CSP permits this scheme only in `img-src`; `connect-src` never includes the provider origin because all provider traffic stays in Rust.

Initial limits are resolution-aware and must be frozen against controlled real-provider samples before final acceptance:

- prompt: 12,000 UTF-8 characters;
- at most four reference images;
- each reference image: 32 MiB;
- 1K response/decoded: 24/16 MiB;
- 2K response/decoded: 64/48 MiB;
- 4K response/decoded: 128/96 MiB;
- response limits apply to the decompressed stream before full JSON parsing; Base64 characters, decoded bytes, candidates, parts, dimensions and total pixels are independently bounded;
- archive: 2 GiB total, 10,000 entries, 64 MiB manifest, with per-entry declared and streamed limits.

## 8. `.cloudinn` archive

`.cloudinn` is a ZIP container with normalized forward-slash paths:

```text
manifest.json
save/save.sqlite3
assets/sha256/<hash-prefix>/<sha256>.<ext>
```

Manifest version 1 contains:

- archive format version;
- application version;
- database schema/ruleset versions;
- source save ID and display name;
- creation timestamp;
- every payload entry's relative path, SHA-256 and byte length;
- referenced asset metadata.

The manifest lists and hashes payload entries only; it never lists or hashes itself. The finished ZIP receives a separate whole-file SHA-256 for diagnostics and transfer verification, not as an authenticity claim.

Export:

- checkpoint WAL and create a consistent database snapshot;
- hold a per-save export read lease from snapshot creation through referenced-asset hashing and archive completion; GC, restore and conflicting publish operations cannot run during that lease;
- derive a portable database clone that retains authoritative hotel and adopted-asset data but removes recovery catalog rows, runtime sessions, leases, staging paths, retry timers and other machine-local control-plane state;
- strip non-terminal/unadopted generation work and machine-local queue state; adopted provenance may remain without credentials or responses. The separate provider-control database is never part of a save snapshot or archive;
- query the frozen portable clone—not the active database after snapshot—for the exact asset set, and include only those referenced assets;
- write to a temporary sibling file, validate the finished archive, sync, then atomically rename;
- never include recovery points, logs, Keychain material, provider responses or unreferenced staging files.

Import is two-stage: `inspect_import` copies the selected archive into app-owned immutable staging while hashing, fully validates that exact copy and returns an opaque short-lived token. The token is single-use, bound to the current native session, staged package path and SHA-256, and expires after 15 minutes. `import_save` consumes the same staged bytes and an optional display name; it never reopens the player-selected source path.

Import:

- preflight free space using the archive's bounded declared sizes plus safety margin;
- admit only `manifest.json`, `save/save.sqlite3` and lowercase content-addressed asset paths; reject absolute/backslash/NUL/Unicode paths, `..`, directories, symlinks, duplicates/case collisions, unsupported compression, encrypted entries, ZIP64 overflow and extra undeclared files;
- bound compressed bytes, per-entry/cumulative decompressed bytes, compression ratio, entries and parse work before extraction;
- stream into an app-owned staging directory while hashing; consumption rechecks the staged package hash and invalidates the token before publish;
- open the untrusted database read-only with `trusted_schema=OFF`, extensions disabled and an exact allowed table/index/object set; validate integrity, schema compatibility, game state and the exact asset set;
- allocate a fresh save ID, then in one staging transaction re-key only enumerated relational columns and known JSON `$.saveId` fields—never arbitrary string replacement—and set the disambiguated display name;
- strip imported recovery/runtime/lease/staging state and reject unexpected provider-control tables. Any compatible archive containing non-terminal queue work is converted to `needs-player-confirmation`; sent/ambiguous work becomes `needs-retry-confirmation`, and no imported job automatically sends a request;
- assert after re-key that no structured save-ID reference contains the source ID, while unrelated player text that happens to contain it remains byte-identical;
- repeat foreign-key, normal game and asset validation, close/sync, then publish with rename-no-replace;
- never overwrite or merge with an existing save.

## 9. Keychain and redaction

Keychain service is derived from the bundle identifier, for example `com.cloudinn.game.api-nebula`; development and Phase 5 smoke bundles use isolated service/account values and must prove production entries are unchanged.
Account: `nanobanana`

Native commands:

- `provider_token_status() -> { state: 'missing' | 'available' | 'locked' | 'denied' | 'unavailable' }`
- `set_provider_token(token) -> status`
- `delete_provider_token()`
- `check_provider() -> ProviderHealth`

There is intentionally no command that returns the token. The setup page uses an uncontrolled password field; its value exists for one capability-allowlisted invoke, is cleared immediately, and is never copied into React state/context, game state, localStorage or diagnostic state. Native secret wrappers do not expose sensitive `Debug`/`Display`; the panic hook and redactor are installed before commands run.

`set_provider_token` accepts 1-4096 UTF-8 bytes, rejects NUL/control characters and leading/trailing whitespace, and performs no trimming or Unicode normalization that could change the secret. Oversize/invalid errors and tests report only a stable code and never echo the value or its prefix.

The Keychain item uses after-first-unlock, this-device-only accessibility. `missing` means setup is absent, `available` means a credential can be used without revealing it, and `locked`/`denied`/`unavailable` are distinct stable blocked reasons and error codes. None downgrades to a plaintext fallback.

The redactor runs before every log sink and error serialization. It removes:

- authorization headers and Bearer tokens;
- known credential assignments and private-key blocks;
- Base64/data URI payloads;
- provider response bodies;
- player prompt text from default diagnostics.

Tests place sentinel secrets in every error/header/request field and scan databases, archives, logs, rendered diagnostics and panic output. Any sentinel match fails the gate.

## 10. Durable AI generation queue

Jobs use these states:

```text
queued
blocked-no-credential
waiting-network
checking-model
running-primary
retry-delay
running-fallback
staging-asset
ready-for-review
adopted
needs-retry-confirmation
needs-player-confirmation
superseded
failed-retryable
failed-terminal
cancelled
```

Workers claim jobs with expiring leases. Startup may requeue only work proven not to have sent a billable request. A crash after send but before a confirmable response becomes `needs-retry-confirmation` because the provider has no confirmed idempotency key. Ready/adopted jobs require both an asset row and a matching file hash; otherwise they enter a stable repair/failed state.

Transient retry delay is durable in the generic `retry-delay` state with `next_attempt_at_ms`; `selected_model` plus the last attempt row fixes whether the due attempt resumes the primary or fallback model. Scheduling, model selection and the state transition commit together. Workers compare the deadline against `effective_now_ms = max(wall_now_ms, runtime_session.last_observed_wall_ms)` and advance `last_observed_wall_ms` transactionally, so clock rollback cannot accelerate a paid retry; sleep/wake may make it immediately due. Only an existing proven-unsent reservation from the current effective quota day may be reused when the deadline expires.

Every potentially billable HTTP attempt—primary, retry or fallback—uses one single-use durable send grant and a durable two-step ledger. A grant authorizes exactly the next attempt sequence for one save/job revision, model, request fingerprint and effective quota day; it never authorizes the whole retry/fallback chain. `confirm_visual_send` issues one `player-confirmed` grant. When confirmation is disabled, native policy may issue one `confirmation-disabled` grant for the next eligible attempt; automatic-fallback opt-in only permits compatible fallback selection and never broadens a grant. Choosing fallback issues one `player-fallback-choice` grant for that exact compatible 1K attempt. Every later retry or fallback needs its own next-sequence grant.

Before building/sending the request, one application-wide control transaction validates the unconsumed grant, checks the ceiling, inserts the matching `provider_attempts` reservation and marks the grant consumed with that attempt ID. A crash after grant consumption but before send leaves one reusable proven-unsent reservation and cannot consume the authorization twice. For the last gate before I/O, the worker acquires an epoch-scoped shared send permit, then compares the current coordinator epoch, job lease epoch/status/fingerprint and reservation state. The control transaction also requires `reservation.quota_day` to equal the current effective day before changing the attempt to `sent`; it holds the permit until the request is handed to the transport. Restore requires the exclusive form of the same permit before bumping the epoch, so it either observes an already handed-off `sent` attempt or prevents the stale worker from sending—there is no reserve-before-restore/send-after-restore gap.

A crash while still `reserved` is proven unsent and may reuse that reservation only on the same effective day. Across a day boundary it becomes the terminal `expired-unsent` state with no fabricated `sent_at_ms`; any still-issued old-day grant becomes `expired`, and the player/policy must issue a new-day grant before a new reservation. The old reservation is not refunded. Any crash from `sent` is billing-ambiguous and requires a new explicit retry confirmation, never reuse of the consumed grant. State transitions fill their constrained timestamps and bounded outcome code but never delete the row. Every attempt row counts against its recorded day and is never refunded by cancellation or failure.

Quota days are UTC day indexes. The effective day is `max(floor(now_ms / 86_400_000), provider_preferences.last_quota_day)`, so wall-clock rollback cannot reset allowance. Advancing the stored day and reserving the attempt are one transaction. Used count is `COUNT(*)` for the effective `quota_day` across every attempt state—reserved, sent, known/unknown outcomes and expired-unsent—so completion, ambiguity, expiration, cancellation and failure never refund allowance. The UI shows the effective day, used count and ceiling before confirmation; changing the ceiling never erases the append-only ledger.

Typed reliability commands are the only application boundary for visual jobs:

- `enqueue_visual_job(saveId, request, expectedRevision, targetFingerprint)`
- `list_visual_jobs(saveId)`
- `retry_visual_job(saveId, jobId)`
- `choose_visual_fallback(saveId, jobId, expectedJobRevision, 'compatible-1k')`
- `cancel_visual_job(saveId, jobId)`
- `confirm_visual_send(saveId, jobId, expectedJobRevision)`
- `confirm_visual_adoption(saveId, jobId, expectedRevision, targetFingerprint)`
- `get_provider_preferences()` / `update_provider_preferences(expectedRevision, writablePreferences)`

`ReliabilityPort`, Tauri and deterministic browser/fake adapters share the single `JobStatus` union from the Phase 5 reliability contracts. Browser behavior never performs live provider calls or claims native durability.

The writable preferences DTO contains only `dailyRequestCeiling`, `requireSendConfirmation` and `allowAutomatic1kFallback`. `last_quota_day`, ledger usage, timestamps and revision are read-only native projections. Update uses the monotonic `preferences_revision` for compare-and-set, increments it in the control transaction and preserves/advances `last_quota_day`; wall-clock `updated_at_ms` is never used as a concurrency token.

Fallback choice is a narrow enum, never an arbitrary model string. Native transition validation requires a compatible 1K request, current job revision/status, explicit extra-call confirmation and available application-wide quota before it selects the recorded fallback model; 2K/4K requests are rejected without mutation.

Cancel, supersede, request replacement and restore expire incompatible `issued` grants before their save-DB transition while holding the appropriate exclusive permit. Cross-database startup validation requires every remaining issued grant to match the current job revision, next sequence, selected model and request fingerprint; mismatch blocks sends and is resolved only by idempotent expiry, never by rebinding the grant.

Provider behavior:

- group: API Nebula `nanobanana`;
- endpoint: `https://img-api.apinebula.ai`;
- primary: `gemini-3.1-flash-image`;
- fallback: `gemini-2.5-flash-image`;
- query `GET /v1/models` before first generation, cache health for at most 15 minutes, and invalidate on a model-not-found response;
- use `POST /v1beta/models/{model}:generateContent`;
- default review image is 1K;
- 2K/4K requires the primary or another explicitly compatible model and never silently falls back to 1K;
- use a fixed HTTPS origin and never forward authorization across an origin-changing redirect;
- retry only classified transient failures at most three attempts with capped `Retry-After`; an ambiguous in-flight failure requires player confirmation;
- authentication, invalid request, safety rejection and malformed image are terminal until player action;
- network absence moves the job to `waiting-network` without changing the blueprint or hotel;
- fallback is used only when the primary is unavailable and the requested resolution is supported;
- settings include a player-chosen daily request ceiling and generate-before-send confirmation. Automatic 1K fallback is disabled by default; enabling it is an explicit preference because it may create another paid call and changes the recorded actual model;
- raw Base64 is stream-decoded to native staging and never persisted in SQLite, GameState or logs;
- the real AI queue is independent of the serialized `GameProvider` mutation queue, so generation cannot block gameplay;
- focus jobs may be created only after the player adopts their master image and reference that asset ID/hash.

The official API Nebula model list remains runtime-authoritative because upstream availability may change.

## 11. UI and player language

### First run

- Create or select a named save.
- Explain that AI setup is optional and offline play remains complete.
- Offer token setup through an uncontrolled password field without displaying an existing token.
- Run provider health check only after token setup or explicit player action.

### Save manager

- list name, last played time, day, room count, schema health and recovery availability;
- create and rename saves;
- export, import and open recovery history;
- no delete action in Version 1 Phase 5.

### Design studio

- show durable queue states and selected model;
- retry, cancel and explicitly choose fallback where compatible;
- explain that failed generation did not affect money, blueprint or operations;
- show missing-asset placeholder with recovery guidance.

### Diagnostics

Player message format:

1. what happened;
2. what remains safe;
3. what the player can do next;
4. optional stable error code and copyable redacted details.

Diagnostics show app/schema versions, database integrity result, recovery count, queue counts, provider reachability and recent redacted error codes. They never show tokens, prompts, response bodies or full local paths. Diagnostic files have fixed per-file size, file-count and retention-age limits.

## 12. macOS shell and release readiness

- Use standard Application, File, Edit, View, Window and Help menus.
- File menu exposes new/open/rename/import/export/recovery actions.
- Persist only safe window size and position; clamp restored windows to an attached display.
- Confirm min-size and full-screen behavior at 1100×720 through 1440×900.
- Replace `csp: null` with a restrictive production CSP that permits self/app assets plus `cloudinn-asset:` only in `img-src`; no provider origin appears in `connect-src` because provider HTTP is native.
- Verify all icon sizes and the `.icns` bundle visually.
- Keep network and Keychain capabilities in native Rust; WKWebView receives no broad outbound network permission.
- Production builds disable devtools and raw console-error forwarding.
- Intercept native close/quit, pause new game commands, flush the current command/checkpoint, mark a clean session and then acknowledge close. SIGKILL and power-loss recovery still rely on WAL, journals and startup replay rather than this handshake.
- Produce a readiness record for bundle ID, versioning, entitlements, hardened runtime, Developer ID, notarization, stapling and update strategy.
- Do not sign, notarize or publish without a separate release decision.

## 13. Verification gates

Automated:

- TypeScript typecheck and full Vitest.
- Rust unit/integration tests, Clippy `-D warnings`, format and migration fixtures.
- Archive fuzz/path traversal/size/hash tests.
- Secret sentinel scan.
- Playwright first-run, save manager, import/export, queue/offline, missing-asset and diagnostics scenarios.
- Deterministic 30-day maximum hotel replay plus accelerated thousands-of-commits soak.
- Native helper failpoint crash matrix.

Current-Mac:

- import a real Phase 4 final database and migrate/reopen;
- generate or fixture a real image through the native asset pipeline;
- force-close during write and restore;
- export, import under a new ID, and compare authoritative state and asset hashes;
- run at least two continuous hours with the maximum hotel fixture;
- sleep/wake, offline/online transition and missing-asset recovery;
- build App and DMG from an exact commit, record paths, hashes, RSS and OS/architecture;
- assess signing/notarization readiness accurately.

## 14. Acceptance

Phase 5 is accepted only with:

- zero Critical or Important findings from independent specification and whole-diff reviews;
- no unresolved save corruption, secret exposure or archive traversal finding;
- all automated and current-Mac gates recorded against exact commits;
- the feature branch fast-forward merged into `main`;
- user-owned files preserved;
- cleanup of worktrees or branches performed only with explicit deletion approval.
