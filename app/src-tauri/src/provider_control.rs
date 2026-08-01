use crate::redaction::SafeError;
use crate::reliability::{
    lock_app_root, CONTROL_APPLICATION_ID, CONTROL_SCHEMA_VERSION, SAVE_APPLICATION_ID,
    SAVE_SCHEMA_VERSION,
};
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub const PROVIDER_CONTROL_FILENAME: &str = "provider-control.sqlite3";
pub const DEFAULT_DAILY_REQUEST_CEILING: i64 = 10;
pub const UTC_DAY_MS: i64 = 86_400_000;

const PARTIAL_FILENAME_PREFIX: &str = ".provider-control.sqlite3.partial.";

const PROVIDER_PREFERENCES_SQL: &str = r#"
CREATE TABLE provider_preferences (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  preferences_revision INTEGER NOT NULL CHECK(preferences_revision >= 0),
  daily_request_ceiling INTEGER NOT NULL CHECK(daily_request_ceiling BETWEEN 0 AND 100),
  require_send_confirmation INTEGER NOT NULL CHECK(require_send_confirmation IN (0,1)),
  allow_automatic_1k_fallback INTEGER NOT NULL CHECK(allow_automatic_1k_fallback IN (0,1)),
  last_quota_day INTEGER NOT NULL CHECK(last_quota_day >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
)
"#;

const PROVIDER_ATTEMPTS_SQL: &str = r#"
CREATE TABLE provider_attempts (
  attempt_id TEXT PRIMARY KEY CHECK(length(attempt_id) BETWEEN 1 AND 128),
  save_id TEXT NOT NULL CHECK(length(save_id) BETWEEN 1 AND 128),
  job_id TEXT NOT NULL CHECK(length(job_id) BETWEEN 1 AND 128),
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
)
"#;

const PROVIDER_SEND_GRANTS_SQL: &str = r#"
CREATE TABLE provider_send_grants (
  grant_id TEXT PRIMARY KEY CHECK(length(grant_id) BETWEEN 1 AND 128),
  save_id TEXT NOT NULL CHECK(length(save_id) BETWEEN 1 AND 128),
  job_id TEXT NOT NULL CHECK(length(job_id) BETWEEN 1 AND 128),
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
)
"#;

const ISSUED_GRANT_INDEX_SQL: &str = r#"
CREATE UNIQUE INDEX provider_send_grants_one_issued_sequence
ON provider_send_grants(save_id, job_id, attempt_sequence)
WHERE state = 'issued'
"#;

const ATTEMPT_QUOTA_INDEX_SQL: &str = r#"
CREATE INDEX provider_attempts_quota_day
ON provider_attempts(quota_day)
"#;

const ATTEMPT_JOB_INDEX_SQL: &str = r#"
CREATE INDEX provider_attempts_job_history
ON provider_attempts(save_id, job_id, sequence)
"#;

const ISSUED_GRANT_LOOKUP_INDEX_SQL: &str = r#"
CREATE INDEX provider_send_grants_issued_lookup
ON provider_send_grants(save_id, job_id, state)
WHERE state = 'issued'
"#;

pub const PROVIDER_CONTROL_SCHEMA_SQL: &str = r#"
CREATE TABLE provider_preferences (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  preferences_revision INTEGER NOT NULL CHECK(preferences_revision >= 0),
  daily_request_ceiling INTEGER NOT NULL CHECK(daily_request_ceiling BETWEEN 0 AND 100),
  require_send_confirmation INTEGER NOT NULL CHECK(require_send_confirmation IN (0,1)),
  allow_automatic_1k_fallback INTEGER NOT NULL CHECK(allow_automatic_1k_fallback IN (0,1)),
  last_quota_day INTEGER NOT NULL CHECK(last_quota_day >= 0),
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms >= 0)
);

CREATE TABLE provider_attempts (
  attempt_id TEXT PRIMARY KEY CHECK(length(attempt_id) BETWEEN 1 AND 128),
  save_id TEXT NOT NULL CHECK(length(save_id) BETWEEN 1 AND 128),
  job_id TEXT NOT NULL CHECK(length(job_id) BETWEEN 1 AND 128),
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
  grant_id TEXT PRIMARY KEY CHECK(length(grant_id) BETWEEN 1 AND 128),
  save_id TEXT NOT NULL CHECK(length(save_id) BETWEEN 1 AND 128),
  job_id TEXT NOT NULL CHECK(length(job_id) BETWEEN 1 AND 128),
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

CREATE INDEX provider_attempts_quota_day
ON provider_attempts(quota_day);

CREATE INDEX provider_attempts_job_history
ON provider_attempts(save_id, job_id, sequence);

CREATE INDEX provider_send_grants_issued_lookup
ON provider_send_grants(save_id, job_id, state)
WHERE state = 'issued';
"#;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SaveStorageState {
    NoSaves,
    AllPreV7,
    HasV7,
    Unreadable,
}

