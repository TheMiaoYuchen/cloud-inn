use crate::redaction::SafeError;
use crate::save_validation::validate_v7_schema_fingerprint;
use fs2::FileExt;
use rusqlite::Connection;
use std::collections::HashSet;
use std::fs::{self, File, OpenOptions};
use std::path::Path;
use unicode_normalization::UnicodeNormalization;
use unicode_segmentation::UnicodeSegmentation;

pub(crate) const SAVE_APPLICATION_ID: i64 = 0x434C_494E;
pub(crate) const CONTROL_APPLICATION_ID: i64 = 0x434C_4354;
pub(crate) const SAVE_SCHEMA_VERSION: i64 = 7;
pub(crate) const CONTROL_SCHEMA_VERSION: i64 = 1;

pub(crate) fn normalize_display_name(value: &str) -> Result<String, SafeError> {
    let normalized = value.trim().nfc().collect::<String>();
    if normalized.chars().any(char::is_control)
        || normalized.graphemes(true).count() > 40
        || normalized.graphemes(true).count() == 0
        || normalized.len() > 1024
    {
        return Err(SafeError::new("save.invalid-name", "存档名称无效"));
    }
    Ok(normalized)
}

pub(crate) struct AppRootLock(File);

pub(crate) struct PerSaveLock(File);

pub(crate) struct SharedSendRestorePermit(File);
pub(crate) struct ExclusiveSendRestorePermit(File);

pub(crate) fn lock_app_root(app_root: &Path) -> Result<AppRootLock, SafeError> {
    fs::create_dir_all(app_root).map_err(|_| lock_error())?;
    lock_file(&app_root.join(".cloud-inn.root.lock")).map(AppRootLock)
}

pub(crate) fn lock_save(save_directory: &Path) -> Result<PerSaveLock, SafeError> {
    fs::create_dir_all(save_directory).map_err(|_| lock_error())?;
    lock_file(&save_directory.join(".cloud-inn.save.lock")).map(PerSaveLock)
}

pub(crate) fn lock_send_restore_shared(
    app_root: &Path,
) -> Result<SharedSendRestorePermit, SafeError> {
    let file = open_lock_file(&app_root.join(".cloud-inn.send-restore.lock"))?;
    file.lock_shared().map_err(|_| lock_error())?;
    Ok(SharedSendRestorePermit(file))
}

pub(crate) fn lock_send_restore_exclusive(
    app_root: &Path,
) -> Result<ExclusiveSendRestorePermit, SafeError> {
    let file = open_lock_file(&app_root.join(".cloud-inn.send-restore.lock"))?;
    file.lock_exclusive().map_err(|_| lock_error())?;
    Ok(ExclusiveSendRestorePermit(file))
}

fn lock_file(path: &Path) -> Result<File, SafeError> {
    let file = open_lock_file(path)?;
    file.lock_exclusive().map_err(|_| lock_error())?;
    Ok(file)
}

fn open_lock_file(path: &Path) -> Result<File, SafeError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|_| lock_error())?;
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|_| lock_error())?;
    Ok(file)
}

impl Drop for AppRootLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

