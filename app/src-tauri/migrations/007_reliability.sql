CREATE TABLE IF NOT EXISTS save_metadata (
  save_id TEXT PRIMARY KEY REFERENCES saves(save_id) ON DELETE CASCADE,
  display_name TEXT NOT NULL
    CHECK(length(CAST(display_name AS BLOB)) BETWEEN 1 AND 1024)
    CHECK(display_name = trim(display_name))
    CHECK(instr(display_name, char(0)) = 0),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  renamed_at_ms INTEGER NOT NULL CHECK(renamed_at_ms >= created_at_ms),
  metadata_revision INTEGER NOT NULL DEFAULT 0 CHECK(metadata_revision >= 0)
);

CREATE TABLE IF NOT EXISTS assets (
  asset_id TEXT PRIMARY KEY
    CHECK(length(asset_id) BETWEEN 1 AND 128)
    CHECK(asset_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  relative_path TEXT NOT NULL UNIQUE
    CHECK(length(CAST(relative_path AS BLOB)) BETWEEN 1 AND 1024)
    CHECK(relative_path NOT LIKE '/%')
    CHECK(relative_path NOT LIKE '%\%')
    CHECK(relative_path NOT LIKE '%..%')
    CHECK(instr(relative_path, char(0)) = 0),
  sha256 TEXT NOT NULL UNIQUE
    CHECK(length(sha256) = 64 AND sha256 NOT GLOB '*[^0-9a-f]*'),
  mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/webp')),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 100663296),
  width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 16384),
  height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 16384),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0)
);

CREATE TABLE IF NOT EXISTS asset_references (
  owner_kind TEXT NOT NULL
    CHECK(length(owner_kind) BETWEEN 1 AND 64)
    CHECK(owner_kind NOT GLOB '*[^a-z-]*'),
  owner_id TEXT NOT NULL CHECK(length(owner_id) BETWEEN 1 AND 256),
  asset_id TEXT NOT NULL REFERENCES assets(asset_id) ON DELETE RESTRICT,
  PRIMARY KEY(owner_kind, owner_id, asset_id)
);

CREATE TABLE IF NOT EXISTS generation_jobs (
  job_id TEXT PRIMARY KEY
    CHECK(length(job_id) BETWEEN 1 AND 128)
    CHECK(job_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  save_id TEXT NOT NULL REFERENCES saves(save_id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL CHECK(target_kind IN ('master','focus')),
  target_fingerprint TEXT NOT NULL CHECK(length(target_fingerprint) BETWEEN 1 AND 256),
  request_fingerprint TEXT NOT NULL CHECK(
    length(request_fingerprint) = 64
    AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
  ),
  job_revision INTEGER NOT NULL DEFAULT 0 CHECK(job_revision >= 0),
  request_json TEXT NOT NULL CHECK(
    json_valid(request_json)
    AND json_type(request_json) = 'object'
    AND length(CAST(request_json AS BLOB)) BETWEEN 2 AND 262144
  ),
  status TEXT NOT NULL CHECK(status IN (
    'queued','blocked-no-credential','waiting-network','checking-model',
    'running-primary','retry-delay','running-fallback','staging-asset',
    'ready-for-review','adopted','needs-retry-confirmation',
    'needs-player-confirmation','superseded',
    'failed-retryable','failed-terminal','cancelled'
  )),
  selected_model TEXT CHECK(
    selected_model IS NULL OR length(selected_model) BETWEEN 1 AND 128
  ),
  next_attempt_at_ms INTEGER CHECK(
    next_attempt_at_ms IS NULL OR next_attempt_at_ms >= 0
  ),
  lease_owner TEXT CHECK(lease_owner IS NULL OR length(lease_owner) BETWEEN 1 AND 128),
  lease_until_ms INTEGER CHECK(lease_until_ms IS NULL OR lease_until_ms >= 0),
  lease_epoch INTEGER NOT NULL DEFAULT 0 CHECK(lease_epoch >= 0),
  asset_id TEXT REFERENCES assets(asset_id) ON DELETE RESTRICT,
  error_code TEXT CHECK(error_code IS NULL OR length(error_code) BETWEEN 1 AND 128),
  response_ambiguous INTEGER NOT NULL DEFAULT 0 CHECK(response_ambiguous IN (0,1)),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= created_at_ms),
  CHECK(
    (status = 'retry-delay' AND next_attempt_at_ms IS NOT NULL)
    OR (status <> 'retry-delay' AND next_attempt_at_ms IS NULL)
  ),
  CHECK(
    (
      status IN ('checking-model','running-primary','running-fallback','staging-asset')
      AND lease_owner IS NOT NULL
      AND lease_until_ms IS NOT NULL
    )
    OR (
      status NOT IN ('checking-model','running-primary','running-fallback','staging-asset')
      AND lease_owner IS NULL
      AND lease_until_ms IS NULL
    )
  ),
  CHECK(
    status NOT IN ('ready-for-review','adopted')
    OR asset_id IS NOT NULL
  ),
  CHECK(
    response_ambiguous = 0
    OR status IN ('needs-retry-confirmation','needs-player-confirmation','failed-terminal')
  )
);

CREATE TABLE IF NOT EXISTS asset_write_intents (
  job_id TEXT PRIMARY KEY REFERENCES generation_jobs(job_id) ON DELETE CASCADE,
  operation_id TEXT NOT NULL UNIQUE
    CHECK(length(operation_id) BETWEEN 1 AND 128)
    CHECK(operation_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  temp_relative_path TEXT NOT NULL
    CHECK(length(CAST(temp_relative_path AS BLOB)) BETWEEN 1 AND 1024)
    CHECK(temp_relative_path NOT LIKE '/%')
    CHECK(temp_relative_path NOT LIKE '%\%')
    CHECK(temp_relative_path NOT LIKE '%..%')
    CHECK(instr(temp_relative_path, char(0)) = 0),
  final_relative_path TEXT NOT NULL
    CHECK(length(CAST(final_relative_path AS BLOB)) BETWEEN 1 AND 1024)
    CHECK(final_relative_path NOT LIKE '/%')
    CHECK(final_relative_path NOT LIKE '%\%')
    CHECK(final_relative_path NOT LIKE '%..%')
    CHECK(instr(final_relative_path, char(0)) = 0),
  expected_sha256 TEXT NOT NULL CHECK(
    length(expected_sha256) = 64
    AND expected_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  mime_type TEXT NOT NULL CHECK(mime_type IN ('image/png','image/jpeg','image/webp')),
  byte_length INTEGER NOT NULL CHECK(byte_length BETWEEN 1 AND 100663296),
  width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 16384),
  height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 16384),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0)
);