impl SaveStorageState {
    fn permits_first_initialization(self) -> bool {
        matches!(self, Self::NoSaves | Self::AllPreV7)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderPreferencesProjection {
    pub preferences_revision: i64,
    pub daily_request_ceiling: i64,
    pub require_send_confirmation: bool,
    pub allow_automatic_1k_fallback: bool,
    pub last_quota_day: i64,
    pub effective_quota_day: i64,
    pub used_attempts: i64,
    pub updated_at_ms: i64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WritableProviderPreferences {
    pub daily_request_ceiling: i64,
    pub require_send_confirmation: bool,
    pub allow_automatic_1k_fallback: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProviderControlError {
    Io,
    Database,
    BootstrapForbidden,
    Invalid(&'static str),
}

impl fmt::Display for ProviderControlError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Io => formatter.write_str("provider control storage is unavailable"),
            Self::Database => formatter.write_str("provider control database operation failed"),
            Self::BootstrapForbidden => {
                formatter.write_str("provider control bootstrap is not permitted")
            }
            Self::Invalid(reason) => write!(formatter, "provider control is invalid: {reason}"),
        }
    }
}

impl std::error::Error for ProviderControlError {}

impl From<ProviderControlError> for SafeError {
    fn from(_error: ProviderControlError) -> Self {
        SafeError::new(
            "provider.control-invalid",
            "图片服务计费控制记录无效或不可用",
        )
    }
}

pub struct ProviderControlStore {
    app_root: PathBuf,
}

impl ProviderControlStore {
    pub fn new(app_root: PathBuf) -> Self {
        Self { app_root }
    }

    pub fn path(&self) -> PathBuf {
        self.app_root.join(PROVIDER_CONTROL_FILENAME)
    }

    pub fn bootstrap(&self, now_ms: i64) -> Result<Connection, SafeError> {
        let quota_day = utc_day_index_inner(now_ms).map_err(SafeError::from)?;
        let _lock = lock_app_root(&self.app_root)?;
        self.bootstrap_locked(quota_day, now_ms, || Ok(()))
            .map_err(SafeError::from)
    }

    fn bootstrap_locked<F>(
        &self,
        quota_day: i64,
        now_ms: i64,
        before_publish: F,
    ) -> Result<Connection, ProviderControlError>
    where
        F: FnOnce() -> Result<(), ProviderControlError>,
    {
        let final_path = self.path();

        if final_path.exists() {
            return open_validated_path(&final_path);
        }
        reject_non_regular_existing_path(&final_path)?;
        let save_storage = inspect_save_storage_inner(&self.app_root)?;
        if !save_storage.permits_first_initialization() {
            return Err(ProviderControlError::BootstrapForbidden);
        }

        let partial_path = create_owned_partial(&self.app_root)?;
        let mut partial_guard = PartialGuard::new(partial_path.clone());
        create_partial_database(&partial_path, quota_day, now_ms)?;
        sync_regular_file(&partial_path)?;
        before_publish()?;

        fs::hard_link(&partial_path, &final_path)
            .map_err(|_| ProviderControlError::Invalid("control database publish failed"))?;
        sync_directory(&self.app_root)?;
        partial_guard.remove_owned()?;
        sync_directory(&self.app_root)?;
        open_validated_path(&final_path)
    }

    pub fn open_validated(&self) -> Result<Connection, SafeError> {
        let _lock = lock_app_root(&self.app_root)?;
        open_validated_path(&self.path()).map_err(SafeError::from)
    }

    pub fn get_preferences(&self, now_ms: i64) -> Result<ProviderPreferencesProjection, SafeError> {
        let quota_day = utc_day_index_inner(now_ms).map_err(SafeError::from)?;
        let _lock = lock_app_root(&self.app_root)?;
        let connection = open_validated_path(&self.path()).map_err(SafeError::from)?;
        read_preferences_projection(&connection, quota_day).map_err(SafeError::from)
    }

    pub fn update_preferences(
        &self,
        expected_revision: i64,
        preferences: WritableProviderPreferences,
        now_ms: i64,
    ) -> Result<ProviderPreferencesProjection, SafeError> {
        let quota_day = utc_day_index_inner(now_ms).map_err(SafeError::from)?;
        if expected_revision < 0 || !(0..=100).contains(&preferences.daily_request_ceiling) {
            return Err(ProviderControlError::Invalid("invalid preferences update").into());
        }
        let _lock = lock_app_root(&self.app_root)?;
        let mut connection = open_validated_path(&self.path()).map_err(SafeError::from)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| SafeError::from(ProviderControlError::Database))?;
        let changed = transaction
            .execute(
                "UPDATE provider_preferences
                 SET preferences_revision = preferences_revision + 1,
                     daily_request_ceiling = ?1,
                     require_send_confirmation = ?2,
                     allow_automatic_1k_fallback = ?3,
                     last_quota_day = max(last_quota_day, ?4),
                     updated_at_ms = ?5
                 WHERE singleton = 1 AND preferences_revision = ?6",
                params![
                    preferences.daily_request_ceiling,
                    preferences.require_send_confirmation,
                    preferences.allow_automatic_1k_fallback,
                    quota_day,
                    now_ms,
                    expected_revision,
                ],
            )
            .map_err(|_| SafeError::from(ProviderControlError::Database))?;
        if changed != 1 {
            return Err(ProviderControlError::Invalid("preferences revision is stale").into());
        }
        let projection =
            read_preferences_projection(&transaction, quota_day).map_err(SafeError::from)?;
        transaction
            .commit()
            .map_err(|_| SafeError::from(ProviderControlError::Database))?;
        Ok(projection)
    }
}

pub fn inspect_save_storage(app_root: &Path) -> Result<SaveStorageState, SafeError> {
    inspect_save_storage_inner(app_root).map_err(SafeError::from)
}

pub fn utc_day_index(now_ms: i64) -> Result<i64, SafeError> {
    utc_day_index_inner(now_ms).map_err(SafeError::from)
}

fn read_preferences_projection(
    connection: &Connection,
    wall_quota_day: i64,
) -> Result<ProviderPreferencesProjection, ProviderControlError> {
    let (
        preferences_revision,
        daily_request_ceiling,
        require_send_confirmation,
        allow_automatic_1k_fallback,
        last_quota_day,
        updated_at_ms,
    ) = connection
        .query_row(
            "SELECT preferences_revision,daily_request_ceiling,
                    require_send_confirmation,allow_automatic_1k_fallback,
                    last_quota_day,updated_at_ms
             FROM provider_preferences WHERE singleton=1",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, bool>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            },
        )
        .map_err(|_| ProviderControlError::Database)?;
    let effective_quota_day = wall_quota_day.max(last_quota_day);
    let used_attempts = connection
        .query_row(
            "SELECT count(*) FROM provider_attempts WHERE quota_day=?1",
            [effective_quota_day],
            |row| row.get(0),
        )
        .map_err(|_| ProviderControlError::Database)?;
    Ok(ProviderPreferencesProjection {
        preferences_revision,
        daily_request_ceiling,
        require_send_confirmation,
        allow_automatic_1k_fallback,
        last_quota_day,
        effective_quota_day,
        used_attempts,
        updated_at_ms,
    })
}

fn inspect_save_storage_inner(app_root: &Path) -> Result<SaveStorageState, ProviderControlError> {
    let saves_root = app_root.join("saves");
    let saves_metadata = match fs::symlink_metadata(&saves_root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(SaveStorageState::NoSaves);
        }
        Err(_) => return Ok(SaveStorageState::Unreadable),
    };
    if saves_metadata.file_type().is_symlink() || !saves_metadata.is_dir() {
        return Ok(SaveStorageState::Unreadable);
    }

    let entries = match fs::read_dir(&saves_root) {
        Ok(entries) => entries,
        Err(_) => return Ok(SaveStorageState::Unreadable),
    };
    let mut saw_save = false;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => return Ok(SaveStorageState::Unreadable),
        };
        saw_save = true;
        let save_directory = entry.path();
        let directory_metadata = match fs::symlink_metadata(&save_directory) {
            Ok(metadata) => metadata,
            Err(_) => return Ok(SaveStorageState::Unreadable),
        };
        if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
            return Ok(SaveStorageState::Unreadable);
        }

        let database_path = save_directory.join("save.sqlite3");
        let database_metadata = match fs::symlink_metadata(&database_path) {
            Ok(metadata) => metadata,
            Err(_) => return Ok(SaveStorageState::Unreadable),
        };
        if database_metadata.file_type().is_symlink() || !database_metadata.is_file() {
            return Ok(SaveStorageState::Unreadable);
        }
        let database_uri = match immutable_database_uri(&database_path) {
            Ok(uri) => uri,
            Err(_) => return Ok(SaveStorageState::Unreadable),
        };
        let connection = match Connection::open_with_flags(
            database_uri,
            OpenFlags::SQLITE_OPEN_READ_ONLY
                | OpenFlags::SQLITE_OPEN_NO_MUTEX
                | OpenFlags::SQLITE_OPEN_URI,
        ) {
            Ok(connection) => connection,
            Err(_) => return Ok(SaveStorageState::Unreadable),
        };
        let application_id: i64 =
            match connection.pragma_query_value(None, "application_id", |row| row.get(0)) {
                Ok(value) => value,
                Err(_) => return Ok(SaveStorageState::Unreadable),
            };
        let schema_version: i64 =
            match connection.pragma_query_value(None, "user_version", |row| row.get(0)) {
                Ok(value) => value,
                Err(_) => return Ok(SaveStorageState::Unreadable),
            };
        if application_id == SAVE_APPLICATION_ID && schema_version == SAVE_SCHEMA_VERSION {
            return Ok(SaveStorageState::HasV7);
        }
        if application_id != 0
            || schema_version != 0
            || !has_recognized_legacy_migration_ledger(&connection)
        {
            return Ok(SaveStorageState::Unreadable);
        }
    }

    Ok(if saw_save {
        SaveStorageState::AllPreV7
    } else {
        SaveStorageState::NoSaves
    })
}