impl Drop for PerSaveLock {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

impl Drop for SharedSendRestorePermit {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

impl Drop for ExclusiveSendRestorePermit {
    fn drop(&mut self) {
        let _ = FileExt::unlock(&self.0);
    }
}

const REQUIRED_TABLES: &[&str] = &[
    "schema_migrations",
    "saves",
    "room_blueprints",
    "room_instances",
    "daily_reports",
    "save_metadata",
    "assets",
    "asset_references",
    "generation_jobs",
    "asset_write_intents",
    "recovery_points",
    "runtime_session",
];

const REQUIRED_INDEXES: &[&str] = &[
    "room_blueprints_save_blueprint",
    "generation_jobs_status_lease",
    "generation_jobs_save_history",
    "asset_references_asset_roots",
    "recovery_points_rotation",
    "asset_write_intents_reconcile",
];

const REQUIRED_TRIGGERS: &[&str] = &[
    "saves_phase4_json_insert_check",
    "saves_phase4_json_update_check",
];

pub(crate) const V7_TABLES: &[&str] = &[
    "save_metadata",
    "assets",
    "asset_references",
    "generation_jobs",
    "asset_write_intents",
    "recovery_points",
    "runtime_session",
];

pub(crate) fn validate_current_save_database(connection: &Connection) -> Result<(), SafeError> {
    let application_id = pragma_i64(connection, "application_id")?;
    if application_id != SAVE_APPLICATION_ID {
        return Err(validation_error("存档应用标识不匹配"));
    }
    let user_version = pragma_i64(connection, "user_version")?;
    if user_version != SAVE_SCHEMA_VERSION {
        return Err(validation_error("存档结构版本不匹配"));
    }

    let integrity = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
        .map_err(db_error)?;
    if integrity != "ok" {
        return Err(validation_error("存档完整性检查失败"));
    }
    let foreign_key_violation_count = connection
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(db_error)?;
    if foreign_key_violation_count != 0 {
        return Err(validation_error("存档关系检查失败"));
    }

    validate_exact_objects(connection, "table", REQUIRED_TABLES)?;
    validate_exact_objects(connection, "index", REQUIRED_INDEXES)?;
    validate_exact_objects(connection, "trigger", REQUIRED_TRIGGERS)?;
    validate_v7_schema_fingerprint(connection)
        .map_err(|_| validation_error("存档结构定义不匹配"))?;
    let view_count = connection
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='view'",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(db_error)?;
    if view_count != 0 {
        return Err(validation_error("存档包含未知视图"));
    }

    let (migration_count, minimum_migration, maximum_migration) = connection
        .query_row(
            "SELECT count(*),MIN(version),MAX(version) FROM schema_migrations",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .map_err(db_error)?;
    if migration_count != SAVE_SCHEMA_VERSION
        || minimum_migration != Some(1)
        || maximum_migration != Some(SAVE_SCHEMA_VERSION)
    {
        return Err(validation_error("迁移审计记录不完整"));
    }
    let save_count = connection
        .query_row("SELECT count(*) FROM saves", [], |row| row.get::<_, i64>(0))
        .map_err(db_error)?;
    let metadata_count = connection
        .query_row("SELECT count(*) FROM save_metadata", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(db_error)?;
    if save_count != metadata_count {
        return Err(validation_error("存档元数据数量无效"));
    }
    let missing_metadata_count = connection
        .query_row(
            "SELECT count(*) FROM saves
             WHERE NOT EXISTS (
               SELECT 1 FROM save_metadata
               WHERE save_metadata.save_id = saves.save_id
             )",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(db_error)?;
    if missing_metadata_count != 0 {
        return Err(validation_error("存档元数据与游戏存档不一致"));
    }
    let orphan_metadata_count = connection
        .query_row(
            "SELECT count(*) FROM save_metadata
             WHERE NOT EXISTS (
               SELECT 1 FROM saves
               WHERE saves.save_id = save_metadata.save_id
             )",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(db_error)?;
    if orphan_metadata_count != 0 {
        return Err(validation_error("存档元数据存在孤立记录"));
    }
    let runtime_singleton_count = connection
        .query_row(
            "SELECT count(*) FROM runtime_session WHERE singleton=1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(db_error)?;
    if runtime_singleton_count != 1 {
        return Err(validation_error("运行会话单例无效"));
    }
    Ok(())
}

pub(crate) fn legacy_schema_needs_repair(connection: &Connection) -> Result<bool, SafeError> {
    for (table, column) in [
        ("room_instances", "ordinal"),
        ("saves", "phase2_json"),
        ("room_blueprints", "openings_json"),
        ("saves", "operations_json"),
        ("saves", "phase4_json"),
    ] {
        if !has_column(connection, table, column)? {
            return Ok(true);
        }
    }
    let trigger_count = connection
        .query_row(
            "SELECT count(*) FROM sqlite_master
             WHERE type='trigger' AND name IN (
               'saves_phase4_json_insert_check',
               'saves_phase4_json_update_check'
             )",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(db_error)?;
    Ok(trigger_count != 2)
}

fn has_column(connection: &Connection, table: &str, column: &str) -> Result<bool, SafeError> {
    let sql = format!("SELECT 1 FROM pragma_table_info('{table}') WHERE name=?1");
    connection
        .prepare(&sql)
        .map_err(db_error)?
        .exists([column])
        .map_err(db_error)
}

fn validate_exact_objects(
    connection: &Connection,
    object_type: &str,
    required: &[&str],
) -> Result<(), SafeError> {
    let mut statement = connection
        .prepare(
            "SELECT name FROM sqlite_master
             WHERE type=?1 AND name NOT LIKE 'sqlite_autoindex_%'",
        )
        .map_err(db_error)?;
    let names = statement
        .query_map([object_type], |row| row.get::<_, String>(0))
        .map_err(db_error)?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(db_error)?;
    let expected = required
        .iter()
        .map(|name| (*name).to_string())
        .collect::<HashSet<_>>();
    if names != expected {
        let mut actual_names = names.into_iter().collect::<Vec<_>>();
        actual_names.sort();
        return Err(validation_error(match object_type {
            "table" => "存档表结构不完整",
            _ => "存档索引结构不完整",
        })
        .with_detail(&format!("{object_type}:{}", actual_names.join(","))));
    }
    Ok(())
}

fn pragma_i64(connection: &Connection, name: &str) -> Result<i64, SafeError> {
    connection
        .query_row(&format!("PRAGMA {name}"), [], |row| row.get(0))
        .map_err(db_error)
}

fn db_error(_error: rusqlite::Error) -> SafeError {
    validation_error("存档结构验证失败")
}

fn validation_error(message: &'static str) -> SafeError {
    SafeError::new("migration.validation-failed", message)
}

fn lock_error() -> SafeError {
    SafeError::new("save.locked", "存档正被另一个操作使用")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fixed_save_database_identity_is_stable() {
        assert_eq!(SAVE_APPLICATION_ID, 0x434C_494E);
        assert_eq!(CONTROL_APPLICATION_ID, 0x434C_4354);
        assert_eq!(SAVE_SCHEMA_VERSION, 7);
        assert_eq!(CONTROL_SCHEMA_VERSION, 1);
    }

    #[test]
    fn display_names_trim_normalize_and_reject_controls_or_excessive_graphemes() {
        assert_eq!(normalize_display_name("  Cafe\u{301}  ").unwrap(), "Café");
        assert!(normalize_display_name("safe\nname").is_err());
        assert!(normalize_display_name(&"云".repeat(41)).is_err());
    }
}