CREATE TABLE IF NOT EXISTS recovery_points (
  recovery_id TEXT PRIMARY KEY
    CHECK(length(recovery_id) BETWEEN 1 AND 128)
    CHECK(recovery_id NOT GLOB '*[^A-Za-z0-9_-]*'),
  kind TEXT NOT NULL CHECK(kind IN ('automatic','pre-upgrade','pre-restore')),
  origin_commit_revision INTEGER CHECK(
    origin_commit_revision IS NULL OR origin_commit_revision >= 0
  ),
  restore_revision INTEGER NOT NULL CHECK(restore_revision >= 0),
  reason TEXT NOT NULL CHECK(length(CAST(reason AS BLOB)) BETWEEN 1 AND 512),
  status TEXT NOT NULL CHECK(status IN ('pending','ready','failed')),
  relative_path TEXT NOT NULL
    CHECK(length(CAST(relative_path AS BLOB)) BETWEEN 1 AND 1024)
    CHECK(relative_path NOT LIKE '/%')
    CHECK(relative_path NOT LIKE '%\%')
    CHECK(relative_path NOT LIKE '%..%')
    CHECK(instr(relative_path, char(0)) = 0),
  package_sha256 TEXT NOT NULL CHECK(
    length(package_sha256) = 64
    AND package_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  manifest_sha256 TEXT CHECK(
    manifest_sha256 IS NULL OR (
      length(manifest_sha256) = 64
      AND manifest_sha256 NOT GLOB '*[^0-9a-f]*'
    )
  ),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms >= 0),
  CHECK(
    (kind = 'automatic' AND origin_commit_revision IS NOT NULL)
    OR kind IN ('pre-upgrade','pre-restore')
  )
);

CREATE TABLE IF NOT EXISTS runtime_session (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  session_id TEXT NOT NULL CHECK(length(session_id) BETWEEN 1 AND 128),
  clean_shutdown INTEGER NOT NULL CHECK(clean_shutdown IN (0,1)),
  last_durable_revision INTEGER NOT NULL CHECK(last_durable_revision >= 0),
  coordinator_epoch INTEGER NOT NULL CHECK(coordinator_epoch >= 0),
  last_observed_wall_ms INTEGER NOT NULL CHECK(last_observed_wall_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);

CREATE INDEX IF NOT EXISTS generation_jobs_status_lease
  ON generation_jobs(status, lease_until_ms, lease_epoch);
CREATE INDEX IF NOT EXISTS generation_jobs_save_history
  ON generation_jobs(save_id, created_at_ms DESC, job_id);
CREATE INDEX IF NOT EXISTS asset_references_asset_roots
  ON asset_references(asset_id, owner_kind, owner_id);
CREATE INDEX IF NOT EXISTS recovery_points_rotation
  ON recovery_points(kind, status, created_at_ms DESC, recovery_id);
CREATE INDEX IF NOT EXISTS asset_write_intents_reconcile
  ON asset_write_intents(created_at_ms, operation_id);

INSERT OR IGNORE INTO save_metadata(
  save_id, display_name, created_at_ms, renamed_at_ms, metadata_revision
)
SELECT
  save_id,
  '云岫酒店 1',
  0,
  0,
  0
FROM saves;

INSERT OR IGNORE INTO runtime_session(
  singleton, session_id, clean_shutdown, last_durable_revision,
  coordinator_epoch, last_observed_wall_ms, updated_at_ms
)
SELECT
  1,
  'migration-bootstrap',
  1,
  COALESCE(MAX(revision), 0),
  0,
  0,
  0
FROM saves;