fn has_recognized_legacy_migration_ledger(connection: &Connection) -> bool {
    let mut statement = match connection.prepare(
        "SELECT name,type,\"notnull\",pk
         FROM pragma_table_info('schema_migrations')
         ORDER BY cid",
    ) {
        Ok(statement) => statement,
        Err(_) => return false,
    };
    let columns = match statement.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, i64>(2)?,
            row.get::<_, i64>(3)?,
        ))
    }) {
        Ok(rows) => rows.collect::<rusqlite::Result<Vec<_>>>(),
        Err(_) => return false,
    };
    let Ok(columns) = columns else {
        return false;
    };
    if columns
        != [
            ("version".to_string(), "INTEGER".to_string(), 0, 1),
            ("applied_at".to_string(), "TEXT".to_string(), 1, 0),
        ]
    {
        return false;
    }

    let audit = connection.query_row(
        "SELECT count(*),
                COALESCE(min(version),0),
                COALESCE(max(version),0),
                count(DISTINCT version),
                COALESCE(sum(typeof(version) <> 'integer'),0)
         FROM schema_migrations",
        [],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        },
    );
    let Ok((count, minimum, maximum, distinct, non_integer)) = audit else {
        return false;
    };
    (count == 0 && minimum == 0 && maximum == 0)
        || (minimum == 1
            && maximum > 0
            && maximum < SAVE_SCHEMA_VERSION
            && count == maximum
            && distinct == count
            && non_integer == 0)
}

fn utc_day_index_inner(now_ms: i64) -> Result<i64, ProviderControlError> {
    if now_ms < 0 {
        return Err(ProviderControlError::Invalid("clock is before UTC epoch"));
    }
    Ok(now_ms / UTC_DAY_MS)
}

fn create_partial_database(
    path: &Path,
    quota_day: i64,
    now_ms: i64,
) -> Result<(), ProviderControlError> {
    {
        let conn = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| ProviderControlError::Database)?;
        configure_connection(&conn)?;
        conn.pragma_update(None, "journal_mode", "DELETE")
            .map_err(|_| ProviderControlError::Database)?;
        conn.pragma_update(None, "application_id", CONTROL_APPLICATION_ID)
            .map_err(|_| ProviderControlError::Database)?;
        conn.pragma_update(None, "user_version", CONTROL_SCHEMA_VERSION)
            .map_err(|_| ProviderControlError::Database)?;
        conn.execute_batch(PROVIDER_CONTROL_SCHEMA_SQL)
            .map_err(|_| ProviderControlError::Database)?;
        conn.execute(
            "INSERT INTO provider_preferences(
                singleton, preferences_revision, daily_request_ceiling,
                require_send_confirmation, allow_automatic_1k_fallback,
                last_quota_day, updated_at_ms
             ) VALUES(1, 0, ?1, 1, 0, ?2, ?3)",
            params![DEFAULT_DAILY_REQUEST_CEILING, quota_day, now_ms],
        )
        .map_err(|_| ProviderControlError::Database)?;
        validate_connection(&conn)?;
        conn.close().map_err(|_| ProviderControlError::Database)?;
    }
    Ok(())
}

fn open_validated_path(path: &Path) -> Result<Connection, ProviderControlError> {
    validate_existing_read_only(path)?;
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| ProviderControlError::Database)?;
    configure_connection(&conn)?;
    validate_connection(&conn)?;
    Ok(conn)
}

fn validate_existing_read_only(path: &Path) -> Result<(), ProviderControlError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ProviderControlError::Io)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ProviderControlError::Invalid(
            "control database is not a regular file",
        ));
    }
    reject_existing_sidecars(path)?;
    let conn = Connection::open_with_flags(
        immutable_database_uri(path)?,
        OpenFlags::SQLITE_OPEN_READ_ONLY
            | OpenFlags::SQLITE_OPEN_NO_MUTEX
            | OpenFlags::SQLITE_OPEN_URI,
    )
    .map_err(|_| ProviderControlError::Database)?;
    configure_read_only_connection(&conn)?;
    validate_connection(&conn)?;
    conn.close().map_err(|_| ProviderControlError::Database)
}

fn reject_existing_sidecars(path: &Path) -> Result<(), ProviderControlError> {
    for suffix in ["-journal", "-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        match fs::symlink_metadata(PathBuf::from(sidecar)) {
            Ok(_) => {
                return Err(ProviderControlError::Invalid(
                    "control database has an unexpected sidecar",
                ));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(ProviderControlError::Io),
        }
    }
    Ok(())
}

fn immutable_database_uri(path: &Path) -> Result<String, ProviderControlError> {
    let path = path.to_str().ok_or(ProviderControlError::Io)?;
    let mut uri = String::with_capacity(path.len() + 17);
    uri.push_str("file:");
    for byte in path.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b':' | b'-' | b'.' | b'_' | b'~') {
            uri.push(char::from(byte));
        } else {
            const HEX: &[u8; 16] = b"0123456789ABCDEF";
            uri.push('%');
            uri.push(char::from(HEX[usize::from(byte >> 4)]));
            uri.push(char::from(HEX[usize::from(byte & 0x0f)]));
        }
    }
    uri.push_str("?immutable=1");
    Ok(uri)
}

fn configure_connection(conn: &Connection) -> Result<(), ProviderControlError> {
    configure_read_only_connection(conn)?;
    conn.pragma_update(None, "synchronous", "FULL")
        .map_err(|_| ProviderControlError::Database)?;
    Ok(())
}

fn configure_read_only_connection(conn: &Connection) -> Result<(), ProviderControlError> {
    conn.busy_timeout(Duration::from_secs(5))
        .map_err(|_| ProviderControlError::Database)?;
    conn.pragma_update(None, "foreign_keys", "ON")
        .map_err(|_| ProviderControlError::Database)?;
    conn.pragma_update(None, "trusted_schema", "OFF")
        .map_err(|_| ProviderControlError::Database)?;
    Ok(())
}

fn validate_connection(conn: &Connection) -> Result<(), ProviderControlError> {
    let journal_mode: String = conn
        .pragma_query_value(None, "journal_mode", |row| row.get(0))
        .map_err(|_| ProviderControlError::Database)?;
    if journal_mode != "delete" {
        return Err(ProviderControlError::Invalid(
            "unexpected control journal mode",
        ));
    }
    let application_id: i64 = conn
        .pragma_query_value(None, "application_id", |row| row.get(0))
        .map_err(|_| ProviderControlError::Database)?;
    if application_id != CONTROL_APPLICATION_ID {
        return Err(ProviderControlError::Invalid("unexpected application id"));
    }
    let schema_version: i64 = conn
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(|_| ProviderControlError::Database)?;
    if schema_version != CONTROL_SCHEMA_VERSION {
        return Err(ProviderControlError::Invalid(
            "unsupported control schema version",
        ));
    }
    let integrity: String = conn
        .pragma_query_value(None, "integrity_check", |row| row.get(0))
        .map_err(|_| ProviderControlError::Database)?;
    if integrity != "ok" {
        return Err(ProviderControlError::Invalid("integrity check failed"));
    }
    if conn
        .query_row("SELECT 1 FROM pragma_foreign_key_check LIMIT 1", [], |_| {
            Ok(())
        })
        .optional()
        .map_err(|_| ProviderControlError::Database)?
        .is_some()
    {
        return Err(ProviderControlError::Invalid("foreign key check failed"));
    }

    validate_schema_objects(conn)?;
    validate_rows(conn)?;
    Ok(())
}

fn validate_schema_objects(conn: &Connection) -> Result<(), ProviderControlError> {
    let expected = [
        ("table", "provider_preferences", PROVIDER_PREFERENCES_SQL),
        ("table", "provider_attempts", PROVIDER_ATTEMPTS_SQL),
        ("table", "provider_send_grants", PROVIDER_SEND_GRANTS_SQL),
        (
            "index",
            "provider_send_grants_one_issued_sequence",
            ISSUED_GRANT_INDEX_SQL,
        ),
        (
            "index",
            "provider_attempts_quota_day",
            ATTEMPT_QUOTA_INDEX_SQL,
        ),
        (
            "index",
            "provider_attempts_job_history",
            ATTEMPT_JOB_INDEX_SQL,
        ),
        (
            "index",
            "provider_send_grants_issued_lookup",
            ISSUED_GRANT_LOOKUP_INDEX_SQL,
        ),
    ];
    let mut statement = conn
        .prepare(
            "SELECT type, name, sql
             FROM sqlite_schema
             WHERE name NOT LIKE 'sqlite_%'
             ORDER BY type, name",
        )
        .map_err(|_| ProviderControlError::Database)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
            ))
        })
        .map_err(|_| ProviderControlError::Database)?;
    let mut actual = Vec::new();
    for row in rows {
        actual.push(row.map_err(|_| ProviderControlError::Database)?);
    }
    if actual.len() != expected.len() {
        return Err(ProviderControlError::Invalid(
            "unexpected schema object count",
        ));
    }
    for (object_type, name, sql) in expected {
        let Some((_, _, actual_sql)) = actual.iter().find(|(actual_type, actual_name, _)| {
            actual_type == object_type && actual_name == name
        }) else {
            return Err(ProviderControlError::Invalid(
                "required schema object is missing",
            ));
        };
        let Some(actual_sql) = actual_sql else {
            return Err(ProviderControlError::Invalid(
                "required schema definition is missing",
            ));
        };
        if normalize_sql(actual_sql) != normalize_sql(sql) {
            return Err(ProviderControlError::Invalid(
                "schema definition does not match",
            ));
        }
    }
    Ok(())
}

fn validate_rows(conn: &Connection) -> Result<(), ProviderControlError> {
    let preferences_count: i64 = conn
        .query_row(
            "SELECT count(*) FROM provider_preferences WHERE singleton = 1",
            [],
            |row| row.get(0),
        )
        .map_err(|_| ProviderControlError::Database)?;
    if preferences_count != 1 {
        return Err(ProviderControlError::Invalid(
            "preferences singleton is missing",
        ));
    }

    let invalid_attempt: bool = conn
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM provider_attempts
               WHERE state NOT IN (
                 'reserved','sent','outcome-known','outcome-unknown','expired-unsent'
               )
               OR reserved_at_ms < 0
               OR (state = 'reserved' AND (
                 sent_at_ms IS NOT NULL OR completed_at_ms IS NOT NULL OR outcome_code IS NOT NULL
               ))
               OR (state = 'sent' AND (
                 sent_at_ms IS NULL OR sent_at_ms < reserved_at_ms
                 OR completed_at_ms IS NOT NULL OR outcome_code IS NOT NULL
               ))
               OR (state = 'expired-unsent' AND (
                 sent_at_ms IS NOT NULL OR completed_at_ms IS NULL
                 OR completed_at_ms < reserved_at_ms OR outcome_code <> 'expired-unsent'
               ))
               OR (state IN ('outcome-known','outcome-unknown') AND (
                 sent_at_ms IS NULL OR sent_at_ms < reserved_at_ms
                 OR completed_at_ms IS NULL OR completed_at_ms < sent_at_ms
                 OR outcome_code IS NULL
               ))
             )",
            [],
            |row| row.get(0),
        )
        .map_err(|_| ProviderControlError::Database)?;
    if invalid_attempt {
        return Err(ProviderControlError::Invalid(
            "attempt ledger contains an invalid row",
        ));
    }

    let invalid_grant: bool = conn
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM provider_send_grants
               WHERE state NOT IN ('issued','consumed','expired')
               OR (state = 'issued' AND (
                 consumed_attempt_id IS NOT NULL OR consumed_at_ms IS NOT NULL
               ))
               OR (state = 'consumed' AND (
                 consumed_attempt_id IS NULL OR consumed_at_ms IS NULL
                 OR consumed_at_ms < issued_at_ms
               ))
               OR (state = 'expired' AND (
                 consumed_attempt_id IS NOT NULL OR consumed_at_ms IS NOT NULL
               ))
             )",
            [],
            |row| row.get(0),
        )
        .map_err(|_| ProviderControlError::Database)?;
    if invalid_grant {
        return Err(ProviderControlError::Invalid(
            "send grants contain an invalid row",
        ));
    }

    let unmatched_attempt: bool = conn
        .query_row(
            "SELECT EXISTS(
               SELECT 1
               FROM provider_attempts AS attempt
               LEFT JOIN provider_send_grants AS grant
                 ON grant.consumed_attempt_id = attempt.attempt_id
                AND grant.state = 'consumed'
               WHERE grant.grant_id IS NULL
             )",
            [],
            |row| row.get(0),
        )
        .map_err(|_| ProviderControlError::Database)?;
    if unmatched_attempt {
        return Err(ProviderControlError::Invalid(
            "attempt is missing its consumed send grant",
        ));
    }

    let mismatched_consumption: bool = conn
        .query_row(
            "SELECT EXISTS(
               SELECT 1
               FROM provider_send_grants AS grant
               JOIN provider_attempts AS attempt
                 ON attempt.attempt_id = grant.consumed_attempt_id
               WHERE grant.state = 'consumed'
                 AND (
                   grant.save_id <> attempt.save_id
                   OR grant.job_id <> attempt.job_id
                   OR grant.attempt_sequence <> attempt.sequence
                   OR grant.model <> attempt.model
                   OR grant.quota_day <> attempt.quota_day
                 )
             )",
            [],
            |row| row.get(0),
        )
        .map_err(|_| ProviderControlError::Database)?;
    if mismatched_consumption {
        return Err(ProviderControlError::Invalid(
            "send grant does not match its attempt",
        ));
    }
    Ok(())
}

fn normalize_sql(sql: &str) -> String {
    sql.chars()
        .filter(|character| !character.is_whitespace() && *character != ';')
        .flat_map(char::to_lowercase)
        .collect()
}

fn create_owned_partial(root: &Path) -> Result<PathBuf, ProviderControlError> {
    static PARTIAL_SEQUENCE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    for _ in 0..128 {
        let sequence = PARTIAL_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = root.join(format!(
            "{PARTIAL_FILENAME_PREFIX}{}.{}",
            std::process::id(),
            sequence
        ));
        match OpenOptions::new()
            .create_new(true)
            .read(true)
            .write(true)
            .open(&path)
        {
            Ok(_) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(_) => return Err(ProviderControlError::Io),
        }
    }
    Err(ProviderControlError::Io)
}

fn reject_non_regular_existing_path(path: &Path) -> Result<(), ProviderControlError> {
    match fs::symlink_metadata(path) {
        Ok(_) => Err(ProviderControlError::Invalid(
            "control database path is occupied",
        )),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(ProviderControlError::Io),
    }
}

fn sync_regular_file(path: &Path) -> Result<(), ProviderControlError> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| ProviderControlError::Io)?;
    file.sync_all().map_err(|_| ProviderControlError::Io)
}

fn sync_directory(path: &Path) -> Result<(), ProviderControlError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ProviderControlError::Io)
}

struct PartialGuard {
    path: PathBuf,
    armed: bool,
}

impl PartialGuard {
    fn new(path: PathBuf) -> Self {
        Self { path, armed: true }
    }

    fn remove_owned(&mut self) -> Result<(), ProviderControlError> {
        remove_partial_group(&self.path)?;
        self.armed = false;
        Ok(())
    }
}

impl Drop for PartialGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = remove_partial_group(&self.path);
        }
    }
}

fn remove_partial_group(path: &Path) -> Result<(), ProviderControlError> {
    for suffix in ["-journal", "-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        match fs::remove_file(PathBuf::from(sidecar)) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(ProviderControlError::Io),
        }
    }
    fs::remove_file(path).map_err(|_| ProviderControlError::Io)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static ROOT_SEQUENCE: AtomicU64 = AtomicU64::new(0);
    const NOW_MS: i64 = 1_753_747_200_000;
    const HASH: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    struct TestRoot {
        path: PathBuf,
    }

    impl TestRoot {
        fn new(name: &str) -> Self {
            let sequence = ROOT_SEQUENCE.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "cloud-inn-provider-control-{name}-{}-{sequence}",
                std::process::id()
            ));
            if path.exists() {
                fs::remove_dir_all(&path).expect("remove stale test root");
            }
            fs::create_dir_all(&path).expect("create test root");
            Self { path }
        }

        fn store(&self) -> ProviderControlStore {
            ProviderControlStore::new(self.path.clone())
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    fn create_test_save_database(
        root: &TestRoot,
        save_id: &str,
        application_id: i64,
        schema_version: i64,
    ) -> PathBuf {
        let save_directory = root.path.join("saves").join(save_id);
        fs::create_dir_all(&save_directory).expect("create save directory");
        let database_path = save_directory.join("save.sqlite3");
        let connection = Connection::open(&database_path).expect("create save database");
        connection
            .pragma_update(None, "application_id", application_id)
            .expect("set save application id");
        connection
            .pragma_update(None, "user_version", schema_version)
            .expect("set save schema version");
        if application_id == 0 && schema_version == 0 {
            connection
                .execute_batch(
                    "CREATE TABLE schema_migrations(
                       version INTEGER PRIMARY KEY,
                       applied_at TEXT NOT NULL
                     );
                     INSERT INTO schema_migrations(version,applied_at)
                     VALUES(1,'now'),(2,'now'),(3,'now'),(4,'now'),(5,'now'),(6,'now');",
                )
                .expect("create legacy migration ledger");
        }
        connection.close().expect("close save database");
        database_path
    }

    fn assert_no_owned_partials(root: &TestRoot) {
        let partials: Vec<_> = fs::read_dir(&root.path)
            .unwrap()
            .filter_map(Result::ok)
            .map(|entry| entry.file_name())
            .filter(|name| name.to_string_lossy().starts_with(PARTIAL_FILENAME_PREFIX))
            .collect();
        assert!(partials.is_empty(), "owned partials remain: {partials:?}");
    }

    fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        PathBuf::from(sidecar)
    }

    fn database_group_snapshot(path: &Path) -> Vec<(String, Vec<u8>)> {
        let mut snapshot = Vec::new();
        for suffix in ["", "-journal", "-wal", "-shm"] {
            let candidate = if suffix.is_empty() {
                path.to_path_buf()
            } else {
                sidecar_path(path, suffix)
            };
            if candidate.exists() {
                snapshot.push((
                    suffix.to_string(),
                    fs::read(candidate).expect("read database group member"),
                ));
            }
        }
        snapshot
    }

    fn expect_control_error<T>(result: Result<T, SafeError>) {
        let error = match result {
            Ok(_) => panic!("expected provider control error"),
            Err(error) => error,
        };
        let serialized = serde_json::to_value(error).expect("serialize safe error");
        assert_eq!(serialized["code"], "provider.control-invalid");
        assert!(serialized["detail"].is_null());
        let text = serialized.to_string();
        assert!(!text.contains("/Users/"));
        assert!(!text.contains("CREATE TABLE"));
        assert!(!text.contains("SELECT "));
    }

    fn insert_issued_grant(
        conn: &Connection,
        grant_id: &str,
        sequence: i64,
        quota_day: i64,
    ) -> rusqlite::Result<()> {
        conn.execute(
            "INSERT INTO provider_send_grants(
               grant_id,save_id,job_id,job_revision,attempt_sequence,model,
               request_fingerprint,quota_day,source,state,issued_at_ms
             ) VALUES(?1,'save-1','job-1',0,?2,'model-1',?3,?4,
                      'player-confirmed','issued',100)",
            params![grant_id, sequence, HASH, quota_day],
        )?;
        Ok(())
    }

    fn consume_grant_with_attempt(
        conn: &Connection,
        grant_id: &str,
        attempt_id: &str,
        sequence: i64,
        quota_day: i64,
    ) {
        let transaction = conn.unchecked_transaction().expect("transaction");
        transaction
            .execute(
                "INSERT INTO provider_attempts(
                   attempt_id,save_id,job_id,quota_day,model,sequence,state,reserved_at_ms
                 ) VALUES(?1,'save-1','job-1',?2,'model-1',?3,'reserved',110)",
                params![attempt_id, quota_day, sequence],
            )
            .expect("insert attempt");
        transaction
            .execute(
                "UPDATE provider_send_grants
                 SET state='consumed',consumed_attempt_id=?1,consumed_at_ms=110
                 WHERE grant_id=?2 AND state='issued'",
                params![attempt_id, grant_id],
            )
            .expect("consume grant");
        transaction.commit().expect("commit");
    }

    #[test]
    fn first_bootstrap_is_atomic_and_seeds_safe_defaults() {
        let root = TestRoot::new("first-bootstrap");
        let store = root.store();
        let conn = store.bootstrap(NOW_MS).expect("bootstrap");
        let preferences = conn
            .query_row(
                "SELECT preferences_revision,daily_request_ceiling,
                        require_send_confirmation,allow_automatic_1k_fallback,
                        last_quota_day,updated_at_ms
                 FROM provider_preferences WHERE singleton=1",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                    ))
                },
            )
            .expect("preferences");
        assert_eq!(
            preferences,
            (
                0,
                DEFAULT_DAILY_REQUEST_CEILING,
                1,
                0,
                utc_day_index(NOW_MS).unwrap(),
                NOW_MS,
            )
        );
        assert!(store.path().is_file());
        assert_no_owned_partials(&root);
        assert_eq!(
            conn.pragma_query_value(None, "application_id", |row| row.get::<_, i64>(0))
                .unwrap(),
            CONTROL_APPLICATION_ID
        );
        assert_eq!(
            conn.pragma_query_value(None, "user_version", |row| row.get::<_, i64>(0))
                .unwrap(),
            CONTROL_SCHEMA_VERSION
        );
    }

    #[test]
    fn preferences_update_is_monotonic_cas_and_writable_dto_cannot_set_derived_fields() {
        let root = TestRoot::new("preferences-cas");
        let store = root.store();
        store.bootstrap(NOW_MS).unwrap();
        let initial = store.get_preferences(NOW_MS).unwrap();
        assert_eq!(
            initial,
            ProviderPreferencesProjection {
                preferences_revision: 0,
                daily_request_ceiling: DEFAULT_DAILY_REQUEST_CEILING,
                require_send_confirmation: true,
                allow_automatic_1k_fallback: false,
                last_quota_day: utc_day_index(NOW_MS).unwrap(),
                effective_quota_day: utc_day_index(NOW_MS).unwrap(),
                used_attempts: 0,
                updated_at_ms: NOW_MS,
            }
        );

        let future_ms = NOW_MS + 2 * UTC_DAY_MS;
        let writable = WritableProviderPreferences {
            daily_request_ceiling: 25,
            require_send_confirmation: false,
            allow_automatic_1k_fallback: true,
        };
        assert_eq!(
            serde_json::to_value(&writable).unwrap(),
            serde_json::json!({
                "dailyRequestCeiling": 25,
                "requireSendConfirmation": false,
                "allowAutomatic1kFallback": true,
            })
        );
        assert!(
            serde_json::from_value::<WritableProviderPreferences>(serde_json::json!({
                "dailyRequestCeiling": 25,
                "requireSendConfirmation": false,
                "allowAutomatic1kFallback": true,
                "lastQuotaDay": 0,
            }))
            .is_err()
        );

        let updated = store
            .update_preferences(0, writable.clone(), future_ms)
            .unwrap();
        assert_eq!(updated.preferences_revision, 1);
        assert_eq!(updated.daily_request_ceiling, 25);
        assert!(!updated.require_send_confirmation);
        assert!(updated.allow_automatic_1k_fallback);
        assert_eq!(updated.last_quota_day, utc_day_index(future_ms).unwrap());

        expect_control_error(store.update_preferences(
            0,
            WritableProviderPreferences {
                daily_request_ceiling: 1,
                require_send_confirmation: true,
                allow_automatic_1k_fallback: false,
            },
            future_ms,
        ));
        assert_eq!(store.get_preferences(future_ms).unwrap(), updated);

        let rollback_clock_update = store
            .update_preferences(
                1,
                WritableProviderPreferences {
                    daily_request_ceiling: 20,
                    require_send_confirmation: true,
                    allow_automatic_1k_fallback: false,
                },
                NOW_MS,
            )
            .unwrap();
        assert_eq!(rollback_clock_update.preferences_revision, 2);
        assert_eq!(rollback_clock_update.last_quota_day, updated.last_quota_day);
        assert_eq!(
            rollback_clock_update.effective_quota_day,
            updated.last_quota_day
        );
    }

    #[test]
    fn save_storage_scanner_is_read_only_and_classifies_supported_states() {
        let empty_root = TestRoot::new("no-saves");
        assert!(!empty_root.path.join("saves").exists());
        assert_eq!(
            inspect_save_storage(&empty_root.path).unwrap(),
            SaveStorageState::NoSaves
        );
        assert!(!empty_root.path.join("saves").exists());

        let pre_v7_root = TestRoot::new("pre-v7");
        create_test_save_database(&pre_v7_root, "legacy", 0, 0);
        assert_eq!(
            inspect_save_storage(&pre_v7_root.path).unwrap(),
            SaveStorageState::AllPreV7
        );
        pre_v7_root
            .store()
            .bootstrap(NOW_MS)
            .expect("pre-v7 bootstrap");

        let v7_root = TestRoot::new("current-v7");
        create_test_save_database(
            &v7_root,
            "current",
            SAVE_APPLICATION_ID,
            SAVE_SCHEMA_VERSION,
        );
        assert_eq!(
            inspect_save_storage(&v7_root.path).unwrap(),
            SaveStorageState::HasV7
        );
        expect_control_error(v7_root.store().bootstrap(NOW_MS));
        assert!(!v7_root.store().path().exists());

        let wrong_app_root = TestRoot::new("wrong-save-app-id");
        create_test_save_database(
            &wrong_app_root,
            "wrong-app",
            SAVE_APPLICATION_ID + 1,
            SAVE_SCHEMA_VERSION - 1,
        );
        assert_eq!(
            inspect_save_storage(&wrong_app_root.path).unwrap(),
            SaveStorageState::Unreadable
        );
        expect_control_error(wrong_app_root.store().bootstrap(NOW_MS));

        let branded_pre_v7_root = TestRoot::new("branded-pre-v7");
        create_test_save_database(
            &branded_pre_v7_root,
            "branded-pre-v7",
            SAVE_APPLICATION_ID,
            SAVE_SCHEMA_VERSION - 1,
        );
        assert_eq!(
            inspect_save_storage(&branded_pre_v7_root.path).unwrap(),
            SaveStorageState::Unreadable
        );
        expect_control_error(branded_pre_v7_root.store().bootstrap(NOW_MS));

        let future_root = TestRoot::new("future-save");
        create_test_save_database(
            &future_root,
            "future",
            SAVE_APPLICATION_ID,
            SAVE_SCHEMA_VERSION + 1,
        );
        assert_eq!(
            inspect_save_storage(&future_root.path).unwrap(),
            SaveStorageState::Unreadable
        );
        expect_control_error(future_root.store().bootstrap(NOW_MS));

        let corrupt_root = TestRoot::new("unreadable-save");
        let corrupt_directory = corrupt_root.path.join("saves").join("corrupt");
        fs::create_dir_all(&corrupt_directory).unwrap();
        fs::write(corrupt_directory.join("save.sqlite3"), b"not sqlite").unwrap();
        assert_eq!(
            inspect_save_storage(&corrupt_root.path).unwrap(),
            SaveStorageState::Unreadable
        );
        expect_control_error(corrupt_root.store().bootstrap(NOW_MS));

        let missing_database_root = TestRoot::new("missing-save-database");
        fs::create_dir_all(missing_database_root.path.join("saves").join("missing")).unwrap();
        assert_eq!(
            inspect_save_storage(&missing_database_root.path).unwrap(),
            SaveStorageState::Unreadable
        );
        expect_control_error(missing_database_root.store().bootstrap(NOW_MS));

        let no_ledger_root = TestRoot::new("legacy-without-ledger");
        let no_ledger_path = create_test_save_database(&no_ledger_root, "no-ledger", 0, 0);
        let connection = Connection::open(&no_ledger_path).unwrap();
        connection
            .execute("DROP TABLE schema_migrations", [])
            .unwrap();
        connection.close().unwrap();
        assert_eq!(
            inspect_save_storage(&no_ledger_root.path).unwrap(),
            SaveStorageState::Unreadable
        );
        expect_control_error(no_ledger_root.store().bootstrap(NOW_MS));

        let gapped_ledger_root = TestRoot::new("legacy-gapped-ledger");
        let gapped_path = create_test_save_database(&gapped_ledger_root, "gapped", 0, 0);
        let connection = Connection::open(&gapped_path).unwrap();
        connection
            .execute("DELETE FROM schema_migrations WHERE version=3", [])
            .unwrap();
        connection.close().unwrap();
        assert_eq!(
            inspect_save_storage(&gapped_ledger_root.path).unwrap(),
            SaveStorageState::Unreadable
        );
        expect_control_error(gapped_ledger_root.store().bootstrap(NOW_MS));
    }

    #[cfg(unix)]
    #[test]
    fn save_storage_scanner_rejects_symlinked_save_entries_and_databases() {
        use std::os::unix::fs::symlink;

        let directory_link_root = TestRoot::new("save-directory-symlink");
        let outside_directory = directory_link_root.path.join("outside");
        fs::create_dir_all(&outside_directory).unwrap();
        fs::create_dir_all(directory_link_root.path.join("saves")).unwrap();
        symlink(
            &outside_directory,
            directory_link_root.path.join("saves").join("linked"),
        )
        .unwrap();
        assert_eq!(
            inspect_save_storage(&directory_link_root.path).unwrap(),
            SaveStorageState::Unreadable
        );
        expect_control_error(directory_link_root.store().bootstrap(NOW_MS));

        let database_link_root = TestRoot::new("save-database-symlink");
        let target = database_link_root.path.join("outside.sqlite3");
        let target_connection = Connection::open(&target).unwrap();
        target_connection.close().unwrap();
        let save_directory = database_link_root.path.join("saves").join("linked-db");
        fs::create_dir_all(&save_directory).unwrap();
        symlink(&target, save_directory.join("save.sqlite3")).unwrap();
        assert_eq!(
            inspect_save_storage(&database_link_root.path).unwrap(),
            SaveStorageState::Unreadable
        );
        expect_control_error(database_link_root.store().bootstrap(NOW_MS));
    }

    #[test]
    fn invalid_existing_control_is_validated_read_only_without_changing_its_group() {
        let root = TestRoot::new("invalid-existing-read-only");
        let path = root.store().path();
        fs::write(&path, b"invalid provider control bytes").unwrap();
        fs::write(sidecar_path(&path, "-journal"), b"journal sentinel").unwrap();
        fs::write(sidecar_path(&path, "-wal"), b"wal sentinel").unwrap();
        fs::write(sidecar_path(&path, "-shm"), b"shm sentinel").unwrap();
        let before = database_group_snapshot(&path);

        expect_control_error(root.store().bootstrap(NOW_MS));

        assert_eq!(database_group_snapshot(&path), before);
        assert_no_owned_partials(&root);
    }

    #[test]
    fn valid_existing_control_with_any_sidecar_fails_without_changing_group_bytes() {
        for suffix in ["-journal", "-wal", "-shm"] {
            let root = TestRoot::new("valid-control-with-sidecar");
            let store = root.store();
            store.bootstrap(NOW_MS).unwrap().close().unwrap();
            let sidecar = sidecar_path(&store.path(), suffix);
            fs::write(&sidecar, format!("sentinel-{suffix}")).unwrap();
            let before = database_group_snapshot(&store.path());

            expect_control_error(store.bootstrap(NOW_MS));

            assert_eq!(database_group_snapshot(&store.path()), before, "{suffix}");
            assert_no_owned_partials(&root);
        }
    }

    #[test]
    fn valid_control_with_wal_header_and_no_sidecars_fails_without_mutation() {
        let root = TestRoot::new("valid-control-wal-header");
        let store = root.store();
        store.bootstrap(NOW_MS).unwrap().close().unwrap();
        let connection = Connection::open(store.path()).unwrap();
        assert_eq!(
            connection
                .pragma_update_and_check(None, "journal_mode", "WAL", |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "wal"
        );
        connection.close().unwrap();
        for suffix in ["-journal", "-wal", "-shm"] {
            assert!(!sidecar_path(&store.path(), suffix).exists(), "{suffix}");
        }
        let before = database_group_snapshot(&store.path());

        expect_control_error(store.bootstrap(NOW_MS));

        assert_eq!(database_group_snapshot(&store.path()), before);
    }

    #[test]
    fn no_replace_publish_preserves_a_racing_target_and_cleans_owned_partial() {
        let root = TestRoot::new("no-replace-race");
        let store = root.store();
        let final_path = store.path();
        let competitor = b"competitor-owned bytes";
        let _lock = lock_app_root(&root.path).unwrap();
        let result = store.bootstrap_locked(utc_day_index(NOW_MS).unwrap(), NOW_MS, || {
            fs::write(&final_path, competitor).map_err(|_| ProviderControlError::Io)
        });

        assert!(result.is_err());
        assert_eq!(fs::read(&final_path).unwrap(), competitor);
        assert_no_owned_partials(&root);
    }

    #[test]
    fn publish_failpoint_leaves_no_database_or_partial_group() {
        let root = TestRoot::new("publish-failpoint");
        let store = root.store();
        let _lock = lock_app_root(&root.path).unwrap();
        let result = store.bootstrap_locked(utc_day_index(NOW_MS).unwrap(), NOW_MS, || {
            Err(ProviderControlError::Invalid("test publish failpoint"))
        });

        assert!(result.is_err());
        assert!(!store.path().exists());
        assert_no_owned_partials(&root);
    }

    #[test]
    fn concurrent_bootstrap_calls_publish_one_valid_database() {
        let root = TestRoot::new("concurrent-bootstrap");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let mut handles = Vec::new();
        for _ in 0..2 {
            let app_root = root.path.clone();
            let barrier = barrier.clone();
            handles.push(std::thread::spawn(move || {
                barrier.wait();
                let connection = ProviderControlStore::new(app_root)
                    .bootstrap(NOW_MS)
                    .expect("concurrent bootstrap");
                connection
                    .query_row("SELECT count(*) FROM provider_preferences", [], |row| {
                        row.get::<_, i64>(0)
                    })
                    .expect("query preferences")
            }));
        }
        for handle in handles {
            assert_eq!(handle.join().expect("bootstrap thread"), 1);
        }
        root.store().open_validated().expect("reopen exact schema");
        assert_no_owned_partials(&root);
    }

    #[test]
    fn unrelated_legacy_partial_group_is_neither_reused_nor_deleted() {
        let root = TestRoot::new("legacy-partial-group");
        let partial = root.path.join(".provider-control.sqlite3.partial.fixture");
        fs::write(&partial, b"legacy partial").unwrap();
        fs::write(sidecar_path(&partial, "-journal"), b"legacy journal").unwrap();
        let before = database_group_snapshot(&partial);

        root.store().bootstrap(NOW_MS).expect("bootstrap");

        assert_eq!(database_group_snapshot(&partial), before);
        root.store().open_validated().expect("valid control");
    }

    #[test]
    fn initialized_database_never_reseeds_a_missing_preferences_row() {
        let root = TestRoot::new("missing-preferences");
        let store = root.store();
        let conn = store.bootstrap(NOW_MS).unwrap();
        conn.execute("DELETE FROM provider_preferences", [])
            .unwrap();
        drop(conn);

        expect_control_error(store.open_validated());
        let raw = Connection::open(store.path()).unwrap();
        let count: i64 = raw
            .query_row("SELECT count(*) FROM provider_preferences", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn exact_schema_validation_rejects_extra_objects() {
        let root = TestRoot::new("extra-schema");
        let store = root.store();
        let conn = store.bootstrap(NOW_MS).unwrap();
        conn.execute("CREATE TABLE unexpected(value TEXT)", [])
            .unwrap();
        drop(conn);
        expect_control_error(store.open_validated());
    }

    #[test]
    fn attempt_checks_reject_null_and_impossible_timestamps() {
        let root = TestRoot::new("attempt-checks");
        let conn = root.store().bootstrap(NOW_MS).unwrap();
        let day = utc_day_index(NOW_MS).unwrap();

        let sent_without_timestamp = conn.execute(
            "INSERT INTO provider_attempts(
               attempt_id,save_id,job_id,quota_day,model,sequence,state,reserved_at_ms
             ) VALUES('attempt-null-sent','save-1','job-1',?1,'model-1',1,'sent',100)",
            [day],
        );
        assert!(sent_without_timestamp.is_err());

        let outcome_without_completion = conn.execute(
            "INSERT INTO provider_attempts(
               attempt_id,save_id,job_id,quota_day,model,sequence,state,
               reserved_at_ms,sent_at_ms,outcome_code
             ) VALUES('attempt-null-completed','save-1','job-2',?1,'model-1',1,
                      'outcome-known',100,110,'ok')",
            [day],
        );
        assert!(outcome_without_completion.is_err());

        let expired_with_sent_timestamp = conn.execute(
            "INSERT INTO provider_attempts(
               attempt_id,save_id,job_id,quota_day,model,sequence,state,
               reserved_at_ms,sent_at_ms,completed_at_ms,outcome_code
             ) VALUES('attempt-fake-sent','save-1','job-3',?1,'model-1',1,
                      'expired-unsent',100,105,110,'expired-unsent')",
            [day],
        );
        assert!(expired_with_sent_timestamp.is_err());
    }

    #[test]
    fn reserved_attempt_can_expire_unsent_without_fabricating_send_time() {
        let root = TestRoot::new("expired-unsent");
        let conn = root.store().bootstrap(NOW_MS).unwrap();
        let day = utc_day_index(NOW_MS).unwrap();
        insert_issued_grant(&conn, "grant-1", 1, day).unwrap();
        consume_grant_with_attempt(&conn, "grant-1", "attempt-1", 1, day);
        conn.execute(
            "UPDATE provider_attempts
             SET state='expired-unsent',completed_at_ms=200,outcome_code='expired-unsent'
             WHERE attempt_id='attempt-1' AND state='reserved'",
            [],
        )
        .unwrap();
        let row = conn
            .query_row(
                "SELECT state,sent_at_ms,completed_at_ms,outcome_code
                 FROM provider_attempts WHERE attempt_id='attempt-1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Option<i64>>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            row,
            (
                "expired-unsent".to_string(),
                None,
                200,
                "expired-unsent".to_string()
            )
        );
        validate_connection(&conn).unwrap();
    }

    #[test]
    fn partial_unique_index_allows_new_same_sequence_grant_after_expiry() {
        let root = TestRoot::new("grant-partial-index");
        let conn = root.store().bootstrap(NOW_MS).unwrap();
        let day = utc_day_index(NOW_MS).unwrap();
        insert_issued_grant(&conn, "grant-old", 1, day).unwrap();
        assert!(insert_issued_grant(&conn, "grant-duplicate", 1, day).is_err());
        conn.execute(
            "UPDATE provider_send_grants SET state='expired'
             WHERE grant_id='grant-old' AND state='issued'",
            [],
        )
        .unwrap();
        insert_issued_grant(&conn, "grant-new-day", 1, day + 1).unwrap();
        let count: i64 = conn
            .query_row(
                "SELECT count(*) FROM provider_send_grants
                 WHERE save_id='save-1' AND job_id='job-1' AND attempt_sequence=1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn grant_checks_reject_consumed_nulls_and_bad_fingerprints() {
        let root = TestRoot::new("grant-checks");
        let conn = root.store().bootstrap(NOW_MS).unwrap();
        let day = utc_day_index(NOW_MS).unwrap();

        let consumed_without_attempt = conn.execute(
            "INSERT INTO provider_send_grants(
               grant_id,save_id,job_id,job_revision,attempt_sequence,model,
               request_fingerprint,quota_day,source,state,issued_at_ms
             ) VALUES('grant-null','save-1','job-1',0,1,'model-1',?1,?2,
                      'player-confirmed','consumed',100)",
            params![HASH, day],
        );
        assert!(consumed_without_attempt.is_err());

        let uppercase_fingerprint = conn.execute(
            "INSERT INTO provider_send_grants(
               grant_id,save_id,job_id,job_revision,attempt_sequence,model,
               request_fingerprint,quota_day,source,state,issued_at_ms
             ) VALUES('grant-uppercase','save-1','job-1',0,1,'model-1',?1,?2,
                      'player-confirmed','issued',100)",
            params!["A".repeat(64), day],
        );
        assert!(uppercase_fingerprint.is_err());
    }

    #[test]
    fn validation_rejects_an_attempt_without_a_consumed_grant() {
        let root = TestRoot::new("orphan-attempt");
        let store = root.store();
        let conn = store.bootstrap(NOW_MS).unwrap();
        let day = utc_day_index(NOW_MS).unwrap();
        conn.execute(
            "INSERT INTO provider_attempts(
               attempt_id,save_id,job_id,quota_day,model,sequence,state,reserved_at_ms
             ) VALUES('attempt-orphan','save-1','job-1',?1,'model-1',1,'reserved',100)",
            [day],
        )
        .unwrap();
        drop(conn);
        expect_control_error(store.open_validated());
    }

    #[test]
    fn negative_clock_is_rejected_without_creating_control_state() {
        let root = TestRoot::new("negative-clock");
        let store = root.store();
        expect_control_error(store.bootstrap(-1));
        assert!(!store.path().exists());
    }
}
