use crate::archive::{
    ArchiveAssetMetadata, ArchiveManifest, ArchivePayloadFile, ArchivePayloadRecord,
    TemporaryArchive, ARCHIVE_FORMAT_VERSION,
};
use crate::assets::{validate_stored_asset_path, AssetStore, StoredAsset};
use crate::cross_database_validation::validate_issued_grants_for_save;
use crate::provider_control::ProviderControlStore;
use crate::recovery::{RecoveryId, RecoveryPackage, RecoveryReason};
use crate::redaction::SafeError;
use crate::reliability::{
    legacy_schema_needs_repair, lock_save, normalize_display_name, validate_current_save_database,
    PerSaveLock, SAVE_APPLICATION_ID, SAVE_SCHEMA_VERSION,
};
use crate::save_validation::{validate_asset_registry, validate_single_save_identity};
use rusqlite::backup::Backup;
use rusqlite::{params, Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;
use uuid::Uuid;

pub struct SaveRepository {
    root: PathBuf,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSummary {
    save_id: String,
    display_name: String,
    metadata_revision: i64,
    game_revision: i64,
    current_day: i64,
    room_count: i64,
    schema_healthy: bool,
    recovery_available: bool,
    last_played_at_ms: i64,
}

impl SaveSummary {
    pub(crate) fn save_id(&self) -> &str {
        &self.save_id
    }
}

/// A player-visible recovery point. Package paths and checksums deliberately
/// remain private; callers can only act on the opaque recovery identifier.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecoveryPointSummary {
    recovery_id: String,
    kind: String,
    restore_revision: i64,
    reason: String,
    created_at_ms: i64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreRecoveryResult {
    save_id: String,
    revision: i64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PreparedSaveExport {
    pub(crate) archive: TemporaryArchive,
    pub(crate) suggested_filename: String,
    pub(crate) source_save_id: String,
    pub(crate) display_name: String,
    pub(crate) schema_version: u32,
    pub(crate) ruleset_version: String,
}

/// Native-only input for publishing one generated image and attaching it to a
/// domain owner. The repository derives both the catalog identity and file
/// path from the verified bytes; callers never supply either value.
pub(crate) struct AssetReferenceStoreRequest<'a> {
    pub(crate) owner_kind: &'a str,
    pub(crate) owner_id: &'a str,
    pub(crate) bytes: &'a [u8],
    pub(crate) mime_type: &'a str,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

pub(crate) struct PreparedSaveDatabase {
    path: PathBuf,
    control_connection: Connection,
    _save_lock: PerSaveLock,
}

impl std::fmt::Debug for PreparedSaveDatabase {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("PreparedSaveDatabase")
    }
}

impl SaveRepository {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub fn load_game(&self, save_id: &str) -> Result<Option<Value>, String> {
        validate_save_id(save_id)?;
        let path = self.db_path(save_id);
        if !database_or_journal_exists(&path)? {
            return Ok(None);
        }
        let conn = self.open_existing(save_id)?;
        load_game_from_connection(&conn, save_id)
    }

    pub fn list_saves(&self) -> Result<Vec<SaveSummary>, SafeError> {
        let saves_root = self.root.join("saves");
        let entries = match fs::read_dir(&saves_root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err(SafeError::new("save.corrupt", "无法读取存档目录")),
        };
        let mut saves = Vec::new();
        for entry in entries {
            let Ok(entry) = entry else { continue };
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if !file_type.is_dir() || file_type.is_symlink() {
                continue;
            }
            let Some(save_id) = entry.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if validate_save_id(&save_id).is_err() {
                continue;
            }
            let path = entry.path().join("save.sqlite3");
            if !existing_regular_database(&path)? {
                continue;
            }
            let Ok(connection) = open_read_only(&path, "migration.validation-failed") else {
                continue;
            };
            if validate_current_save_database(&connection).is_err()
                || validate_opened_save(&connection, &path, &save_id, false).is_err()
            {
                continue;
            }
            if let Ok(summary) = read_save_summary(&connection, &save_id) {
                saves.push(summary);
            }
        }
        saves.sort_by(|left, right| left.save_id.cmp(&right.save_id));
        Ok(saves)
    }

    pub fn create_save(&self, display_name: Option<String>) -> Result<SaveSummary, SafeError> {
        let display_name = match display_name {
            Some(value) => normalize_display_name(&value)?,
            None => self.default_display_name()?,
        };
        let save_id = Uuid::new_v4().to_string();
        let path = self.db_path(&save_id);
        let directory = path
            .parent()
            .ok_or_else(|| SafeError::new("save.corrupt", "存档目录无效"))?;
        let _control = self.bootstrap_provider_control()?;
        ensure_save_directory(directory)?;
        let _save_lock = lock_save(directory)?;
        if database_or_journal_exists(&path)
            .map_err(|_| SafeError::new("save.conflict", "存档已存在"))?
        {
            return Err(SafeError::new("save.conflict", "存档已存在"));
        }
        prepare_database_file(&path, &save_id, true)?;
        let mut connection = open_current_connection(&path)?;
        let timestamp = current_time_ms()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| SafeError::new("save.corrupt", "无法创建存档"))?;
        tx.execute(
            "INSERT INTO saves(save_id,schema_version,ruleset_version,revision,phase,current_day,cash_cents,rate_cents,updated_at) VALUES(?1,1,'prototype-v1',0,'design',0,100000000,80000,datetime('now'))",
            [&save_id],
        ).map_err(|_| SafeError::new("save.corrupt", "无法创建存档"))?;
        tx.execute(
            "INSERT INTO save_metadata(save_id,display_name,created_at_ms,renamed_at_ms,metadata_revision) VALUES(?1,?2,?3,?3,0)",
            params![save_id, display_name, timestamp],
        ).map_err(|_| SafeError::new("save.corrupt", "无法创建存档"))?;
        tx.commit()
            .map_err(|_| SafeError::new("save.corrupt", "无法创建存档"))?;
        validate_opened_save(&connection, &path, &save_id, false)?;
        read_save_summary(&connection, &save_id)
    }

    pub fn rename_save(
        &self,
        save_id: &str,
        display_name: String,
        expected_metadata_revision: i64,
    ) -> Result<SaveSummary, SafeError> {
        validate_save_id(save_id).map_err(|_| SafeError::new("save.invalid-id", "存档标识无效"))?;
        if expected_metadata_revision < 0 {
            return Err(SafeError::new("save.conflict", "存档版本无效"));
        }
        let display_name = normalize_display_name(&display_name)?;
        let prepared = self.prepare_save_database(save_id)?;
        let connection = open_current_connection(&prepared.path)?;
        let timestamp = current_time_ms()?;
        let changed = connection.execute(
            "UPDATE save_metadata SET display_name=?1,renamed_at_ms=?2,metadata_revision=metadata_revision+1 WHERE save_id=?3 AND metadata_revision=?4",
            params![display_name, timestamp, save_id, expected_metadata_revision],
        ).map_err(|_| SafeError::new("save.corrupt", "无法重命名存档"))?;
        if changed != 1 {
            return Err(SafeError::new("save.conflict", "存档已更新，请重新加载"));
        }
        read_save_summary(&connection, save_id)
    }

    /// Stores a verified image under the save's content-addressed asset
    /// directory, then records its immutable catalog entry and owner
    /// reference in one SQLite transaction. The filesystem publish happens
    /// first: an interrupted catalog write can only leave an unreferenced,
    /// content-addressed file, never a database row that points at a partial
    /// payload.
    #[allow(dead_code)]
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn store_asset_reference(
        &self,
        save_id: &str,
        request: AssetReferenceStoreRequest<'_>,
    ) -> Result<String, SafeError> {
        validate_asset_owner(request.owner_kind, request.owner_id)?;
        let prepared = self.prepare_save_database(save_id)?;
        let save_directory = prepared
            .path
            .parent()
            .ok_or_else(|| SafeError::new("save.corrupt", "存档目录无效"))?;
        let asset = AssetStore::new(save_directory)
            .store(
                request.bytes,
                request.mime_type,
                request.width,
                request.height,
            )
            .map_err(|_| SafeError::new("save.corrupt", "资源内容无效"))?;
        let mut connection = open_current_connection(&prepared.path)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| SafeError::new("save.corrupt", "无法记录资源"))?;
        let asset_id = persist_verified_asset_reference(
            &transaction,
            &asset,
            request.owner_kind,
            request.owner_id,
        )?;
        transaction
            .commit()
            .map_err(|_| SafeError::new("save.corrupt", "无法记录资源"))?;
        Ok(asset_id)
    }

    /// Lists only catalog rows that have been promoted to `ready` and whose
    /// complete, non-player-visible metadata passes the native validation
    /// boundary. A malformed ready row is never partially exposed.
    pub fn list_recovery_points(
        &self,
        save_id: &str,
    ) -> Result<Vec<RecoveryPointSummary>, SafeError> {
        validate_save_id(save_id).map_err(|_| SafeError::new("save.invalid-id", "存档标识无效"))?;
        let prepared = self.prepare_save_database(save_id)?;
        let connection = open_read_only(&prepared.path, "recovery.corrupt")?;
        read_ready_recovery_points(&connection)
    }

    /// Freezes one internally consistent export while the per-save lock is
    /// held. The returned archive is app-owned; callers may only publish it
    /// through the native no-clobber archive boundary after a save dialog.
    pub(crate) fn prepare_save_export(
        &self,
        save_id: &str,
    ) -> Result<PreparedSaveExport, SafeError> {
        validate_save_id(save_id).map_err(|_| SafeError::new("save.invalid-id", "存档标识无效"))?;
        let prepared = self.prepare_save_database(save_id)?;
        let export_root = self.root.join("export-staging");
        ensure_export_directory(&export_root)?;
        let staging = export_root.join(format!("snapshot-{}", Uuid::new_v4()));
        fs::create_dir(&staging).map_err(|_| archive_export_failed())?;
        let mut staging_guard = OwnedDirectory::new(staging.clone());
        let database_path = staging.join("save").join("save.sqlite3");
        fs::create_dir(staging.join("save")).map_err(|_| archive_export_failed())?;
        online_backup_with_error(&prepared.path, &database_path, archive_export_failed)?;

        let frozen = Connection::open(&database_path).map_err(|_| archive_export_failed())?;
        configure_migration_connection(&frozen).map_err(|_| archive_export_failed())?;
        validate_current_save_database(&frozen).map_err(|_| archive_export_failed())?;
        validate_single_save_identity(&frozen, save_id, false)
            .map_err(|_| archive_export_failed())?;
        frozen
            .execute(
                "DELETE FROM assets
                 WHERE NOT EXISTS(
                   SELECT 1 FROM asset_references
                   WHERE asset_references.asset_id=assets.asset_id
                 )",
                [],
            )
            .map_err(|_| archive_export_failed())?;
        let export_metadata = read_export_metadata(&frozen, save_id)?;
        let assets = read_export_assets(&frozen)?;
        make_single_file_durable(&frozen, &database_path).map_err(|_| archive_export_failed())?;
        drop(frozen);
        sync_file(&database_path).map_err(|_| archive_export_failed())?;

        let save_directory = prepared.path.parent().ok_or_else(archive_export_failed)?;
        let mut payload_files = Vec::with_capacity(assets.len() + 1);
        let mut payload = Vec::with_capacity(assets.len() + 1);
        let database_length = fs::metadata(&database_path)
            .map_err(|_| archive_export_failed())?
            .len();
        payload.push(ArchivePayloadRecord {
            path: "save/save.sqlite3".to_owned(),
            sha256: sha256_file(&database_path).map_err(|_| archive_export_failed())?,
            byte_length: database_length,
        });
        payload_files.push(ArchivePayloadFile {
            archive_path: "save/save.sqlite3".to_owned(),
            source_path: database_path,
        });

        let mut referenced_assets = Vec::with_capacity(assets.len());
        for asset in assets {
            let source = save_directory.join(&asset.relative_path);
            let destination = staging.join(&asset.relative_path);
            copy_export_asset(&source, &destination, &asset)?;
            payload.push(ArchivePayloadRecord {
                path: asset.relative_path.clone(),
                sha256: asset.sha256.clone(),
                byte_length: asset.byte_length,
            });
            payload_files.push(ArchivePayloadFile {
                archive_path: asset.relative_path.clone(),
                source_path: destination,
            });
            referenced_assets.push(ArchiveAssetMetadata {
                asset_id: asset.asset_id,
                path: asset.relative_path,
                mime_type: asset.mime_type,
                byte_length: asset.byte_length,
                width: asset.width,
                height: asset.height,
                sha256: asset.sha256,
            });
        }
        payload.sort_by(|left, right| left.path.cmp(&right.path));
        referenced_assets.sort_by(|left, right| left.path.cmp(&right.path));
        let manifest = ArchiveManifest {
            format_version: ARCHIVE_FORMAT_VERSION,
            application_version: env!("CARGO_PKG_VERSION").to_owned(),
            schema_version: export_metadata.schema_version,
            ruleset_version: export_metadata.ruleset_version.clone(),
            source_save_id: save_id.to_owned(),
            display_name: export_metadata.display_name.clone(),
            created_at_ms: current_time_ms()?,
            payload,
            referenced_assets,
        };
        let archive =
            crate::archive::write_temporary_archive(&export_root, &manifest, &payload_files)
                .map_err(|_| archive_export_failed())?;
        if let Err(error) = seal_export_archive(&archive) {
            remove_temporary_archive(&archive);
            return Err(error);
        }
        let suggested_filename = suggested_archive_filename(&export_metadata.display_name);
        if let Err(error) = staging_guard.remove_now() {
            remove_temporary_archive(&archive);
            return Err(error);
        }
        Ok(PreparedSaveExport {
            archive,
            suggested_filename,
            source_save_id: save_id.to_owned(),
            display_name: export_metadata.display_name,
            schema_version: export_metadata.schema_version,
            ruleset_version: export_metadata.ruleset_version,
        })
    }

    /// Restores a verified recovery package without ever exposing a path to
    /// the caller. A verified pre-restore package is embedded in the candidate
    /// database before the atomic swap, so any failure leaves the current save
    /// untouched and a successful restore is itself reversible.
    pub fn restore_recovery_point(
        &self,
        save_id: &str,
        recovery_id: &str,
    ) -> Result<RestoreRecoveryResult, SafeError> {
        validate_save_id(save_id).map_err(|_| SafeError::new("save.invalid-id", "存档标识无效"))?;
        let recovery_id = RecoveryId::parse(recovery_id).map_err(|_| recovery_corrupt())?;
        let prepared = self.prepare_save_database(save_id)?;
        let current_path = prepared.path.clone();
        let current = open_current_connection(&current_path).map_err(|_| recovery_corrupt())?;
        let target = read_ready_recovery_metadata(&current, &recovery_id)
            .map_err(|error| error.with_detail("读取恢复点元数据失败"))?;
        drop(current);

        let recovery_directory = self.root.join("recovery-packages");
        ensure_recovery_directory(&recovery_directory)?;
        let target_package = target
            .verify_package(&recovery_directory, &recovery_id)
            .map_err(|error| error.with_detail("恢复包验证失败"))?;
        let target_database = target_package.path.join("database.sqlite3");
        let partial = unique_sibling(&current_path, "restore.partial");
        let mut partial_guard = OwnedPartial::new(partial.clone());
        copy_verified_database_payload(&target_database, &partial)
            .map_err(|error| error.with_detail("无法冻结目标恢复包"))?;

        let pre_restore_id = RecoveryId::parse(format!("pre-restore-{}", Uuid::new_v4()))
            .map_err(|_| recovery_corrupt())?;
        let pending_pre_restore_package = self
            .create_frozen_recovery_package(&current_path, &pre_restore_id, recovery_corrupt)
            .map_err(|error| error.with_detail("无法创建恢复前快照"))?;
        let pre_restore_package = crate::recovery::promote_database_preimage(
            &self.root.join("recovery-pending"),
            &recovery_directory,
            &pre_restore_id,
        )
        .map_err(|_| recovery_corrupt().with_detail("无法晋升恢复前快照"))?;
        if pre_restore_package.package_sha256 != pending_pre_restore_package.package_sha256
            || pre_restore_package.manifest_sha256 != pending_pre_restore_package.manifest_sha256
        {
            cleanup_verified_package(&pre_restore_package, &pre_restore_id);
            return Err(recovery_corrupt());
        }
        let mut pre_restore_guard = PendingPackageGuard::new(
            pre_restore_id.clone(),
            pre_restore_package,
            RecoveryReason::Settlement,
        );
        let pre_restore_revision = read_save_revision(&current_path, save_id)?;
        let restored_revision = pre_restore_revision
            .checked_add(1)
            .ok_or_else(recovery_corrupt)?;

        let mut candidate = open_current_connection(&partial)
            .map_err(|_| recovery_corrupt().with_detail("无法打开恢复候选数据库"))?;
        validate_opened_save(&candidate, &partial, save_id, false)
            .map_err(|_| recovery_corrupt())?;
        let candidate_revision = read_save_revision_from_connection(&candidate, save_id)?;
        if candidate_revision != target.restore_revision {
            return Err(recovery_corrupt());
        }
        let transaction = candidate
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| recovery_corrupt())?;
        let changed = transaction
            .execute(
                "UPDATE saves SET revision=?1,updated_at=datetime('now')
                 WHERE save_id=?2 AND revision=?3",
                params![restored_revision, save_id, candidate_revision],
            )
            .map_err(|_| recovery_corrupt())?;
        if changed != 1 {
            return Err(recovery_corrupt());
        }
        let timestamp = current_time_ms()?;
        transaction
            .execute(
                "UPDATE runtime_session
                 SET clean_shutdown=1,last_durable_revision=?1,
                     coordinator_epoch=coordinator_epoch+1,
                     last_observed_wall_ms=MAX(last_observed_wall_ms,?2),updated_at_ms=?2
                 WHERE singleton=1",
                params![restored_revision, timestamp],
            )
            .map_err(|_| recovery_corrupt())?;
        record_ready_recovery_point(
            &transaction,
            &pre_restore_id,
            &pre_restore_guard.package,
            "pre-restore",
            None,
            pre_restore_revision,
            RecoveryReason::Settlement,
        )
        .map_err(|error| error.with_detail("无法写入恢复前快照记录"))?;
        transaction.commit().map_err(|_| recovery_corrupt())?;
        make_single_file_durable(&candidate, &partial).map_err(|_| recovery_corrupt())?;
        drop(candidate);
        validate_restore_candidate(&partial, save_id)?;

        if atomic_replace_database(&current_path, &partial).is_err() {
            return Err(SafeError::new("recovery.restore-failed", "恢复存档失败"));
        }
        partial_guard.disarm();
        pre_restore_guard.disarm();
        Ok(RestoreRecoveryResult {
            save_id: save_id.to_owned(),
            revision: restored_revision,
        })
    }

    /// Completes the filesystem half of a pending automatic recovery point
    /// before making that exact catalog row player-visible.  Both catalog
    /// directories are derived from the repository root; no caller controls a
    /// package path.
    #[allow(dead_code)]
    pub(crate) fn promote_pending_automatic_recovery_point(
        &self,
        save_id: &str,
        recovery_id: &RecoveryId,
    ) -> Result<(), SafeError> {
        validate_save_id(save_id).map_err(|_| SafeError::new("save.invalid-id", "存档标识无效"))?;
        let recovery_id =
            RecoveryId::parse(recovery_id.as_str()).map_err(|_| recovery_corrupt())?;
        let prepared = self.prepare_save_database(save_id)?;
        let mut connection =
            open_current_connection(&prepared.path).map_err(|_| recovery_corrupt())?;
        self.promote_pending_with_connection(&mut connection, &recovery_id)
    }

    fn promote_pending_with_connection(
        &self,
        connection: &mut Connection,
        recovery_id: &RecoveryId,
    ) -> Result<(), SafeError> {
        let metadata = read_promotable_recovery_metadata(connection, recovery_id)?;
        let pending_directory = self.root.join("recovery-pending");
        let recovery_directory = self.root.join("recovery-packages");
        ensure_recovery_directory(&pending_directory)?;
        ensure_recovery_directory(&recovery_directory)?;
        let package = crate::recovery::promote_database_preimage(
            &pending_directory,
            &recovery_directory,
            recovery_id,
        )
        .map_err(|_| recovery_corrupt())?;
        if !metadata.matches_package(&package) {
            return Err(recovery_corrupt());
        }
        if metadata.status == "ready" {
            return Ok(());
        }
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| recovery_corrupt())?;
        let changed = transaction
            .execute(
                "UPDATE recovery_points SET status='ready'
                 WHERE recovery_id=?1 AND status='pending'
                   AND relative_path=?2 AND package_sha256=?3 AND manifest_sha256=?4",
                params![
                    recovery_id.as_str(),
                    metadata.relative_path,
                    metadata.package_sha256,
                    metadata.manifest_sha256,
                ],
            )
            .map_err(|_| recovery_corrupt())?;
        if changed != 1 {
            return Err(recovery_corrupt());
        }
        transaction.commit().map_err(|_| recovery_corrupt())
    }

    fn replay_pending_recovery_points(&self, path: &Path) -> Result<(), SafeError> {
        let mut connection = open_current_connection(path).map_err(|_| recovery_corrupt())?;
        let recovery_ids = {
            let mut statement = connection
                .prepare(
                    "SELECT recovery_id FROM recovery_points
                     WHERE status='pending' AND kind='automatic'
                     ORDER BY created_at_ms,recovery_id",
                )
                .map_err(|_| recovery_corrupt())?;
            let ids = statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(|_| recovery_corrupt())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| recovery_corrupt())?;
            ids
        };
        for recovery_id in recovery_ids {
            let recovery_id = RecoveryId::parse(recovery_id).map_err(|_| recovery_corrupt())?;
            // A missing or damaged package must not make the active save
            // unavailable. It remains hidden as pending for diagnostics and a
            // later retry; verified crash leftovers are promoted immediately.
            let _ = self.promote_pending_with_connection(&mut connection, &recovery_id);
        }
        Ok(())
    }

    fn create_frozen_recovery_package(
        &self,
        source_path: &Path,
        recovery_id: &RecoveryId,
        error: fn() -> SafeError,
    ) -> Result<RecoveryPackage, SafeError> {
        let pending_directory = self.root.join("recovery-pending");
        ensure_recovery_directory(&pending_directory)?;
        let frozen = pending_directory.join(format!(".freeze-{}.sqlite3", Uuid::new_v4()));
        let mut guard = OwnedPartial::new(frozen.clone());
        online_backup_with_error(source_path, &frozen, error)?;
        sync_file(&frozen).map_err(|_| error())?;
        let package =
            crate::recovery::create_database_preimage(&frozen, &pending_directory, recovery_id)
                .map_err(|_| error())?;
        fs::remove_file(&frozen).map_err(|_| error())?;
        guard.disarm();
        Ok(package)
    }

    /// Keeps the newest twenty ready automatic recovery points.  It never
    /// considers manual/pre-migration points or incomplete records.  Every
    /// candidate package is verified before its catalog row is deleted; a
    /// missing, substituted, or malformed package therefore leaves the
    /// catalog entirely untouched.
    #[allow(dead_code)]
    pub(crate) fn rotate_ready_automatic_recovery_points(
        &self,
        save_id: &str,
    ) -> Result<(), SafeError> {
        const AUTOMATIC_RECOVERY_RETENTION: i64 = 20;

        validate_save_id(save_id).map_err(|_| SafeError::new("save.invalid-id", "存档标识无效"))?;
        let prepared = self.prepare_save_database(save_id)?;
        let mut connection =
            open_current_connection(&prepared.path).map_err(|_| recovery_corrupt())?;
        let candidates = read_rotation_candidates(&connection, AUTOMATIC_RECOVERY_RETENTION)?;
        if candidates.is_empty() {
            return Ok(());
        }

        let recovery_directory = self.root.join("recovery-packages");
        ensure_recovery_directory(&recovery_directory)?;
        for candidate in &candidates {
            candidate.verify_package(&recovery_directory)?;
        }

        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| recovery_corrupt())?;
        for candidate in &candidates {
            let deleted = transaction
                .execute(
                    "DELETE FROM recovery_points
                     WHERE recovery_id=?1 AND kind='automatic' AND status='ready'
                       AND relative_path=?2 AND package_sha256=?3 AND manifest_sha256=?4",
                    params![
                        candidate.recovery_id.as_str(),
                        candidate.relative_path,
                        candidate.package_sha256,
                        candidate.manifest_sha256,
                    ],
                )
                .map_err(|_| recovery_corrupt())?;
            if deleted != 1 {
                return Err(recovery_corrupt());
            }
        }
        transaction.commit().map_err(|_| recovery_corrupt())?;

        for candidate in &candidates {
            crate::recovery::remove_verified_database_preimage(
                &recovery_directory,
                &candidate.recovery_id,
                &candidate.package_sha256,
                &candidate.manifest_sha256,
            )
            .map_err(|_| recovery_corrupt())?;
        }
        Ok(())
    }

    fn default_display_name(&self) -> Result<String, SafeError> {
        let existing = self.list_saves()?;
        let used = existing
            .iter()
            .map(|save| save.display_name.as_str())
            .collect::<HashSet<_>>();
        for ordinal in 1..=10_000 {
            let candidate = format!("云岫酒店 {ordinal}");
            if !used.contains(candidate.as_str()) {
                return Ok(candidate);
            }
        }
        Err(SafeError::new("save.conflict", "无法生成存档名称"))
    }

    pub fn commit_game(&self, expected_revision: i64, game: Value) -> Result<(), String> {
        if expected_revision < 0 {
            return Err("存档版本无效".to_string());
        }
        let fields = validate_game(&game)?;
        let save_id = fields.save_id.clone();
        let path = self.db_path(&save_id);
        let database_existed =
            existing_regular_database(&path).map_err(|error| error.to_string())?;
        if database_existed {
            preflight_supported_identity(&path).map_err(|error| error.to_string())?;
        }
        let control_connection = self
            .bootstrap_provider_control()
            .map_err(|error| error.to_string())?;
        let directory = path.parent().ok_or_else(|| "存档目录无效".to_string())?;
        ensure_save_directory(directory).map_err(|error| error.to_string())?;
        let _save_lock = lock_save(directory).map_err(|error| error.to_string())?;
        prepare_database_file(&path, &save_id, true).map_err(|error| error.to_string())?;
        let mut conn = open_current_connection(&path).map_err(|error| error.to_string())?;
        validate_opened_save(&conn, &path, &save_id, expected_revision == 0)
            .map_err(|error| error.to_string())?;
        validate_issued_grants_for_save(&conn, &control_connection, &save_id)
            .map_err(|error| error.to_string())?;
        let current_before_write: i64 = conn
            .query_row(
                "SELECT revision FROM saves WHERE save_id=?1",
                [&save_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_err)?
            .unwrap_or(0);
        let next_revision = expected_revision
            .checked_add(1)
            .ok_or_else(|| "存档版本无效".to_string())?;
        if current_before_write != expected_revision || fields.revision != next_revision {
            return Err("存档已更新，请重新加载".to_string());
        }
        let recovery_reason = load_game_from_connection(&conn, &save_id)?
            .as_ref()
            .and_then(|previous| detect_recovery_reason(previous, &game));
        let mut recovery_guard = if let Some(reason) = recovery_reason {
            let recovery_id = RecoveryId::parse(format!("automatic-{}", Uuid::new_v4()))
                .map_err(|_| "无法创建恢复点".to_string())?;
            let package = self
                .create_frozen_recovery_package(&path, &recovery_id, recovery_corrupt)
                .map_err(|error| error.to_string())?;
            Some(PendingPackageGuard::new(recovery_id, package, reason))
        } else {
            None
        };
        let tx = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_err)?;
        let current: Option<i64> = tx
            .query_row(
                "SELECT revision FROM saves WHERE save_id=?1",
                [&save_id],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_err)?;
        let current = current.unwrap_or(0);
        if current != expected_revision || fields.revision != next_revision {
            return Err("存档已更新，请重新加载".to_string());
        }
        tx.execute("INSERT INTO saves(save_id,schema_version,ruleset_version,revision,phase,current_day,cash_cents,rate_cents,phase2_json,latest_report_json,operations_json,phase4_json,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,datetime('now')) ON CONFLICT(save_id) DO UPDATE SET schema_version=excluded.schema_version,ruleset_version=excluded.ruleset_version,revision=excluded.revision,phase=excluded.phase,current_day=excluded.current_day,cash_cents=excluded.cash_cents,rate_cents=excluded.rate_cents,phase2_json=excluded.phase2_json,latest_report_json=excluded.latest_report_json,operations_json=excluded.operations_json,phase4_json=excluded.phase4_json,updated_at=excluded.updated_at", params![save_id, fields.schema_version, fields.ruleset, fields.revision, fields.phase, fields.current_day, fields.cash_cents, fields.rate_cents, fields.phase2, fields.latest_report, fields.operations, fields.phase4]).map_err(db_err)?;
        tx.execute(
            "INSERT OR IGNORE INTO save_metadata(
               save_id,display_name,created_at_ms,renamed_at_ms,metadata_revision
             ) VALUES(?1,'云岫酒店 1',0,0,0)",
            [&save_id],
        )
        .map_err(db_err)?;
        tx.execute("DELETE FROM room_instances WHERE save_id=?1", [&save_id])
            .map_err(db_err)?;
        tx.execute("DELETE FROM room_blueprints WHERE save_id=?1", [&save_id])
            .map_err(db_err)?;
        if let Some(bp) = fields.blueprint {
            tx.execute("INSERT INTO room_blueprints(save_id,blueprint_id,name,columns_count,rows_count,cells_json,metrics_json,visual_json,openings_json) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)", params![save_id,bp.id,bp.name,bp.columns,bp.rows,bp.cells,bp.metrics,bp.visual,bp.openings]).map_err(db_err)?;
        }
        for (ordinal, room) in fields.rooms.into_iter().enumerate() {
            tx.execute("INSERT INTO room_instances(save_id,instance_id,slot_id,blueprint_id,ordinal,committed_build_cost_cents) VALUES(?1,?2,?3,?4,?5,?6)", params![save_id,room.id,room.slot,room.blueprint,ordinal as i64,room.cost]).map_err(db_err)?;
        }
        tx.execute("DELETE FROM daily_reports WHERE save_id=?1", [&save_id])
            .map_err(db_err)?;
        for (day, report) in fields.reports {
            tx.execute(
                "INSERT INTO daily_reports(save_id,game_day,report_json) VALUES(?1,?2,?3)",
                params![save_id, day, report],
            )
            .map_err(db_err)?;
        }
        if let Some(recovery) = recovery_guard.as_ref() {
            record_pending_automatic_recovery_point(
                &tx,
                &recovery.recovery_id,
                &recovery.package,
                next_revision,
                expected_revision,
                recovery.reason,
            )
            .map_err(|error| error.to_string())?;
        }
        tx.commit().map_err(db_err)?;
        if let Some(recovery) = recovery_guard.as_mut() {
            recovery.disarm();
        }
        drop(conn);
        drop(_save_lock);
        if let Some(recovery) = recovery_guard.as_ref() {
            let _ = self.promote_pending_automatic_recovery_point(&save_id, &recovery.recovery_id);
            let _ = self.rotate_ready_automatic_recovery_points(&save_id);
        }
        Ok(())
    }

    fn db_path(&self, save_id: &str) -> PathBuf {
        self.root.join("saves").join(save_id).join("save.sqlite3")
    }

    pub(crate) fn prepare_save_database(
        &self,
        save_id: &str,
    ) -> Result<PreparedSaveDatabase, SafeError> {
        validate_save_id(save_id).map_err(|_| SafeError::new("save.invalid-id", "存档标识无效"))?;
        let path = self.db_path(save_id);
        let directory = path
            .parent()
            .ok_or_else(|| SafeError::new("migration.failed", "存档目录无效"))?;
        validate_existing_save_directory(directory)?;
        if existing_regular_database(&path)? {
            preflight_supported_identity(&path)?;
        }
        let control_connection = self.bootstrap_provider_control()?;
        let save_lock = lock_save(directory)?;
        prepare_database_file(&path, save_id, false)?;
        let validation_connection = open_read_only(&path, "migration.validation-failed")?;
        validate_opened_save(&validation_connection, &path, save_id, false)?;
        validate_issued_grants_for_save(&validation_connection, &control_connection, save_id)?;
        drop(validation_connection);
        self.replay_pending_recovery_points(&path)?;
        Ok(PreparedSaveDatabase {
            path,
            control_connection,
            _save_lock: save_lock,
        })
    }

    #[cfg(test)]
    fn prepare_for_commit(&self, save_id: &str) -> Result<(), SafeError> {
        validate_save_id(save_id).map_err(|_| SafeError::new("save.invalid-id", "存档标识无效"))?;
        let path = self.db_path(save_id);
        if existing_regular_database(&path)? {
            preflight_supported_identity(&path)?;
        }
        drop(self.bootstrap_provider_control()?);
        let directory = path
            .parent()
            .ok_or_else(|| SafeError::new("migration.failed", "存档目录无效"))?;
        ensure_save_directory(directory)?;
        let _save_lock = lock_save(directory)?;
        prepare_database_file(&path, save_id, true)
    }

    fn bootstrap_provider_control(&self) -> Result<Connection, SafeError> {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| SafeError::new("provider.control-invalid", "系统时间无效"))?
            .as_millis()
            .try_into()
            .map_err(|_| SafeError::new("provider.control-invalid", "系统时间无效"))?;
        ProviderControlStore::new(self.root.clone()).bootstrap(now_ms)
    }

    fn open_existing(&self, save_id: &str) -> Result<Connection, String> {
        let prepared = self
            .prepare_save_database(save_id)
            .map_err(|error| error.to_string())?;
        let connection =
            open_current_connection(&prepared.path).map_err(|error| error.to_string())?;
        validate_opened_save(&connection, &prepared.path, save_id, false)
            .map_err(|error| error.to_string())?;
        validate_issued_grants_for_save(&connection, &prepared.control_connection, save_id)
            .map_err(|error| error.to_string())?;
        Ok(connection)
    }

    #[cfg(test)]
    fn open_for_commit(&self, save_id: &str) -> Result<Connection, String> {
        let path = self.db_path(save_id);
        self.prepare_for_commit(save_id)
            .map_err(|error| error.to_string())?;
        open_current_connection(&path).map_err(|error| error.to_string())
    }

    #[cfg(test)]
    fn open(&self, save_id: &str) -> Result<Connection, String> {
        self.open_for_commit(save_id)
    }
}

#[derive(Debug)]
struct ExportMetadata {
    display_name: String,
    schema_version: u32,
    ruleset_version: String,
}

#[derive(Debug)]
struct ExportAsset {
    asset_id: String,
    relative_path: String,
    sha256: String,
    mime_type: String,
    byte_length: u64,
    width: u32,
    height: u32,
}

fn read_export_metadata(
    connection: &Connection,
    save_id: &str,
) -> Result<ExportMetadata, SafeError> {
    let schema_version = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .map_err(|_| archive_export_failed())?
        .try_into()
        .map_err(|_| archive_export_failed())?;
    let (display_name, ruleset_version) = connection
        .query_row(
            "SELECT metadata.display_name,saves.ruleset_version
             FROM saves JOIN save_metadata AS metadata USING(save_id)
             WHERE saves.save_id=?1",
            [save_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .map_err(|_| archive_export_failed())?;
    Ok(ExportMetadata {
        display_name,
        schema_version,
        ruleset_version,
    })
}

fn read_export_assets(connection: &Connection) -> Result<Vec<ExportAsset>, SafeError> {
    let mut statement = connection
        .prepare(
            "SELECT asset_id,relative_path,sha256,mime_type,byte_length,width,height
             FROM assets ORDER BY relative_path,asset_id",
        )
        .map_err(|_| archive_export_failed())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
            ))
        })
        .map_err(|_| archive_export_failed())?;
    let mut assets = Vec::new();
    for row in rows {
        let (asset_id, relative_path, sha256, mime_type, byte_length, width, height) =
            row.map_err(|_| archive_export_failed())?;
        validate_stored_asset_path(&relative_path, &sha256, &mime_type)
            .map_err(|_| archive_export_failed())?;
        assets.push(ExportAsset {
            asset_id,
            relative_path,
            sha256,
            mime_type,
            byte_length: byte_length
                .try_into()
                .map_err(|_| archive_export_failed())?,
            width: width.try_into().map_err(|_| archive_export_failed())?,
            height: height.try_into().map_err(|_| archive_export_failed())?,
        });
    }
    Ok(assets)
}

fn copy_export_asset(
    source: &Path,
    destination: &Path,
    asset: &ExportAsset,
) -> Result<(), SafeError> {
    let source_metadata = fs::symlink_metadata(source).map_err(|_| archive_export_failed())?;
    if source_metadata.file_type().is_symlink()
        || !source_metadata.is_file()
        || source_metadata.len() != asset.byte_length
    {
        return Err(archive_export_failed());
    }
    let parent = destination.parent().ok_or_else(archive_export_failed)?;
    fs::create_dir_all(parent).map_err(|_| archive_export_failed())?;
    let mut input = OpenOptions::new()
        .read(true)
        .open(source)
        .map_err(|_| archive_export_failed())?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|_| archive_export_failed())?;
    std::io::copy(&mut input, &mut output).map_err(|_| archive_export_failed())?;
    output.sync_all().map_err(|_| archive_export_failed())?;
    if output
        .metadata()
        .map_err(|_| archive_export_failed())?
        .len()
        != asset.byte_length
        || sha256_file(destination).map_err(|_| archive_export_failed())? != asset.sha256
    {
        return Err(archive_export_failed());
    }
    Ok(())
}

fn suggested_archive_filename(display_name: &str) -> String {
    let safe = display_name
        .chars()
        .map(|character| {
            if character.is_control() || matches!(character, '/' | '\\' | ':' | '*') {
                '_'
            } else {
                character
            }
        })
        .take(60)
        .collect::<String>();
    format!("{safe}.cloudinn")
}

struct OwnedDirectory {
    path: Option<PathBuf>,
}

impl OwnedDirectory {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    fn remove_now(&mut self) -> Result<(), SafeError> {
        if let Some(path) = self.path.take() {
            fs::remove_dir_all(path).map_err(|_| archive_export_failed())?;
        }
        Ok(())
    }
}

impl Drop for OwnedDirectory {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = fs::remove_dir_all(path);
        }
    }
}

fn ensure_export_directory(directory: &Path) -> Result<(), SafeError> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(archive_export_failed())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(directory).map_err(|_| archive_export_failed())
        }
        Err(_) => Err(archive_export_failed()),
    }
}

fn archive_export_failed() -> SafeError {
    SafeError::new("archive.export-failed", "无法导出存档")
}

fn seal_export_archive(archive: &TemporaryArchive) -> Result<(), SafeError> {
    let metadata = fs::symlink_metadata(&archive.path).map_err(|_| archive_export_failed())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() != archive.byte_length
        || sha256_file(&archive.path).map_err(|_| archive_export_failed())? != archive.sha256
    {
        return Err(archive_export_failed());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&archive.path, fs::Permissions::from_mode(0o444))
            .map_err(|_| archive_export_failed())?;
    }
    sync_file(&archive.path).map_err(|_| archive_export_failed())
}

fn remove_temporary_archive(archive: &TemporaryArchive) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&archive.path, fs::Permissions::from_mode(0o600));
    }
    let _ = fs::remove_file(&archive.path);
}

fn read_save_summary(connection: &Connection, save_id: &str) -> Result<SaveSummary, SafeError> {
    connection.query_row(
        "SELECT metadata.display_name,metadata.metadata_revision,saves.revision,saves.current_day,
                (SELECT count(*) FROM room_instances WHERE save_id=saves.save_id),
                EXISTS(SELECT 1 FROM recovery_points WHERE status='ready'),
                MAX(metadata.created_at_ms, metadata.renamed_at_ms)
         FROM saves
         JOIN save_metadata AS metadata ON metadata.save_id=saves.save_id
         WHERE saves.save_id=?1",
        [save_id],
        |row| Ok(SaveSummary {
            save_id: save_id.to_owned(),
            display_name: row.get(0)?,
            metadata_revision: row.get(1)?,
            game_revision: row.get(2)?,
            current_day: row.get(3)?,
            room_count: row.get(4)?,
            schema_healthy: true,
            recovery_available: row.get(5)?,
            last_played_at_ms: row.get(6)?,
        }),
    ).map_err(|_| SafeError::new("save.not-found", "存档不存在"))
}

fn read_ready_recovery_points(
    connection: &Connection,
) -> Result<Vec<RecoveryPointSummary>, SafeError> {
    let mut statement = connection
        .prepare(
            "SELECT recovery_id,kind,origin_commit_revision,restore_revision,reason,
                    relative_path,package_sha256,manifest_sha256,created_at_ms
             FROM recovery_points
             WHERE status='ready'
             ORDER BY created_at_ms DESC,recovery_id ASC",
        )
        .map_err(|_| recovery_corrupt())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<String>>(7)?,
                row.get::<_, i64>(8)?,
            ))
        })
        .map_err(|_| recovery_corrupt())?;
    let mut points = Vec::new();
    for row in rows {
        let (
            recovery_id,
            kind,
            origin_commit_revision,
            restore_revision,
            reason,
            relative_path,
            package_sha256,
            manifest_sha256,
            created_at_ms,
        ) = row.map_err(|_| recovery_corrupt())?;
        points.push(validate_ready_recovery_point(
            recovery_id,
            kind,
            origin_commit_revision,
            restore_revision,
            reason,
            relative_path,
            package_sha256,
            manifest_sha256,
            created_at_ms,
        )?);
    }
    Ok(points)
}

fn read_ready_recovery_metadata(
    connection: &Connection,
    recovery_id: &RecoveryId,
) -> Result<ReadyRecoveryMetadata, SafeError> {
    let row = connection
        .query_row(
            "SELECT restore_revision,relative_path,package_sha256,manifest_sha256
             FROM recovery_points WHERE recovery_id=?1 AND status='ready'",
            [recovery_id.as_str()],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|_| recovery_corrupt())?
        .ok_or_else(|| SafeError::new("recovery.not-found", "恢复点不存在"))?;
    let manifest_sha256 = row.3.ok_or_else(recovery_corrupt)?;
    if row.0 < 0
        || !valid_recovery_relative_path(&row.1)
        || !valid_recovery_sha256(&row.2)
        || !valid_recovery_sha256(&manifest_sha256)
    {
        return Err(recovery_corrupt());
    }
    Ok(ReadyRecoveryMetadata {
        restore_revision: row.0,
        relative_path: row.1,
        package_sha256: row.2,
        manifest_sha256,
    })
}

fn read_save_revision(path: &Path, save_id: &str) -> Result<i64, SafeError> {
    let connection = open_read_only(path, "recovery.corrupt")?;
    read_save_revision_from_connection(&connection, save_id)
}

fn read_save_revision_from_connection(
    connection: &Connection,
    save_id: &str,
) -> Result<i64, SafeError> {
    connection
        .query_row(
            "SELECT revision FROM saves WHERE save_id=?1",
            [save_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| recovery_corrupt())
}

fn validate_restore_candidate(path: &Path, save_id: &str) -> Result<(), SafeError> {
    let connection = open_read_only(path, "recovery.restore-failed")?;
    validate_current_save_database(&connection)
        .map_err(|_| SafeError::new("recovery.restore-failed", "恢复存档失败"))?;
    validate_opened_save(&connection, path, save_id, false)
        .map_err(|_| SafeError::new("recovery.restore-failed", "恢复存档失败"))
}

#[derive(Debug)]
struct RecoveryRotationCandidate {
    recovery_id: RecoveryId,
    relative_path: String,
    package_sha256: String,
    manifest_sha256: String,
}

struct PendingPackageGuard {
    recovery_id: RecoveryId,
    package: RecoveryPackage,
    reason: RecoveryReason,
    armed: bool,
}

impl PendingPackageGuard {
    fn new(recovery_id: RecoveryId, package: RecoveryPackage, reason: RecoveryReason) -> Self {
        Self {
            recovery_id,
            package,
            reason,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for PendingPackageGuard {
    fn drop(&mut self) {
        if self.armed {
            cleanup_verified_package(&self.package, &self.recovery_id);
        }
    }
}

#[derive(Debug)]
struct ReadyRecoveryMetadata {
    restore_revision: i64,
    relative_path: String,
    package_sha256: String,
    manifest_sha256: String,
}

impl ReadyRecoveryMetadata {
    fn verify_package(
        &self,
        recovery_directory: &Path,
        recovery_id: &RecoveryId,
    ) -> Result<RecoveryPackage, SafeError> {
        if self.relative_path != format!("recovery-packages/{}", recovery_id.as_str()) {
            return Err(recovery_corrupt());
        }
        let package = crate::recovery::verify_database_preimage(
            &recovery_directory.join(recovery_id.as_str()),
        )
        .map_err(|_| recovery_corrupt())?;
        if package.package_sha256 != self.package_sha256
            || package.manifest_sha256 != self.manifest_sha256
        {
            return Err(recovery_corrupt());
        }
        Ok(package)
    }
}

impl RecoveryRotationCandidate {
    fn verify_package(&self, recovery_directory: &Path) -> Result<(), SafeError> {
        let expected_relative_path = format!("recovery-packages/{}", self.recovery_id.as_str());
        if self.relative_path != expected_relative_path {
            return Err(recovery_corrupt());
        }
        let package_path = recovery_directory.join(self.recovery_id.as_str());
        let package = crate::recovery::verify_database_preimage(&package_path)
            .map_err(|_| recovery_corrupt())?;
        if package.package_sha256 != self.package_sha256
            || package.manifest_sha256 != self.manifest_sha256
        {
            return Err(recovery_corrupt());
        }
        Ok(())
    }
}

fn read_rotation_candidates(
    connection: &Connection,
    retention: i64,
) -> Result<Vec<RecoveryRotationCandidate>, SafeError> {
    let mut statement = connection
        .prepare(
            "SELECT recovery_id,relative_path,package_sha256,manifest_sha256
             FROM recovery_points
             WHERE kind='automatic' AND status='ready'
             ORDER BY created_at_ms DESC,recovery_id DESC
             LIMIT -1 OFFSET ?1",
        )
        .map_err(|_| recovery_corrupt())?;
    let rows = statement
        .query_map([retention], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|_| recovery_corrupt())?;
    let mut candidates = Vec::new();
    for row in rows {
        let (recovery_id, relative_path, package_sha256, manifest_sha256) =
            row.map_err(|_| recovery_corrupt())?;
        let recovery_id = RecoveryId::parse(recovery_id).map_err(|_| recovery_corrupt())?;
        let manifest_sha256 = manifest_sha256.ok_or_else(recovery_corrupt)?;
        if !valid_recovery_relative_path(&relative_path)
            || !valid_recovery_sha256(&package_sha256)
            || !valid_recovery_sha256(&manifest_sha256)
        {
            return Err(recovery_corrupt());
        }
        candidates.push(RecoveryRotationCandidate {
            recovery_id,
            relative_path,
            package_sha256,
            manifest_sha256,
        });
    }
    Ok(candidates)
}

#[allow(clippy::too_many_arguments)]
fn validate_ready_recovery_point(
    recovery_id: String,
    kind: String,
    origin_commit_revision: Option<i64>,
    restore_revision: i64,
    reason: String,
    relative_path: String,
    package_sha256: String,
    manifest_sha256: Option<String>,
    created_at_ms: i64,
) -> Result<RecoveryPointSummary, SafeError> {
    let recovery_id = RecoveryId::parse(recovery_id).map_err(|_| recovery_corrupt())?;
    let reason = RecoveryReason::parse_storage_value(&reason).map_err(|_| recovery_corrupt())?;
    let valid_kind = matches!(kind.as_str(), "automatic" | "pre-upgrade" | "pre-restore");
    let valid_origin = match kind.as_str() {
        "automatic" => origin_commit_revision.is_some_and(|revision| revision >= 0),
        "pre-upgrade" | "pre-restore" => {
            origin_commit_revision.is_none_or(|revision| revision >= 0)
        }
        _ => false,
    };
    if !valid_kind
        || !valid_origin
        || restore_revision < 0
        || created_at_ms < 0
        || !valid_recovery_relative_path(&relative_path)
        || !valid_recovery_sha256(&package_sha256)
        || manifest_sha256
            .as_deref()
            .is_some_and(|digest| !valid_recovery_sha256(digest))
    {
        return Err(recovery_corrupt());
    }
    Ok(RecoveryPointSummary {
        recovery_id: recovery_id.as_str().to_owned(),
        kind,
        restore_revision,
        reason: reason.as_storage_value().to_owned(),
        created_at_ms,
    })
}

fn valid_recovery_relative_path(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= crate::recovery::MAX_PAYLOAD_PATH_LENGTH
        && !value.starts_with('/')
        && !value.contains(['\\', '\0'])
        && !value.contains("..")
}

fn valid_recovery_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[derive(Debug)]
struct PromotableRecoveryMetadata {
    status: String,
    relative_path: String,
    package_sha256: String,
    manifest_sha256: String,
}

impl PromotableRecoveryMetadata {
    fn matches_package(&self, package: &RecoveryPackage) -> bool {
        package.package_sha256 == self.package_sha256
            && package.manifest_sha256 == self.manifest_sha256
    }
}

fn read_promotable_recovery_metadata(
    connection: &Connection,
    recovery_id: &RecoveryId,
) -> Result<PromotableRecoveryMetadata, SafeError> {
    let row = connection
        .query_row(
            "SELECT kind,origin_commit_revision,restore_revision,reason,status,
                    relative_path,package_sha256,manifest_sha256,created_at_ms
             FROM recovery_points WHERE recovery_id=?1",
            [recovery_id.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<i64>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, i64>(8)?,
                ))
            },
        )
        .optional()
        .map_err(|_| recovery_corrupt())?
        .ok_or_else(recovery_corrupt)?;
    let (
        kind,
        origin_commit_revision,
        restore_revision,
        reason,
        status,
        relative_path,
        package_sha256,
        manifest_sha256,
        created_at_ms,
    ) = row;
    let expected_relative_path = format!("recovery-packages/{}", recovery_id.as_str());
    let valid_kind = kind == "automatic";
    let valid_origin = origin_commit_revision
        .is_some_and(|revision| revision >= 0 && restore_revision.checked_add(1) == Some(revision));
    let manifest_sha256 = manifest_sha256.ok_or_else(recovery_corrupt)?;
    if !valid_kind
        || !valid_origin
        || restore_revision < 0
        || created_at_ms < 0
        || RecoveryReason::parse_storage_value(&reason).is_err()
        || !matches!(status.as_str(), "pending" | "ready")
        || relative_path != expected_relative_path
        || !valid_recovery_relative_path(&relative_path)
        || !valid_recovery_sha256(&package_sha256)
        || !valid_recovery_sha256(&manifest_sha256)
    {
        return Err(recovery_corrupt());
    }
    Ok(PromotableRecoveryMetadata {
        status,
        relative_path,
        package_sha256,
        manifest_sha256,
    })
}

fn ensure_recovery_directory(directory: &Path) -> Result<(), SafeError> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(recovery_corrupt())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(directory).map_err(|_| recovery_corrupt())?;
            let metadata = fs::symlink_metadata(directory).map_err(|_| recovery_corrupt())?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(recovery_corrupt());
            }
            Ok(())
        }
        Err(_) => Err(recovery_corrupt()),
    }
}

fn recovery_corrupt() -> SafeError {
    SafeError::new("recovery.corrupt", "恢复点记录无效")
}

/// Persists the catalog half of an asset publish. Callers must have already
/// placed `asset` at its canonical path with [`AssetStore`], and must commit
/// the transaction themselves. Keeping this crate-private transaction API
/// separate from byte publication lets job coordination atomically attach an
/// asset reference alongside its own state transition.
pub(crate) fn persist_verified_asset_reference(
    transaction: &rusqlite::Transaction<'_>,
    asset: &StoredAsset,
    owner_kind: &str,
    owner_id: &str,
) -> Result<String, SafeError> {
    validate_asset_owner(owner_kind, owner_id)?;
    validate_verified_stored_asset(asset)?;
    let asset_id = asset.sha256.clone();
    let created_at_ms = current_time_ms()?;

    transaction
        .execute(
            "INSERT INTO assets(
               asset_id,relative_path,sha256,mime_type,byte_length,width,height,created_at_ms
            ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8)
             ON CONFLICT(asset_id) DO NOTHING",
            params![
                &asset_id,
                &asset.relative_path,
                &asset.sha256,
                &asset.mime_type,
                i64::try_from(asset.byte_length)
                    .map_err(|_| SafeError::new("save.corrupt", "资源内容无效"))?,
                i64::from(asset.width),
                i64::from(asset.height),
                created_at_ms,
            ],
        )
        .map_err(|_| SafeError::new("save.corrupt", "无法记录资源"))?;

    let (relative_path, sha256, mime_type, byte_length, width, height): (
        String,
        String,
        String,
        i64,
        i64,
        i64,
    ) = transaction
        .query_row(
            "SELECT relative_path,sha256,mime_type,byte_length,width,height
             FROM assets WHERE asset_id=?1",
            [&asset_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .map_err(|_| SafeError::new("save.corrupt", "资源记录无效"))?;
    let recorded = StoredAsset {
        sha256,
        relative_path,
        mime_type,
        byte_length: byte_length
            .try_into()
            .map_err(|_| SafeError::new("save.corrupt", "资源记录无效"))?,
        width: width
            .try_into()
            .map_err(|_| SafeError::new("save.corrupt", "资源记录无效"))?,
        height: height
            .try_into()
            .map_err(|_| SafeError::new("save.corrupt", "资源记录无效"))?,
    };
    if recorded != *asset || validate_verified_stored_asset(&recorded).is_err() {
        return Err(SafeError::new("save.corrupt", "资源记录无效"));
    }

    transaction
        .execute(
            "INSERT INTO asset_references(owner_kind,owner_id,asset_id)
             VALUES(?1,?2,?3)
             ON CONFLICT(owner_kind,owner_id,asset_id) DO NOTHING",
            params![owner_kind, owner_id, &asset_id],
        )
        .map_err(|_| SafeError::new("save.corrupt", "无法记录资源引用"))?;
    Ok(asset_id)
}

fn validate_asset_owner(owner_kind: &str, owner_id: &str) -> Result<(), SafeError> {
    if owner_kind.is_empty()
        || owner_kind.len() > 64
        || !owner_kind
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte == b'-')
        || owner_id.is_empty()
        || owner_id.len() > 256
    {
        return Err(SafeError::new("save.corrupt", "资源引用无效"));
    }
    Ok(())
}

fn validate_verified_stored_asset(asset: &StoredAsset) -> Result<(), SafeError> {
    validate_stored_asset_path(&asset.relative_path, &asset.sha256, &asset.mime_type)
        .map_err(|_| SafeError::new("save.corrupt", "资源内容无效"))?;
    if !(1..=100_663_296).contains(&asset.byte_length)
        || !(1..=16_384).contains(&asset.width)
        || !(1..=16_384).contains(&asset.height)
    {
        return Err(SafeError::new("save.corrupt", "资源内容无效"));
    }
    Ok(())
}

/// Records the durable outbox half of an automatic recovery point. The caller
/// owns the surrounding game transaction, so the recovery row cannot become
/// visible unless the revision it protects commits with it.
///
/// The package has already been constructed and verified on disk by
/// `recovery`; this boundary still validates all values persisted into SQLite
/// and derives the catalog path from the opaque identifier rather than from a
/// filesystem path supplied by a caller.
#[allow(dead_code)]
pub(crate) fn record_pending_automatic_recovery_point(
    transaction: &rusqlite::Transaction<'_>,
    recovery_id: &RecoveryId,
    package: &RecoveryPackage,
    origin_commit_revision: i64,
    restore_revision: i64,
    reason: RecoveryReason,
) -> Result<(), SafeError> {
    let recovery_id = RecoveryId::parse(recovery_id.as_str()).map_err(|_| recovery_corrupt())?;
    if package.path.file_name().and_then(|name| name.to_str()) != Some(recovery_id.as_str()) {
        return Err(recovery_corrupt());
    }
    let verified_package =
        crate::recovery::verify_database_preimage(&package.path).map_err(|_| recovery_corrupt())?;
    let expected_origin_revision = restore_revision
        .checked_add(1)
        .ok_or_else(recovery_corrupt)?;
    if origin_commit_revision != expected_origin_revision
        || !valid_recovery_sha256(&verified_package.package_sha256)
        || !valid_recovery_sha256(&verified_package.manifest_sha256)
    {
        return Err(recovery_corrupt());
    }
    let created_at_ms = current_time_ms()?;
    let relative_path = format!("recovery-packages/{}", recovery_id.as_str());
    if !valid_recovery_relative_path(&relative_path) {
        return Err(recovery_corrupt());
    }
    transaction
        .execute(
            "INSERT INTO recovery_points(
               recovery_id,kind,origin_commit_revision,restore_revision,reason,status,
               relative_path,package_sha256,manifest_sha256,created_at_ms
             ) VALUES(?1,'automatic',?2,?3,?4,'pending',?5,?6,?7,?8)",
            params![
                recovery_id.as_str(),
                origin_commit_revision,
                restore_revision,
                reason.as_storage_value(),
                relative_path,
                verified_package.package_sha256,
                verified_package.manifest_sha256,
                created_at_ms,
            ],
        )
        .map_err(|_| recovery_corrupt())?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
fn record_ready_recovery_point(
    transaction: &rusqlite::Transaction<'_>,
    recovery_id: &RecoveryId,
    package: &RecoveryPackage,
    kind: &str,
    origin_commit_revision: Option<i64>,
    restore_revision: i64,
    reason: RecoveryReason,
) -> Result<(), SafeError> {
    if !matches!(kind, "pre-upgrade" | "pre-restore")
        || origin_commit_revision.is_some_and(|revision| revision < 0)
        || restore_revision < 0
    {
        return Err(recovery_corrupt());
    }
    let verified =
        crate::recovery::verify_database_preimage(&package.path).map_err(|_| recovery_corrupt())?;
    if verified != *package
        || package.path.file_name().and_then(|name| name.to_str()) != Some(recovery_id.as_str())
    {
        return Err(recovery_corrupt());
    }
    let relative_path = format!("recovery-packages/{}", recovery_id.as_str());
    transaction
        .execute(
            "INSERT INTO recovery_points(
               recovery_id,kind,origin_commit_revision,restore_revision,reason,status,
               relative_path,package_sha256,manifest_sha256,created_at_ms
             ) VALUES(?1,?2,?3,?4,?5,'ready',?6,?7,?8,?9)",
            params![
                recovery_id.as_str(),
                kind,
                origin_commit_revision,
                restore_revision,
                reason.as_storage_value(),
                relative_path,
                verified.package_sha256,
                verified.manifest_sha256,
                current_time_ms()?,
            ],
        )
        .map_err(|_| recovery_corrupt())?;
    Ok(())
}

fn cleanup_verified_package(package: &RecoveryPackage, recovery_id: &RecoveryId) {
    if let Some(directory) = package.path.parent() {
        let _ = crate::recovery::remove_verified_database_preimage(
            directory,
            recovery_id,
            &package.package_sha256,
            &package.manifest_sha256,
        );
    }
}

fn detect_recovery_reason(previous: &Value, next: &Value) -> Option<RecoveryReason> {
    if previous.get("roomBlueprint") != next.get("roomBlueprint")
        || previous.pointer("/floor/rooms") != next.pointer("/floor/rooms")
    {
        return Some(RecoveryReason::Construction);
    }
    if previous.get("currentDay") != next.get("currentDay")
        || previous.get("reports") != next.get("reports")
        || previous.get("latestReport") != next.get("latestReport")
    {
        return Some(RecoveryReason::Settlement);
    }
    if previous.get("phase4") != next.get("phase4") {
        return Some(RecoveryReason::VisualAdoption);
    }
    None
}

fn current_time_ms() -> Result<i64, SafeError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| SafeError::new("save.corrupt", "系统时间无效"))?
        .as_millis()
        .try_into()
        .map_err(|_| SafeError::new("save.corrupt", "系统时间无效"))
}

fn load_game_from_connection(conn: &Connection, save_id: &str) -> Result<Option<Value>, String> {
    let row = conn
        .query_row(
            "SELECT schema_version,ruleset_version,revision,phase,current_day,cash_cents,rate_cents,phase2_json,latest_report_json,operations_json,phase4_json FROM saves WHERE save_id=?1",
            [save_id],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                ))
            },
        )
        .optional()
        .map_err(db_err)?;
    let Some((
        schema,
        ruleset,
        revision,
        phase,
        day,
        cash,
        rate,
        phase2,
        latest,
        operations,
        phase4,
    )) = row
    else {
        return Ok(None);
    };
    let blueprint = conn
        .query_row("SELECT blueprint_id,name,columns_count,rows_count,cells_json,metrics_json,visual_json,openings_json FROM room_blueprints WHERE save_id=?1", [save_id], |row| {
            let mut blueprint = json!({"id":row.get::<_,String>(0)?,"name":row.get::<_,String>(1)?,"columns":row.get::<_,i64>(2)?,"rows":row.get::<_,i64>(3)?,"cells":serde_json::from_str::<Value>(&row.get::<_,String>(4)?).map_err(|_| rusqlite::Error::InvalidQuery)?,"metrics":serde_json::from_str::<Value>(&row.get::<_,String>(5)?).map_err(|_| rusqlite::Error::InvalidQuery)?,"visual":serde_json::from_str::<Value>(&row.get::<_,String>(6)?).map_err(|_| rusqlite::Error::InvalidQuery)?});
            if let Some(raw) = row.get::<_,Option<String>>(7)? {
                blueprint["openings"] = serde_json::from_str::<Value>(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
            }
            Ok(blueprint)
        }).optional().map_err(db_err)?;
    let mut rooms = Vec::new();
    let mut statement = conn.prepare("SELECT instance_id,slot_id,blueprint_id,committed_build_cost_cents FROM room_instances WHERE save_id=?1 ORDER BY ordinal").map_err(db_err)?;
    let rows = statement.query_map([save_id], |row| Ok(json!({"id":row.get::<_,String>(0)?,"slotId":row.get::<_,String>(1)?,"roomBlueprintId":row.get::<_,String>(2)?,"committedBuildCostCents":row.get::<_,i64>(3)?}))).map_err(db_err)?;
    for room in rows {
        rooms.push(room.map_err(db_err)?);
    }
    let mut reports = Vec::new();
    let mut statement = conn
        .prepare("SELECT report_json FROM daily_reports WHERE save_id=?1 ORDER BY game_day")
        .map_err(db_err)?;
    let rows = statement
        .query_map([save_id], |row| row.get::<_, String>(0))
        .map_err(db_err)?;
    for report in rows {
        reports.push(parse_json(report.map_err(db_err)?)?);
    }
    let latest_value = latest.map(parse_json).transpose()?;
    let mut game = json!({"schemaVersion":schema,"rulesetVersion":ruleset,"saveId":save_id,"revision":revision,"phase":phase,"currentDay":day,"cashCents":cash,"rateCents":rate,"roomBlueprint":blueprint,"floor":{"id":"prototype-floor","rooms":rooms},"reports":reports,"latestReport":latest_value});
    if let Some(raw) = phase2 {
        game["phase2"] = parse_json(raw)?;
    }
    if let Some(raw) = operations {
        game["operations"] = parse_json(raw)?;
    }
    if let Some(raw) = phase4 {
        game["phase4"] = parse_phase4_json(raw)?;
    }
    validate_game(&game)?;
    Ok(Some(game))
}

fn database_or_journal_exists(path: &Path) -> Result<bool, String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() => Err("存档路径无效".to_string()),
        Ok(metadata) if metadata.is_file() => Ok(true),
        Ok(_) => Err("存档路径无效".to_string()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(path
            .parent()
            .is_some_and(|directory| upgrade_journal_path(directory).is_file())),
        Err(_) => Err("无法检查存档".to_string()),
    }
}

fn existing_regular_database(path: &Path) -> Result<bool, SafeError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            Err(validation_migration())
        }
        Ok(_) => Ok(true),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err(validation_migration()),
    }
}

fn validate_existing_save_directory(directory: &Path) -> Result<(), SafeError> {
    let directory_metadata = fs::symlink_metadata(directory).map_err(|_| validation_migration())?;
    if directory_metadata.file_type().is_symlink() || !directory_metadata.is_dir() {
        return Err(validation_migration());
    }
    Ok(())
}

fn ensure_save_directory(directory: &Path) -> Result<(), SafeError> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(failed_migration())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir_all(directory).map_err(|_| failed_migration())
        }
        Err(_) => Err(failed_migration()),
    }
}

fn prepare_database_file(
    path: &Path,
    expected_save_id: &str,
    allow_create: bool,
) -> Result<(), SafeError> {
    recover_interrupted_upgrade(path)?;
    if !path.exists() {
        return if allow_create {
            initialize_current_database(path)
        } else {
            Err(SafeError::new("save.not-found", "存档不存在"))
        };
    }
    let metadata = fs::symlink_metadata(path).map_err(|_| validation_migration())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(validation_migration());
    }

    let inspection = inspect_database(path)?;
    if inspection.user_version == SAVE_SCHEMA_VERSION {
        if inspection.application_id != SAVE_APPLICATION_ID {
            return Err(unsupported_migration());
        }
        let connection = open_read_only(path, "migration.validation-failed")?;
        validate_current_database_contents(&connection)?;
        return Ok(());
    }
    if inspection.user_version != 0
        || inspection.application_id != 0
        || inspection.audit_version > SAVE_SCHEMA_VERSION
    {
        return Err(unsupported_migration());
    }

    let connection = open_read_only(path, "migration.validation-failed")?;
    let audit_version = read_contiguous_legacy_audit_version(&connection)?;
    if legacy_schema_needs_repair(&connection)? && audit_version >= SAVE_SCHEMA_VERSION {
        return Err(validation_migration());
    }
    reject_partial_v7_schema(&connection)?;
    validate_single_save_identity(&connection, expected_save_id, false)
        .map_err(|_| validation_migration())?;
    drop(connection);
    migrate_database_clone(path, audit_version, inspection.user_version)
}

#[derive(Clone, Copy)]
struct DatabaseInspection {
    application_id: i64,
    user_version: i64,
    audit_version: i64,
}

fn preflight_supported_identity(path: &Path) -> Result<(), SafeError> {
    let connection = open_read_only(path, "migration.validation-failed")?;
    let application_id = connection
        .query_row("PRAGMA application_id", [], |row| row.get::<_, i64>(0))
        .map_err(|_| validation_migration())?;
    let user_version = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .map_err(|_| validation_migration())?;
    if matches!(
        (application_id, user_version),
        (0, 0) | (SAVE_APPLICATION_ID, SAVE_SCHEMA_VERSION)
    ) {
        if application_id == 0 {
            read_contiguous_legacy_audit_version(&connection)?;
        }
        Ok(())
    } else {
        Err(unsupported_migration())
    }
}

fn inspect_database(path: &Path) -> Result<DatabaseInspection, SafeError> {
    let connection = open_read_only(path, "migration.validation-failed")?;
    let application_id = connection
        .query_row("PRAGMA application_id", [], |row| row.get::<_, i64>(0))
        .map_err(|_| validation_migration())?;
    let user_version = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .map_err(|_| validation_migration())?;
    let audit_version = connection
        .query_row(
            "SELECT COALESCE(MAX(version),0) FROM schema_migrations",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| validation_migration())?;
    Ok(DatabaseInspection {
        application_id,
        user_version,
        audit_version,
    })
}

fn read_contiguous_legacy_audit_version(connection: &Connection) -> Result<i64, SafeError> {
    let has_audit = connection
        .prepare(
            "SELECT 1 FROM sqlite_master
             WHERE type='table' AND name='schema_migrations'",
        )
        .map_err(|_| validation_migration())?
        .exists([])
        .map_err(|_| validation_migration())?;
    if !has_audit {
        return Err(validation_migration());
    }
    let (count, minimum, maximum) = connection
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
        .map_err(|_| validation_migration())?;
    let maximum = maximum.ok_or_else(validation_migration)?;
    if minimum != Some(1) || !(1..SAVE_SCHEMA_VERSION).contains(&maximum) || count != maximum {
        return Err(validation_migration());
    }
    Ok(maximum)
}

fn initialize_current_database(path: &Path) -> Result<(), SafeError> {
    let partial = unique_sibling(path, "initialize.partial");
    let mut guard = OwnedPartial::new(partial.clone());
    let mut connection = Connection::open(&partial).map_err(|_| failed_migration())?;
    apply_all_migrations(&mut connection)?;
    validate_current_database_contents(&connection)?;
    make_single_file_durable(&connection, &partial)?;
    drop(connection);
    publish_new_database(&partial, path)?;
    guard.disarm();
    Ok(())
}

fn migrate_database_clone(
    path: &Path,
    old_version: i64,
    old_user_version: i64,
) -> Result<(), SafeError> {
    let directory = path.parent().ok_or_else(failed_migration)?;
    let backup_directory = directory.join("pre-upgrade");
    ensure_backup_directory(&backup_directory)?;
    let backup_path = create_content_addressed_upgrade_backup(
        path,
        &backup_directory,
        old_version,
        old_user_version,
    )?;

    let partial = unique_sibling(path, "upgrade.partial");
    let mut guard = OwnedPartial::new(partial.clone());
    online_backup(&backup_path, &partial)?;
    let mut connection = Connection::open(&partial).map_err(|_| failed_migration())?;
    configure_migration_connection(&connection)?;
    apply_all_migrations(&mut connection)?;
    validate_current_database_contents(&connection)?;
    make_single_file_durable(&connection, &partial)?;
    drop(connection);
    atomic_replace_database(path, &partial)?;
    guard.disarm();
    Ok(())
}

fn ensure_backup_directory(directory: &Path) -> Result<(), SafeError> {
    match fs::symlink_metadata(directory) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(backup_migration())
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(directory).map_err(|_| backup_migration())?;
            sync_directory(directory.parent().ok_or_else(backup_migration)?)
                .map_err(|_| backup_migration())
        }
        Err(_) => Err(backup_migration()),
    }
}

fn create_content_addressed_upgrade_backup(
    source: &Path,
    directory: &Path,
    old_version: i64,
    old_user_version: i64,
) -> Result<PathBuf, SafeError> {
    let temporary = unique_backup_path(directory, "partial");
    let mut guard = OwnedPartial::new(temporary.clone());
    online_backup(source, &temporary)?;
    let backup_connection = Connection::open(&temporary).map_err(|_| backup_migration())?;
    backup_connection
        .pragma_update(None, "journal_mode", "DELETE")
        .map_err(|_| backup_migration())?;
    backup_connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|_| backup_migration())?;
    drop(backup_connection);
    sync_file(&temporary).map_err(|_| backup_migration())?;
    let digest = sha256_file(&temporary).map_err(|_| backup_migration())?;
    let final_path = directory.join(format!("schema-v{old_version}-{digest}.sqlite3"));

    match fs::symlink_metadata(&final_path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(backup_migration())
        }
        Ok(_) => {
            if sha256_file(&final_path).map_err(|_| backup_migration())? != digest {
                return Err(backup_migration());
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::rename(&temporary, &final_path).map_err(|_| backup_migration())?;
            guard.disarm();
            sync_directory(directory).map_err(|_| backup_migration())?;
        }
        Err(_) => return Err(backup_migration()),
    }
    validate_upgrade_backup(&final_path, old_user_version)?;
    Ok(final_path)
}

fn validate_upgrade_backup(path: &Path, old_version: i64) -> Result<(), SafeError> {
    let connection = open_read_only(path, "migration.backup-failed")?;
    let integrity = connection
        .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
        .map_err(|_| backup_migration())?;
    let user_version = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .map_err(|_| backup_migration())?;
    if integrity != "ok" || user_version != old_version {
        return Err(backup_migration());
    }
    Ok(())
}

fn sha256_file(path: &Path) -> std::io::Result<String> {
    let mut file = OpenOptions::new().read(true).open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let digest = hasher.finalize();
    let mut encoded = String::with_capacity(digest.len() * 2);
    const HEX: &[u8; 16] = b"0123456789abcdef";
    for byte in digest {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    Ok(encoded)
}

fn unique_backup_path(directory: &Path, label: &str) -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    directory.join(format!(
        ".schema-v7.{label}.{}.{nonce}.sqlite3",
        std::process::id()
    ))
}

fn apply_all_migrations(connection: &mut Connection) -> Result<(), SafeError> {
    connection
        .execute_batch(include_str!("../migrations/001_initial.sql"))
        .map_err(|_| failed_migration())?;
    connection
        .execute(
            "INSERT OR IGNORE INTO schema_migrations(version,applied_at)
             VALUES(1,datetime('now'))",
            [],
        )
        .map_err(|_| failed_migration())?;
    migrate_legacy(connection).map_err(|_| failed_migration())?;
    migrate_phase2(connection).map_err(|_| failed_migration())?;
    migrate_blueprint_openings(connection).map_err(|_| failed_migration())?;
    migrate_operations(connection).map_err(|_| failed_migration())?;
    migrate_phase4(connection).map_err(|_| failed_migration())?;
    canonicalize_core_schema(connection)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| failed_migration())?;
    transaction
        .execute_batch(include_str!("../migrations/007_reliability.sql"))
        .map_err(|_| failed_migration())?;
    transaction
        .execute(
            "INSERT OR IGNORE INTO schema_migrations(version,applied_at)
             VALUES(7,datetime('now'))",
            [],
        )
        .map_err(|_| failed_migration())?;
    transaction
        .pragma_update(None, "application_id", SAVE_APPLICATION_ID)
        .map_err(|_| failed_migration())?;
    transaction
        .pragma_update(None, "user_version", SAVE_SCHEMA_VERSION)
        .map_err(|_| failed_migration())?;
    transaction.commit().map_err(|_| failed_migration())
}

fn canonicalize_core_schema(connection: &mut Connection) -> Result<(), SafeError> {
    connection
        .pragma_update(None, "foreign_keys", "OFF")
        .map_err(|_| failed_migration())?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| failed_migration())?;
    transaction
        .execute_batch(
            "DROP TRIGGER IF EXISTS saves_phase4_json_insert_check;
             DROP TRIGGER IF EXISTS saves_phase4_json_update_check;
             DROP INDEX IF EXISTS room_blueprints_save_blueprint;
             ALTER TABLE daily_reports RENAME TO daily_reports_pre_v7;
             ALTER TABLE room_instances RENAME TO room_instances_pre_v7;
             ALTER TABLE room_blueprints RENAME TO room_blueprints_pre_v7;
             ALTER TABLE saves RENAME TO saves_pre_v7;",
        )
        .map_err(|_| failed_migration())?;
    transaction
        .execute_batch(include_str!("../migrations/001_initial.sql"))
        .map_err(|_| failed_migration())?;
    transaction
        .execute_batch(
            "ALTER TABLE room_blueprints ADD COLUMN openings_json TEXT;
             ALTER TABLE saves ADD COLUMN operations_json TEXT;
             INSERT INTO saves(
               save_id,schema_version,ruleset_version,revision,phase,current_day,
               cash_cents,rate_cents,phase2_json,latest_report_json,phase4_json,
               updated_at,operations_json
             )
             SELECT
               save_id,schema_version,ruleset_version,revision,phase,current_day,
               cash_cents,rate_cents,phase2_json,latest_report_json,phase4_json,
               updated_at,operations_json
             FROM saves_pre_v7;
             INSERT INTO room_blueprints(
               save_id,blueprint_id,name,columns_count,rows_count,cells_json,
               metrics_json,visual_json,openings_json
             )
             SELECT
               save_id,blueprint_id,name,columns_count,rows_count,cells_json,
               metrics_json,visual_json,openings_json
             FROM room_blueprints_pre_v7;
             INSERT INTO room_instances(
               save_id,instance_id,slot_id,blueprint_id,ordinal,
               committed_build_cost_cents
             )
             SELECT
               save_id,instance_id,slot_id,blueprint_id,ordinal,
               committed_build_cost_cents
             FROM room_instances_pre_v7;
             INSERT INTO daily_reports(save_id,game_day,report_json)
             SELECT save_id,game_day,report_json FROM daily_reports_pre_v7;
             DROP TABLE daily_reports_pre_v7;
             DROP TABLE room_instances_pre_v7;
             DROP TABLE room_blueprints_pre_v7;
             DROP TABLE saves_pre_v7;
             CREATE UNIQUE INDEX room_blueprints_save_blueprint
               ON room_blueprints(save_id, blueprint_id);
             CREATE TRIGGER saves_phase4_json_insert_check
             BEFORE INSERT ON saves
             WHEN NEW.phase4_json IS NOT NULL
              AND (NOT json_valid(NEW.phase4_json) OR json_type(NEW.phase4_json) <> 'object')
             BEGIN
               SELECT RAISE(ABORT, 'phase4_json must be a valid JSON object');
             END;
             CREATE TRIGGER saves_phase4_json_update_check
             BEFORE UPDATE OF phase4_json ON saves
             WHEN NEW.phase4_json IS NOT NULL
              AND (NOT json_valid(NEW.phase4_json) OR json_type(NEW.phase4_json) <> 'object')
             BEGIN
               SELECT RAISE(ABORT, 'phase4_json must be a valid JSON object');
             END;",
        )
        .map_err(|_| failed_migration())?;
    transaction.commit().map_err(|_| failed_migration())?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|_| failed_migration())
}

fn validate_current_database_contents(connection: &Connection) -> Result<(), SafeError> {
    validate_current_save_database(connection)?;
    let mut statement = connection
        .prepare("SELECT save_id FROM saves ORDER BY save_id")
        .map_err(|_| validation_migration())?;
    let save_ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| validation_migration())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| validation_migration())?;
    drop(statement);
    for save_id in save_ids {
        load_game_from_connection(connection, &save_id)
            .map_err(|error| validation_migration().with_detail(&error))?
            .ok_or_else(validation_migration)?;
    }
    Ok(())
}

fn validate_opened_save(
    connection: &Connection,
    database_path: &Path,
    expected_save_id: &str,
    allow_empty: bool,
) -> Result<(), SafeError> {
    validate_single_save_identity(connection, expected_save_id, allow_empty)
        .map_err(|_| validation_migration())?;
    let save_directory = database_path.parent().ok_or_else(validation_migration)?;
    validate_asset_registry(connection, save_directory).map_err(|_| validation_migration())
}

fn reject_partial_v7_schema(connection: &Connection) -> Result<(), SafeError> {
    let placeholders = crate::reliability::V7_TABLES
        .iter()
        .map(|_| "?")
        .collect::<Vec<_>>()
        .join(",");
    let query = format!(
        "SELECT count(*) FROM sqlite_master
         WHERE type='table' AND name IN ({placeholders})"
    );
    let count = connection
        .query_row(
            &query,
            rusqlite::params_from_iter(crate::reliability::V7_TABLES.iter()),
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| validation_migration())?;
    if count != 0 {
        return Err(validation_migration().with_detail("旧版存档包含部分 v7 表"));
    }
    let allowed = [
        "schema_migrations",
        "saves",
        "room_blueprints",
        "room_instances",
        "daily_reports",
        "room_blueprints_save_blueprint",
        "saves_phase4_json_insert_check",
        "saves_phase4_json_update_check",
    ]
    .into_iter()
    .collect::<HashSet<_>>();
    let mut statement = connection
        .prepare(
            "SELECT name FROM sqlite_master
             WHERE type IN ('table','index','trigger','view')
               AND name NOT LIKE 'sqlite_autoindex_%'",
        )
        .map_err(|_| validation_migration())?;
    let names = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|_| validation_migration())?;
    for name in names {
        if !allowed.contains(name.map_err(|_| validation_migration())?.as_str()) {
            return Err(validation_migration().with_detail("旧版存档包含未知结构对象"));
        }
    }
    Ok(())
}

fn online_backup(source_path: &Path, destination_path: &Path) -> Result<(), SafeError> {
    online_backup_with_error(source_path, destination_path, backup_migration)
}

fn copy_verified_database_payload(source: &Path, destination: &Path) -> Result<(), SafeError> {
    let metadata = fs::symlink_metadata(source).map_err(|_| recovery_corrupt())?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(recovery_corrupt());
    }
    let mut input = OpenOptions::new()
        .read(true)
        .open(source)
        .map_err(|_| recovery_corrupt())?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|_| recovery_corrupt())?;
    std::io::copy(&mut input, &mut output).map_err(|_| recovery_corrupt())?;
    output.sync_all().map_err(|_| recovery_corrupt())
}

fn online_backup_with_error(
    source_path: &Path,
    destination_path: &Path,
    error: fn() -> SafeError,
) -> Result<(), SafeError> {
    let source = Connection::open_with_flags(source_path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| error())?;
    let mut destination = Connection::open(destination_path).map_err(|_| error())?;
    let backup = Backup::new(&source, &mut destination).map_err(|_| error())?;
    backup
        .run_to_completion(128, Duration::from_millis(1), None)
        .map_err(|_| error())?;
    drop(backup);
    drop(destination);
    drop(source);
    Ok(())
}

fn open_read_only(path: &Path, code: &'static str) -> Result<Connection, SafeError> {
    Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| SafeError::new(code, "无法只读检查存档"))
}

fn configure_migration_connection(connection: &Connection) -> Result<(), SafeError> {
    connection
        .busy_timeout(Duration::from_millis(5_000))
        .map_err(|_| failed_migration())?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|_| failed_migration())?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|_| failed_migration())
}

fn open_current_connection(path: &Path) -> Result<Connection, SafeError> {
    let connection = Connection::open(path).map_err(|_| validation_migration())?;
    connection
        .busy_timeout(Duration::from_millis(5_000))
        .map_err(|_| validation_migration())?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(|_| validation_migration())?;
    retry_busy(|| connection.pragma_update(None, "journal_mode", "WAL"))
        .map_err(|_| validation_migration())?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|_| validation_migration())?;
    validate_current_database_contents(&connection)?;
    Ok(connection)
}

fn make_single_file_durable(connection: &Connection, path: &Path) -> Result<(), SafeError> {
    connection
        .pragma_update(None, "journal_mode", "DELETE")
        .map_err(|_| failed_migration())?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|_| failed_migration())?;
    sync_file(path).map_err(|_| failed_migration())
}

fn publish_new_database(partial: &Path, active: &Path) -> Result<(), SafeError> {
    fs::rename(partial, active).map_err(|_| failed_migration())?;
    let directory = active.parent().ok_or_else(failed_migration)?;
    sync_directory(directory).map_err(|_| failed_migration())
}

fn atomic_replace_database(active: &Path, partial: &Path) -> Result<(), SafeError> {
    let rollback = unique_sibling(active, "rollback");
    let directory = active.parent().ok_or_else(failed_migration)?;
    let journal = UpgradeJournal::new(partial, &rollback)?;
    write_upgrade_journal(directory, &journal)?;

    fs::rename(active, &rollback).map_err(|_| failed_migration())?;
    if move_sidecar_if_present(active, &rollback, "-wal")
        .and_then(|()| move_sidecar_if_present(active, &rollback, "-shm"))
        .and_then(|()| sync_directory(directory).map_err(|_| failed_migration()))
        .is_err()
    {
        restore_rollback_group(active, &rollback)?;
        return Err(failed_migration());
    }
    if fs::rename(partial, active).is_err() {
        restore_rollback_group(active, &rollback)?;
        return Err(failed_migration());
    }
    if sync_directory(directory).is_err() {
        restore_rollback_group(active, &rollback)?;
        return Err(failed_migration());
    }
    if let Err(error) = open_read_only(active, "migration.validation-failed")
        .and_then(|connection| validate_current_database_contents(&connection))
    {
        restore_rollback_group(active, &rollback)?;
        return Err(error);
    }
    remove_database_group(&rollback);
    remove_upgrade_journal(directory);
    sync_directory(directory).map_err(|_| failed_migration())?;
    Ok(())
}

#[derive(Debug, Deserialize, Serialize)]
struct UpgradeJournal {
    version: u8,
    partial_name: String,
    rollback_name: String,
}

impl UpgradeJournal {
    fn new(partial: &Path, rollback: &Path) -> Result<Self, SafeError> {
        Ok(Self {
            version: 1,
            partial_name: safe_file_name(partial)?,
            rollback_name: safe_file_name(rollback)?,
        })
    }

    fn validate(&self) -> Result<(), SafeError> {
        if self.version != 1
            || !valid_owned_database_name(&self.partial_name, "partial")
            || !valid_owned_database_name(&self.rollback_name, "rollback")
        {
            return Err(failed_migration());
        }
        Ok(())
    }
}

fn recover_interrupted_upgrade(active: &Path) -> Result<(), SafeError> {
    let directory = active.parent().ok_or_else(failed_migration)?;
    let journal_path = upgrade_journal_path(directory);
    let bytes = match fs::read(&journal_path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err(failed_migration()),
    };
    let journal =
        serde_json::from_slice::<UpgradeJournal>(&bytes).map_err(|_| failed_migration())?;
    journal.validate()?;
    let partial = directory.join(&journal.partial_name);
    let rollback = directory.join(&journal.rollback_name);

    let new_is_valid = if active.is_file() {
        open_read_only(active, "migration.validation-failed")
            .and_then(|connection| validate_current_database_contents(&connection))
            .is_ok()
    } else {
        false
    };
    if new_is_valid {
        remove_database_group(&rollback);
        remove_database_group(&partial);
        remove_upgrade_journal(directory);
        sync_directory(directory).map_err(|_| failed_migration())?;
        return Ok(());
    }

    if !rollback.is_file() {
        if active.is_file()
            && (append_suffix(&rollback, "-wal").is_file()
                || append_suffix(&rollback, "-shm").is_file())
        {
            restore_sidecar_if_present(active, &rollback, "-wal")?;
            restore_sidecar_if_present(active, &rollback, "-shm")?;
            sync_directory(directory).map_err(|_| failed_migration())?;
        }
        if active.is_file() && legacy_database_is_intact(active) {
            remove_database_group(&partial);
            remove_upgrade_journal(directory);
            sync_directory(directory).map_err(|_| failed_migration())?;
            return Ok(());
        }
        return Err(failed_migration());
    }
    restore_rollback_group(active, &rollback)?;
    remove_database_group(&partial);
    Ok(())
}

fn legacy_database_is_intact(path: &Path) -> bool {
    let Ok(connection) = open_read_only(path, "migration.validation-failed") else {
        return false;
    };
    let application_id = connection
        .query_row("PRAGMA application_id", [], |row| row.get::<_, i64>(0))
        .ok();
    let user_version = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .ok();
    if application_id != Some(0)
        || user_version != Some(0)
        || read_contiguous_legacy_audit_version(&connection).is_err()
        || reject_partial_v7_schema(&connection).is_err()
    {
        return false;
    }
    connection
        .query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
        .is_ok_and(|result| result == "ok")
}

fn restore_rollback_group(active: &Path, rollback: &Path) -> Result<(), SafeError> {
    let _ = fs::remove_file(active);
    fs::rename(rollback, active).map_err(|_| failed_migration())?;
    restore_sidecar_if_present(active, rollback, "-wal")?;
    restore_sidecar_if_present(active, rollback, "-shm")?;
    let directory = active.parent().ok_or_else(failed_migration)?;
    sync_directory(directory).map_err(|_| failed_migration())?;
    remove_upgrade_journal(directory);
    sync_directory(directory).map_err(|_| failed_migration())
}

fn move_sidecar_if_present(active: &Path, rollback: &Path, suffix: &str) -> Result<(), SafeError> {
    let source = append_suffix(active, suffix);
    if source.exists() {
        fs::rename(source, append_suffix(rollback, suffix)).map_err(|_| failed_migration())?;
    }
    Ok(())
}

fn restore_sidecar_if_present(
    active: &Path,
    rollback: &Path,
    suffix: &str,
) -> Result<(), SafeError> {
    let source = append_suffix(rollback, suffix);
    if source.exists() {
        let destination = append_suffix(active, suffix);
        let _ = fs::remove_file(&destination);
        fs::rename(source, destination).map_err(|_| failed_migration())?;
    }
    Ok(())
}

fn remove_database_group(main: &Path) {
    let _ = fs::remove_file(main);
    let _ = fs::remove_file(append_suffix(main, "-wal"));
    let _ = fs::remove_file(append_suffix(main, "-shm"));
}

fn append_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(suffix);
    PathBuf::from(name)
}

fn write_upgrade_journal(directory: &Path, journal: &UpgradeJournal) -> Result<(), SafeError> {
    let temporary = directory.join(".cloud-inn.upgrade-journal.partial");
    let final_path = upgrade_journal_path(directory);
    let bytes = serde_json::to_vec(journal).map_err(|_| failed_migration())?;
    let mut file = OpenOptions::new()
        .create(true)
        .truncate(true)
        .write(true)
        .open(&temporary)
        .map_err(|_| failed_migration())?;
    file.write_all(&bytes).map_err(|_| failed_migration())?;
    file.sync_all().map_err(|_| failed_migration())?;
    drop(file);
    fs::rename(&temporary, &final_path).map_err(|_| failed_migration())?;
    sync_directory(directory).map_err(|_| failed_migration())
}

fn remove_upgrade_journal(directory: &Path) {
    let _ = fs::remove_file(upgrade_journal_path(directory));
    let _ = fs::remove_file(directory.join(".cloud-inn.upgrade-journal.partial"));
}

fn upgrade_journal_path(directory: &Path) -> PathBuf {
    directory.join(".cloud-inn.upgrade-journal.json")
}

fn safe_file_name(path: &Path) -> Result<String, SafeError> {
    path.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .map(str::to_owned)
        .ok_or_else(failed_migration)
}

fn valid_owned_database_name(name: &str, label: &str) -> bool {
    name.starts_with(".save.")
        && name.contains(&format!(".{label}."))
        && name.ends_with(".sqlite3")
        && !name.contains('/')
        && !name.contains('\\')
        && !name.contains("..")
}

fn sync_file(path: &Path) -> std::io::Result<()> {
    OpenOptions::new().read(true).open(path)?.sync_all()
}

fn sync_directory(path: &Path) -> std::io::Result<()> {
    File::open(path)?.sync_all()
}

fn unique_sibling(path: &Path, label: &str) -> PathBuf {
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    path.with_file_name(format!(
        ".save.{}.{label}.{nonce}.sqlite3",
        std::process::id()
    ))
}

struct OwnedPartial {
    path: Option<PathBuf>,
}

impl OwnedPartial {
    fn new(path: PathBuf) -> Self {
        Self { path: Some(path) }
    }

    fn disarm(&mut self) {
        self.path = None;
    }
}

impl Drop for OwnedPartial {
    fn drop(&mut self) {
        if let Some(path) = self.path.take() {
            let _ = fs::remove_file(&path);
            let _ = fs::remove_file(path.with_extension("sqlite3-wal"));
            let _ = fs::remove_file(path.with_extension("sqlite3-shm"));
        }
    }
}

fn unsupported_migration() -> SafeError {
    SafeError::new("migration.unsupported-version", "存档版本不受此版本支持")
}

fn backup_migration() -> SafeError {
    SafeError::new("migration.backup-failed", "迁移前备份失败")
}

fn failed_migration() -> SafeError {
    SafeError::new("migration.failed", "存档迁移失败")
}

fn validation_migration() -> SafeError {
    SafeError::new("migration.validation-failed", "迁移后存档验证失败")
}

fn retry_busy<T>(mut operation: impl FnMut() -> rusqlite::Result<T>) -> Result<T, String> {
    for attempt in 0..5 {
        match operation() {
            Ok(value) => return Ok(value),
            Err(rusqlite::Error::SqliteFailure(error, _))
                if matches!(
                    error.code,
                    rusqlite::ErrorCode::DatabaseBusy | rusqlite::ErrorCode::DatabaseLocked
                ) && attempt < 4 =>
            {
                std::thread::sleep(std::time::Duration::from_millis(10 * (attempt + 1)));
            }
            Err(error) => return Err(db_err(error)),
        }
    }
    unreachable!()
}

fn migrate_legacy(conn: &mut Connection) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_err)?;
    let has_ordinal: bool = tx
        .prepare("SELECT 1 FROM pragma_table_info('room_instances') WHERE name='ordinal'")
        .map_err(db_err)?
        .exists([])
        .map_err(db_err)?;
    let has_v2: bool = tx
        .query_row(
            "SELECT count(*) FROM schema_migrations WHERE version=2",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map_err(db_err)?
        > 0;
    if has_ordinal && has_v2 {
        return tx.commit().map_err(db_err);
    }
    if !has_ordinal {
        tx.execute_batch("ALTER TABLE room_instances RENAME TO room_instances_legacy; CREATE UNIQUE INDEX IF NOT EXISTS room_blueprints_save_blueprint ON room_blueprints(save_id, blueprint_id); CREATE TABLE room_instances (save_id TEXT NOT NULL REFERENCES saves(save_id) ON DELETE CASCADE, instance_id TEXT NOT NULL, slot_id TEXT NOT NULL, blueprint_id TEXT NOT NULL, ordinal INTEGER NOT NULL CHECK(ordinal >= 0), committed_build_cost_cents INTEGER NOT NULL CHECK(committed_build_cost_cents >= 0), PRIMARY KEY(save_id, instance_id), UNIQUE(save_id, slot_id), UNIQUE(save_id, ordinal), FOREIGN KEY(save_id, blueprint_id) REFERENCES room_blueprints(save_id, blueprint_id) ON DELETE CASCADE); INSERT INTO room_instances(save_id,instance_id,slot_id,blueprint_id,ordinal,committed_build_cost_cents) SELECT save_id,instance_id,slot_id,blueprint_id,ROW_NUMBER() OVER (PARTITION BY save_id ORDER BY rowid)-1,committed_build_cost_cents FROM room_instances_legacy; DROP TABLE room_instances_legacy;").map_err(db_err)?;
    }
    tx.execute_batch("CREATE UNIQUE INDEX IF NOT EXISTS room_blueprints_save_blueprint ON room_blueprints(save_id, blueprint_id);").map_err(db_err)?;
    tx.execute(
        "INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(2,datetime('now'))",
        [],
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)
}

fn migrate_phase2(conn: &mut Connection) -> Result<(), String> {
    let has_phase2: bool = conn
        .prepare("SELECT 1 FROM pragma_table_info('saves') WHERE name='phase2_json'")
        .map_err(db_err)?
        .exists([])
        .map_err(db_err)?;
    if !has_phase2 {
        conn.execute("ALTER TABLE saves ADD COLUMN phase2_json TEXT", [])
            .map_err(db_err)?;
    }
    conn.execute(
        "INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(3,datetime('now'))",
        [],
    )
    .map_err(db_err)?;
    Ok(())
}

fn migrate_blueprint_openings(conn: &mut Connection) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_err)?;
    let has_openings: bool = tx
        .prepare("SELECT 1 FROM pragma_table_info('room_blueprints') WHERE name='openings_json'")
        .map_err(db_err)?
        .exists([])
        .map_err(db_err)?;
    if !has_openings {
        tx.execute(
            "ALTER TABLE room_blueprints ADD COLUMN openings_json TEXT",
            [],
        )
        .map_err(db_err)?;
    }
    tx.execute(
        "INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(4,datetime('now'))",
        [],
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)
}

fn migrate_operations(conn: &mut Connection) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_err)?;
    let has_operations = tx
        .prepare("SELECT 1 FROM pragma_table_info('saves') WHERE name='operations_json'")
        .map_err(db_err)?
        .exists([])
        .map_err(db_err)?;
    if !has_operations {
        tx.execute("ALTER TABLE saves ADD COLUMN operations_json TEXT", [])
            .map_err(db_err)?;
    }
    tx.execute(
        "INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(5,datetime('now'))",
        [],
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)
}

fn migrate_phase4(conn: &mut Connection) -> Result<(), String> {
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_err)?;
    let has_phase4 = tx
        .prepare("SELECT 1 FROM pragma_table_info('saves') WHERE name='phase4_json'")
        .map_err(db_err)?
        .exists([])
        .map_err(db_err)?;
    if !has_phase4 {
        tx.execute(
            "ALTER TABLE saves ADD COLUMN phase4_json TEXT
             CHECK(phase4_json IS NULL OR
                   (json_valid(phase4_json) AND json_type(phase4_json) = 'object'))",
            [],
        )
        .map_err(db_err)?;
    }
    tx.execute_batch(
        "CREATE TRIGGER IF NOT EXISTS saves_phase4_json_insert_check
         BEFORE INSERT ON saves
         WHEN NEW.phase4_json IS NOT NULL
          AND (NOT json_valid(NEW.phase4_json) OR json_type(NEW.phase4_json) <> 'object')
         BEGIN
           SELECT RAISE(ABORT, 'phase4_json must be a valid JSON object');
         END;
         CREATE TRIGGER IF NOT EXISTS saves_phase4_json_update_check
         BEFORE UPDATE OF phase4_json ON saves
         WHEN NEW.phase4_json IS NOT NULL
          AND (NOT json_valid(NEW.phase4_json) OR json_type(NEW.phase4_json) <> 'object')
         BEGIN
           SELECT RAISE(ABORT, 'phase4_json must be a valid JSON object');
         END;",
    )
    .map_err(db_err)?;
    tx.execute(
        "INSERT OR IGNORE INTO schema_migrations(version,applied_at) VALUES(6,datetime('now'))",
        [],
    )
    .map_err(db_err)?;
    tx.commit().map_err(db_err)
}

fn db_err(e: rusqlite::Error) -> String {
    format!("数据库操作失败: {e}")
}
fn parse_json(s: String) -> Result<Value, String> {
    serde_json::from_str(&s).map_err(|_| "存档数据损坏".to_string())
}
fn parse_phase4_json(s: String) -> Result<Value, String> {
    if s.len() > PHASE4_MAX_JSON_BYTES {
        return Err(phase4_error("JSON超过大小限制"));
    }
    serde_json::from_str(&s).map_err(|_| phase4_error("JSON结构无效"))
}
fn validate_save_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("存档标识无效".into());
    }
    Ok(())
}
fn obj<'a>(v: &'a Value, k: &str) -> Result<&'a Value, String> {
    v.get(k).ok_or_else(|| "存档数据损坏".into())
}
fn strv(v: &Value, k: &str) -> Result<String, String> {
    obj(v, k)?
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| "存档数据损坏".into())
}
fn intv(v: &Value, k: &str, min: i64, positive: bool) -> Result<i64, String> {
    let n = obj(v, k)?
        .as_i64()
        .ok_or_else(|| "存档数据损坏".to_string())?;
    if n < min || (positive && n <= 0) {
        Err("存档数据损坏".into())
    } else {
        Ok(n)
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct Point {
    x: i64,
    y: i64,
}

#[derive(Clone, Copy)]
struct Footprint {
    width: i64,
    height: i64,
}

#[derive(Clone, Copy)]
struct SlotGeometry {
    width: i64,
    height: i64,
}

#[derive(Clone, Copy)]
struct Rectangle {
    anchor: Point,
    width: i64,
    height: i64,
}

impl Rectangle {
    fn contains(self, point: Point) -> bool {
        point.x >= self.anchor.x
            && point.x - self.anchor.x < self.width
            && point.y >= self.anchor.y
            && point.y - self.anchor.y < self.height
    }

    fn overlaps(self, other: Self) -> bool {
        self.anchor.x < other.anchor.x + other.width
            && other.anchor.x < self.anchor.x + self.width
            && self.anchor.y < other.anchor.y + other.height
            && other.anchor.y < self.anchor.y + self.height
    }

    fn adjacent_to(self, point: Point) -> bool {
        (point.x == self.anchor.x - 1
            && point.y >= self.anchor.y
            && point.y - self.anchor.y < self.height)
            || (point.x == self.anchor.x + self.width
                && point.y >= self.anchor.y
                && point.y - self.anchor.y < self.height)
            || (point.y == self.anchor.y - 1
                && point.x >= self.anchor.x
                && point.x - self.anchor.x < self.width)
            || (point.y == self.anchor.y + self.height
                && point.x >= self.anchor.x
                && point.x - self.anchor.x < self.width)
    }
}

fn array<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    obj(value, key)?
        .as_array()
        .ok_or_else(|| "存档数据损坏".to_string())
}

fn parse_point(value: &Value, width: i64, height: i64) -> Result<Point, String> {
    let point = Point {
        x: intv(value, "x", 0, false)?,
        y: intv(value, "y", 0, false)?,
    };
    if point.x >= width || point.y >= height {
        return Err("存档数据损坏".into());
    }
    Ok(point)
}

fn neighbors(point: Point) -> [Point; 4] {
    [
        Point {
            x: point.x - 1,
            y: point.y,
        },
        Point {
            x: point.x + 1,
            y: point.y,
        },
        Point {
            x: point.x,
            y: point.y - 1,
        },
        Point {
            x: point.x,
            y: point.y + 1,
        },
    ]
}

fn is_connected(points: &HashSet<Point>) -> bool {
    let Some(start) = points.iter().next().copied() else {
        return false;
    };
    let mut seen = HashSet::from([start]);
    let mut queue = VecDeque::from([start]);
    while let Some(current) = queue.pop_front() {
        for next in neighbors(current) {
            if points.contains(&next) && seen.insert(next) {
                queue.push_back(next);
            }
        }
    }
    seen.len() == points.len()
}

fn validate_metrics(value: &Value, cell_count: usize) -> Result<(), String> {
    let area = obj(value, "areaSquareMeters")?
        .as_f64()
        .filter(|number| number.is_finite() && *number > 0.0)
        .ok_or_else(|| "存档数据损坏".to_string())?;
    let expected_area = cell_count as f64 * 0.25;
    let build_cost = intv(value, "buildCostCents", 0, false)?;
    let suggested_rate = intv(value, "suggestedRateCents", 0, true)?;
    let business_fit = intv(value, "businessFitBps", 0, false)?;
    let area_delta_quarters = (96_i64 - cell_count as i64).abs();
    let expected_fit = ((17_000 - area_delta_quarters * 125 + 1) / 2).clamp(0, 10_000);
    if (area - expected_area).abs() > f64::EPSILON
        || build_cost != 2_000_000 + 100_000 * cell_count as i64
        || suggested_rate != 32_000 + 500 * cell_count as i64
        || business_fit != expected_fit
    {
        return Err("存档数据损坏".into());
    }
    Ok(())
}

fn validate_cells(
    value: &Value,
    columns: i64,
    rows: i64,
) -> Result<(HashSet<Point>, Footprint), String> {
    let cells = value
        .as_array()
        .filter(|cells| !cells.is_empty())
        .ok_or_else(|| "存档数据损坏".to_string())?;
    let mut points = HashSet::new();
    let mut zones = HashSet::new();
    for cell in cells {
        let point = parse_point(cell, columns, rows)?;
        let zone = strv(cell, "zone")?;
        if !["bedroom", "bathroom"].contains(&zone.as_str()) || !points.insert(point) {
            return Err("存档数据损坏".into());
        }
        zones.insert(zone);
    }
    if !zones.contains("bedroom") || !zones.contains("bathroom") || !is_connected(&points) {
        return Err("存档数据损坏".into());
    }
    let min_x = points.iter().map(|point| point.x).min().unwrap();
    let max_x = points.iter().map(|point| point.x).max().unwrap();
    let min_y = points.iter().map(|point| point.y).min().unwrap();
    let max_y = points.iter().map(|point| point.y).max().unwrap();
    Ok((
        points,
        Footprint {
            width: max_x - min_x + 1,
            height: max_y - min_y + 1,
        },
    ))
}

fn validate_openings(value: &Value, cells: &HashSet<Point>) -> Result<(), String> {
    let mut seen = HashSet::new();
    for (key, kind) in [("walls", "wall"), ("doors", "door"), ("windows", "window")] {
        for opening in array(value, key)? {
            let point = Point {
                x: intv(opening, "x", 0, false)?,
                y: intv(opening, "y", 0, false)?,
            };
            let side = strv(opening, "side")?;
            if !["north", "east", "south", "west"].contains(&side.as_str()) {
                return Err("存档数据损坏".into());
            }
            if let Some(value_kind) = opening.get("kind") {
                if value_kind.as_str() != Some(kind) {
                    return Err("存档数据损坏".into());
                }
            }
            let outside = match side.as_str() {
                "north" => Point {
                    x: point.x,
                    y: point.y - 1,
                },
                "east" => Point {
                    x: point.x + 1,
                    y: point.y,
                },
                "south" => Point {
                    x: point.x,
                    y: point.y + 1,
                },
                "west" => Point {
                    x: point.x - 1,
                    y: point.y,
                },
                _ => unreachable!(),
            };
            if !cells.contains(&point) || cells.contains(&outside) || !seen.insert((point, side)) {
                return Err("存档数据损坏".into());
            }
        }
    }
    Ok(())
}

fn validate_room(
    value: &Value,
    columns: i64,
    rows: i64,
    require_visual: bool,
) -> Result<Footprint, String> {
    strv(value, "id")?;
    strv(value, "name")?;
    let (cells, footprint) = validate_cells(obj(value, "cells")?, columns, rows)?;
    validate_metrics(obj(value, "metrics")?, cells.len())?;
    validate_openings(obj(value, "openings")?, &cells)?;
    if require_visual || value.get("visual").is_some() {
        validate_visual_tree(obj(value, "visual")?)?;
    }
    Ok(footprint)
}

fn parse_template_points(
    template: &Value,
    key: &str,
    width: i64,
    height: i64,
) -> Result<HashSet<Point>, String> {
    let values = array(template, key)?;
    if values.is_empty() {
        return Err("存档数据损坏".into());
    }
    let mut points = HashSet::new();
    for value in values {
        if !points.insert(parse_point(value, width, height)?) {
            return Err("存档数据损坏".into());
        }
    }
    Ok(points)
}

fn validate_corridor_template(value: &Value) -> Result<HashMap<String, SlotGeometry>, String> {
    strv(value, "id")?;
    strv(value, "name")?;
    let width = intv(value, "width", 1, true)?;
    let height = intv(value, "height", 1, true)?;
    let core = parse_template_points(value, "core", width, height)?;
    let corridor = parse_template_points(value, "corridor", width, height)?;
    let entrances = parse_template_points(value, "entrances", width, height)?;
    if !core.is_disjoint(&corridor) || !is_connected(&corridor) {
        return Err("存档数据损坏".into());
    }
    let core_and_entrances = core
        .iter()
        .chain(&entrances)
        .copied()
        .collect::<HashSet<_>>();
    let entrance_bridges = entrances.iter().any(|entrance| {
        neighbors(*entrance)
            .iter()
            .any(|point| corridor.contains(point))
            && reachable_set(*entrance, &core_and_entrances)
                .iter()
                .any(|point| core.contains(point))
    });
    if !entrance_bridges {
        return Err("存档数据损坏".into());
    }

    let mut slots = HashMap::new();
    let mut slot_rectangles = Vec::new();
    for slot in array(value, "slots")? {
        let id = strv(slot, "id")?;
        let slot_width = intv(slot, "width", 1, true)?;
        let slot_height = intv(slot, "height", 1, true)?;
        let anchor = parse_point(obj(slot, "anchor")?, width, height)?;
        if slot_width > width - anchor.x
            || slot_height > height - anchor.y
            || slots
                .insert(
                    id,
                    SlotGeometry {
                        width: slot_width,
                        height: slot_height,
                    },
                )
                .is_some()
        {
            return Err("存档数据损坏".into());
        }
        let rectangle = Rectangle {
            anchor,
            width: slot_width,
            height: slot_height,
        };
        if core
            .iter()
            .chain(&corridor)
            .any(|point| rectangle.contains(*point))
            || slot_rectangles
                .iter()
                .any(|existing| rectangle.overlaps(*existing))
            || !corridor.iter().any(|point| rectangle.adjacent_to(*point))
        {
            return Err("存档数据损坏".into());
        }
        slot_rectangles.push(rectangle);
    }
    Ok(slots)
}

fn reachable_set(start: Point, traversable: &HashSet<Point>) -> HashSet<Point> {
    let mut seen = HashSet::from([start]);
    let mut queue = VecDeque::from([start]);
    while let Some(current) = queue.pop_front() {
        for next in neighbors(current) {
            if traversable.contains(&next) && seen.insert(next) {
                queue.push_back(next);
            }
        }
    }
    seen
}

struct Fields {
    save_id: String,
    schema_version: i64,
    ruleset: String,
    revision: i64,
    phase: String,
    current_day: i64,
    cash_cents: i64,
    rate_cents: i64,
    latest_report: Option<String>,
    phase2: Option<String>,
    operations: Option<String>,
    phase4: Option<String>,
    blueprint: Option<Blueprint>,
    rooms: Vec<Room>,
    reports: Vec<(i64, String)>,
}
struct Blueprint {
    id: String,
    name: String,
    columns: i64,
    rows: i64,
    cells: String,
    metrics: String,
    visual: String,
    openings: Option<String>,
}
struct Room {
    id: String,
    slot: String,
    blueprint: String,
    cost: i64,
}

fn validate_game(g: &Value) -> Result<Fields, String> {
    let schema = intv(g, "schemaVersion", 1, false)?;
    if schema != 1 {
        return Err("存档数据损坏".into());
    }
    let save_id = strv(g, "saveId")?;
    validate_save_id(&save_id)?;
    let ruleset = strv(g, "rulesetVersion")?;
    let revision = intv(g, "revision", 0, false)?;
    let phase = strv(g, "phase")?;
    if !["design", "floor", "ready", "open"].contains(&phase.as_str()) {
        return Err("存档数据损坏".into());
    }
    let current_day = intv(g, "currentDay", 0, false)?;
    let cash_cents = intv(g, "cashCents", 0, false)?;
    let rate_cents = intv(g, "rateCents", 0, true)?;
    let phase2 = match g.get("phase2") {
        Some(Value::Null) | None => None,
        Some(value) => Some(validate_phase2(value)?),
    };
    let operations = match g.get("operations") {
        Some(Value::Null) | None => None,
        Some(value) => {
            validate_operations(value, current_day).map_err(|error| {
                if g.get("phase4").is_some() && error == OPERATIONS_DAILY_SUMMARY_ERROR {
                    phase4_error("经营报告算术不一致")
                } else {
                    error
                }
            })?;
            Some(serde_json::to_string(value).map_err(|_| "存档数据损坏".to_string())?)
        }
    };
    let phase4 = match g.get("phase4") {
        None => None,
        Some(value) => {
            validate_phase4(value, g)?;
            Some(serde_json::to_string(value).map_err(|_| "存档数据损坏".to_string())?)
        }
    };
    let latest_report = match g.get("latestReport") {
        Some(Value::Null) | None => None,
        Some(v) => {
            let latest_day = intv(v, "day", 1, true)?;
            if latest_day != current_day {
                return Err("存档数据损坏".into());
            }
            Some(serde_json::to_string(v).map_err(|_| "存档数据损坏".to_string())?)
        }
    };
    let blueprint = match g.get("roomBlueprint") {
        Some(Value::Null) | None => None,
        Some(v) => {
            let columns = intv(v, "columns", 1, true)?;
            let rows = intv(v, "rows", 1, true)?;
            let openings = match v.get("openings") {
                Some(Value::Null) | None => None,
                Some(openings) => {
                    let (cells, _) = validate_cells(obj(v, "cells")?, columns, rows)?;
                    validate_openings(openings, &cells)?;
                    Some(serde_json::to_string(openings).map_err(|_| "存档数据损坏".to_string())?)
                }
            };
            Some(Blueprint {
                id: strv(v, "id")?,
                name: strv(v, "name")?,
                columns,
                rows,
                cells: serde_json::to_string(obj(v, "cells")?)
                    .map_err(|_| "存档数据损坏".to_string())?,
                metrics: serde_json::to_string(obj(v, "metrics")?)
                    .map_err(|_| "存档数据损坏".to_string())?,
                visual: {
                    validate_visual_tree(obj(v, "visual")?)?;
                    serde_json::to_string(obj(v, "visual")?)
                }
                .map_err(|_| "存档数据损坏".to_string())?,
                openings,
            })
        }
    };
    let floor = obj(g, "floor")?;
    if strv(floor, "id")? != "prototype-floor" {
        return Err("存档数据损坏".into());
    }
    let mut rooms = Vec::new();
    let mut slots = HashSet::new();
    let mut instance_ids = HashSet::new();
    for v in obj(floor, "rooms")?
        .as_array()
        .ok_or_else(|| "存档数据损坏".to_string())?
    {
        let room = Room {
            id: strv(v, "id")?,
            slot: strv(v, "slotId")?,
            blueprint: strv(v, "roomBlueprintId")?,
            cost: intv(v, "committedBuildCostCents", 0, false)?,
        };
        let legacy_slot =
            ["slot-nw", "slot-ne", "slot-sw", "slot-se"].contains(&room.slot.as_str());
        let ring_slot = [
            "north-west",
            "north-east",
            "east-north",
            "east-south",
            "south-east",
            "south-west",
            "west-south",
            "west-north",
        ]
        .contains(&room.slot.as_str());
        if rooms.len() >= 8 || (!legacy_slot && !ring_slot) || !instance_ids.insert(room.id.clone())
        {
            return Err("存档数据损坏".into());
        }
        if !slots.insert(room.slot.clone()) {
            return Err("存档数据损坏".into());
        }
        if blueprint.as_ref().map(|bp| bp.id.as_str()) != Some(room.blueprint.as_str()) {
            return Err("存档数据损坏".into());
        }
        rooms.push(room);
    }
    let mut reports = Vec::new();
    let mut days = HashSet::new();
    let mut previous_day = 0;
    for v in obj(g, "reports")?
        .as_array()
        .ok_or_else(|| "存档数据损坏".to_string())?
    {
        let day = intv(v, "day", 1, true)?;
        if !days.insert(day) || day != previous_day + 1 {
            return Err("日报日期重复".into());
        }
        previous_day = day;
        reports.push((
            day,
            serde_json::to_string(v).map_err(|_| "存档数据损坏".to_string())?,
        ));
    }
    if current_day == 0 {
        if !reports.is_empty() || latest_report.is_some() {
            return Err("存档数据损坏".into());
        }
    } else if reports.len() as i64 != current_day
        || previous_day != current_day
        || latest_report.is_none()
    {
        return Err("存档数据损坏".into());
    }
    if matches!(phase.as_str(), "ready" | "open") && blueprint.is_none() {
        return Err("存档数据损坏".into());
    }
    Ok(Fields {
        save_id,
        schema_version: schema,
        ruleset,
        revision,
        phase,
        current_day,
        cash_cents,
        rate_cents,
        latest_report,
        phase2,
        operations,
        phase4,
        blueprint,
        rooms,
        reports,
    })
}

const JS_MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const PHASE4_STABLE_ID_MAX_LENGTH: usize = 96;
const PHASE4_MAX_JSON_BYTES: usize = 8 * 1024 * 1024;
const PHASE4_PUBLIC_SPACE_TYPES: [&str; 12] = [
    "sky-lobby",
    "all-day-dining",
    "chinese-restaurant",
    "bar",
    "executive-lounge",
    "spa",
    "pool",
    "gym",
    "ballroom",
    "meeting-room",
    "garden-terrace",
    "boutique",
];

fn phase4_error(detail: &str) -> String {
    format!("内容规模存档{detail}")
}

fn phase4_object<'a>(
    value: &'a Value,
    label: &str,
) -> Result<&'a serde_json::Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| phase4_error(&format!("{label}结构无效")))
}

fn phase4_array<'a>(value: &'a Value, label: &str) -> Result<&'a Vec<Value>, String> {
    value
        .as_array()
        .ok_or_else(|| phase4_error(&format!("{label}结构无效")))
}

fn phase4_field<'a>(
    object: &'a serde_json::Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<&'a Value, String> {
    object
        .get(key)
        .ok_or_else(|| phase4_error(&format!("{label}结构无效")))
}

fn phase4_stable_id<'a>(value: &'a Value, label: &str) -> Result<&'a str, String> {
    let id = value
        .as_str()
        .ok_or_else(|| phase4_error(&format!("{label}必须是稳定 ID")))?;
    let valid = !id.is_empty()
        && id.len() <= PHASE4_STABLE_ID_MAX_LENGTH
        && id.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b':' | b'-'))
        });
    if !valid {
        return Err(phase4_error(&format!("{label}必须是稳定 ID")));
    }
    Ok(id)
}

fn validate_phase4_money(value: &Value) -> Result<(), String> {
    let safe_integer = value
        .as_i64()
        .is_some_and(|money| (0..=JS_MAX_SAFE_INTEGER).contains(&money));
    let safe_float = value.as_f64().is_some_and(|money| {
        money.is_finite()
            && money.fract() == 0.0
            && (0.0..=JS_MAX_SAFE_INTEGER as f64).contains(&money)
    });
    if safe_integer || safe_float {
        Ok(())
    } else {
        Err(phase4_error("施工金额必须是安全整数"))
    }
}

fn validate_phase4_identity_record(value: &Value, label: &str) -> Result<(), String> {
    let definitions = phase4_object(value, label)?;
    let mut ids = HashSet::new();
    for (key, raw_definition) in definitions {
        phase4_stable_id(&Value::String(key.clone()), "记录键")?;
        let definition = phase4_object(raw_definition, label)?;
        let id = phase4_stable_id(
            phase4_field(definition, "id", &format!("{label}编号"))?,
            &format!("{label}编号"),
        )?;
        if !ids.insert(id) {
            return Err(phase4_error(&format!("{label}编号重复")));
        }
    }
    for (key, raw_definition) in definitions {
        let definition = phase4_object(raw_definition, label)?;
        if definition.get("id").and_then(Value::as_str) != Some(key) {
            return Err(phase4_error("记录键与编号不一致"));
        }
    }
    Ok(())
}

fn phase4_is_credential_key(key: &str) -> bool {
    let normalized = key
        .chars()
        .filter(|character| character.is_ascii_alphanumeric())
        .map(|character| character.to_ascii_lowercase())
        .collect::<String>();
    matches!(
        normalized.as_str(),
        "password"
            | "passwd"
            | "secret"
            | "apikey"
            | "accesstoken"
            | "refreshtoken"
            | "authtoken"
            | "privatekey"
            | "clientsecret"
            | "credential"
            | "credentials"
    )
}

fn phase4_is_base64(value: &str) -> bool {
    let payload = if value.starts_with("data:") && value.contains(";base64,") {
        value
            .split_once(',')
            .map(|(_, payload)| payload)
            .unwrap_or("")
    } else {
        value
    };
    let bytes = payload.as_bytes();
    if bytes.len() < 128 || bytes.len() % 4 != 0 {
        return false;
    }
    let padding = bytes.iter().rev().take_while(|byte| **byte == b'=').count();
    padding <= 2
        && bytes[..bytes.len() - padding]
            .iter()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/'))
        && bytes[bytes.len() - padding..]
            .iter()
            .all(|byte| *byte == b'=')
}

fn phase4_is_javascript_whitespace(character: char) -> bool {
    matches!(
        character,
        '\u{0009}'
            | '\u{000A}'
            | '\u{000B}'
            | '\u{000C}'
            | '\u{000D}'
            | '\u{0020}'
            | '\u{00A0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
    )
}

fn phase4_contains_bearer_credential(value: &str, lower: &str) -> bool {
    lower.match_indices("bearer").any(|(index, _)| {
        let has_word_boundary = index == 0
            || !lower.as_bytes()[index - 1].is_ascii_alphanumeric()
                && lower.as_bytes()[index - 1] != b'_';
        if !has_word_boundary {
            return false;
        }
        let remainder = &value[index + "bearer".len()..];
        let mut whitespace_end = 0;
        let mut has_whitespace = false;
        for (offset, character) in remainder.char_indices() {
            if !phase4_is_javascript_whitespace(character) {
                break;
            }
            has_whitespace = true;
            whitespace_end = offset + character.len_utf8();
        }
        if !has_whitespace {
            return false;
        }
        remainder[whitespace_end..]
            .bytes()
            .take_while(|byte| {
                byte.is_ascii_alphanumeric()
                    || matches!(byte, b'.' | b'_' | b'~' | b'+' | b'/' | b'=' | b'-')
            })
            .count()
            >= 12
    })
}

fn phase4_contains_credential(value: &str) -> bool {
    let lower = value.to_ascii_lowercase();
    if lower.contains("-----begin ") && lower.contains("private key-----") {
        return true;
    }
    if phase4_contains_bearer_credential(value, &lower) {
        return true;
    }
    [
        "api_key",
        "api-key",
        "apikey",
        "access_token",
        "access-token",
        "accesstoken",
        "refresh_token",
        "refresh-token",
        "refreshtoken",
        "auth_token",
        "auth-token",
        "authtoken",
        "private_key",
        "private-key",
        "privatekey",
        "client_secret",
        "client-secret",
        "clientsecret",
        "password",
        "secret",
        "credential",
        "credentials",
    ]
    .iter()
    .any(|term| {
        lower.match_indices(term).any(|(index, _)| {
            let has_boundary = index == 0
                || (!lower.as_bytes()[index - 1].is_ascii_alphanumeric()
                    && lower.as_bytes()[index - 1] != b'_');
            has_boundary
                && lower[index + term.len()..]
                    .trim_start()
                    .starts_with([':', '='])
        })
    })
}

fn validate_phase4_tree(value: &Value) -> Result<(), String> {
    let mut pending = vec![(value, 0usize)];
    while let Some((current, depth)) = pending.pop() {
        if depth > 32 {
            return Err(phase4_error("JSON嵌套过深"));
        }
        match current {
            Value::String(text) => {
                if text.chars().count() > 4_096 {
                    return Err(phase4_error("文本超过长度限制"));
                }
                if phase4_contains_credential(text) {
                    return Err(phase4_error("禁止持久化凭据"));
                }
                if phase4_is_base64(text) {
                    return Err(phase4_error("禁止持久化Base64数据"));
                }
            }
            Value::Array(values) => {
                pending.extend(values.iter().map(|child| (child, depth + 1)));
            }
            Value::Object(object) => {
                for (key, child) in object {
                    if key.chars().count() > 128 {
                        return Err(phase4_error("字段名超过长度限制"));
                    }
                    if phase4_is_credential_key(key) {
                        return Err(phase4_error("禁止持久化凭据"));
                    }
                    pending.push((child, depth + 1));
                }
            }
            _ => {}
        }
    }
    Ok(())
}

fn validate_phase4_safe_numbers(value: &Value) -> Result<(), String> {
    let mut pending = vec![value];
    while let Some(current) = pending.pop() {
        match current {
            Value::Number(number) => {
                let safe = number.as_f64().is_some_and(|value| {
                    value.is_finite() && value.abs() <= JS_MAX_SAFE_INTEGER as f64
                });
                if !safe {
                    return Err(phase4_error("数字必须是有限安全 JSON 数字"));
                }
            }
            Value::Array(values) => pending.extend(values),
            Value::Object(object) => pending.extend(object.values()),
            _ => {}
        }
    }
    Ok(())
}

fn phase4_type<'a>(value: &'a Value, label: &str) -> Result<&'a str, String> {
    let candidate = value
        .as_str()
        .ok_or_else(|| phase4_error(&format!("{label}目录引用无效")))?;
    if !PHASE4_PUBLIC_SPACE_TYPES.contains(&candidate) {
        return Err(phase4_error(&format!("{label}目录引用无效")));
    }
    Ok(candidate)
}

fn phase4_zone(value: &Value) -> Result<&str, String> {
    phase4_one_of(
        value,
        &[
            "zone:arrival",
            "zone:seating",
            "zone:kitchen",
            "zone:bar-service",
            "zone:quiet",
            "zone:wet",
            "zone:fitness",
            "zone:event",
            "zone:back-of-house",
            "zone:terrace",
            "zone:retail",
            "zone:deck",
            "zone:service-route",
            "zone:entrance",
            "zone:reception",
            "zone:waiting",
            "zone:luggage",
            "zone:elevator-lobby",
            "zone:treatment",
            "zone:wet-route",
            "zone:stage",
            "zone:meeting-setup",
            "zone:partition",
        ],
        "分区",
    )
}

fn phase4_item(value: &Value) -> Result<&str, String> {
    phase4_one_of(
        value,
        &[
            "item:reception-desk",
            "item:lounge-seat",
            "item:dining-table",
            "item:service-counter",
            "item:bar-counter",
            "item:treatment-bed",
            "item:pool",
            "item:fitness-station",
            "item:event-table",
            "item:meeting-table",
            "item:planter",
            "item:display-case",
        ],
        "物品目录",
    )
}

fn phase4_policy_group(facility_type: &str) -> Option<&'static str> {
    match facility_type {
        "all-day-dining" | "chinese-restaurant" => Some("dining"),
        "bar" => Some("bar"),
        "spa" => Some("spa"),
        "ballroom" | "meeting-room" => Some("banquet"),
        _ => None,
    }
}

fn phase4_policy_allowed(group: &str, positioning: &str, price: &str, opening: &str) -> bool {
    matches!(
        (group, positioning, price, opening),
        (
            "dining",
            "positioning:international-luxury",
            "price-band:premium",
            "opening-policy:breakfast-dinner"
        ) | (
            "dining",
            "positioning:local-contemporary",
            "price-band:upper-midscale",
            "opening-policy:all-day"
        ) | (
            "dining",
            "positioning:destination-dining",
            "price-band:luxury",
            "opening-policy:dinner-only"
        ) | (
            "bar",
            "positioning:craft-cocktail",
            "price-band:premium",
            "opening-policy:evening"
        ) | (
            "bar",
            "positioning:social-lounge",
            "price-band:upper-midscale",
            "opening-policy:afternoon-late"
        ) | (
            "bar",
            "positioning:skyline-luxury",
            "price-band:luxury",
            "opening-policy:sunset-late"
        ) | (
            "spa",
            "positioning:restorative-wellness",
            "price-band:premium",
            "opening-policy:appointment-daily"
        ) | (
            "spa",
            "positioning:clinical-wellness",
            "price-band:luxury",
            "opening-policy:appointment-extended"
        ) | (
            "spa",
            "positioning:express-wellness",
            "price-band:upper-midscale",
            "opening-policy:daytime"
        ) | (
            "banquet",
            "positioning:corporate-events",
            "price-band:premium",
            "opening-policy:booked-events"
        ) | (
            "banquet",
            "positioning:celebration-luxury",
            "price-band:luxury",
            "opening-policy:booked-events"
        ) | (
            "banquet",
            "positioning:flexible-events",
            "price-band:upper-midscale",
            "opening-policy:day-evening"
        )
    )
}

fn phase4_offering_allowed(facility_type: &str, offering: &str) -> bool {
    matches!(
        (facility_type, offering),
        (
            "all-day-dining",
            "dish:tea-smoked-duck" | "dish:cloud-breakfast" | "dish:harbor-seafood"
        ) | (
            "chinese-restaurant",
            "dish:tea-smoked-duck" | "dish:crystal-shrimp" | "dish:mountain-broth"
        ) | (
            "bar",
            "drink:cloud-negroni" | "drink:tea-spritz" | "drink:night-orchard"
        ) | (
            "spa",
            "service:cloud-restoration" | "service:express-recovery" | "service:couples-ritual"
        ) | (
            "ballroom" | "meeting-room",
            "service:cloud-wedding" | "service:executive-summit" | "service:cultural-gala"
        )
    )
}

fn phase4_menu_allowed(facility_type: &str, menu: &str) -> bool {
    matches!(
        (facility_type, menu),
        (
            "all-day-dining",
            "menu:all-day-balanced" | "menu:all-day-seasonal" | "menu:all-day-chef-led"
        ) | (
            "chinese-restaurant",
            "menu:chinese-regional" | "menu:chinese-banquet" | "menu:chinese-modern"
        ) | (
            "bar",
            "menu:bar-classics" | "menu:bar-seasonal" | "menu:bar-zero-proof"
        )
    )
}

fn phase4_unique_catalog_ids(value: &Value, allowed: &HashSet<String>) -> Result<(), String> {
    let mut ids = HashSet::new();
    for raw in phase4_array(value, "目录进度")? {
        let id = phase4_stable_id(raw, "目录进度编号")?;
        if !ids.insert(id) {
            return Err(phase4_error("目录进度编号重复"));
        }
        if !allowed.contains(id) {
            return Err(phase4_error("目录引用无效"));
        }
    }
    Ok(())
}

fn phase4_int(value: &Value, label: &str, minimum: i64, maximum: i64) -> Result<i64, String> {
    let number = value
        .as_f64()
        .filter(|number| number.is_finite() && number.fract() == 0.0)
        .filter(|number| {
            *number >= minimum as f64
                && *number <= maximum as f64
                && number.abs() <= JS_MAX_SAFE_INTEGER as f64
        })
        .ok_or_else(|| phase4_error(&format!("{label}必须是安全整数")))?;
    Ok(number as i64)
}

fn phase4_bool(value: &Value, label: &str) -> Result<bool, String> {
    value
        .as_bool()
        .ok_or_else(|| phase4_error(&format!("{label}结构无效")))
}

fn phase4_one_of<'a>(value: &'a Value, allowed: &[&str], label: &str) -> Result<&'a str, String> {
    let candidate = value
        .as_str()
        .ok_or_else(|| phase4_error(&format!("{label}目录引用无效")))?;
    if !allowed.contains(&candidate) {
        return Err(phase4_error(&format!("{label}目录引用无效")));
    }
    Ok(candidate)
}

fn phase4_unique_ids<'a>(value: &'a Value, label: &str) -> Result<Vec<&'a str>, String> {
    let mut ids = HashSet::new();
    let mut result = Vec::new();
    for raw in phase4_array(value, label)? {
        let id = phase4_stable_id(raw, label)?;
        if !ids.insert(id) {
            return Err(phase4_error(&format!("{label}编号重复")));
        }
        result.push(id);
    }
    Ok(result)
}

fn validate_phase4(value: &Value, game: &Value) -> Result<(), String> {
    if serde_json::to_vec(value)
        .map_err(|_| phase4_error("JSON结构无效"))?
        .len()
        > PHASE4_MAX_JSON_BYTES
    {
        return Err(phase4_error("JSON超过大小限制"));
    }
    validate_phase4_tree(value)?;
    let phase4 = phase4_object(value, "状态")?;
    let current_day = phase4_int(
        game.get("currentDay")
            .ok_or_else(|| phase4_error("当前营业日结构无效"))?,
        "当前营业日",
        0,
        30,
    )?;
    if phase4.get("rulesetVersion").and_then(Value::as_str) != Some("content-scale-v1") {
        return Err(phase4_error("规则版本无效"));
    }
    for (key, label) in [
        ("building", "建筑"),
        ("floorTemplates", "楼层模板"),
        ("spaceBlueprints", "公共空间蓝图"),
        ("publicSpaces", "公共空间"),
        ("facilities", "设施"),
        ("catalogProgress", "目录进度"),
    ] {
        phase4_object(phase4_field(phase4, key, label)?, label)?;
    }
    for (key, label) in [
        ("floorTemplates", "楼层模板"),
        ("spaceBlueprints", "公共空间蓝图"),
        ("publicSpaces", "公共空间"),
        ("facilities", "设施"),
    ] {
        validate_phase4_identity_record(phase4_field(phase4, key, label)?, label)?;
    }
    let floors = phase4_array(phase4_field(phase4, "floors", "楼层")?, "楼层")?;
    if floors.len() > 64 {
        return Err(phase4_error("楼层最多保留64层"));
    }
    match phase4.get("recentFlowSnapshot") {
        Some(Value::Null | Value::Object(_)) => {}
        _ => return Err(phase4_error("近期流动快照结构无效")),
    }

    let templates = phase4_object(
        phase4_field(phase4, "floorTemplates", "楼层模板")?,
        "楼层模板",
    )?;
    if templates.len() > 64 {
        return Err(phase4_error("楼层模板最多保留64项"));
    }
    let mut design_ids = HashSet::new();
    if let Some(master) = game
        .get("phase2")
        .and_then(|phase2| phase2.get("roomMaster"))
        .filter(|master| !master.is_null())
    {
        design_ids.insert(phase4_stable_id(obj(master, "id")?, "客房母版编号")?);
    }
    if let Some(blueprint) = game.get("roomBlueprint").filter(|value| !value.is_null()) {
        design_ids.insert(phase4_stable_id(obj(blueprint, "id")?, "客房设计编号")?);
    }
    let mut variants = HashMap::new();
    if let Some(raw_variants) = game
        .get("phase2")
        .and_then(|phase2| phase2.get("roomVariants"))
    {
        for raw_variant in phase4_array(raw_variants, "客房变体")? {
            let variant = phase4_object(raw_variant, "客房变体")?;
            let id =
                phase4_stable_id(phase4_field(variant, "id", "客房变体编号")?, "客房变体编号")?;
            let master_id = phase4_stable_id(
                phase4_field(variant, "masterId", "客房母版编号")?,
                "客房母版编号",
            )?;
            if variants.insert(id, master_id).is_some() {
                return Err(phase4_error("客房变体编号重复"));
            }
        }
    }
    let mut template_uses = HashMap::new();
    let mut template_placements: HashMap<&str, HashMap<&str, (&str, Option<&str>)>> =
        HashMap::new();
    let mut template_slots: HashMap<&str, HashMap<&str, HashSet<&str>>> = HashMap::new();
    for (template_id, raw_template) in templates {
        let template = phase4_object(raw_template, "楼层模板")?;
        let use_id = phase4_one_of(
            phase4_field(template, "use", "楼层用途")?,
            &["entrance", "sky-lobby", "guest", "facility", "service"],
            "楼层用途",
        )?;
        template_uses.insert(template_id.as_str(), use_id);
        let columns = phase4_int(
            phase4_field(template, "columns", "楼层模板列数")?,
            "楼层模板列数",
            1,
            512,
        )?;
        let rows = phase4_int(
            phase4_field(template, "rows", "楼层模板行数")?,
            "楼层模板行数",
            1,
            512,
        )?;
        if phase4_field(template, "cellAreaSquareMeters", "楼层模板单元面积")?.as_f64() != Some(1.0)
        {
            return Err(phase4_error("楼层模板单元面积无效"));
        }
        let mut placements = HashMap::new();
        for raw_placement in phase4_array(
            phase4_field(template, "roomPlacements", "客房放置")?,
            "客房放置",
        )? {
            let placement = phase4_object(raw_placement, "客房放置")?;
            let id = phase4_stable_id(
                phase4_field(placement, "id", "客房放置编号")?,
                "客房放置编号",
            )?;
            let master_id = phase4_stable_id(
                phase4_field(placement, "roomBlueprintId", "客房母版编号")?,
                "客房母版编号",
            )?;
            if !design_ids.is_empty() && !design_ids.contains(master_id) {
                return Err(phase4_error("客房设计引用无效"));
            }
            let variant_id = placement
                .get("variantId")
                .map(|value| phase4_stable_id(value, "客房变体编号"))
                .transpose()?;
            if variant_id.is_some_and(|id| variants.get(id).copied() != Some(master_id)) {
                return Err(phase4_error("客房变体引用无效"));
            }
            let anchor_x = phase4_int(
                phase4_field(placement, "anchorX", "客房横坐标")?,
                "客房横坐标",
                0,
                columns - 1,
            )?;
            let anchor_y = phase4_int(
                phase4_field(placement, "anchorY", "客房纵坐标")?,
                "客房纵坐标",
                0,
                rows - 1,
            )?;
            let width = phase4_int(
                phase4_field(placement, "width", "客房宽度")?,
                "客房宽度",
                1,
                columns,
            )?;
            let height = phase4_int(
                phase4_field(placement, "height", "客房高度")?,
                "客房高度",
                1,
                rows,
            )?;
            if anchor_x + width > columns || anchor_y + height > rows {
                return Err(phase4_error("客房放置超出楼层模板"));
            }
            let rotation = phase4_int(
                phase4_field(placement, "rotation", "客房旋转")?,
                "客房旋转",
                0,
                270,
            )?;
            if ![0, 90, 180, 270].contains(&rotation) {
                return Err(phase4_error("客房放置几何无效"));
            }
            phase4_bool(phase4_field(placement, "mirrored", "客房镜像")?, "客房镜像")?;
            if placements.insert(id, (master_id, variant_id)).is_some() {
                return Err(phase4_error("客房放置编号重复"));
            }
        }
        template_placements.insert(template_id, placements);
        let mut slots = HashMap::new();
        for raw_slot in phase4_array(
            phase4_field(template, "publicSpaceSlots", "公共空间槽位")?,
            "公共空间槽位",
        )? {
            let slot = phase4_object(raw_slot, "公共空间槽位")?;
            let id = phase4_stable_id(
                phase4_field(slot, "id", "公共空间槽位编号")?,
                "公共空间槽位编号",
            )?;
            let permitted_values = phase4_array(
                phase4_field(slot, "permittedTypes", "允许设施类型")?,
                "允许设施类型",
            )?;
            let permitted = permitted_values
                .iter()
                .map(|value| phase4_type(value, "设施类型"))
                .collect::<Result<HashSet<_>, _>>()?;
            if permitted.is_empty() || permitted.len() != permitted_values.len() {
                return Err(phase4_error("允许设施类型无效"));
            }
            let geometry_fields = ["anchorX", "anchorY", "width", "height"];
            let geometry_field_count = geometry_fields
                .iter()
                .filter(|field| slot.get(**field).is_some())
                .count();
            if geometry_field_count != 0 && geometry_field_count != geometry_fields.len() {
                return Err(phase4_error("公共空间槽位几何必须完整"));
            }
            if geometry_field_count == geometry_fields.len() {
                let geometry_int = |field: &str, minimum: i64, maximum: i64| {
                    phase4_int(
                        phase4_field(slot, field, "公共空间槽位几何")?,
                        "公共空间槽位几何",
                        minimum,
                        maximum,
                    )
                };
                let anchor_x = geometry_int("anchorX", 0, columns - 1)?;
                let anchor_y = geometry_int("anchorY", 0, rows - 1)?;
                let width = geometry_int("width", 1, columns)?;
                let height = geometry_int("height", 1, rows)?;
                let right = anchor_x
                    .checked_add(width)
                    .ok_or_else(|| phase4_error("公共空间槽位几何超出楼层模板"))?;
                let bottom = anchor_y
                    .checked_add(height)
                    .ok_or_else(|| phase4_error("公共空间槽位几何超出楼层模板"))?;
                if right > columns || bottom > rows {
                    return Err(phase4_error("公共空间槽位几何超出楼层模板"));
                }
            }
            if slots.insert(id, permitted).is_some() {
                return Err(phase4_error("公共空间槽位无效"));
            }
        }
        template_slots.insert(template_id, slots);
    }

    let mut floor_ids = HashSet::new();
    let mut floor_records = HashMap::new();
    let mut floor_numbers = HashSet::new();
    let mut owned_spaces = HashMap::new();
    let mut room_ids = HashSet::new();
    let mut room_owners = Vec::new();
    let mut room_count = 0usize;
    for raw_floor in floors {
        let floor = phase4_object(raw_floor, "楼层")?;
        let floor_id = phase4_stable_id(phase4_field(floor, "id", "楼层编号")?, "楼层编号")?;
        if !floor_ids.insert(floor_id) {
            return Err(phase4_error("楼层编号重复"));
        }
        let floor_number = phase4_int(
            phase4_field(floor, "floorNumber", "楼层号")?,
            "楼层号",
            1,
            64,
        )?;
        if !floor_numbers.insert(floor_number) {
            return Err(phase4_error("楼层号重复"));
        }
        let use_id = phase4_one_of(
            phase4_field(floor, "use", "楼层用途")?,
            &["entrance", "sky-lobby", "guest", "facility", "service"],
            "楼层用途",
        )?;
        let template_id = phase4_stable_id(
            phase4_field(floor, "templateId", "楼层模板编号")?,
            "楼层模板编号",
        )?;
        if template_uses.get(template_id).copied() != Some(use_id) {
            return Err(phase4_error("楼层模板引用无效"));
        }
        phase4_bool(
            phase4_field(floor, "purchased", "楼层购买状态")?,
            "楼层购买状态",
        )?;
        for space_id in phase4_unique_ids(
            phase4_field(floor, "publicSpaceInstanceIds", "楼层公共空间")?,
            "楼层公共空间",
        )? {
            if owned_spaces.insert(space_id, floor_id).is_some() {
                return Err(phase4_error("公共空间所属楼层重复"));
            }
        }
        floor_records.insert(floor_id, (use_id, template_id));
        for raw_room in phase4_array(phase4_field(floor, "rooms", "客房")?, "客房")? {
            room_count += 1;
            if room_count > 240 {
                return Err(phase4_error("客房最多保留240间"));
            }
            let room = phase4_object(raw_room, "客房")?;
            let room_id = phase4_stable_id(phase4_field(room, "id", "客房编号")?, "客房编号")?;
            if !room_ids.insert(room_id) {
                return Err(phase4_error("客房编号重复"));
            }
            room_owners.push((
                phase4_stable_id(
                    phase4_field(room, "floorId", "客房楼层编号")?,
                    "客房楼层编号",
                )?,
                floor_id,
            ));
            let placement_id = phase4_stable_id(
                phase4_field(room, "localPlacementId", "客房放置编号")?,
                "客房放置编号",
            )?;
            let master_id = phase4_stable_id(
                phase4_field(room, "roomBlueprintId", "客房母版编号")?,
                "客房母版编号",
            )?;
            let variant_id = room
                .get("variantId")
                .map(|value| phase4_stable_id(value, "客房变体编号"))
                .transpose()?;
            if template_placements
                .get(template_id)
                .and_then(|placements| placements.get(placement_id))
                .copied()
                != Some((master_id, variant_id))
            {
                return Err(phase4_error("客房放置或设计引用无效"));
            }
            validate_phase4_money(phase4_field(room, "committedBuildCostCents", "施工金额")?)?;
        }
    }
    if room_owners
        .iter()
        .any(|(floor_id, _)| !floor_ids.contains(floor_id))
    {
        return Err(phase4_error("客房楼层引用无效"));
    }
    if room_owners
        .iter()
        .any(|(floor_id, containing_floor_id)| floor_id != containing_floor_id)
    {
        return Err(phase4_error("客房必须属于所在楼层"));
    }

    let building = phase4_object(phase4_field(phase4, "building", "建筑")?, "建筑")?;
    if phase4_stable_id(
        phase4_field(building, "templateId", "建筑模板编号")?,
        "建筑模板编号",
    )? != "building-template:first-tower"
    {
        return Err(phase4_error("目录引用无效"));
    }
    let entrance_id = phase4_stable_id(
        phase4_field(building, "entranceFloorId", "入口楼层编号")?,
        "入口楼层编号",
    )?;
    if floor_records.get(entrance_id).map(|record| record.0) != Some("entrance") {
        return Err(phase4_error("入口楼层引用无效"));
    }
    for floor_id in phase4_unique_ids(
        phase4_field(building, "skyLobbyFloorIds", "空中大堂楼层")?,
        "空中大堂楼层",
    )? {
        if floor_records.get(floor_id).map(|record| record.0) != Some("sky-lobby") {
            return Err(phase4_error("空中大堂楼层引用无效"));
        }
    }
    for floor_id in phase4_unique_ids(
        phase4_field(building, "purchasedFloorIds", "已购买楼层")?,
        "已购买楼层",
    )? {
        if !floor_ids.contains(floor_id) {
            return Err(phase4_error("已购买楼层引用无效"));
        }
    }
    let mut expansion_numbers = HashSet::new();
    for raw_number in phase4_array(
        phase4_field(building, "availableExpansionFloorNumbers", "可扩建楼层")?,
        "可扩建楼层",
    )? {
        let number = phase4_int(raw_number, "可扩建楼层号", 1, 64)?;
        if !expansion_numbers.insert(number) || floor_numbers.contains(&number) {
            return Err(phase4_error("可扩建楼层引用无效"));
        }
    }

    let blueprints = phase4_object(
        phase4_field(phase4, "spaceBlueprints", "公共空间蓝图")?,
        "公共空间蓝图",
    )?;
    if blueprints.len() > 32 {
        return Err(phase4_error("公共空间蓝图最多保留32项"));
    }
    let public_spaces = phase4_object(
        phase4_field(phase4, "publicSpaces", "公共空间")?,
        "公共空间",
    )?;
    if public_spaces.len() > 32 {
        return Err(phase4_error("公共空间最多保留32项"));
    }
    let mut occupied_space_placements = HashSet::new();
    for (space_id, raw_space) in public_spaces {
        let space = phase4_object(raw_space, "公共空间")?;
        let type_id = phase4_type(phase4_field(space, "type", "公共空间类型")?, "公共空间类型")?;
        let floor_id = phase4_stable_id(
            phase4_field(space, "floorId", "公共空间楼层编号")?,
            "公共空间楼层编号",
        )?;
        if !floor_ids.contains(floor_id) {
            return Err(phase4_error("公共空间楼层引用无效"));
        }
        if owned_spaces.get(space_id.as_str()).copied() != Some(floor_id) {
            return Err(phase4_error("公共空间楼层引用无效"));
        }
        let slot_id = phase4_stable_id(
            phase4_field(space, "localPlacementId", "公共空间槽位编号")?,
            "公共空间槽位编号",
        )?;
        if !occupied_space_placements.insert((floor_id, slot_id)) {
            return Err(phase4_error("公共空间放置重复"));
        }
        let (floor_use, canonical_template_id) = floor_records
            .get(floor_id)
            .copied()
            .ok_or_else(|| phase4_error("公共空间楼层引用无效"))?;
        let snapshot_template_id = format!("template-snapshot:{floor_id}");
        let applied_template_id = if template_slots.contains_key(snapshot_template_id.as_str()) {
            snapshot_template_id.as_str()
        } else {
            canonical_template_id
        };
        if template_uses.get(applied_template_id).copied() != Some(floor_use) {
            return Err(phase4_error("公共空间槽位或类型引用无效"));
        }
        if !template_slots
            .get(applied_template_id)
            .and_then(|slots| slots.get(slot_id))
            .is_some_and(|types| types.contains(type_id))
        {
            return Err(phase4_error("公共空间槽位或类型引用无效"));
        }
        let blueprint_id = phase4_stable_id(
            phase4_field(space, "blueprintId", "公共空间蓝图编号")?,
            "公共空间蓝图编号",
        )?;
        if blueprints
            .get(blueprint_id)
            .and_then(|blueprint| blueprint.get("type"))
            .and_then(Value::as_str)
            != Some(type_id)
        {
            return Err(phase4_error("公共空间蓝图引用无效"));
        }
        validate_phase4_money(phase4_field(space, "committedBuildCostCents", "施工金额")?)?;
    }
    if owned_spaces.len() != public_spaces.len() {
        return Err(phase4_error("楼层公共空间反向引用不完整"));
    }
    for raw_blueprint in blueprints.values() {
        let blueprint = phase4_object(raw_blueprint, "公共空间蓝图")?;
        phase4_type(
            phase4_field(blueprint, "type", "公共空间类型")?,
            "公共空间类型",
        )?;
        let name = phase4_field(blueprint, "name", "公共空间名称")?
            .as_str()
            .filter(|name| !name.trim().is_empty() && name.trim() == *name)
            .filter(|name| name.chars().count() <= 256)
            .ok_or_else(|| phase4_error("公共空间名称文本无效"))?;
        let _ = name;
        let cells = phase4_array(
            phase4_field(blueprint, "cells", "公共空间蓝图格子")?,
            "公共空间蓝图格子",
        )?;
        if cells.len() > 8_192 {
            return Err(phase4_error("公共空间蓝图格子最多保留8192项"));
        }
        let columns = phase4_int(
            phase4_field(blueprint, "columns", "公共空间列数")?,
            "公共空间列数",
            1,
            512,
        )?;
        let rows = phase4_int(
            phase4_field(blueprint, "rows", "公共空间行数")?,
            "公共空间行数",
            1,
            512,
        )?;
        let mut coordinates = HashSet::new();
        for raw_cell in cells {
            let cell = phase4_object(raw_cell, "公共空间格子")?;
            let x = phase4_int(
                phase4_field(cell, "x", "公共空间格子横坐标")?,
                "公共空间格子横坐标",
                0,
                columns - 1,
            )?;
            let y = phase4_int(
                phase4_field(cell, "y", "公共空间格子纵坐标")?,
                "公共空间格子纵坐标",
                0,
                rows - 1,
            )?;
            if !coordinates.insert((x, y)) {
                return Err(phase4_error("公共空间格子坐标重复"));
            }
            phase4_zone(phase4_field(cell, "zoneId", "分区编号")?)?;
        }
        let items = phase4_array(
            phase4_field(blueprint, "placedItems", "公共空间蓝图物品")?,
            "公共空间蓝图物品",
        )?;
        if items.len() > 256 {
            return Err(phase4_error("公共空间蓝图物品最多保留256项"));
        }
        let mut item_ids = HashSet::new();
        for raw_item in items {
            let item = phase4_object(raw_item, "公共空间物品")?;
            let id = phase4_stable_id(
                phase4_field(item, "id", "公共空间物品编号")?,
                "公共空间物品编号",
            )?;
            if !item_ids.insert(id) {
                return Err(phase4_error("公共空间物品编号重复"));
            }
            phase4_item(phase4_field(item, "catalogItemId", "物品目录编号")?)?;
            let x = phase4_int(
                phase4_field(item, "x", "物品横坐标")?,
                "物品横坐标",
                0,
                columns - 1,
            )?;
            let y = phase4_int(
                phase4_field(item, "y", "物品纵坐标")?,
                "物品纵坐标",
                0,
                rows - 1,
            )?;
            let width = phase4_int(
                phase4_field(item, "width", "物品宽度")?,
                "物品宽度",
                1,
                columns,
            )?;
            let height = phase4_int(
                phase4_field(item, "height", "物品高度")?,
                "物品高度",
                1,
                rows,
            )?;
            if x + width > columns || y + height > rows {
                return Err(phase4_error("公共空间物品超出蓝图"));
            }
            let rotation = phase4_int(
                phase4_field(item, "rotation", "物品旋转")?,
                "物品旋转",
                0,
                270,
            )?;
            if ![0, 90, 180, 270].contains(&rotation) {
                return Err(phase4_error("物品旋转无效"));
            }
        }
        validate_phase4_money(phase4_field(
            blueprint,
            "committedBuildCostCents",
            "施工金额",
        )?)?;
    }
    let facilities = phase4_object(phase4_field(phase4, "facilities", "设施")?, "设施")?;
    if facilities.len() > 32 {
        return Err(phase4_error("设施最多保留32项"));
    }
    let mut facility_space_ids = HashSet::new();
    for raw_facility in facilities.values() {
        let facility = phase4_object(raw_facility, "设施")?;
        let type_id = phase4_type(phase4_field(facility, "type", "设施类型")?, "设施类型")?;
        let instance_id = phase4_stable_id(
            phase4_field(facility, "publicSpaceInstanceId", "设施公共空间编号")?,
            "设施公共空间编号",
        )?;
        if !facility_space_ids.insert(instance_id) {
            return Err(phase4_error("设施公共空间引用重复"));
        }
        if public_spaces
            .get(instance_id)
            .and_then(|space| space.get("type"))
            .and_then(Value::as_str)
            != Some(type_id)
        {
            return Err(phase4_error("设施公共空间引用无效"));
        }
        phase4_one_of(
            phase4_field(facility, "status", "设施状态")?,
            &["planned", "operating", "closed"],
            "设施状态",
        )?;
        phase4_bool(
            phase4_field(facility, "enabled", "设施启用状态")?,
            "设施启用状态",
        )?;
        validate_phase4_money(phase4_field(
            facility,
            "dailyOperatingCostCents",
            "设施每日成本",
        )?)?;
        let inputs = phase4_object(
            phase4_field(facility, "segmentInputs", "设施客群输入")?,
            "设施客群输入",
        )?;
        if inputs.len() != OPERATIONS_SEGMENTS.len()
            || OPERATIONS_SEGMENTS
                .iter()
                .any(|id| !inputs.contains_key(*id))
        {
            return Err(phase4_error("设施客群目录不完整"));
        }
        for input in inputs.values() {
            let input = phase4_object(input, "设施客群输入")?;
            phase4_int(
                phase4_field(input, "appealBps", "客群吸引力")?,
                "客群吸引力",
                0,
                10_000,
            )?;
            phase4_int(
                phase4_field(input, "satisfactionBps", "客群满意度")?,
                "客群满意度",
                0,
                10_000,
            )?;
            phase4_int(
                phase4_field(input, "dailyDemand", "客群每日需求")?,
                "客群每日需求",
                0,
                JS_MAX_SAFE_INTEGER,
            )?;
        }
        let developed = phase4_unique_ids(
            phase4_field(facility, "developedOfferingIds", "已开发产品")?,
            "已开发产品",
        )?;
        if developed
            .iter()
            .any(|offering| !phase4_offering_allowed(type_id, offering))
        {
            return Err(phase4_error("目录引用无效"));
        }
        match facility.get("policy") {
            Some(Value::Null) => {}
            Some(policy) => {
                let policy = phase4_object(policy, "设施策略")?;
                let positioning = phase4_stable_id(
                    phase4_field(policy, "positioningId", "设施策略编号")?,
                    "设施策略编号",
                )?;
                let price = phase4_stable_id(
                    phase4_field(policy, "priceBandId", "设施策略编号")?,
                    "设施策略编号",
                )?;
                let opening = phase4_stable_id(
                    phase4_field(policy, "openingPolicyId", "设施策略编号")?,
                    "设施策略编号",
                )?;
                let group =
                    phase4_policy_group(type_id).ok_or_else(|| phase4_error("目录引用无效"))?;
                if !phase4_policy_allowed(group, positioning, price, opening) {
                    return Err(phase4_error("目录引用无效"));
                }
                phase4_int(
                    phase4_field(policy, "capacity", "设施容量")?,
                    "设施容量",
                    1,
                    10_000,
                )?;
                validate_phase4_money(phase4_field(policy, "serviceBudgetCents", "设施服务预算")?)?;
                if let Some(offering) = policy.get("signatureOfferingId") {
                    let offering = phase4_stable_id(offering, "招牌产品编号")?;
                    if !phase4_offering_allowed(type_id, offering) || !developed.contains(&offering)
                    {
                        return Err(phase4_error("目录引用无效"));
                    }
                }
            }
            None => return Err(phase4_error("设施策略结构无效")),
        }
        match facility.get("menuSelection") {
            Some(Value::Null) => {}
            Some(menu) => {
                let menu = phase4_object(menu, "菜单选择")?;
                let menu_id = phase4_stable_id(
                    phase4_field(menu, "menuStructureId", "菜单编号")?,
                    "菜单编号",
                )?;
                if !phase4_menu_allowed(type_id, menu_id) {
                    return Err(phase4_error("目录引用无效"));
                }
                phase4_unique_ids(
                    phase4_field(menu, "selectedItemIds", "菜单条目")?,
                    "菜单条目",
                )?;
            }
            None => return Err(phase4_error("菜单选择结构无效")),
        }
        let history = phase4_array(
            phase4_field(facility, "dailyResults", "设施历史")?,
            "设施历史",
        )?;
        if history.len() > 30 {
            return Err(phase4_error("设施历史最多保留30天"));
        }
        let mut previous_day = 0;
        for result in history {
            let result = phase4_object(result, "设施历史")?;
            let day = phase4_int(
                phase4_field(result, "day", "设施历史日期")?,
                "设施历史日期",
                1,
                30,
            )?;
            if day <= previous_day || day > current_day {
                return Err(phase4_error("设施历史日期无效"));
            }
            previous_day = day;
            for (key, label) in [
                ("visits", "设施到访量"),
                ("revenueCents", "设施收入"),
                ("operatingCostCents", "设施经营成本"),
            ] {
                phase4_int(
                    phase4_field(result, key, label)?,
                    label,
                    0,
                    JS_MAX_SAFE_INTEGER,
                )?;
            }
            phase4_int(
                phase4_field(result, "utilizationBps", "设施利用率")?,
                "设施利用率",
                0,
                10_000,
            )?;
            phase4_int(
                phase4_field(result, "satisfactionDeltaBps", "设施满意度变化")?,
                "设施满意度变化",
                -200,
                200,
            )?;
            phase4_int(
                phase4_field(result, "appealDeltaBps", "设施吸引力变化")?,
                "设施吸引力变化",
                -200,
                200,
            )?;
            phase4_unique_ids(phase4_field(result, "reasonCodes", "设施原因")?, "设施原因")?;
        }
        for (key, value) in facility {
            if key.ends_with("Cents") {
                phase4_int(value, key, 0, JS_MAX_SAFE_INTEGER)?;
            }
        }
    }
    let progress = phase4_object(
        phase4_field(phase4, "catalogProgress", "目录进度")?,
        "目录进度",
    )?;
    let facility_catalog = PHASE4_PUBLIC_SPACE_TYPES
        .iter()
        .map(|kind| format!("facility:{kind}"))
        .collect::<HashSet<_>>();
    phase4_unique_catalog_ids(
        phase4_field(progress, "unlockedIds", "内容解锁")?,
        &facility_catalog,
    )?;
    let market_catalog = OPERATIONS_SEGMENTS
        .iter()
        .map(|segment| format!("market:{segment}"))
        .collect::<HashSet<_>>();
    phase4_unique_catalog_ids(
        phase4_field(progress, "discoveredMarketEntryIds", "市场目录")?,
        &market_catalog,
    )?;
    if let Some(snapshot) = phase4
        .get("recentFlowSnapshot")
        .filter(|item| !item.is_null())
    {
        let snapshot = phase4_object(snapshot, "近期流动快照")?;
        phase4_int(
            phase4_field(snapshot, "day", "流动快照日期")?,
            "流动快照日期",
            0,
            30,
        )?;
        let visible_floor_id = phase4_stable_id(
            phase4_field(snapshot, "visibleFloorId", "可见楼层编号")?,
            "可见楼层编号",
        )?;
        if !floor_ids.contains(visible_floor_id) {
            return Err(phase4_error("流动楼层引用无效"));
        }
        let events = phase4_array(phase4_field(snapshot, "events", "流动事件")?, "流动事件")?;
        if events.len() > 150 {
            return Err(phase4_error("流动事件最多保留150项"));
        }
        let mut ids = HashSet::new();
        let mut graph_ids = floor_ids.clone();
        graph_ids.extend(public_spaces.keys().map(String::as_str));
        graph_ids.extend(facilities.keys().map(String::as_str));
        graph_ids.insert("flow:hotel-residents");
        for raw_event in events {
            let event = phase4_object(raw_event, "流动事件")?;
            let id = phase4_stable_id(phase4_field(event, "id", "流动事件编号")?, "流动事件编号")?;
            if !ids.insert(id) {
                return Err(phase4_error("流动事件编号重复"));
            }
            phase4_one_of(
                phase4_field(event, "kind", "流动事件类型")?,
                &["guest", "staff", "service"],
                "流动事件类型",
            )?;
            for (key, label) in [("fromId", "流动起点编号"), ("toId", "流动终点编号")] {
                let reference = phase4_stable_id(phase4_field(event, key, label)?, label)?;
                if !graph_ids.contains(reference) {
                    return Err(phase4_error("流动引用无效"));
                }
            }
            phase4_int(
                phase4_field(event, "count", "流动数量")?,
                "流动数量",
                1,
                JS_MAX_SAFE_INTEGER,
            )?;
        }
    }
    validate_phase4_safe_numbers(value)?;
    Ok(())
}

const OPERATIONS_DEPARTMENTS: [&str; 6] = [
    "frontOffice",
    "housekeeping",
    "foodAndBeverage",
    "engineering",
    "security",
    "guestRelations",
];
const OPERATIONS_SEGMENTS: [&str; 6] = [
    "business",
    "couple",
    "family",
    "leisure",
    "high-net-worth",
    "cultural-experience",
];
const OPERATIONS_UNLOCKS: [&str; 3] = [
    "operations:pricing-automation",
    "operations:premium-segments",
    "operations:signature-service",
];

fn operations_object(value: &Value) -> Result<&serde_json::Map<String, Value>, String> {
    value
        .as_object()
        .ok_or_else(|| "经营存档数据损坏".to_string())
}

fn operations_array<'a>(value: &'a Value, key: &str) -> Result<&'a Vec<Value>, String> {
    obj(value, key)?
        .as_array()
        .ok_or_else(|| "经营存档数据损坏".to_string())
}

fn operations_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, String> {
    obj(value, key)?
        .as_str()
        .filter(|text| !text.is_empty() && text.trim() == *text)
        .ok_or_else(|| "经营存档数据损坏".to_string())
}

fn operations_int(value: &Value, key: &str, minimum: i64, maximum: i64) -> Result<i64, String> {
    let number = obj(value, key)?
        .as_i64()
        .ok_or_else(|| "经营存档数据损坏".to_string())?;
    if number < minimum || number > maximum || number > JS_MAX_SAFE_INTEGER {
        return Err("经营存档数据损坏".into());
    }
    Ok(number)
}

fn operations_optional_int(
    value: &Value,
    key: &str,
    minimum: i64,
    maximum: i64,
) -> Result<Option<i64>, String> {
    value
        .get(key)
        .map(|_| operations_int(value, key, minimum, maximum))
        .transpose()
}

fn operations_bps(value: &Value, key: &str) -> Result<i64, String> {
    operations_int(value, key, 0, 10_000)
}

fn checked_sum(values: impl IntoIterator<Item = i64>) -> Result<i64, String> {
    let total = values.into_iter().map(i128::from).sum::<i128>();
    if total < -i128::from(JS_MAX_SAFE_INTEGER) || total > i128::from(JS_MAX_SAFE_INTEGER) {
        Err("经营存档数据损坏".into())
    } else {
        Ok(total as i64)
    }
}

fn operations_one_of(value: &Value, key: &str, allowed: &[&str]) -> Result<String, String> {
    let candidate = operations_string(value, key)?;
    if !allowed.contains(&candidate) {
        return Err("经营存档数据损坏".into());
    }
    Ok(candidate.to_string())
}

fn validate_operations_departments(value: &Value) -> Result<(), String> {
    let departments = operations_object(value)?;
    if departments.len() != OPERATIONS_DEPARTMENTS.len()
        || OPERATIONS_DEPARTMENTS
            .iter()
            .any(|id| !departments.contains_key(*id))
    {
        return Err("经营存档数据损坏".into());
    }
    let specialties: HashMap<&str, [&str; 2]> = HashMap::from([
        ("frontOffice", ["arrival-flow", "front-desk-care"]),
        ("housekeeping", ["room-turnover", "quality-control"]),
        ("foodAndBeverage", ["dining-throughput", "menu-quality"]),
        ("engineering", ["preventive-maintenance", "rapid-repair"]),
        ("security", ["risk-prevention", "emergency-response"]),
        ("guestRelations", ["personalized-care", "service-recovery"]),
    ]);
    for id in OPERATIONS_DEPARTMENTS {
        let department = &departments[id];
        if operations_string(department, "id")? != id {
            return Err("经营存档数据损坏".into());
        }
        operations_int(department, "staffing", 0, 500)?;
        operations_int(department, "dailyBudgetCents", 0, 100_000_000)?;
        operations_bps(department, "trainingBps")?;
        operations_bps(department, "serviceStandardBps")?;
        if let Some(specialty) = department.get("leaderSpecialty") {
            if !specialties[id].contains(
                &specialty
                    .as_str()
                    .ok_or_else(|| "经营存档数据损坏".to_string())?,
            ) {
                return Err("经营存档数据损坏".into());
            }
        }
    }
    Ok(())
}

fn validate_operations_prices(value: &Value) -> Result<(), String> {
    for (key, policy) in operations_object(value)? {
        if key.is_empty() || key.trim() != key || operations_string(policy, "roomOfferId")? != key {
            return Err("经营存档数据损坏".into());
        }
        let nightly = operations_int(policy, "nightlyRateCents", 0, JS_MAX_SAFE_INTEGER)?;
        let explicit = [
            "baseRateCents",
            "minRateCents",
            "maxRateCents",
            "automaticPricing",
        ]
        .iter()
        .any(|field| policy.get(*field).is_some());
        if explicit {
            let base = operations_int(policy, "baseRateCents", 1, JS_MAX_SAFE_INTEGER)?;
            let minimum = operations_int(policy, "minRateCents", 1, JS_MAX_SAFE_INTEGER)?;
            let maximum = operations_int(policy, "maxRateCents", 1, JS_MAX_SAFE_INTEGER)?;
            if obj(policy, "automaticPricing")?.as_bool().is_none()
                || minimum > base
                || base > maximum
                || nightly < minimum
                || nightly > maximum
            {
                return Err("经营存档数据损坏".into());
            }
        }
    }
    Ok(())
}

fn upgrade_rule(kind: &str, level: i64) -> Option<(i64, i64)> {
    match (kind, level) {
        ("workspace", 1) => Some((120_000, 2)),
        ("workspace", 2) => Some((200_000, 3)),
        ("view", 1) => Some((180_000, 2)),
        ("view", 2) => Some((280_000, 3)),
        ("familyCapacity", 1) => Some((160_000, 2)),
        ("familyCapacity", 2) => Some((240_000, 3)),
        ("privacy", 1) => Some((150_000, 2)),
        ("privacy", 2) => Some((240_000, 3)),
        _ => None,
    }
}

fn validate_operations_upgrades(value: &Value, current_day: i64) -> Result<(), String> {
    for (key, upgrade) in operations_object(value)? {
        let room_offer_id = operations_string(upgrade, "roomOfferId")?;
        let upgrade_id = operations_string(upgrade, "upgradeId")?;
        let level = operations_int(upgrade, "level", 1, JS_MAX_SAFE_INTEGER)?;
        let Some(kind_value) = upgrade.get("kind") else {
            continue;
        };
        let kind = kind_value
            .as_str()
            .ok_or_else(|| "经营存档数据损坏".to_string())?;
        let (cost, closure_days) =
            upgrade_rule(kind, level).ok_or_else(|| "经营存档数据损坏".to_string())?;
        let committed_day = operations_int(upgrade, "committedDay", 0, current_day)?;
        let remaining = operations_int(upgrade, "remainingClosureDays", 0, JS_MAX_SAFE_INTEGER)?;
        if upgrade_id != kind
            || key != &format!("{room_offer_id}:{kind}")
            || operations_int(upgrade, "costCents", 0, JS_MAX_SAFE_INTEGER)? != cost
            || remaining != (closure_days - (current_day - committed_day)).max(0)
        {
            return Err("经营存档数据损坏".into());
        }
    }
    Ok(())
}

fn validate_operations_loans(value: &Value) -> Result<(), String> {
    let mut ids = HashSet::new();
    let reserved = [
        "safety-loan:daily-settlement",
        "safety-loan:department-training",
        "safety-loan:room-renovation",
    ];
    for loan in value
        .as_array()
        .ok_or_else(|| "经营存档数据损坏".to_string())?
    {
        let id = operations_string(loan, "id")?;
        if !ids.insert(id) {
            return Err("经营存档数据损坏".into());
        }
        let principal = operations_int(loan, "principalCents", 1, JS_MAX_SAFE_INTEGER)?;
        let outstanding = operations_int(loan, "outstandingCents", 1, principal)?;
        let interest = operations_bps(loan, "dailyInterestBps")?;
        operations_int(loan, "minimumPaymentCents", 1, outstanding)?;
        if reserved.contains(&id) && interest != 10 {
            return Err("经营存档数据损坏".into());
        }
    }
    Ok(())
}

fn validate_operations_need(value: &Value, current_day: i64) -> Result<(), String> {
    operations_string(value, "id")?;
    operations_one_of(value, "segmentId", &OPERATIONS_SEGMENTS)?;
    operations_one_of(value, "kind", &["room-feature", "service", "price"])?;
    operations_int(value, "discoveredDay", 0, current_day)?;
    operations_bps(value, "strengthBps")?;
    Ok(())
}

#[derive(Clone, Copy)]
struct OperationsDailyTotals {
    day: i64,
    revenue: i64,
    operating: i64,
    finance: i64,
    net: i64,
    cash: i64,
    reputation: i64,
    available: i64,
    sold: i64,
    occupancy: i64,
    category_version: u8,
    room_revenue: i64,
    public_space_revenue: i64,
    department_cost: i64,
    facility_operating_cost: i64,
}

fn operations_report_error() -> String {
    "经营报告算术不一致".into()
}

const OPERATIONS_DAILY_SUMMARY_ERROR: &str = "经营日报汇总与客群明细不一致";

fn operations_report_category_version(value: &Value) -> Result<u8, String> {
    let present = [
        "roomRevenueCents",
        "publicSpaceRevenueCents",
        "departmentCostCents",
        "facilityOperatingCostCents",
    ]
    .map(|key| value.get(key).is_some());
    match present {
        [false, false, false, false] => Ok(0),
        [true, false, true, false] => Ok(1),
        [true, true, true, true] => Ok(2),
        _ => Err(operations_report_error()),
    }
}

fn validate_operations_daily(
    value: &Value,
    current_day: i64,
) -> Result<OperationsDailyTotals, String> {
    let day = operations_int(value, "day", 1, 30)?;
    let mut segment_ids = HashSet::new();
    let mut segment_revenue = Vec::new();
    let mut segment_sold = Vec::new();
    let segments = operations_array(value, "segments")?;
    if segments.len() != OPERATIONS_SEGMENTS.len() {
        return Err("经营存档数据损坏".into());
    }
    for (index, segment) in segments.iter().enumerate() {
        let id = operations_one_of(segment, "segmentId", &OPERATIONS_SEGMENTS)?;
        if id != OPERATIONS_SEGMENTS[index] {
            return Err("经营存档数据损坏".into());
        }
        if !segment_ids.insert(id) {
            return Err("经营存档数据损坏".into());
        }
        operations_int(segment, "demand", 0, JS_MAX_SAFE_INTEGER)?;
        segment_sold.push(operations_int(
            segment,
            "soldRooms",
            0,
            JS_MAX_SAFE_INTEGER,
        )?);
        operations_int(segment, "averageRateCents", 0, JS_MAX_SAFE_INTEGER)?;
        segment_revenue.push(operations_int(
            segment,
            "revenueCents",
            0,
            JS_MAX_SAFE_INTEGER,
        )?);
        operations_bps(segment, "satisfactionBps")?;
    }
    let revenue = operations_int(value, "revenueCents", 0, JS_MAX_SAFE_INTEGER)?;
    let operating = operations_int(value, "operatingCostCents", 0, JS_MAX_SAFE_INTEGER)?;
    let finance = operations_int(value, "financeCostCents", 0, JS_MAX_SAFE_INTEGER)?;
    let net = operations_int(
        value,
        "netIncomeCents",
        -JS_MAX_SAFE_INTEGER,
        JS_MAX_SAFE_INTEGER,
    )?;
    let cash = operations_int(value, "endingCashCents", 0, JS_MAX_SAFE_INTEGER)?;
    let reputation = operations_bps(value, "reputationBps")?;
    let category_version = operations_report_category_version(value)?;
    let room_revenue = if category_version > 0 {
        operations_int(value, "roomRevenueCents", 0, JS_MAX_SAFE_INTEGER)?
    } else {
        revenue
    };
    let public_space_revenue = if category_version == 2 {
        operations_int(value, "publicSpaceRevenueCents", 0, JS_MAX_SAFE_INTEGER)?
    } else {
        0
    };
    let department_cost = if category_version > 0 {
        operations_int(value, "departmentCostCents", 0, JS_MAX_SAFE_INTEGER)?
    } else {
        operating
    };
    let facility_operating_cost = if category_version == 2 {
        operations_int(value, "facilityOperatingCostCents", 0, JS_MAX_SAFE_INTEGER)?
    } else {
        0
    };
    if checked_sum(segment_revenue)? != room_revenue
        || checked_sum([room_revenue, public_space_revenue])? != revenue
        || checked_sum([department_cost, facility_operating_cost])? != operating
        || checked_sum([revenue, -operating, -finance])? != net
    {
        return Err(OPERATIONS_DAILY_SUMMARY_ERROR.to_string());
    }
    if operations_optional_int(value, "loanInterestCents", 0, JS_MAX_SAFE_INTEGER)?
        .is_some_and(|stored| stored != finance)
    {
        return Err("经营存档贷款利息不一致".into());
    }
    operations_optional_int(value, "cashShortfallCents", 0, JS_MAX_SAFE_INTEGER)?;
    let available =
        operations_optional_int(value, "availableRooms", 0, JS_MAX_SAFE_INTEGER)?.unwrap_or(0);
    let segment_sold = checked_sum(segment_sold)?;
    let sold = operations_optional_int(value, "soldRooms", 0, JS_MAX_SAFE_INTEGER)?
        .unwrap_or(segment_sold);
    let occupancy = operations_optional_int(value, "occupancyBps", 0, 10_000)?.unwrap_or(0);
    if value.get("soldRooms").is_some() && sold != segment_sold {
        return Err("经营存档数据损坏".into());
    }
    let expected_occupancy = if available == 0 {
        0
    } else {
        ((i128::from(sold) * 10_000) / i128::from(available)) as i64
    };
    if sold > available || (value.get("occupancyBps").is_some() && occupancy != expected_occupancy)
    {
        return Err("经营存档数据损坏".into());
    }
    operations_optional_int(value, "reputationDeltaBps", -10_000, 10_000)?;
    for lost in value
        .get("lostBookings")
        .map(|items| {
            items
                .as_array()
                .ok_or_else(|| "经营存档数据损坏".to_string())
        })
        .transpose()?
        .unwrap_or(&Vec::new())
    {
        operations_one_of(lost, "segmentId", &OPERATIONS_SEGMENTS)?;
        operations_one_of(
            lost,
            "code",
            &["hard-requirement", "price", "service", "no-inventory"],
        )?;
        operations_int(lost, "count", 0, JS_MAX_SAFE_INTEGER)?;
        operations_string(lost, "explanation")?;
    }
    for review in value
        .get("reviews")
        .map(|items| {
            items
                .as_array()
                .ok_or_else(|| "经营存档数据损坏".to_string())
        })
        .transpose()?
        .unwrap_or(&Vec::new())
    {
        operations_one_of(review, "segmentId", &OPERATIONS_SEGMENTS)?;
        operations_bps(review, "ratingBps")?;
        operations_string(review, "text")?;
    }
    for booking in value
        .get("bookings")
        .map(|items| {
            items
                .as_array()
                .ok_or_else(|| "经营存档数据损坏".to_string())
        })
        .transpose()?
        .unwrap_or(&Vec::new())
    {
        operations_one_of(booking, "segmentId", &OPERATIONS_SEGMENTS)?;
        operations_string(booking, "roomId")?;
        operations_string(booking, "offerId")?;
        operations_int(booking, "rateCents", 0, JS_MAX_SAFE_INTEGER)?;
    }
    for need in value
        .get("discoveredNeeds")
        .map(|items| {
            items
                .as_array()
                .ok_or_else(|| "经营存档数据损坏".to_string())
        })
        .transpose()?
        .unwrap_or(&Vec::new())
    {
        validate_operations_need(need, current_day)?;
    }
    Ok(OperationsDailyTotals {
        day,
        revenue,
        operating,
        finance,
        net,
        cash,
        reputation,
        available,
        sold,
        occupancy,
        category_version,
        room_revenue,
        public_space_revenue,
        department_cost,
        facility_operating_cost,
    })
}

fn validate_operations_aggregate(
    value: &Value,
    reports: &[OperationsDailyTotals],
    number_key: &str,
    number: i64,
) -> Result<(), String> {
    let first = reports
        .first()
        .ok_or_else(|| "经营存档数据损坏".to_string())?;
    let last = reports
        .last()
        .ok_or_else(|| "经营存档数据损坏".to_string())?;
    let revenue = checked_sum(reports.iter().map(|report| report.revenue))?;
    let operating = checked_sum(reports.iter().map(|report| report.operating))?;
    let finance = checked_sum(reports.iter().map(|report| report.finance))?;
    let net = checked_sum(reports.iter().map(|report| report.net))?;
    let available = checked_sum(reports.iter().map(|report| report.available))?;
    let sold = checked_sum(reports.iter().map(|report| report.sold))?;
    let occupancy =
        checked_sum(reports.iter().map(|report| report.occupancy))? / reports.len() as i64;
    let reputation =
        checked_sum(reports.iter().map(|report| report.reputation))? / reports.len() as i64;
    let aggregate_version = operations_report_category_version(value)?;
    let expected_version = if reports.iter().any(|report| report.category_version == 2) {
        2
    } else {
        0
    };
    let room_revenue = checked_sum(reports.iter().map(|report| report.room_revenue))?;
    let public_space_revenue =
        checked_sum(reports.iter().map(|report| report.public_space_revenue))?;
    let department_cost = checked_sum(reports.iter().map(|report| report.department_cost))?;
    let facility_operating_cost =
        checked_sum(reports.iter().map(|report| report.facility_operating_cost))?;
    if operations_int(value, number_key, 1, 4)? != number
        || operations_int(value, "startDay", 1, 30)? != first.day
        || operations_int(value, "endDay", 1, 30)? != last.day
    {
        return Err("经营存档数据损坏".into());
    }
    if operations_int(value, "revenueCents", 0, JS_MAX_SAFE_INTEGER)? != revenue
        || operations_int(
            value,
            "netIncomeCents",
            -JS_MAX_SAFE_INTEGER,
            JS_MAX_SAFE_INTEGER,
        )? != net
        || operations_optional_int(value, "operatingCostCents", 0, JS_MAX_SAFE_INTEGER)?
            .is_some_and(|stored| stored != operating)
        || operations_optional_int(value, "financeCostCents", 0, JS_MAX_SAFE_INTEGER)?
            .is_some_and(|stored| stored != finance)
        || operations_optional_int(value, "availableRooms", 0, JS_MAX_SAFE_INTEGER)?
            .is_some_and(|stored| stored != available)
        || operations_optional_int(value, "soldRooms", 0, JS_MAX_SAFE_INTEGER)?
            .is_some_and(|stored| stored != sold)
        || operations_optional_int(value, "averageOccupancyBps", 0, 10_000)?
            .is_some_and(|stored| stored != occupancy)
        || operations_optional_int(value, "reputationBps", 0, 10_000)?
            .is_some_and(|stored| stored != reputation)
        || aggregate_version != expected_version
        || (aggregate_version == 2
            && (operations_int(value, "roomRevenueCents", 0, JS_MAX_SAFE_INTEGER)? != room_revenue
                || operations_int(value, "publicSpaceRevenueCents", 0, JS_MAX_SAFE_INTEGER)?
                    != public_space_revenue
                || operations_int(value, "departmentCostCents", 0, JS_MAX_SAFE_INTEGER)?
                    != department_cost
                || operations_int(value, "facilityOperatingCostCents", 0, JS_MAX_SAFE_INTEGER)?
                    != facility_operating_cost))
    {
        return Err(operations_report_error());
    }
    if number_key == "week"
        && (value.get("averageOccupancyBps").is_none() || value.get("reputationBps").is_none())
    {
        return Err("经营存档数据损坏".into());
    }
    if number_key == "month"
        && (operations_int(value, "debtPaymentCents", 0, JS_MAX_SAFE_INTEGER)? != finance
            || operations_int(value, "endingCashCents", 0, JS_MAX_SAFE_INTEGER)? != last.cash)
    {
        return Err("经营存档数据损坏".into());
    }
    if let Some(code) = value.get("topReasonCode") {
        let code = code
            .as_str()
            .ok_or_else(|| "经营存档数据损坏".to_string())?;
        if ![
            "hard-requirement",
            "price",
            "service",
            "no-inventory",
            "none",
        ]
        .contains(&code)
        {
            return Err("经营存档数据损坏".into());
        }
    }
    for key in ["topResultCode", "suggestedActionCode"] {
        if value.get(key).is_some() {
            operations_string(value, key)?;
        }
    }
    Ok(())
}

fn validate_operations(value: &Value, current_day: i64) -> Result<(), String> {
    operations_object(value)?;
    if operations_string(value, "rulesetVersion")? != "operations-v1" {
        return Err("经营存档数据损坏".into());
    }
    operations_one_of(value, "difficulty", &["casual", "management"])?;
    let reputation = operations_bps(value, "reputationBps")?;
    let maximum_reputation = operations_bps(value, "maximumReputationBps")?;
    if maximum_reputation < reputation || current_day > 30 {
        return Err("经营存档数据损坏".into());
    }
    validate_operations_departments(obj(value, "departments")?)?;
    validate_operations_prices(obj(value, "pricePolicies")?)?;
    validate_operations_upgrades(obj(value, "offerUpgrades")?, current_day)?;
    validate_operations_loans(obj(value, "loans")?)?;
    let mut need_ids = HashSet::new();
    for need in operations_array(value, "discoveredNeeds")? {
        validate_operations_need(need, current_day)?;
        if !need_ids.insert(operations_string(need, "id")?) {
            return Err("经营存档数据损坏".into());
        }
    }
    if let Some(mix) = value.get("segmentMix") {
        let mut total = 0;
        for (segment, bps) in operations_object(mix)? {
            if !OPERATIONS_SEGMENTS.contains(&segment.as_str()) {
                return Err("经营存档数据损坏".into());
            }
            let value = bps
                .as_i64()
                .filter(|number| (0..=10_000).contains(number))
                .ok_or_else(|| "经营存档数据损坏".to_string())?;
            total += value;
        }
        if total != 0 && total != 10_000 {
            return Err("经营存档数据损坏".into());
        }
    }
    let daily_values = operations_array(value, "dailyReports")?;
    if daily_values.len() > 30 {
        return Err("经营存档数据损坏".into());
    }
    let mut daily = Vec::new();
    for report in daily_values {
        let totals = validate_operations_daily(report, current_day)?;
        if daily
            .last()
            .is_some_and(|prior: &OperationsDailyTotals| totals.day <= prior.day)
        {
            return Err("经营存档数据损坏".into());
        }
        daily.push(totals);
    }
    if let Some(last) = daily.last() {
        if last.day != current_day || last.reputation != reputation {
            return Err("经营存档数据损坏".into());
        }
    }
    let daily_by_day = daily
        .iter()
        .map(|report| (report.day, *report))
        .collect::<HashMap<_, _>>();
    let expected_weeks = (1..=4)
        .filter_map(|week| {
            let reports = (((week - 1) * 7 + 1)..=week * 7)
                .map(|day| daily_by_day.get(&day).copied())
                .collect::<Option<Vec<_>>>()?;
            Some((week, reports))
        })
        .collect::<Vec<_>>();
    let weekly = operations_array(value, "weeklyReports")?;
    if weekly.len() != expected_weeks.len() {
        return Err("经营存档数据损坏".into());
    }
    for (index, (week, reports)) in expected_weeks.iter().enumerate() {
        validate_operations_aggregate(&weekly[index], reports, "week", *week)?;
    }
    let closes = operations_array(value, "monthlyCloses")?;
    let month = (1..=30)
        .map(|day| daily_by_day.get(&day).copied())
        .collect::<Option<Vec<_>>>();
    if closes.len() != usize::from(month.is_some()) {
        return Err("经营存档数据损坏".into());
    }
    if let Some(month) = month {
        validate_operations_aggregate(&closes[0], &month, "month", 1)?;
    }
    let mut unlocks = HashSet::new();
    for unlock in operations_array(value, "unlockedContent")? {
        let key = unlock
            .as_str()
            .filter(|key| OPERATIONS_UNLOCKS.contains(key))
            .ok_or_else(|| "经营存档数据损坏".to_string())?;
        if !unlocks.insert(key) {
            return Err("经营存档数据损坏".into());
        }
    }
    let speed = operations_int(value, "timeSpeed", 0, 4)?;
    if ![0, 1, 2, 4].contains(&speed) {
        return Err("经营存档数据损坏".into());
    }
    let checkpoint = match obj(value, "lastOfflineCheckpointMs")? {
        Value::Null => None,
        _ => Some(operations_int(
            value,
            "lastOfflineCheckpointMs",
            0,
            JS_MAX_SAFE_INTEGER,
        )?),
    };
    let has_operations_history = !daily.is_empty() || !weekly.is_empty() || !closes.is_empty();
    if current_day == 30 && (speed != 0 || (has_operations_history && checkpoint.is_none())) {
        return Err("经营存档数据损坏".into());
    }
    Ok(())
}

fn validate_phase2(value: &Value) -> Result<String, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "存档数据损坏".to_string())?;
    for key in [
        "hotelGene",
        "roomMaster",
        "roomVariants",
        "corridorTemplate",
    ] {
        if !object.contains_key(key) {
            return Err("存档数据损坏".into());
        }
    }
    validate_gene(&object["hotelGene"])?;
    let variants = array(value, "roomVariants")?;
    let master = &object["roomMaster"];
    let mut variant_footprints = HashMap::new();
    if master.is_null() {
        if !variants.is_empty() {
            return Err("存档数据损坏".into());
        }
    } else {
        let columns = intv(master, "columns", 1, true)?;
        let rows = intv(master, "rows", 1, true)?;
        let master_id = strv(master, "id")?;
        validate_room(master, columns, rows, true)?;
        validate_gene(obj(master, "gene")?)?;
        for variant in variants {
            let variant_id = strv(variant, "id")?;
            if variant_id == master_id
                || strv(variant, "masterId")? != master_id
                || variant_footprints.contains_key(&variant_id)
                || ![0, 90, 180, 270].contains(&intv(variant, "rotation", 0, false)?)
                || obj(variant, "mirrored")?.as_bool().is_none()
            {
                return Err("存档数据损坏".into());
            }
            if let Some(kind) = variant.get("variantKind") {
                if !["king", "twin", "corner"]
                    .contains(&kind.as_str().ok_or_else(|| "存档数据损坏".to_string())?)
                {
                    return Err("存档数据损坏".into());
                }
            }
            let overrides = array(variant, "overrides")?;
            let mut unique_overrides = HashSet::new();
            for override_name in overrides {
                let override_name = override_name
                    .as_str()
                    .filter(|name| {
                        [
                            "bedType",
                            "area",
                            "view",
                            "furniture",
                            "featureIntensity",
                            "gene",
                        ]
                        .contains(name)
                    })
                    .ok_or_else(|| "存档数据损坏".to_string())?;
                if !unique_overrides.insert(override_name) {
                    return Err("存档数据损坏".into());
                }
            }
            validate_gene(obj(variant, "gene")?)?;
            let footprint = validate_room(variant, columns, rows, false)?;
            variant_footprints.insert(variant_id, footprint);
        }
    }

    let slots = if object["corridorTemplate"].is_null() {
        None
    } else {
        Some(validate_corridor_template(&object["corridorTemplate"])?)
    };
    if let Some(placements) = object.get("floorPlacements") {
        let placements = placements
            .as_array()
            .ok_or_else(|| "存档数据损坏".to_string())?;
        let slots = slots.as_ref().ok_or_else(|| "存档数据损坏".to_string())?;
        let mut placed_slots = HashSet::new();
        for placement in placements {
            let slot_id = strv(placement, "slotId")?;
            let variant_id = strv(placement, "variantId")?;
            let rotation = intv(placement, "rotation", 0, false)?;
            if !placed_slots.insert(slot_id.clone())
                || ![0, 90, 180, 270].contains(&rotation)
                || obj(placement, "mirrored")?.as_bool().is_none()
            {
                return Err("存档数据损坏".into());
            }
            let slot = slots
                .get(&slot_id)
                .ok_or_else(|| "存档数据损坏".to_string())?;
            let footprint = variant_footprints
                .get(&variant_id)
                .ok_or_else(|| "存档数据损坏".to_string())?;
            let (room_width, room_height) = if matches!(rotation, 90 | 270) {
                (footprint.height, footprint.width)
            } else {
                (footprint.width, footprint.height)
            };
            if room_width > slot.width || room_height > slot.height {
                return Err("存档数据损坏".into());
            }
        }
    }
    if let Some(design_visuals) = object.get("designVisuals") {
        validate_design_visuals(design_visuals)?;
    }
    let text = serde_json::to_string(value).map_err(|_| "存档数据损坏".to_string())?;
    let lower = text.to_ascii_lowercase();
    if lower.contains("base64")
        || lower.contains("api_key")
        || lower.contains("token")
        || lower.contains("secret")
    {
        return Err("视觉元数据不安全".into());
    }
    validate_visual_tree(value)?;
    Ok(text)
}

fn validate_visual_request(
    request: &Value,
    seen: &mut HashSet<String>,
    master_count: &mut usize,
    focus_count: &mut usize,
) -> Result<(), String> {
    let kind = strv(request, "kind")?;
    let key = match kind.as_str() {
        "master" => {
            *master_count += 1;
            "master".to_string()
        }
        "focus" => {
            let focus = strv(request, "focus")?;
            if focus.trim().is_empty() {
                return Err("存档数据损坏".into());
            }
            *focus_count += 1;
            format!("focus:{}", focus.trim())
        }
        _ => return Err("存档数据损坏".into()),
    };
    if !seen.insert(key) || *master_count > 1 || *focus_count > 3 {
        return Err("存档数据损坏".into());
    }
    Ok(())
}

fn validate_design_visuals(value: &Value) -> Result<(), String> {
    if strv(value, "status")? != "complete" {
        return Err("存档数据损坏".into());
    }
    let assets = array(value, "assets")?;
    let errors = array(value, "errors")?;
    if assets.len() + errors.len() > 4 {
        return Err("存档数据损坏".into());
    }
    let mut seen = HashSet::new();
    let mut master_count = 0;
    let mut focus_count = 0;
    for asset in assets {
        validate_visual_request(
            obj(asset, "request")?,
            &mut seen,
            &mut master_count,
            &mut focus_count,
        )?;
        let asset_path = strv(asset, "assetPath")?;
        if !asset_path.starts_with("/visuals/") || asset_path.contains("..") {
            return Err("视觉资源命名空间无效".into());
        }
    }
    for error in errors {
        validate_visual_request(
            obj(error, "request")?,
            &mut seen,
            &mut master_count,
            &mut focus_count,
        )?;
        if strv(error, "message")?.trim().is_empty()
            || obj(error, "retryable")?.as_bool() != Some(true)
        {
            return Err("存档数据损坏".into());
        }
    }
    Ok(())
}

fn validate_gene(value: &Value) -> Result<(), String> {
    for key in ["palette", "metal", "lighting", "mood"] {
        strv(value, key)?;
    }
    let materials = obj(value, "materials")?
        .as_array()
        .ok_or_else(|| "存档数据损坏".to_string())?;
    if materials.is_empty()
        || materials
            .iter()
            .any(|item| item.as_str().is_none_or(str::is_empty))
    {
        return Err("存档数据损坏".into());
    }
    Ok(())
}

fn validate_visual_tree(value: &Value) -> Result<(), String> {
    match value {
        Value::Object(map) => {
            if let Some(asset) = map.get("assetPath").and_then(Value::as_str) {
                if !asset.starts_with("/visuals/") || asset.contains("..") {
                    return Err("视觉资源命名空间无效".into());
                }
            }
            for child in map.values() {
                validate_visual_tree(child)?;
            }
        }
        Value::Array(items) => {
            for child in items {
                validate_visual_tree(child)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    type SnapshotMutation = (&'static str, Box<dyn Fn(&mut Value)>);

    fn root(name: &str) -> PathBuf {
        let p = std::env::temp_dir().join(format!("cloud-inn-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&p);
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn create_v6_database(repository: &SaveRepository) -> PathBuf {
        let path = repository.db_path("save-1");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut connection = Connection::open(&path).unwrap();
        connection
            .execute_batch(include_str!("../migrations/001_initial.sql"))
            .unwrap();
        connection
            .execute(
                "INSERT INTO schema_migrations(version,applied_at)
                 VALUES(1,'fixture')",
                [],
            )
            .unwrap();
        migrate_legacy(&mut connection).unwrap();
        migrate_phase2(&mut connection).unwrap();
        migrate_blueprint_openings(&mut connection).unwrap();
        migrate_operations(&mut connection).unwrap();
        migrate_phase4(&mut connection).unwrap();
        connection
            .execute(
                "INSERT INTO saves(
                   save_id,schema_version,ruleset_version,revision,phase,
                   current_day,cash_cents,rate_cents,phase2_json,
                   latest_report_json,operations_json,phase4_json,updated_at
                 ) VALUES(
                   'save-1',1,'prototype-v1',1,'design',
                   0,100,10,NULL,NULL,NULL,NULL,'fixture'
                 )",
                [],
            )
            .unwrap();
        connection.pragma_update(None, "application_id", 0).unwrap();
        connection.pragma_update(None, "user_version", 0).unwrap();
        connection
            .pragma_update(None, "journal_mode", "DELETE")
            .unwrap();
        drop(connection);
        path
    }

    fn game() -> Value {
        json!({"schemaVersion":1,"rulesetVersion":"prototype-v1","saveId":"save-1","revision":1,"phase":"design","currentDay":0,"cashCents":100,"rateCents":10,"roomBlueprint":null,"floor":{"id":"prototype-floor","rooms":[]},"reports":[],"latestReport":null})
    }

    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
        ];
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes
    }
    fn operations_departments() -> Value {
        json!({
            "frontOffice": {"id":"frontOffice","staffing":0,"dailyBudgetCents":0,"trainingBps":0,"serviceStandardBps":5000},
            "housekeeping": {"id":"housekeeping","staffing":0,"dailyBudgetCents":0,"trainingBps":0,"serviceStandardBps":5000},
            "foodAndBeverage": {"id":"foodAndBeverage","staffing":0,"dailyBudgetCents":0,"trainingBps":0,"serviceStandardBps":5000},
            "engineering": {"id":"engineering","staffing":0,"dailyBudgetCents":0,"trainingBps":0,"serviceStandardBps":5000},
            "security": {"id":"security","staffing":0,"dailyBudgetCents":0,"trainingBps":0,"serviceStandardBps":5000},
            "guestRelations": {"id":"guestRelations","staffing":0,"dailyBudgetCents":0,"trainingBps":0,"serviceStandardBps":5000}
        })
    }
    fn minimal_operations() -> Value {
        json!({
            "rulesetVersion":"operations-v1",
            "difficulty":"casual",
            "reputationBps":5000,
            "departments":operations_departments(),
            "pricePolicies":{},
            "offerUpgrades":{},
            "loans":[],
            "discoveredNeeds":[],
            "dailyReports":[],
            "weeklyReports":[],
            "monthlyCloses":[],
            "maximumReputationBps":5000,
            "unlockedContent":[],
            "timeSpeed":0,
            "lastOfflineCheckpointMs":null
        })
    }
    fn operations_daily(day: i64) -> Value {
        json!({
            "day":day,
            "segments":[
                {"segmentId":"business","demand":2,"soldRooms":1,"averageRateCents":1000,"revenueCents":1000,"satisfactionBps":5000 + day},
                {"segmentId":"couple","demand":0,"soldRooms":0,"averageRateCents":0,"revenueCents":0,"satisfactionBps":5000},
                {"segmentId":"family","demand":0,"soldRooms":0,"averageRateCents":0,"revenueCents":0,"satisfactionBps":5000},
                {"segmentId":"leisure","demand":0,"soldRooms":0,"averageRateCents":0,"revenueCents":0,"satisfactionBps":5000},
                {"segmentId":"high-net-worth","demand":0,"soldRooms":0,"averageRateCents":0,"revenueCents":0,"satisfactionBps":5000},
                {"segmentId":"cultural-experience","demand":0,"soldRooms":0,"averageRateCents":0,"revenueCents":0,"satisfactionBps":5000}
            ],
            "revenueCents":1000,"operatingCostCents":100,"financeCostCents":10,"netIncomeCents":890,
            "endingCashCents":1_000_000 + day,"reputationBps":5000 + day,
            "availableRooms":2,"soldRooms":1,"occupancyBps":5000,
            "departmentCostCents":100,"roomRevenueCents":1000,"loanInterestCents":10,"cashShortfallCents":0,
            "lostBookings":[{"segmentId":"couple","code":"price","count":1,"explanation":"rate"}],
            "reviews":[{"segmentId":"business","ratingBps":5000 + day,"text":"ok"}],
            "bookings":[{"segmentId":"business","roomId":"room-1","offerId":"offer-1","rateCents":1000}],
            "reputationDeltaBps":1,
            "discoveredNeeds":[]
        })
    }
    fn operations_week(week: i64) -> Value {
        let start_day = (week - 1) * 7 + 1;
        let end_day = week * 7;
        json!({
            "week":week,"startDay":start_day,"endDay":end_day,
            "revenueCents":7000,"operatingCostCents":700,"financeCostCents":70,"netIncomeCents":6230,
            "availableRooms":14,"soldRooms":7,"averageOccupancyBps":5000,
            "reputationBps":5000 + (start_day + end_day) / 2,
            "topResultCode":"segment:business","topReasonCode":"price","suggestedActionCode":"adjust-pricing"
        })
    }
    fn full_operations_game() -> Value {
        let daily = (1..=30).map(operations_daily).collect::<Vec<_>>();
        let legacy = (1..=30).map(|day| json!({"day":day})).collect::<Vec<_>>();
        let mut operations = minimal_operations();
        operations["dailyReports"] = json!(daily);
        operations["weeklyReports"] = json!((1..=4).map(operations_week).collect::<Vec<_>>());
        operations["monthlyCloses"] = json!([{
            "month":1,"startDay":1,"endDay":30,"revenueCents":30000,"operatingCostCents":3000,
            "financeCostCents":300,"netIncomeCents":26700,"debtPaymentCents":300,
            "availableRooms":60,"soldRooms":30,"averageOccupancyBps":5000,"reputationBps":5015,
            "endingCashCents":1_000_030,"topResultCode":"segment:business","topReasonCode":"price",
            "suggestedActionCode":"adjust-pricing"
        }]);
        operations["reputationBps"] = json!(5030);
        operations["maximumReputationBps"] = json!(6000);
        operations["unlockedContent"] = json!(["operations:pricing-automation"]);
        operations["timeSpeed"] = json!(0);
        operations["lastOfflineCheckpointMs"] = json!(30_000);
        operations["pricePolicies"] = json!({"offer-1":{
            "roomOfferId":"offer-1","nightlyRateCents":1000,"baseRateCents":1000,
            "minRateCents":800,"maxRateCents":1200,"automaticPricing":true
        }});
        operations["offerUpgrades"] = json!({
            "offer-1:workspace":{"roomOfferId":"offer-1","upgradeId":"workspace","kind":"workspace","level":1,"remainingClosureDays":0,"committedDay":2,"costCents":120000},
            "legacy":{"roomOfferId":"removed-offer","upgradeId":"old-custom","level":42}
        });
        operations["loans"] = json!([{"id":"loan-1","principalCents":10000,"outstandingCents":5000,"dailyInterestBps":100,"minimumPaymentCents":500}]);
        let mut state = game();
        state["currentDay"] = json!(30);
        state["cashCents"] = json!(1_000_030);
        state["reports"] = json!(legacy);
        state["latestReport"] = json!({"day":30});
        state["operations"] = operations;
        state
    }
    fn blueprint_game(revision: i64, rooms: Value) -> Value {
        let mut g = game();
        g["revision"] = json!(revision);
        g["roomBlueprint"] = json!({"id":"bp-1","name":"Suite","columns":1,"rows":1,"cells":[],"metrics":{"areaSquareMeters":1,"buildCostCents":1,"suggestedRateCents":1,"businessFitBps":1},"visual":{"status":"idle"}});
        g["floor"]["rooms"] = rooms;
        g
    }
    fn blueprint_with_openings_game() -> Value {
        let mut g = game();
        g["roomBlueprint"] = json!({
            "id": "bp-openings",
            "name": "Opening Suite",
            "columns": 2,
            "rows": 1,
            "cells": [
                {"x": 0, "y": 0, "zone": "bedroom"},
                {"x": 1, "y": 0, "zone": "bathroom"}
            ],
            "openings": {
                "walls": [],
                "doors": [{"x": 0, "y": 0, "side": "north"}],
                "windows": [{"x": 1, "y": 0, "side": "east"}]
            },
            "metrics": {
                "areaSquareMeters": 0.5,
                "buildCostCents": 2_200_000,
                "suggestedRateCents": 33_000,
                "businessFitBps": 2_625
            },
            "visual": {"status": "idle"}
        });
        g
    }
    fn valid_phase2_game() -> Value {
        let mut g = game();
        let gene = json!({
            "palette": "jade",
            "materials": ["wood"],
            "metal": "bronze",
            "lighting": "warm",
            "mood": "quiet"
        });
        let cells = json!([
            {"x": 0, "y": 0, "zone": "bedroom"},
            {"x": 1, "y": 0, "zone": "bathroom"}
        ]);
        let metrics = json!({
            "areaSquareMeters": 0.5,
            "buildCostCents": 2_200_000,
            "suggestedRateCents": 33_000,
            "businessFitBps": 2_625
        });
        let openings = json!({
            "walls": [],
            "doors": [{"x": 0, "y": 0, "side": "north"}],
            "windows": []
        });
        g["phase2"] = json!({
            "hotelGene": gene,
            "roomMaster": {
                "id": "master-1", "name": "Suite", "columns": 2, "rows": 1,
                "cells": cells, "metrics": metrics, "visual": {"status": "idle"},
                "gene": gene, "openings": openings
            },
            "roomVariants": [{
                "id": "variant-1", "name": "King", "masterId": "master-1",
                "variantKind": "king", "cells": cells, "rotation": 0,
                "mirrored": false, "overrides": ["bedType"], "gene": gene,
                "metrics": metrics, "visual": {"status": "idle"}, "openings": openings
            }],
            "corridorTemplate": {
                "id": "test-ring", "name": "Test ring", "width": 6, "height": 6,
                "core": [{"x": 2, "y": 3}],
                "corridor": [{"x": 2, "y": 0}],
                "entrances": [{"x": 2, "y": 1}, {"x": 2, "y": 2}],
                "slots": [{"id": "north", "anchor": {"x": 3, "y": 0}, "width": 2, "height": 2}]
            },
            "floorPlacements": [{
                "slotId": "north", "variantId": "variant-1", "rotation": 0,
                "mirrored": false
            }]
        });
        g
    }
    #[test]
    fn creates_and_migrates_new_db() {
        let r = SaveRepository::new(root("migrate"));
        assert_eq!(r.load_game("save-1").unwrap(), None);
        assert!(!r.db_path("save-1").exists());
        assert!(!r.db_path("save-1").parent().unwrap().exists());
        r.commit_game(0, game()).unwrap();
        assert!(r.db_path("save-1").is_file());
        assert_eq!(
            r.open("save-1")
                .unwrap()
                .query_row::<i64, _, _>("SELECT count(*) FROM schema_migrations", [], |x| x.get(0))
                .unwrap(),
            7
        );
    }

    #[test]
    fn phase5_catalog_uses_stable_ids_normalized_names_and_metadata_cas() {
        let repository = SaveRepository::new(root("phase5-catalog"));
        let created = repository
            .create_save(Some("  e\u{301}  ".to_string()))
            .unwrap();
        assert!(Uuid::parse_str(&created.save_id).is_ok());
        assert_eq!(created.display_name, "é");
        assert_eq!(created.metadata_revision, 0);
        assert_eq!(created.game_revision, 0);
        assert_eq!(created.current_day, 0);
        assert_eq!(created.room_count, 0);

        let renamed = repository
            .rename_save(&created.save_id, "同名存档".to_string(), 0)
            .unwrap();
        assert_eq!(renamed.save_id, created.save_id);
        assert_eq!(renamed.display_name, "同名存档");
        assert_eq!(renamed.metadata_revision, 1);
        assert_eq!(renamed.game_revision, 0);
        assert!(repository
            .rename_save(&created.save_id, "过期写入".to_string(), 0)
            .unwrap_err()
            .to_string()
            .ends_with("(save.conflict)"));

        let duplicate_name = repository
            .create_save(Some("同名存档".to_string()))
            .unwrap();
        let default_named = repository.create_save(None).unwrap();
        assert_ne!(duplicate_name.save_id, created.save_id);
        assert_eq!(default_named.display_name, "云岫酒店 1");
        assert_eq!(repository.list_saves().unwrap().len(), 3);
    }

    #[test]
    fn phase5_catalog_ignores_invalid_directory_entries() {
        let repository = SaveRepository::new(root("phase5-catalog-invalid-entry"));
        let valid = repository
            .create_save(Some("有效存档".to_string()))
            .unwrap();
        let saves_root = repository.root.join("saves");
        fs::create_dir_all(saves_root.join("not a save")).unwrap();
        fs::write(saves_root.join("random-file"), b"not a save").unwrap();

        assert_eq!(
            repository
                .list_saves()
                .unwrap()
                .into_iter()
                .map(|summary| summary.save_id)
                .collect::<Vec<_>>(),
            vec![valid.save_id]
        );
    }

    #[test]
    fn phase5_asset_store_records_a_verified_asset_and_deduplicated_reference() {
        let repository = SaveRepository::new(root("phase5-asset-reference"));
        let save = repository
            .create_save(Some("资源引用".to_string()))
            .unwrap();
        let bytes = png_header(17, 23);

        let first = repository
            .store_asset_reference(
                &save.save_id,
                AssetReferenceStoreRequest {
                    owner_kind: "generation-job",
                    owner_id: "job-1",
                    bytes: &bytes,
                    mime_type: "image/png",
                    width: 17,
                    height: 23,
                },
            )
            .unwrap();
        let second = repository
            .store_asset_reference(
                &save.save_id,
                AssetReferenceStoreRequest {
                    owner_kind: "generation-job",
                    owner_id: "job-1",
                    bytes: &bytes,
                    mime_type: "image/png",
                    width: 17,
                    height: 23,
                },
            )
            .unwrap();
        assert_eq!(first, second);

        let connection = open_current_connection(&repository.db_path(&save.save_id)).unwrap();
        let asset = connection
            .query_row(
                "SELECT asset_id,relative_path,sha256,mime_type,byte_length,width,height
                 FROM assets WHERE asset_id=?1",
                [&first],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(asset.0, first);
        assert_eq!(asset.0, asset.2);
        assert_eq!(
            asset.1,
            format!("assets/sha256/{}/{}.png", &first[..2], first)
        );
        assert_eq!(asset.3, "image/png");
        assert_eq!((asset.4, asset.5, asset.6), (bytes.len() as i64, 17, 23));
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM asset_references
                     WHERE owner_kind='generation-job' AND owner_id='job-1' AND asset_id=?1",
                    [&first],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
        assert_eq!(
            fs::read(
                repository
                    .db_path(&save.save_id)
                    .parent()
                    .unwrap()
                    .join(&asset.1)
            )
            .unwrap(),
            bytes
        );
    }

    #[test]
    fn phase5_asset_reference_rejects_conflicting_existing_asset_metadata() {
        let repository = SaveRepository::new(root("phase5-asset-metadata-conflict"));
        let save = repository
            .create_save(Some("资源冲突".to_string()))
            .unwrap();
        let bytes = png_header(17, 23);
        let save_directory = repository
            .db_path(&save.save_id)
            .parent()
            .unwrap()
            .to_path_buf();
        let stored = AssetStore::new(&save_directory)
            .store(&bytes, "image/png", 17, 23)
            .unwrap();
        let mut connection = open_current_connection(&repository.db_path(&save.save_id)).unwrap();
        connection
            .execute(
                "INSERT INTO assets(
                   asset_id,relative_path,sha256,mime_type,byte_length,width,height,created_at_ms
                ) VALUES(?1,?2,?3,?4,?5,?6,?7,0)",
                params![
                    &stored.sha256,
                    &stored.relative_path,
                    &stored.sha256,
                    &stored.mime_type,
                    i64::try_from(stored.byte_length).unwrap(),
                    18_i64,
                    i64::from(stored.height),
                ],
            )
            .unwrap();
        let transaction = connection.transaction().unwrap();
        let error =
            persist_verified_asset_reference(&transaction, &stored, "generation-job", "job-1")
                .unwrap_err();
        assert!(error.to_string().ends_with("(save.corrupt)"));
        transaction.rollback().unwrap();
        assert_eq!(
            connection
                .query_row("SELECT count(*) FROM asset_references", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );
    }

    #[allow(clippy::too_many_arguments)]
    fn insert_recovery_point(
        repository: &SaveRepository,
        save_id: &str,
        recovery_id: &str,
        kind: &str,
        origin_commit_revision: Option<i64>,
        restore_revision: i64,
        reason: &str,
        status: &str,
        created_at_ms: i64,
    ) {
        let connection = open_current_connection(&repository.db_path(save_id)).unwrap();
        connection
            .execute(
                "INSERT INTO recovery_points(
                   recovery_id,kind,origin_commit_revision,restore_revision,reason,status,
                   relative_path,package_sha256,manifest_sha256,created_at_ms
                 ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
                params![
                    recovery_id,
                    kind,
                    origin_commit_revision,
                    restore_revision,
                    reason,
                    status,
                    format!("recovery-packages/{recovery_id}"),
                    "a".repeat(64),
                    Some("b".repeat(64)),
                    created_at_ms,
                ],
            )
            .unwrap();
    }

    fn verified_recovery_package(
        repository: &SaveRepository,
        save_id: &str,
        recovery_id: &RecoveryId,
    ) -> RecoveryPackage {
        let pending = repository.root.join("recovery-pending");
        fs::create_dir(&pending).unwrap();
        crate::recovery::create_database_preimage(
            &repository.db_path(save_id),
            &pending,
            recovery_id,
        )
        .unwrap()
    }

    fn insert_verified_ready_automatic_recovery_point(
        repository: &SaveRepository,
        save_id: &str,
        recovery_id: &str,
        created_at_ms: i64,
    ) {
        let recovery_id = RecoveryId::parse(recovery_id).unwrap();
        let recovery_directory = repository.root.join("recovery-packages");
        fs::create_dir_all(&recovery_directory).unwrap();
        let package = crate::recovery::create_database_preimage(
            &repository.db_path(save_id),
            &recovery_directory,
            &recovery_id,
        )
        .unwrap();
        let connection = open_current_connection(&repository.db_path(save_id)).unwrap();
        connection
            .execute(
                "INSERT INTO recovery_points(
                   recovery_id,kind,origin_commit_revision,restore_revision,reason,status,
                   relative_path,package_sha256,manifest_sha256,created_at_ms
                 ) VALUES(?1,'automatic',?2,?3,'construction','ready',?4,?5,?6,?7)",
                params![
                    recovery_id.as_str(),
                    created_at_ms + 1,
                    created_at_ms,
                    format!("recovery-packages/{}", recovery_id.as_str()),
                    package.package_sha256,
                    package.manifest_sha256,
                    created_at_ms,
                ],
            )
            .unwrap();
    }

    #[test]
    fn phase5_pending_recovery_row_rolls_back_with_its_game_transaction() {
        let repository = SaveRepository::new(root("phase5-recovery-pending-rollback"));
        let save = repository
            .create_save(Some("恢复事务".to_string()))
            .unwrap();
        let recovery_id = RecoveryId::parse("pending-rollback").unwrap();
        let package = verified_recovery_package(&repository, &save.save_id, &recovery_id);
        let mut connection = open_current_connection(&repository.db_path(&save.save_id)).unwrap();

        let transaction = connection.transaction().unwrap();
        record_pending_automatic_recovery_point(
            &transaction,
            &recovery_id,
            &package,
            1,
            0,
            RecoveryReason::Construction,
        )
        .unwrap();
        transaction.rollback().unwrap();

        let count = connection
            .query_row(
                "SELECT count(*) FROM recovery_points WHERE recovery_id=?1",
                [recovery_id.as_str()],
                |row| row.get::<_, i64>(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn phase5_pending_recovery_row_commits_with_verified_package_metadata() {
        let repository = SaveRepository::new(root("phase5-recovery-pending-commit"));
        let save = repository
            .create_save(Some("恢复事务".to_string()))
            .unwrap();
        let recovery_id = RecoveryId::parse("pending-commit").unwrap();
        let package = verified_recovery_package(&repository, &save.save_id, &recovery_id);
        let expected_package_sha256 = package.package_sha256.clone();
        let expected_manifest_sha256 = package.manifest_sha256.clone();
        let mut connection = open_current_connection(&repository.db_path(&save.save_id)).unwrap();

        let transaction = connection.transaction().unwrap();
        record_pending_automatic_recovery_point(
            &transaction,
            &recovery_id,
            &package,
            1,
            0,
            RecoveryReason::Settlement,
        )
        .unwrap();
        transaction.commit().unwrap();

        let row = connection
            .query_row(
                "SELECT kind,origin_commit_revision,restore_revision,reason,status,
                        relative_path,package_sha256,manifest_sha256,created_at_ms
                 FROM recovery_points WHERE recovery_id=?1",
                [recovery_id.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, String>(6)?,
                        row.get::<_, String>(7)?,
                        row.get::<_, i64>(8)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(row.0, "automatic");
        assert_eq!(row.1, 1);
        assert_eq!(row.2, 0);
        assert_eq!(row.3, "settlement");
        assert_eq!(row.4, "pending");
        assert_eq!(row.5, "recovery-packages/pending-commit");
        assert_eq!(row.6, expected_package_sha256);
        assert_eq!(row.7, expected_manifest_sha256);
        assert!(row.8 >= 0);
    }

    #[test]
    fn phase5_promotes_a_verified_pending_recovery_point_exactly_once() {
        let repository = SaveRepository::new(root("phase5-recovery-promotion"));
        let save = repository
            .create_save(Some("恢复晋升".to_string()))
            .unwrap();
        let recovery_id = RecoveryId::parse("promote-verified").unwrap();
        let package = verified_recovery_package(&repository, &save.save_id, &recovery_id);
        let mut connection = open_current_connection(&repository.db_path(&save.save_id)).unwrap();
        let transaction = connection.transaction().unwrap();
        record_pending_automatic_recovery_point(
            &transaction,
            &recovery_id,
            &package,
            1,
            0,
            RecoveryReason::Construction,
        )
        .unwrap();
        transaction.commit().unwrap();
        drop(connection);

        repository
            .promote_pending_automatic_recovery_point(&save.save_id, &recovery_id)
            .unwrap();
        assert!(!repository
            .root
            .join("recovery-pending")
            .join(recovery_id.as_str())
            .exists());
        let ready = repository
            .root
            .join("recovery-packages")
            .join(recovery_id.as_str());
        let verified = crate::recovery::verify_database_preimage(&ready).unwrap();
        assert_eq!(verified.package_sha256, package.package_sha256);
        assert_eq!(verified.manifest_sha256, package.manifest_sha256);

        let connection = open_current_connection(&repository.db_path(&save.save_id)).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM recovery_points WHERE recovery_id=?1",
                    [recovery_id.as_str()],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "ready"
        );
        drop(connection);

        repository
            .promote_pending_automatic_recovery_point(&save.save_id, &recovery_id)
            .unwrap();
    }

    #[test]
    fn phase5_startup_replays_a_committed_pending_recovery_point() {
        let repository = SaveRepository::new(root("phase5-recovery-startup-replay"));
        let save = repository
            .create_save(Some("恢复重放".to_string()))
            .unwrap();
        let recovery_id = RecoveryId::parse("startup-replay").unwrap();
        let package = verified_recovery_package(&repository, &save.save_id, &recovery_id);
        let mut connection = open_current_connection(&repository.db_path(&save.save_id)).unwrap();
        let transaction = connection.transaction().unwrap();
        record_pending_automatic_recovery_point(
            &transaction,
            &recovery_id,
            &package,
            1,
            0,
            RecoveryReason::Construction,
        )
        .unwrap();
        transaction.commit().unwrap();
        drop(connection);

        let points = repository.list_recovery_points(&save.save_id).unwrap();
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].recovery_id, recovery_id.as_str());
        assert!(repository
            .root
            .join("recovery-packages")
            .join(recovery_id.as_str())
            .is_dir());
    }

    #[test]
    fn phase5_game_commit_creates_reversible_verified_preimage() {
        let repository = SaveRepository::new(root("phase5-recovery-real-commit"));
        repository.commit_game(0, game()).unwrap();
        let next = blueprint_game(2, json!([]));
        repository.commit_game(1, next).unwrap();

        let points = repository.list_recovery_points("save-1").unwrap();
        assert_eq!(points.len(), 1);
        assert_eq!(points[0].kind, "automatic");
        assert_eq!(points[0].restore_revision, 1);
        assert_eq!(points[0].reason, "construction");

        let restored = repository
            .restore_recovery_point("save-1", &points[0].recovery_id)
            .unwrap();
        assert_eq!(restored.save_id, "save-1");
        assert_eq!(restored.revision, 3);
        let mut restored_game = game();
        restored_game["revision"] = json!(3);
        assert_eq!(repository.load_game("save-1").unwrap(), Some(restored_game));
        let post_restore = repository.list_recovery_points("save-1").unwrap();
        assert_eq!(post_restore.len(), 1);
        assert_eq!(post_restore[0].kind, "pre-restore");
        assert_eq!(post_restore[0].restore_revision, 2);

        let rolled_forward = repository
            .restore_recovery_point("save-1", &post_restore[0].recovery_id)
            .unwrap();
        assert_eq!(rolled_forward.revision, 4);
        let mut expected_forward = blueprint_game(2, json!([]));
        expected_forward["revision"] = json!(4);
        assert_eq!(
            repository.load_game("save-1").unwrap(),
            Some(expected_forward)
        );
    }

    #[test]
    fn phase5_export_round_trips_frozen_database_and_referenced_asset_hashes() {
        let repository = SaveRepository::new(root("phase5-export-round-trip"));
        repository.commit_game(0, game()).unwrap();
        let png = png_header(19, 29);
        let asset_id = repository
            .store_asset_reference(
                "save-1",
                AssetReferenceStoreRequest {
                    owner_kind: "generation-job",
                    owner_id: "export-job",
                    bytes: &png,
                    mime_type: "image/png",
                    width: 19,
                    height: 29,
                },
            )
            .unwrap();

        let export = repository.prepare_save_export("save-1").unwrap();
        assert_eq!(export.source_save_id, "save-1");
        assert_eq!(
            export.schema_version,
            u32::try_from(SAVE_SCHEMA_VERSION).unwrap()
        );
        assert_eq!(export.ruleset_version, "prototype-v1");
        assert!(export.suggested_filename.ends_with(".cloudinn"));
        assert_eq!(
            sha256_file(&export.archive.path).unwrap(),
            export.archive.sha256
        );
        assert_eq!(
            fs::metadata(&export.archive.path).unwrap().len(),
            export.archive.byte_length
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&export.archive.path)
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o444
            );
        }

        let import_root = root("phase5-export-round-trip-import");
        fs::create_dir_all(&import_root).unwrap();
        let service = crate::archive::ArchiveImportService::new(&import_root).unwrap();
        let inspection = service.inspect_import(&export.archive.path, 1_000).unwrap();
        assert_eq!(inspection.source_save_id, "save-1");
        assert_eq!(inspection.schema_version, export.schema_version);
        let consumed = service.consume_import(&inspection.token, 1_001).unwrap();
        assert_eq!(consumed.manifest.referenced_assets.len(), 1);
        assert_eq!(consumed.manifest.referenced_assets[0].asset_id, asset_id);
        assert_eq!(consumed.manifest.referenced_assets[0].sha256, asset_id);
        assert_eq!(
            fs::read(
                consumed
                    .extracted_save_directory
                    .join(&consumed.manifest.referenced_assets[0].path)
            )
            .unwrap(),
            png
        );
    }

    #[test]
    fn phase5_export_and_commit_serialize_to_a_valid_snapshot() {
        use std::sync::{Arc, Barrier};

        let storage_root = root("phase5-export-concurrent");
        SaveRepository::new(storage_root.clone())
            .commit_game(0, game())
            .unwrap();
        let barrier = Arc::new(Barrier::new(3));
        let export_barrier = Arc::clone(&barrier);
        let export_root = storage_root.clone();
        let export_thread = std::thread::spawn(move || {
            export_barrier.wait();
            SaveRepository::new(export_root).prepare_save_export("save-1")
        });
        let commit_barrier = Arc::clone(&barrier);
        let commit_root = storage_root.clone();
        let commit_thread = std::thread::spawn(move || {
            commit_barrier.wait();
            SaveRepository::new(commit_root).commit_game(1, blueprint_game(2, json!([])))
        });
        barrier.wait();
        let export = export_thread.join().unwrap().unwrap();
        commit_thread.join().unwrap().unwrap();

        let import_root = root("phase5-export-concurrent-import");
        fs::create_dir_all(&import_root).unwrap();
        let service = crate::archive::ArchiveImportService::new(&import_root).unwrap();
        let inspection = service.inspect_import(&export.archive.path, 2_000).unwrap();
        let consumed = service.consume_import(&inspection.token, 2_001).unwrap();
        let connection = open_read_only(
            &consumed.extracted_save_directory.join("save.sqlite3"),
            "archive.export-failed",
        )
        .unwrap();
        let revision = read_save_revision_from_connection(&connection, "save-1").unwrap();
        assert!(matches!(revision, 1 | 2));
    }

    #[test]
    fn phase5_export_fails_closed_when_a_catalog_asset_is_missing() {
        let repository = SaveRepository::new(root("phase5-export-missing-asset"));
        repository.commit_game(0, game()).unwrap();
        let png = png_header(31, 37);
        let asset_id = repository
            .store_asset_reference(
                "save-1",
                AssetReferenceStoreRequest {
                    owner_kind: "generation-job",
                    owner_id: "missing-export-job",
                    bytes: &png,
                    mime_type: "image/png",
                    width: 31,
                    height: 37,
                },
            )
            .unwrap();
        let asset_path =
            repository.db_path("save-1").parent().unwrap().join(
                crate::assets::content_addressed_relative_path(&asset_id, "image/png").unwrap(),
            );
        fs::remove_file(asset_path).unwrap();

        assert!(repository.prepare_save_export("save-1").is_err());
    }

    #[test]
    fn phase5_corrupt_restore_target_never_replaces_current_save() {
        let repository = SaveRepository::new(root("phase5-recovery-safe-failure"));
        repository.commit_game(0, game()).unwrap();
        let next = blueprint_game(2, json!([]));
        repository.commit_game(1, next.clone()).unwrap();
        let point = repository.list_recovery_points("save-1").unwrap().remove(0);
        let package = repository
            .root
            .join("recovery-packages")
            .join(&point.recovery_id);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&package, fs::Permissions::from_mode(0o755)).unwrap();
            fs::set_permissions(
                package.join("database.sqlite3"),
                fs::Permissions::from_mode(0o644),
            )
            .unwrap();
        }
        fs::write(package.join("database.sqlite3"), b"not sqlite").unwrap();

        let error = repository
            .restore_recovery_point("save-1", &point.recovery_id)
            .unwrap_err();
        assert!(error.to_string().ends_with("(recovery.corrupt)"));
        assert_eq!(repository.load_game("save-1").unwrap(), Some(next));
    }

    #[test]
    fn phase5_refuses_to_promote_a_corrupt_pending_recovery_package() {
        let repository = SaveRepository::new(root("phase5-recovery-promotion-corrupt"));
        let save = repository
            .create_save(Some("恢复晋升损坏".to_string()))
            .unwrap();
        let recovery_id = RecoveryId::parse("promote-corrupt").unwrap();
        let package = verified_recovery_package(&repository, &save.save_id, &recovery_id);
        let mut connection = open_current_connection(&repository.db_path(&save.save_id)).unwrap();
        let transaction = connection.transaction().unwrap();
        record_pending_automatic_recovery_point(
            &transaction,
            &recovery_id,
            &package,
            1,
            0,
            RecoveryReason::Settlement,
        )
        .unwrap();
        transaction.commit().unwrap();
        drop(connection);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&package.path, fs::Permissions::from_mode(0o755)).unwrap();
            fs::set_permissions(
                package.path.join("manifest.json"),
                fs::Permissions::from_mode(0o644),
            )
            .unwrap();
        }
        fs::write(package.path.join("manifest.json"), b"tampered").unwrap();

        let error = repository
            .promote_pending_automatic_recovery_point(&save.save_id, &recovery_id)
            .unwrap_err();
        assert!(error.to_string().ends_with("(recovery.corrupt)"));
        assert!(package.path.is_dir());
        assert!(!repository
            .root
            .join("recovery-packages")
            .join(recovery_id.as_str())
            .exists());
        let connection = open_current_connection(&repository.db_path(&save.save_id)).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT status FROM recovery_points WHERE recovery_id=?1",
                    [recovery_id.as_str()],
                    |row| row.get::<_, String>(0),
                )
                .unwrap(),
            "pending"
        );
    }

    #[test]
    fn phase5_recovery_catalog_lists_only_valid_ready_points() {
        let repository = SaveRepository::new(root("phase5-recovery-catalog"));
        let save = repository
            .create_save(Some("恢复目录".to_string()))
            .unwrap();
        insert_recovery_point(
            &repository,
            &save.save_id,
            "ready-later",
            "automatic",
            Some(4),
            3,
            "construction",
            "ready",
            20,
        );
        insert_recovery_point(
            &repository,
            &save.save_id,
            "ready-earlier",
            "pre-upgrade",
            None,
            2,
            "settlement",
            "ready",
            10,
        );
        insert_recovery_point(
            &repository,
            &save.save_id,
            "pending-hidden",
            "automatic",
            Some(5),
            4,
            "visual-adoption",
            "pending",
            30,
        );

        let points = repository.list_recovery_points(&save.save_id).unwrap();
        assert_eq!(points.len(), 2);
        assert_eq!(points[0].recovery_id, "ready-later");
        assert_eq!(points[0].kind, "automatic");
        assert_eq!(points[0].restore_revision, 3);
        assert_eq!(points[0].reason, "construction");
        assert_eq!(points[0].created_at_ms, 20);
        assert_eq!(points[1].recovery_id, "ready-earlier");
    }

    #[test]
    fn phase5_recovery_catalog_rejects_a_corrupt_ready_row() {
        let repository = SaveRepository::new(root("phase5-recovery-catalog-corrupt"));
        let save = repository
            .create_save(Some("恢复目录".to_string()))
            .unwrap();
        insert_recovery_point(
            &repository,
            &save.save_id,
            "ready-valid",
            "automatic",
            Some(1),
            0,
            "construction",
            "ready",
            1,
        );
        let connection = open_current_connection(&repository.db_path(&save.save_id)).unwrap();
        connection
            .pragma_update(None, "ignore_check_constraints", "ON")
            .unwrap();
        connection
            .execute(
                "INSERT INTO recovery_points(
                   recovery_id,kind,origin_commit_revision,restore_revision,reason,status,
                   relative_path,package_sha256,manifest_sha256,created_at_ms
                 ) VALUES('bad/id','automatic',2,1,'construction','ready',
                   'recovery-packages/bad','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                   NULL,2)",
                [],
            )
            .unwrap();
        connection
            .pragma_update(None, "ignore_check_constraints", "OFF")
            .unwrap();
        drop(connection);

        let error = repository.list_recovery_points(&save.save_id).unwrap_err();
        assert!(error.to_string().ends_with("(recovery.corrupt)"));
    }

    #[test]
    fn phase5_rotation_keeps_twenty_ready_automatic_points_and_protects_other_rows() {
        let repository = SaveRepository::new(root("phase5-recovery-rotation"));
        let save = repository
            .create_save(Some("恢复轮换".to_string()))
            .unwrap();
        for ordinal in 0..21 {
            insert_verified_ready_automatic_recovery_point(
                &repository,
                &save.save_id,
                &format!("automatic-{ordinal:02}"),
                ordinal,
            );
        }
        insert_recovery_point(
            &repository,
            &save.save_id,
            "protected-pre-upgrade",
            "pre-upgrade",
            None,
            0,
            "construction",
            "ready",
            100,
        );
        insert_recovery_point(
            &repository,
            &save.save_id,
            "protected-pending",
            "automatic",
            Some(1),
            0,
            "construction",
            "pending",
            101,
        );
        insert_recovery_point(
            &repository,
            &save.save_id,
            "protected-failed",
            "automatic",
            Some(1),
            0,
            "construction",
            "failed",
            102,
        );

        repository
            .rotate_ready_automatic_recovery_points(&save.save_id)
            .unwrap();

        let connection = open_current_connection(&repository.db_path(&save.save_id)).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM recovery_points
                     WHERE kind='automatic' AND status='ready'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            20
        );
        for recovery_id in [
            "protected-pre-upgrade",
            "protected-pending",
            "protected-failed",
        ] {
            assert_eq!(
                connection
                    .query_row(
                        "SELECT count(*) FROM recovery_points WHERE recovery_id=?1",
                        [recovery_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .unwrap(),
                1
            );
        }
        drop(connection);
        assert!(!repository
            .root
            .join("recovery-packages")
            .join("automatic-00")
            .exists());
        assert!(repository
            .root
            .join("recovery-packages")
            .join("automatic-01")
            .is_dir());
    }

    #[test]
    fn phase5_rotation_refuses_to_delete_catalog_rows_when_a_package_is_missing() {
        let repository = SaveRepository::new(root("phase5-recovery-rotation-missing"));
        let save = repository
            .create_save(Some("恢复轮换".to_string()))
            .unwrap();
        for ordinal in 0..21 {
            insert_verified_ready_automatic_recovery_point(
                &repository,
                &save.save_id,
                &format!("automatic-{ordinal:02}"),
                ordinal,
            );
        }
        let oldest_package = repository
            .root
            .join("recovery-packages")
            .join("automatic-00");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&oldest_package, fs::Permissions::from_mode(0o755)).unwrap();
        }
        fs::rename(
            &oldest_package,
            repository.root.join("withheld-automatic-00"),
        )
        .unwrap();

        let error = repository
            .rotate_ready_automatic_recovery_points(&save.save_id)
            .unwrap_err();
        assert!(error.to_string().ends_with("(recovery.corrupt)"));
        let connection = open_current_connection(&repository.db_path(&save.save_id)).unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT count(*) FROM recovery_points
                     WHERE kind='automatic' AND status='ready'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            21
        );
    }

    #[test]
    fn phase5_v6_clone_migration_seeds_exact_metadata_runtime_and_backup() {
        let repository = SaveRepository::new(root("phase5-v6"));
        let path = create_v6_database(&repository);

        repository.prepare_save_database("save-1").unwrap();

        let connection = Connection::open(&path).unwrap();
        assert_eq!(
            connection
                .query_row("PRAGMA application_id", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            SAVE_APPLICATION_ID
        );
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            SAVE_SCHEMA_VERSION
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT save_id,display_name,created_at_ms,renamed_at_ms,metadata_revision
                     FROM save_metadata",
                    [],
                    |row| Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                    )),
                )
                .unwrap(),
            ("save-1".into(), "云岫酒店 1".into(), 0, 0, 0)
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT singleton,session_id,clean_shutdown,last_durable_revision,
                            coordinator_epoch,last_observed_wall_ms,updated_at_ms
                     FROM runtime_session",
                    [],
                    |row| Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                        row.get::<_, i64>(6)?,
                    )),
                )
                .unwrap(),
            (1, "migration-bootstrap".into(), 1, 1, 0, 0, 0)
        );
        drop(connection);

        assert_eq!(
            repository.load_game("save-1").unwrap().unwrap()["saveId"],
            "save-1"
        );
        let backup_directory = path.parent().unwrap().join("pre-upgrade");
        let backups = fs::read_dir(&backup_directory)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .filter(|candidate| {
                candidate
                    .file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| {
                        name.starts_with("schema-v6-") && name.ends_with(".sqlite3")
                    })
            })
            .collect::<Vec<_>>();
        assert_eq!(backups.len(), 1);
        let backup_connection =
            Connection::open_with_flags(&backups[0], OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        assert_eq!(
            backup_connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert_eq!(
            backup_connection
                .query_row(
                    "SELECT revision FROM saves WHERE save_id='save-1'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn phase5_repeated_current_open_is_byte_stable_and_creates_no_backup() {
        let repository = SaveRepository::new(root("phase5-repeat"));
        repository.commit_game(0, game()).unwrap();
        let path = repository.db_path("save-1");
        let before = fs::read(&path).unwrap();

        repository.prepare_save_database("save-1").unwrap();
        repository.prepare_save_database("save-1").unwrap();

        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(!path.parent().unwrap().join("pre-upgrade").exists());
    }

    #[test]
    fn phase5_unknown_load_creates_nothing_and_current_without_control_fails_closed() {
        let app_root = root("phase5-control-order");
        let repository = SaveRepository::new(app_root.clone());
        assert_eq!(repository.load_game("unknown-save").unwrap(), None);
        assert!(!app_root.join("saves/unknown-save").exists());
        assert!(!app_root
            .join(crate::provider_control::PROVIDER_CONTROL_FILENAME)
            .exists());

        repository.commit_game(0, game()).unwrap();
        let control_path = app_root.join(crate::provider_control::PROVIDER_CONTROL_FILENAME);
        assert!(control_path.is_file());
        fs::remove_file(&control_path).unwrap();
        let database_before = fs::read(repository.db_path("save-1")).unwrap();

        let error = repository.prepare_save_database("save-1").unwrap_err();

        assert!(
            error.to_string().contains("provider.control-invalid"),
            "{error}"
        );
        assert_eq!(
            fs::read(repository.db_path("save-1")).unwrap(),
            database_before
        );
        assert!(!control_path.exists());
    }

    #[test]
    fn phase5_first_commit_recovers_a_durable_empty_database() {
        let app_root = root("phase5-empty-first-commit");
        let repository = SaveRepository::new(app_root);
        drop(repository.bootstrap_provider_control().unwrap());
        let path = repository.db_path("save-1");
        ensure_save_directory(path.parent().unwrap()).unwrap();
        let _save_lock = lock_save(path.parent().unwrap()).unwrap();
        initialize_current_database(&path).unwrap();
        assert_eq!(
            Connection::open(&path)
                .unwrap()
                .query_row("SELECT count(*) FROM saves", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
        drop(_save_lock);

        repository.commit_game(0, game()).unwrap();

        assert_eq!(
            repository.load_game("save-1").unwrap().unwrap()["revision"],
            1
        );
    }

    #[test]
    fn phase5_legacy_identity_mismatch_fails_before_backup_or_swap() {
        let repository = SaveRepository::new(root("phase5-legacy-identity"));
        let path = create_v6_database(&repository);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute("UPDATE saves SET save_id='other-save'", [])
            .unwrap();
        drop(connection);
        let before = fs::read(&path).unwrap();

        let error = repository.prepare_save_database("save-1").unwrap_err();

        assert!(
            error.to_string().contains("migration.validation-failed"),
            "{error}"
        );
        assert_eq!(fs::read(&path).unwrap(), before);
        assert!(!path.parent().unwrap().join("pre-upgrade").exists());
    }

    #[test]
    fn phase5_open_enforces_cross_database_issued_grant_identity() {
        let app_root = root("phase5-cross-database");
        let repository = SaveRepository::new(app_root.clone());
        repository.commit_game(0, game()).unwrap();
        let fingerprint = "a".repeat(64);
        let save_connection = repository.open("save-1").unwrap();
        save_connection
            .execute(
                "INSERT INTO generation_jobs(
                   job_id,save_id,target_kind,target_fingerprint,request_fingerprint,
                   request_json,status,selected_model,created_at_ms,updated_at_ms
                 ) VALUES(
                   'job-1','save-1','master','target-1',?1,
                   '{}','queued','model-1',1,1
                 )",
                [&fingerprint],
            )
            .unwrap();
        drop(save_connection);
        let control_connection = ProviderControlStore::new(app_root)
            .open_validated()
            .unwrap();
        control_connection
            .execute(
                "INSERT INTO provider_send_grants(
                   grant_id,save_id,job_id,job_revision,attempt_sequence,model,
                   request_fingerprint,quota_day,source,state,issued_at_ms
                 ) VALUES(
                   'grant-1','save-1','job-1',0,1,'model-1',
                   ?1,0,'player-confirmed','issued',1
                 )",
                [&fingerprint],
            )
            .unwrap();
        drop(control_connection);

        assert!(repository.load_game("save-1").is_ok());

        let save_connection = Connection::open(repository.db_path("save-1")).unwrap();
        save_connection
            .execute(
                "UPDATE generation_jobs SET job_revision=1 WHERE job_id='job-1'",
                [],
            )
            .unwrap();
        drop(save_connection);

        let error = repository.load_game("save-1").unwrap_err();
        assert!(error.contains("provider.control-invalid"), "{error}");
    }

    #[test]
    fn phase5_forced_migration_failure_leaves_original_byte_identical() {
        let repository = SaveRepository::new(root("phase5-forced-failure"));
        let path = create_v6_database(&repository);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute(
                "INSERT INTO room_blueprints(
                   save_id,blueprint_id,name,columns_count,rows_count,
                   cells_json,metrics_json,visual_json,openings_json
                 ) VALUES(
                   'save-1','broken-blueprint','Broken',1,1,
                   'not-json','{}','{}',NULL
                 )",
                [],
            )
            .unwrap();
        drop(connection);
        let before = fs::read(&path).unwrap();

        let error = repository.prepare_save_database("save-1").unwrap_err();

        assert!(error.to_string().contains("migration.validation-failed"));
        assert_eq!(fs::read(&path).unwrap(), before);
        assert_eq!(
            fs::read_dir(path.parent().unwrap().join("pre-upgrade"))
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("schema-v6-"))
                .count(),
            1
        );
        let connection = Connection::open(&path).unwrap();
        assert_eq!(
            connection
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn phase5_wrong_application_id_and_future_version_are_read_only_rejections() {
        for (name, application_id, user_version) in [("wrong-app", 1234, 0), ("future", 0, 8)] {
            let repository = SaveRepository::new(root(name));
            let path = create_v6_database(&repository);
            let connection = Connection::open(&path).unwrap();
            connection
                .pragma_update(None, "application_id", application_id)
                .unwrap();
            connection
                .pragma_update(None, "user_version", user_version)
                .unwrap();
            drop(connection);
            let before = fs::read(&path).unwrap();

            let error = repository.prepare_save_database("save-1").unwrap_err();

            assert!(error.to_string().contains("migration.unsupported-version"));
            assert_eq!(fs::read(&path).unwrap(), before);
        }
    }

    #[test]
    fn phase5_startup_restores_active_missing_upgrade_journal() {
        let repository = SaveRepository::new(root("phase5-journal-restore"));
        let path = create_v6_database(&repository);
        repository.bootstrap_provider_control().unwrap();
        let directory = path.parent().unwrap();
        let rollback = unique_sibling(&path, "rollback");
        let partial = unique_sibling(&path, "upgrade.partial");
        let wal_connection = Connection::open(&path).unwrap();
        wal_connection
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
        wal_connection
            .pragma_update(None, "wal_autocheckpoint", 0)
            .unwrap();
        wal_connection
            .execute("UPDATE saves SET revision=2 WHERE save_id='save-1'", [])
            .unwrap();
        let main_bytes = fs::read(&path).unwrap();
        let wal_bytes = fs::read(append_suffix(&path, "-wal")).unwrap();
        let shm_bytes = fs::read(append_suffix(&path, "-shm")).unwrap();
        drop(wal_connection);
        fs::write(&path, &main_bytes).unwrap();
        fs::write(append_suffix(&path, "-wal"), &wal_bytes).unwrap();
        fs::write(append_suffix(&path, "-shm"), &shm_bytes).unwrap();
        online_backup(&path, &partial).unwrap();
        let journal = UpgradeJournal::new(&partial, &rollback).unwrap();
        write_upgrade_journal(directory, &journal).unwrap();
        fs::rename(&path, &rollback).unwrap();
        fs::rename(
            append_suffix(&path, "-wal"),
            append_suffix(&rollback, "-wal"),
        )
        .unwrap();

        recover_interrupted_upgrade(&path).unwrap();

        assert_eq!(
            Connection::open(&path)
                .unwrap()
                .query_row(
                    "SELECT revision FROM saves WHERE save_id='save-1'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2
        );
        assert!(!upgrade_journal_path(directory).exists());
        assert!(!rollback.exists());

        repository.prepare_save_database("save-1").unwrap();

        assert!(path.is_file());
        assert!(!upgrade_journal_path(directory).exists());
        assert!(!rollback.exists());
        assert_eq!(
            Connection::open(&path)
                .unwrap()
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            7
        );
        assert_eq!(
            fs::read_dir(directory.join("pre-upgrade"))
                .unwrap()
                .filter_map(Result::ok)
                .filter(|entry| entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("schema-v6-"))
                .count(),
            1
        );
        assert_ne!(fs::read(&path).unwrap(), main_bytes);
    }

    #[test]
    fn phase5_recovery_resumes_after_main_restore_before_wal_restore() {
        let repository = SaveRepository::new(root("phase5-journal-resume-sidecars"));
        let path = create_v6_database(&repository);
        drop(repository.bootstrap_provider_control().unwrap());
        let directory = path.parent().unwrap();
        let rollback = unique_sibling(&path, "rollback");
        let partial = unique_sibling(&path, "upgrade.partial");
        let wal_connection = Connection::open(&path).unwrap();
        wal_connection
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
        wal_connection
            .pragma_update(None, "wal_autocheckpoint", 0)
            .unwrap();
        wal_connection
            .execute("UPDATE saves SET revision=2 WHERE save_id='save-1'", [])
            .unwrap();
        let main_bytes = fs::read(&path).unwrap();
        let wal_bytes = fs::read(append_suffix(&path, "-wal")).unwrap();
        let shm_bytes = fs::read(append_suffix(&path, "-shm")).unwrap();
        drop(wal_connection);
        fs::write(&path, &main_bytes).unwrap();
        fs::write(append_suffix(&path, "-wal"), &wal_bytes).unwrap();
        fs::write(append_suffix(&path, "-shm"), &shm_bytes).unwrap();
        online_backup(&path, &partial).unwrap();
        write_upgrade_journal(
            directory,
            &UpgradeJournal::new(&partial, &rollback).unwrap(),
        )
        .unwrap();
        fs::rename(&path, &rollback).unwrap();
        fs::rename(
            append_suffix(&path, "-wal"),
            append_suffix(&rollback, "-wal"),
        )
        .unwrap();
        fs::rename(
            append_suffix(&path, "-shm"),
            append_suffix(&rollback, "-shm"),
        )
        .unwrap();
        fs::rename(&rollback, &path).unwrap();

        recover_interrupted_upgrade(&path).unwrap();

        assert_eq!(
            Connection::open(&path)
                .unwrap()
                .query_row(
                    "SELECT revision FROM saves WHERE save_id='save-1'",
                    [],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            2
        );
        assert!(!upgrade_journal_path(directory).exists());
        assert!(!append_suffix(&rollback, "-wal").exists());
        assert!(!append_suffix(&rollback, "-shm").exists());
    }

    #[test]
    fn phase5_preupgrade_backup_name_changes_when_source_changes() {
        let repository = SaveRepository::new(root("phase5-backup-hash"));
        let path = create_v6_database(&repository);
        let backup_directory = path.parent().unwrap().join("pre-upgrade");
        ensure_backup_directory(&backup_directory).unwrap();
        let first =
            create_content_addressed_upgrade_backup(&path, &backup_directory, 6, 0).unwrap();
        let first_bytes = fs::read(&first).unwrap();

        let connection = Connection::open(&path).unwrap();
        connection
            .execute("UPDATE saves SET revision=2 WHERE save_id='save-1'", [])
            .unwrap();
        drop(connection);
        let second =
            create_content_addressed_upgrade_backup(&path, &backup_directory, 6, 0).unwrap();

        assert_ne!(first, second);
        assert_eq!(fs::read(&first).unwrap(), first_bytes);
        assert_ne!(fs::read(&first).unwrap(), fs::read(&second).unwrap());
    }

    #[test]
    fn phase5_pre_swap_journal_cleans_partial_and_retries_safely() {
        let repository = SaveRepository::new(root("phase5-journal-pre-swap"));
        let path = create_v6_database(&repository);
        repository.bootstrap_provider_control().unwrap();
        let directory = path.parent().unwrap();
        let rollback = unique_sibling(&path, "rollback");
        let partial = unique_sibling(&path, "upgrade.partial");
        online_backup(&path, &partial).unwrap();
        let journal = UpgradeJournal::new(&partial, &rollback).unwrap();
        write_upgrade_journal(directory, &journal).unwrap();
        repository.prepare_save_database("save-1").unwrap();

        assert!(!upgrade_journal_path(directory).exists());
        assert!(!partial.exists());
        assert_eq!(
            Connection::open(&path)
                .unwrap()
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            7
        );
    }

    #[test]
    fn phase5_post_publish_journal_keeps_valid_new_database() {
        let repository = SaveRepository::new(root("phase5-journal-post-publish"));
        let path = create_v6_database(&repository);
        repository.bootstrap_provider_control().unwrap();
        let directory = path.parent().unwrap();
        let rollback = unique_sibling(&path, "rollback");
        let partial = unique_sibling(&path, "upgrade.partial");
        online_backup(&path, &partial).unwrap();
        let mut partial_connection = Connection::open(&partial).unwrap();
        configure_migration_connection(&partial_connection).unwrap();
        apply_all_migrations(&mut partial_connection).unwrap();
        validate_current_database_contents(&partial_connection).unwrap();
        make_single_file_durable(&partial_connection, &partial).unwrap();
        drop(partial_connection);
        let journal = UpgradeJournal::new(&partial, &rollback).unwrap();
        write_upgrade_journal(directory, &journal).unwrap();
        fs::rename(&path, &rollback).unwrap();
        fs::rename(&partial, &path).unwrap();
        sync_directory(directory).unwrap();

        recover_interrupted_upgrade(&path).unwrap();

        assert!(!upgrade_journal_path(directory).exists());
        assert!(!rollback.exists());
        assert_eq!(
            Connection::open(&path)
                .unwrap()
                .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            7
        );
    }

    #[test]
    fn phase5_missing_rollback_with_corrupt_active_preserves_journal() {
        let repository = SaveRepository::new(root("phase5-journal-corrupt-active"));
        let path = create_v6_database(&repository);
        repository.bootstrap_provider_control().unwrap();
        let directory = path.parent().unwrap();
        let rollback = unique_sibling(&path, "rollback");
        let partial = unique_sibling(&path, "upgrade.partial");
        online_backup(&path, &partial).unwrap();
        let journal = UpgradeJournal::new(&partial, &rollback).unwrap();
        write_upgrade_journal(directory, &journal).unwrap();
        fs::write(&path, b"corrupt-active").unwrap();

        assert!(repository.prepare_save_database("save-1").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"corrupt-active");
        assert!(upgrade_journal_path(directory).is_file());
        assert!(partial.is_file());
    }

    #[test]
    fn phase5_generation_job_constraints_reject_null_and_invalid_target_kind() {
        let repository = SaveRepository::new(root("phase5-job-constraints"));
        repository.commit_game(0, game()).unwrap();
        let connection = repository.open("save-1").unwrap();
        let fingerprint = "a".repeat(64);
        for target_kind in [None, Some("unknown")] {
            let result = connection.execute(
                "INSERT INTO generation_jobs(
                   job_id,save_id,target_kind,target_fingerprint,request_fingerprint,
                   request_json,status,created_at_ms,updated_at_ms
                 ) VALUES(?1,'save-1',?2,'target',?3,'{}','queued',0,0)",
                params![
                    format!("job-{}", target_kind.unwrap_or("null")),
                    target_kind,
                    fingerprint
                ],
            );
            assert!(result.is_err());
        }
        for status in ["ready-for-review", "adopted"] {
            let result = connection.execute(
                "INSERT INTO generation_jobs(
                   job_id,save_id,target_kind,target_fingerprint,request_fingerprint,
                   request_json,status,asset_id,created_at_ms,updated_at_ms
                 ) VALUES(?1,'save-1','master','target',?2,'{}',?3,NULL,0,0)",
                params![format!("job-{status}"), fingerprint, status],
            );
            assert!(result.is_err());
        }
    }

    #[test]
    fn operations_are_optional_and_minimal_state_is_valid() {
        assert!(validate_game(&game()).is_ok());
        let mut state = game();
        state["operations"] = minimal_operations();
        assert!(validate_game(&state).is_ok());
    }

    #[test]
    fn operations_allow_history_that_starts_after_a_legacy_game_day() {
        let mut state = game();
        state["currentDay"] = json!(5);
        state["cashCents"] = json!(1_000_005);
        state["reports"] = json!((1..=5).map(|day| json!({"day":day})).collect::<Vec<_>>());
        state["latestReport"] = json!({"day":5});
        let mut operations = minimal_operations();
        operations["dailyReports"] = json!([operations_daily(5)]);
        operations["reputationBps"] = json!(5005);
        operations["maximumReputationBps"] = json!(5005);
        state["operations"] = operations;

        assert!(validate_game(&state).is_ok());
    }

    #[test]
    fn operations_day_30_round_trips_through_sqlite() {
        let repository = SaveRepository::new(root("operations-roundtrip"));
        let state = full_operations_game();

        repository.commit_game(0, state.clone()).unwrap();

        assert_eq!(repository.load_game("save-1").unwrap(), Some(state));
    }

    #[test]
    fn operations_allow_cash_spent_after_the_latest_settled_report() {
        let repository = SaveRepository::new(root("operations-post-settlement-spend"));
        let mut state = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        state["cashCents"] = json!(750_030);
        state["revision"] = json!(1);

        repository.commit_game(0, state.clone()).unwrap();

        assert_eq!(repository.load_game("phase4-shared").unwrap(), Some(state));
    }

    #[test]
    fn operations_day_30_fresh_legacy_initialization_round_trips() {
        let repository = SaveRepository::new(root("operations-day-30-fresh"));
        let mut state = game();
        state["currentDay"] = json!(30);
        state["reports"] = json!((1..=30).map(|day| json!({"day":day})).collect::<Vec<_>>());
        state["latestReport"] = json!({"day":30});
        state["operations"] = minimal_operations();

        repository.commit_game(0, state.clone()).unwrap();

        assert_eq!(repository.load_game("save-1").unwrap(), Some(state));
    }

    #[test]
    fn operations_reject_invalid_scalars_catalogs_and_history() {
        let mutations: Vec<SnapshotMutation> = vec![
            (
                "ruleset",
                Box::new(|g| g["operations"]["rulesetVersion"] = json!("operations-v2")),
            ),
            (
                "difficulty",
                Box::new(|g| g["operations"]["difficulty"] = json!("expert")),
            ),
            (
                "missing department",
                Box::new(|g| {
                    g["operations"]["departments"]
                        .as_object_mut()
                        .unwrap()
                        .remove("security");
                }),
            ),
            (
                "extra department",
                Box::new(|g| g["operations"]["departments"]["spa"] = json!({"id":"spa"})),
            ),
            (
                "department mismatch",
                Box::new(|g| {
                    g["operations"]["departments"]["security"]["id"] = json!("engineering")
                }),
            ),
            (
                "unsafe money",
                Box::new(|g| {
                    g["operations"]["departments"]["security"]["dailyBudgetCents"] =
                        json!(9_007_199_254_740_992_i64)
                }),
            ),
            (
                "fraction bps",
                Box::new(|g| g["operations"]["reputationBps"] = json!(1.5)),
            ),
            (
                "bps range",
                Box::new(|g| g["operations"]["reputationBps"] = json!(10001)),
            ),
            (
                "speed",
                Box::new(|g| g["operations"]["timeSpeed"] = json!(3)),
            ),
            (
                "negative checkpoint",
                Box::new(|g| g["operations"]["lastOfflineCheckpointMs"] = json!(-1)),
            ),
            (
                "unsafe checkpoint",
                Box::new(|g| {
                    g["operations"]["lastOfflineCheckpointMs"] = json!(9_007_199_254_740_992_i64)
                }),
            ),
            (
                "day 30 speed",
                Box::new(|g| g["operations"]["timeSpeed"] = json!(1)),
            ),
            (
                "day 30 checkpoint",
                Box::new(|g| g["operations"]["lastOfflineCheckpointMs"] = Value::Null),
            ),
            (
                "unknown segment",
                Box::new(|g| {
                    g["operations"]["dailyReports"][0]["segments"][0]["segmentId"] = json!("vip")
                }),
            ),
            (
                "duplicate day",
                Box::new(|g| g["operations"]["dailyReports"][1]["day"] = json!(1)),
            ),
            (
                "nonmonotonic day",
                Box::new(|g| {
                    g["operations"]["dailyReports"]
                        .as_array_mut()
                        .unwrap()
                        .swap(1, 2)
                }),
            ),
            (
                "too many days",
                Box::new(|g| {
                    g["operations"]["dailyReports"]
                        .as_array_mut()
                        .unwrap()
                        .push(operations_daily(31))
                }),
            ),
            (
                "outer day mismatch",
                Box::new(|g| g["currentDay"] = json!(29)),
            ),
            (
                "operations reputation mismatch",
                Box::new(|g| g["operations"]["reputationBps"] = json!(5029)),
            ),
        ];
        for (label, mutate) in mutations {
            let mut malformed = full_operations_game();
            mutate(&mut malformed);
            assert!(validate_game(&malformed).is_err(), "{label}");
        }
    }

    #[test]
    fn operations_reject_inconsistent_daily_and_periodic_reports() {
        let mutations: Vec<SnapshotMutation> = vec![
            (
                "segment sum",
                Box::new(|g| g["operations"]["dailyReports"][0]["revenueCents"] = json!(1001)),
            ),
            (
                "net total",
                Box::new(|g| g["operations"]["dailyReports"][0]["netIncomeCents"] = json!(891)),
            ),
            (
                "room revenue",
                Box::new(|g| g["operations"]["dailyReports"][0]["roomRevenueCents"] = json!(999)),
            ),
            (
                "department cost",
                Box::new(|g| g["operations"]["dailyReports"][0]["departmentCostCents"] = json!(99)),
            ),
            (
                "finance cost",
                Box::new(|g| g["operations"]["dailyReports"][0]["loanInterestCents"] = json!(9)),
            ),
            (
                "invalid review",
                Box::new(|g| {
                    g["operations"]["dailyReports"][0]["reviews"][0]["ratingBps"] = json!(10001)
                }),
            ),
            (
                "invalid booking",
                Box::new(|g| {
                    g["operations"]["dailyReports"][0]["bookings"][0]["rateCents"] = json!(-1)
                }),
            ),
            (
                "invalid lost code",
                Box::new(|g| {
                    g["operations"]["dailyReports"][0]["lostBookings"][0]["code"] = json!("unknown")
                }),
            ),
            (
                "missing weekly",
                Box::new(|g| {
                    g["operations"]["weeklyReports"]
                        .as_array_mut()
                        .unwrap()
                        .pop();
                }),
            ),
            (
                "weekly number",
                Box::new(|g| g["operations"]["weeklyReports"][0]["week"] = json!(2)),
            ),
            (
                "weekly window",
                Box::new(|g| g["operations"]["weeklyReports"][0]["startDay"] = json!(2)),
            ),
            (
                "weekly total",
                Box::new(|g| g["operations"]["weeklyReports"][0]["revenueCents"] = json!(7001)),
            ),
            (
                "weekly reputation",
                Box::new(|g| g["operations"]["weeklyReports"][0]["reputationBps"] = json!(5005)),
            ),
            (
                "monthly duplicate",
                Box::new(|g| {
                    let close = g["operations"]["monthlyCloses"][0].clone();
                    g["operations"]["monthlyCloses"]
                        .as_array_mut()
                        .unwrap()
                        .push(close);
                }),
            ),
            (
                "monthly boundary",
                Box::new(|g| g["operations"]["monthlyCloses"][0]["endDay"] = json!(29)),
            ),
            (
                "monthly total",
                Box::new(|g| g["operations"]["monthlyCloses"][0]["netIncomeCents"] = json!(26701)),
            ),
            (
                "monthly cash",
                Box::new(|g| {
                    g["operations"]["monthlyCloses"][0]["endingCashCents"] = json!(1_000_031)
                }),
            ),
        ];
        for (label, mutate) in mutations {
            let mut malformed = full_operations_game();
            mutate(&mut malformed);
            assert!(validate_game(&malformed).is_err(), "{label}");
        }
    }

    #[test]
    fn operations_reject_incomplete_daily_segment_catalogs() {
        let cases = vec![
            ("empty", json!([])),
            (
                "one valid",
                json!([{"segmentId":"business","demand":0,"soldRooms":0,"averageRateCents":0,"revenueCents":0,"satisfactionBps":5000}]),
            ),
            (
                "missing one",
                json!([
                    {"segmentId":"business","demand":0,"soldRooms":0,"averageRateCents":0,"revenueCents":0,"satisfactionBps":5000},
                    {"segmentId":"couple","demand":0,"soldRooms":0,"averageRateCents":0,"revenueCents":0,"satisfactionBps":5000},
                    {"segmentId":"family","demand":0,"soldRooms":0,"averageRateCents":0,"revenueCents":0,"satisfactionBps":5000},
                    {"segmentId":"leisure","demand":0,"soldRooms":0,"averageRateCents":0,"revenueCents":0,"satisfactionBps":5000},
                    {"segmentId":"high-net-worth","demand":0,"soldRooms":0,"averageRateCents":0,"revenueCents":0,"satisfactionBps":5000}
                ]),
            ),
        ];
        for (label, segments) in cases {
            let mut report = operations_daily(1);
            report["segments"] = segments;
            report["revenueCents"] = json!(0);
            report["roomRevenueCents"] = json!(0);
            report["netIncomeCents"] = json!(-110);
            report["soldRooms"] = json!(0);
            report["occupancyBps"] = json!(0);
            let mut operations = minimal_operations();
            operations["dailyReports"] = json!([report]);
            operations["reputationBps"] = json!(5001);
            operations["maximumReputationBps"] = json!(5001);
            let mut state = game();
            state["currentDay"] = json!(1);
            state["cashCents"] = json!(1_000_001);
            state["reports"] = json!([{"day":1}]);
            state["latestReport"] = json!({"day":1});
            state["operations"] = operations;

            assert!(validate_game(&state).is_err(), "{label}");
        }
    }

    #[test]
    fn operations_reject_invalid_finance_upgrades_unlocks_and_market_state() {
        let mutations: Vec<SnapshotMutation> = vec![
            (
                "empty loan",
                Box::new(|g| g["operations"]["loans"][0]["id"] = json!("")),
            ),
            (
                "duplicate loan",
                Box::new(|g| {
                    let loan = g["operations"]["loans"][0].clone();
                    g["operations"]["loans"].as_array_mut().unwrap().push(loan);
                }),
            ),
            (
                "zero balance",
                Box::new(|g| g["operations"]["loans"][0]["outstandingCents"] = json!(0)),
            ),
            (
                "balance principal",
                Box::new(|g| g["operations"]["loans"][0]["outstandingCents"] = json!(10001)),
            ),
            (
                "payment balance",
                Box::new(|g| g["operations"]["loans"][0]["minimumPaymentCents"] = json!(5001)),
            ),
            (
                "reserved contract",
                Box::new(|g| {
                    g["operations"]["loans"][0]["id"] = json!("safety-loan:daily-settlement")
                }),
            ),
            (
                "price key",
                Box::new(|g| {
                    g["operations"]["pricePolicies"]["offer-1"]["roomOfferId"] = json!("offer-2")
                }),
            ),
            (
                "price range",
                Box::new(|g| {
                    g["operations"]["pricePolicies"]["offer-1"]["minRateCents"] = json!(1001)
                }),
            ),
            (
                "price money",
                Box::new(|g| {
                    g["operations"]["pricePolicies"]["offer-1"]["nightlyRateCents"] = json!(-1)
                }),
            ),
            (
                "upgrade missing",
                Box::new(|g| {
                    g["operations"]["offerUpgrades"]["offer-1:workspace"]
                        .as_object_mut()
                        .unwrap()
                        .remove("costCents");
                }),
            ),
            (
                "upgrade key",
                Box::new(|g| {
                    let value = g["operations"]["offerUpgrades"]["offer-1:workspace"].take();
                    g["operations"]["offerUpgrades"]["bad"] = value;
                }),
            ),
            (
                "upgrade id",
                Box::new(|g| {
                    g["operations"]["offerUpgrades"]["offer-1:workspace"]["upgradeId"] =
                        json!("view")
                }),
            ),
            (
                "upgrade kind",
                Box::new(|g| {
                    g["operations"]["offerUpgrades"]["offer-1:workspace"]["kind"] = json!("pool")
                }),
            ),
            (
                "upgrade closure",
                Box::new(|g| {
                    g["operations"]["offerUpgrades"]["offer-1:workspace"]["remainingClosureDays"] =
                        json!(3)
                }),
            ),
            (
                "upgrade cost",
                Box::new(|g| {
                    g["operations"]["offerUpgrades"]["offer-1:workspace"]["costCents"] = json!(1)
                }),
            ),
            (
                "upgrade day",
                Box::new(|g| {
                    g["operations"]["offerUpgrades"]["offer-1:workspace"]["committedDay"] =
                        json!(31)
                }),
            ),
            (
                "maximum reputation",
                Box::new(|g| g["operations"]["maximumReputationBps"] = json!(5029)),
            ),
            (
                "duplicate unlock",
                Box::new(|g| {
                    g["operations"]["unlockedContent"] = json!([
                        "operations:pricing-automation",
                        "operations:pricing-automation"
                    ])
                }),
            ),
            (
                "unknown unlock",
                Box::new(|g| g["operations"]["unlockedContent"] = json!(["unknown"])),
            ),
            (
                "unknown need",
                Box::new(
                    |g| g["operations"]["discoveredNeeds"] = json!([{"id":"n","segmentId":"vip","kind":"service","discoveredDay":1,"strengthBps":1}]),
                ),
            ),
            (
                "duplicate need",
                Box::new(
                    |g| g["operations"]["discoveredNeeds"] = json!([{"id":"n","segmentId":"business","kind":"service","discoveredDay":1,"strengthBps":1},{"id":"n","segmentId":"business","kind":"price","discoveredDay":2,"strengthBps":1}]),
                ),
            ),
            (
                "segment mix",
                Box::new(|g| g["operations"]["segmentMix"] = json!({"business":5000,"vip":5000})),
            ),
        ];
        for (label, mutate) in mutations {
            let mut malformed = full_operations_game();
            mutate(&mut malformed);
            assert!(validate_game(&malformed).is_err(), "{label}");
        }
    }
    #[test]
    fn commits_and_loads_full_state() {
        let r = SaveRepository::new(root("full"));
        let g = game();
        r.commit_game(0, g.clone()).unwrap();
        assert_eq!(r.load_game("save-1").unwrap(), Some(g));
    }

    #[test]
    fn commits_and_loads_blueprint_openings() {
        let r = SaveRepository::new(root("blueprint-openings"));
        let game = blueprint_with_openings_game();

        r.commit_game(0, game.clone()).unwrap();

        assert_eq!(r.load_game("save-1").unwrap(), Some(game));
    }

    #[test]
    fn rejects_malformed_blueprint_openings() {
        let mut game = blueprint_with_openings_game();
        game["roomBlueprint"]["openings"]["doors"][0]["side"] = json!("up");

        assert!(validate_game(&game).is_err());
    }

    #[test]
    fn persists_phase2_design_envelope_and_rejects_unsafe_visual_metadata() {
        let r = SaveRepository::new(root("phase2-roundtrip"));
        let mut g = game();
        g["phase2"] = json!({
            "hotelGene": {"palette": "jade", "materials": ["wood"], "metal":"bronze", "lighting": "warm", "mood": "quiet"},
            "roomMaster": null,
            "roomVariants": [],
            "corridorTemplate": null
        });
        r.commit_game(0, g.clone()).unwrap();
        assert_eq!(r.load_game("save-1").unwrap(), Some(g));

        let mut unsafe_game = game();
        unsafe_game["phase2"] = json!({
            "hotelGene": {}, "roomMaster": null, "roomVariants": [],
            "corridorTemplate": null, "visual": {"assetPath": "data:image/png;base64,AAAA"}
        });
        assert!(r.commit_game(1, unsafe_game).is_err());
    }

    #[test]
    fn rejects_malformed_phase2_envelope() {
        let r = SaveRepository::new(root("phase2-malformed"));
        let mut g = game();
        g["phase2"] = json!({"roomVariants": []});
        assert!(r.commit_game(0, g).is_err());
    }

    #[test]
    fn rejects_duplicate_and_malformed_phase2_rooms() {
        let valid = valid_phase2_game();
        assert!(validate_game(&valid).is_ok());

        let mut variant_without_visual = valid.clone();
        variant_without_visual["phase2"]["roomVariants"][0]
            .as_object_mut()
            .unwrap()
            .remove("visual");
        assert!(
            validate_game(&variant_without_visual).is_ok(),
            "room variants do not own visual state"
        );

        let mut duplicate_id = valid.clone();
        duplicate_id["phase2"]["roomVariants"] = json!([
            duplicate_id["phase2"]["roomVariants"][0].clone(),
            duplicate_id["phase2"]["roomVariants"][0].clone()
        ]);
        assert!(
            validate_game(&duplicate_id).is_err(),
            "duplicate variant id"
        );

        let mut master_id_collision = valid.clone();
        master_id_collision["phase2"]["roomVariants"][0]["id"] = json!("master-1");
        master_id_collision["phase2"]["floorPlacements"][0]["variantId"] = json!("master-1");
        assert!(
            validate_game(&master_id_collision).is_err(),
            "master/variant id collision"
        );

        let mutations: Vec<SnapshotMutation> = vec![
            (
                "invalid zone",
                Box::new(|g| g["phase2"]["roomMaster"]["cells"][0]["zone"] = json!("spa")),
            ),
            (
                "cell out of bounds",
                Box::new(|g| g["phase2"]["roomVariants"][0]["cells"][0]["x"] = json!(2)),
            ),
            (
                "duplicate cell",
                Box::new(|g| {
                    g["phase2"]["roomVariants"][0]["cells"][1] =
                        g["phase2"]["roomVariants"][0]["cells"][0].clone()
                }),
            ),
            (
                "invalid metrics",
                Box::new(|g| g["phase2"]["roomMaster"]["metrics"]["areaSquareMeters"] = json!(-1)),
            ),
            (
                "invalid override",
                Box::new(|g| g["phase2"]["roomVariants"][0]["overrides"] = json!(["pool"])),
            ),
        ];
        for (label, mutate) in mutations {
            let mut malformed = valid.clone();
            mutate(&mut malformed);
            assert!(validate_game(&malformed).is_err(), "{label}");
        }
    }

    #[test]
    fn phase2_metrics_match_typescript_half_rounding() {
        let metrics = json!({
            "areaSquareMeters": 23.75,
            "buildCostCents": 11_500_000,
            "suggestedRateCents": 79_500,
            "businessFitBps": 8_438
        });
        assert!(validate_metrics(&metrics, 95).is_ok());
    }

    #[test]
    fn rejects_malformed_phase2_openings() {
        let valid = valid_phase2_game();
        let mutations: Vec<SnapshotMutation> = vec![
            (
                "invalid side",
                Box::new(|g| {
                    g["phase2"]["roomMaster"]["openings"]["doors"][0]["side"] = json!("up")
                }),
            ),
            (
                "invalid kind",
                Box::new(|g| {
                    g["phase2"]["roomMaster"]["openings"]["doors"][0]["kind"] = json!("window")
                }),
            ),
            (
                "opening not on a room cell",
                Box::new(|g| g["phase2"]["roomMaster"]["openings"]["doors"][0]["y"] = json!(1)),
            ),
            (
                "opening not on boundary side",
                Box::new(|g| {
                    g["phase2"]["roomMaster"]["openings"]["doors"][0]["side"] = json!("east")
                }),
            ),
        ];
        for (label, mutate) in mutations {
            let mut malformed = valid.clone();
            mutate(&mut malformed);
            assert!(validate_game(&malformed).is_err(), "{label}");
        }
    }

    #[test]
    fn persists_phase2_design_visual_assets_and_errors() {
        let repository = SaveRepository::new(root("phase2-design-visuals"));
        let mut game = valid_phase2_game();
        game["phase2"]["designVisuals"] = json!({
            "status": "complete",
            "assets": [
                {"request": {"kind": "master"}, "assetPath": "/visuals/master.png"},
                {"request": {"kind": "focus", "focus": "bathroom"}, "assetPath": "/visuals/bathroom.png"}
            ],
            "errors": [
                {"request": {"kind": "focus", "focus": "view"}, "message": "网络暂不可用", "retryable": true}
            ]
        });

        repository.commit_game(0, game.clone()).unwrap();

        assert_eq!(repository.load_game("save-1").unwrap(), Some(game));
    }

    #[test]
    fn rejects_malformed_phase2_design_visual_metadata() {
        let mut valid = valid_phase2_game();
        valid["phase2"]["designVisuals"] = json!({
            "status": "complete",
            "assets": [
                {"request": {"kind": "master"}, "assetPath": "/visuals/master.png"},
                {"request": {"kind": "focus", "focus": "bathroom"}, "assetPath": "/visuals/bathroom.png"}
            ],
            "errors": []
        });
        let mutations: Vec<SnapshotMutation> = vec![
            (
                "duplicate master",
                Box::new(|g| {
                    let asset = g["phase2"]["designVisuals"]["assets"][0].clone();
                    g["phase2"]["designVisuals"]["assets"]
                        .as_array_mut()
                        .unwrap()
                        .push(asset);
                }),
            ),
            (
                "empty focus",
                Box::new(|g| {
                    g["phase2"]["designVisuals"]["assets"][1]["request"]["focus"] = json!("");
                }),
            ),
            (
                "duplicate focus",
                Box::new(|g| {
                    let asset = g["phase2"]["designVisuals"]["assets"][1].clone();
                    g["phase2"]["designVisuals"]["assets"]
                        .as_array_mut()
                        .unwrap()
                        .push(asset);
                }),
            ),
            (
                "unsafe asset",
                Box::new(|g| {
                    g["phase2"]["designVisuals"]["assets"][0]["assetPath"] =
                        json!("data:image/png;base64,x");
                }),
            ),
            (
                "too many focuses",
                Box::new(|g| {
                    for focus in ["lighting", "view", "extra"] {
                        g["phase2"]["designVisuals"]["assets"]
                            .as_array_mut()
                            .unwrap()
                            .push(json!({
                                "request": {"kind": "focus", "focus": focus},
                                "assetPath": format!("/visuals/{focus}.png")
                            }));
                    }
                }),
            ),
            (
                "invalid retryable error",
                Box::new(|g| {
                    g["phase2"]["designVisuals"]["errors"] = json!([{
                        "request": {"kind": "focus", "focus": "view"},
                        "message": "",
                        "retryable": false
                    }]);
                }),
            ),
        ];
        for (label, mutate) in mutations {
            let mut malformed = valid.clone();
            mutate(&mut malformed);
            assert!(validate_game(&malformed).is_err(), "{label}");
        }
    }

    #[test]
    fn rejects_malformed_phase2_corridor_templates() {
        let valid = valid_phase2_game();
        let mutations: Vec<SnapshotMutation> = vec![
            (
                "invalid corridor cell",
                Box::new(|g| g["phase2"]["corridorTemplate"]["corridor"][0]["x"] = json!("two")),
            ),
            (
                "non-positive slot dimensions",
                Box::new(|g| g["phase2"]["corridorTemplate"]["slots"][0]["width"] = json!(0)),
            ),
            (
                "slot out of bounds",
                Box::new(|g| g["phase2"]["corridorTemplate"]["slots"][0]["anchor"]["x"] = json!(5)),
            ),
            (
                "slot dimensions overflow",
                Box::new(|g| {
                    g["phase2"]["corridorTemplate"]["width"] = json!(i64::MAX);
                    g["phase2"]["corridorTemplate"]["slots"][0]["anchor"]["x"] =
                        json!(i64::MAX - 1);
                    g["phase2"]["corridorTemplate"]["slots"][0]["width"] = json!(2);
                }),
            ),
            (
                "duplicate slot id",
                Box::new(|g| {
                    let slot = g["phase2"]["corridorTemplate"]["slots"][0].clone();
                    g["phase2"]["corridorTemplate"]["slots"] = json!([slot.clone(), slot]);
                }),
            ),
            (
                "slot overlaps corridor",
                Box::new(|g| g["phase2"]["corridorTemplate"]["slots"][0]["anchor"]["x"] = json!(2)),
            ),
            (
                "slots overlap each other",
                Box::new(|g| {
                    let mut slot = g["phase2"]["corridorTemplate"]["slots"][0].clone();
                    slot["id"] = json!("north-2");
                    g["phase2"]["corridorTemplate"]["slots"]
                        .as_array_mut()
                        .unwrap()
                        .push(slot);
                }),
            ),
            (
                "slot not adjacent to corridor",
                Box::new(|g| {
                    g["phase2"]["corridorTemplate"]["slots"][0]["anchor"] = json!({"x": 4, "y": 3})
                }),
            ),
            (
                "disconnected corridor",
                Box::new(|g| {
                    g["phase2"]["corridorTemplate"]["corridor"]
                        .as_array_mut()
                        .unwrap()
                        .push(json!({"x": 5, "y": 5}))
                }),
            ),
            (
                "entrance does not bridge core and corridor",
                Box::new(|g| {
                    g["phase2"]["corridorTemplate"]["entrances"] = json!([{"x": 0, "y": 5}])
                }),
            ),
        ];
        for (label, mutate) in mutations {
            let mut malformed = valid.clone();
            mutate(&mut malformed);
            assert!(validate_game(&malformed).is_err(), "{label}");
        }
    }

    #[test]
    fn rejects_invalid_phase2_placements_and_transformed_fit() {
        let valid = valid_phase2_game();

        let mut unknown_slot = valid.clone();
        unknown_slot["phase2"]["floorPlacements"][0]["slotId"] = json!("unknown");
        assert!(
            validate_game(&unknown_slot).is_err(),
            "unknown template slot"
        );

        let mut oversized = valid.clone();
        oversized["phase2"]["corridorTemplate"]["slots"][0]["width"] = json!(1);
        assert!(
            validate_game(&oversized).is_err(),
            "unrotated footprint does not fit"
        );

        let mut rotated_oversized = valid.clone();
        rotated_oversized["phase2"]["corridorTemplate"]["slots"][0]["height"] = json!(1);
        rotated_oversized["phase2"]["floorPlacements"][0]["rotation"] = json!(90);
        assert!(
            validate_game(&rotated_oversized).is_err(),
            "rotated footprint does not fit"
        );
    }
    #[test]
    fn stale_revision_no_partial_writes() {
        let r = SaveRepository::new(root("stale"));
        r.commit_game(0, game()).unwrap();
        let mut g = game();
        g["revision"] = json!(2);
        assert!(r.commit_game(0, g).is_err());
        assert_eq!(r.load_game("save-1").unwrap(), Some(game()));
    }
    #[test]
    fn duplicate_report_rejected() {
        let r = SaveRepository::new(root("dup"));
        let mut g = game();
        g["reports"] = json!([{"day":1},{"day":1}]);
        assert!(r.commit_game(0, g).is_err());
    }
    #[test]
    fn rolls_back_when_room_insert_fails() {
        let r = SaveRepository::new(root("rollback"));
        let mut prior = blueprint_game(1, json!([]));
        prior["cashCents"] = json!(777);
        r.commit_game(0, prior.clone()).unwrap();
        let conn = r.open("save-1").unwrap();
        conn.execute_batch("CREATE TABLE trigger_probe(count INTEGER NOT NULL); INSERT INTO trigger_probe VALUES(0); CREATE TRIGGER fail_room BEFORE INSERT ON room_instances BEGIN UPDATE trigger_probe SET count=count+1; SELECT RAISE(ABORT, 'forced'); END;").unwrap();
        let mut next = blueprint_game(
            2,
            json!([{"id":"room-1","slotId":"slot-ne","roomBlueprintId":"bp-1","committedBuildCostCents":1}]),
        );
        next["cashCents"] = json!(888);
        let error = r.commit_game(1, next).unwrap_err();
        assert!(error.contains("migration.validation-failed"), "{error}");
        assert_eq!(
            load_game_from_connection(&conn, "save-1").unwrap(),
            Some(prior)
        );
    }
    #[test]
    fn invalid_save_id_rejected() {
        let r = SaveRepository::new(root("id"));
        assert!(r.load_game("../x").is_err());
    }
    #[test]
    fn concurrent_revision_commits_only_one_wins() {
        let root = root("race");
        let first = SaveRepository::new(root.clone());
        first.load_game("save-1").unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let a = SaveRepository::new(root.clone());
        let b = SaveRepository::new(root);
        let ga = game();
        let gb = game();
        let ba = barrier.clone();
        let ha = std::thread::spawn(move || {
            ba.wait();
            a.commit_game(0, ga)
        });
        let bb = barrier;
        let hb = std::thread::spawn(move || {
            bb.wait();
            b.commit_game(0, gb)
        });
        let results = [ha.join().unwrap(), hb.join().unwrap()];
        assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|r| r.is_err()).count(), 1);
    }
    #[test]
    fn rejects_rooms_without_matching_blueprint() {
        let r = SaveRepository::new(root("fk-validation"));
        let mut no_blueprint = game();
        no_blueprint["floor"]["rooms"] = json!([{"id":"r","slotId":"slot-ne","roomBlueprintId":"bp-1","committedBuildCostCents":1}]);
        assert!(r.commit_game(0, no_blueprint).is_err());
        let mismatch = blueprint_game(
            1,
            json!([{"id":"r","slotId":"slot-ne","roomBlueprintId":"other","committedBuildCostCents":1}]),
        );
        assert!(r.commit_game(0, mismatch).is_err());
    }

    #[test]
    fn rejects_unknown_slots_and_more_than_four_rooms() {
        let r = SaveRepository::new(root("slot-validation"));
        let invalid_slot = blueprint_game(
            1,
            json!([{"id":"r","slotId":"slot-center","roomBlueprintId":"bp-1","committedBuildCostCents":1}]),
        );
        assert!(r.commit_game(0, invalid_slot).is_err());

        let rooms = (0..5)
            .map(|i| json!({"id":format!("r-{i}"),"slotId":format!("slot-{i}"),"roomBlueprintId":"bp-1","committedBuildCostCents":1}))
            .collect::<Vec<_>>();
        let too_many = blueprint_game(1, json!(rooms));
        assert!(r.commit_game(0, too_many).is_err());
    }

    #[test]
    fn rejects_duplicate_room_instance_ids() {
        let r = SaveRepository::new(root("room-id-validation"));
        let duplicate = blueprint_game(
            1,
            json!([
                {"id":"same","slotId":"slot-ne","roomBlueprintId":"bp-1","committedBuildCostCents":1},
                {"id":"same","slotId":"slot-nw","roomBlueprintId":"bp-1","committedBuildCostCents":1}
            ]),
        );
        assert!(r.commit_game(0, duplicate).is_err());
    }

    #[test]
    fn rejects_ready_or_open_without_blueprint() {
        let r = SaveRepository::new(root("phase-blueprint-validation"));
        for phase in ["ready", "open"] {
            let mut g = game();
            g["phase"] = json!(phase);
            assert!(r.commit_game(0, g).is_err());
        }
    }

    #[test]
    fn rejects_zero_or_out_of_order_report_days() {
        let r = SaveRepository::new(root("report-day-validation"));
        let mut zero = game();
        zero["reports"] = json!([{"day":0}]);
        assert!(r.commit_game(0, zero).is_err());

        let mut out_of_order = game();
        out_of_order["currentDay"] = json!(3);
        out_of_order["reports"] = json!([{"day":1},{"day":3}]);
        out_of_order["latestReport"] = json!({"day":3});
        assert!(r.commit_game(0, out_of_order).is_err());
    }

    #[test]
    fn rejects_latest_report_that_does_not_match_current_day() {
        let r = SaveRepository::new(root("latest-report-validation"));
        let mut g = game();
        g["currentDay"] = json!(2);
        g["reports"] = json!([{"day":1},{"day":2}]);
        g["latestReport"] = json!({"day":1});
        assert!(r.commit_game(0, g).is_err());
    }

    #[test]
    fn rejects_corrupted_loaded_snapshot() {
        let r = SaveRepository::new(root("load-validation"));
        r.commit_game(0, game()).unwrap();
        let conn = r.open("save-1").unwrap();
        conn.execute(
            "UPDATE saves SET phase='open', latest_report_json=?1",
            [r#"{"day":1}"#],
        )
        .unwrap();
        assert!(r.load_game("save-1").is_err());
    }
    #[test]
    fn preserves_room_array_order() {
        let r = SaveRepository::new(root("order"));
        let rooms = json!([
            {"id":"r-ne","slotId":"slot-ne","roomBlueprintId":"bp-1","committedBuildCostCents":1},
            {"id":"r-nw","slotId":"slot-nw","roomBlueprintId":"bp-1","committedBuildCostCents":2}
        ]);
        let g = blueprint_game(1, rooms);
        r.commit_game(0, g.clone()).unwrap();
        assert_eq!(r.load_game("save-1").unwrap(), Some(g));
    }
    #[test]
    fn migrates_legacy_v1_schema() {
        let root = root("legacy");
        let r = SaveRepository::new(root.clone());
        let path = r.db_path("save-1");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES(1,'now'); CREATE TABLE saves(save_id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL,ruleset_version TEXT NOT NULL,revision INTEGER NOT NULL,phase TEXT NOT NULL,current_day INTEGER NOT NULL,cash_cents INTEGER NOT NULL,rate_cents INTEGER NOT NULL,latest_report_json TEXT,updated_at TEXT NOT NULL); CREATE TABLE room_blueprints(save_id TEXT PRIMARY KEY,blueprint_id TEXT NOT NULL,name TEXT NOT NULL,columns_count INTEGER NOT NULL,rows_count INTEGER NOT NULL,cells_json TEXT NOT NULL,metrics_json TEXT NOT NULL,visual_json TEXT NOT NULL); CREATE TABLE room_instances(save_id TEXT NOT NULL,instance_id TEXT NOT NULL,slot_id TEXT NOT NULL,blueprint_id TEXT NOT NULL,committed_build_cost_cents INTEGER NOT NULL,PRIMARY KEY(save_id,instance_id),UNIQUE(save_id,slot_id)); CREATE TABLE daily_reports(save_id TEXT NOT NULL,game_day INTEGER NOT NULL,report_json TEXT NOT NULL,PRIMARY KEY(save_id,game_day)); INSERT INTO saves VALUES('save-1',1,'prototype-v1',1,'design',0,100,10,NULL,'now'); INSERT INTO room_blueprints VALUES('save-1','bp-1','Suite',1,1,'[]','{}','{\"status\":\"idle\"}'); INSERT INTO room_instances VALUES('save-1','r-ne','slot-ne','bp-1',1); INSERT INTO room_instances VALUES('save-1','r-nw','slot-nw','bp-1',2);").unwrap();
        let loaded = r.load_game("save-1").unwrap().unwrap();
        assert_eq!(loaded["floor"]["rooms"][0]["id"], "r-ne");
        assert_eq!(loaded["floor"]["rooms"][1]["id"], "r-nw");
        let conn = r.open("save-1").unwrap();
        assert!(
            conn.query_row::<i64, _, _>(
                "SELECT count(*) FROM schema_migrations WHERE version=2",
                [],
                |x| x.get(0)
            )
            .unwrap()
                == 1
        );
        let g = blueprint_game(2, json!([]));
        r.commit_game(1, g).unwrap();
        assert!(
            conn.query_row::<i64, _, _>(
                "SELECT count(*) FROM pragma_table_info('room_instances') WHERE name='ordinal'",
                [],
                |x| x.get(0)
            )
            .unwrap()
                == 1
        );
    }
    #[test]
    fn rejects_duplicate_room_ordinals_at_database_layer() {
        let r = SaveRepository::new(root("ordinal-unique"));
        let g = blueprint_game(
            1,
            json!([
                {"id":"r-ne","slotId":"slot-ne","roomBlueprintId":"bp-1","committedBuildCostCents":1},
                {"id":"r-nw","slotId":"slot-nw","roomBlueprintId":"bp-1","committedBuildCostCents":2}
            ]),
        );
        r.commit_game(0, g).unwrap();
        let conn = r.open("save-1").unwrap();
        let err = conn
            .execute(
                "UPDATE room_instances SET ordinal=0 WHERE instance_id='r-nw'",
                [],
            )
            .unwrap_err();
        assert!(err.to_string().contains("UNIQUE"));
    }
    #[test]
    fn concurrent_legacy_open_migration_is_idempotent() {
        let root = root("legacy-race");
        let r = SaveRepository::new(root.clone());
        let path = r.db_path("save-1");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL); INSERT INTO schema_migrations VALUES(1,'now'); CREATE TABLE saves(save_id TEXT PRIMARY KEY,schema_version INTEGER NOT NULL,ruleset_version TEXT NOT NULL,revision INTEGER NOT NULL,phase TEXT NOT NULL,current_day INTEGER NOT NULL,cash_cents INTEGER NOT NULL,rate_cents INTEGER NOT NULL,latest_report_json TEXT,updated_at TEXT NOT NULL); CREATE TABLE room_blueprints(save_id TEXT PRIMARY KEY,blueprint_id TEXT NOT NULL,name TEXT NOT NULL,columns_count INTEGER NOT NULL,rows_count INTEGER NOT NULL,cells_json TEXT NOT NULL,metrics_json TEXT NOT NULL,visual_json TEXT NOT NULL); CREATE TABLE room_instances(save_id TEXT NOT NULL,instance_id TEXT NOT NULL,slot_id TEXT NOT NULL,blueprint_id TEXT NOT NULL,committed_build_cost_cents INTEGER NOT NULL,PRIMARY KEY(save_id,instance_id),UNIQUE(save_id,slot_id)); CREATE TABLE daily_reports(save_id TEXT NOT NULL,game_day INTEGER NOT NULL,report_json TEXT NOT NULL,PRIMARY KEY(save_id,game_day)); INSERT INTO saves VALUES('save-1',1,'prototype-v1',1,'design',0,100,10,NULL,'now'); INSERT INTO room_blueprints VALUES('save-1','bp-1','Suite',1,1,'[]','{}','{\"status\":\"idle\"}'); INSERT INTO room_instances VALUES('save-1','r-ne','slot-ne','bp-1',1);").unwrap();
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let a = SaveRepository::new(root.clone());
        let b = SaveRepository::new(root);
        let ba = barrier.clone();
        let ha = std::thread::spawn(move || {
            ba.wait();
            a.load_game("save-1")
        });
        let bb = barrier;
        let hb = std::thread::spawn(move || {
            bb.wait();
            b.load_game("save-1")
        });
        assert!(ha.join().unwrap().is_ok());
        assert!(hb.join().unwrap().is_ok());
    }

    fn phase4_fixture(raw: &str) -> Value {
        serde_json::from_str(raw).unwrap()
    }

    fn phase4_fixture_with_snapshot_slot(slot_id: &str) -> Value {
        let mut game = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        let mut snapshot = game["phase4"]["floorTemplates"]["template:facility:standard"].clone();
        snapshot["id"] = json!("template-snapshot:floor:03");
        snapshot["publicSpaceSlots"][0]["id"] = json!(slot_id);
        game["phase4"]["floorTemplates"]
            .as_object_mut()
            .unwrap()
            .insert("template-snapshot:floor:03".into(), snapshot);
        game
    }

    fn phase4_fixture_json_with_money_token(token: &str) -> String {
        let raw = include_str!("../tests/fixtures/phase4-valid.json");
        let original = "\"committedBuildCostCents\": 2500000";
        assert!(raw.contains(original));
        raw.replacen(
            original,
            &format!("\"committedBuildCostCents\": {token}"),
            1,
        )
    }

    fn phase4_fixture_with_money_token(token: &str) -> Value {
        phase4_fixture(&phase4_fixture_json_with_money_token(token))
    }

    const PHASE4_INVALID_FIXTURES: [(&str, &str); 10] = [
        ("bad-report-arithmetic.json", "经营报告算术不一致"),
        ("excessive-cells.json", "公共空间蓝图格子最多保留8192项"),
        ("excessive-floors.json", "楼层最多保留64层"),
        ("excessive-flow-events.json", "流动事件最多保留150项"),
        ("excessive-history.json", "设施历史最多保留30天"),
        ("excessive-items.json", "公共空间蓝图物品最多保留256项"),
        ("excessive-rooms.json", "客房最多保留240间"),
        ("forbidden-base64.json", "禁止持久化Base64数据"),
        ("forbidden-credential.json", "禁止持久化凭据"),
        ("unknown-catalog-reference.json", "目录引用无效"),
    ];

    const PHASE4_TASK2_ERROR_CLASSES: [(&str, &str); 8] = [
        ("duplicate-floor-id", "楼层编号重复"),
        ("unknown-room-floor", "客房楼层引用无效"),
        ("unsafe-money", "施工金额必须是安全整数"),
        ("wrong-containing-floor", "客房必须属于所在楼层"),
        ("malformed-record-key", "记录键必须是稳定 ID"),
        ("non-object-record-value", "公共空间蓝图结构无效"),
        ("record-key-id-mismatch", "记录键与编号不一致"),
        ("duplicate-record-value-id", "公共空间编号重复"),
    ];

    fn phase4_fixture_with_serialized_bytes(target: usize) -> Value {
        let mut game = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        let phase4 = game["phase4"].as_object_mut().unwrap();
        phase4.insert(
            "persistenceMetadata".into(),
            json!({
                "asciiKey": "ascii value",
                "非ASCII键": "中文值",
                "exponentNumber": phase4_fixture("1e2"),
            }),
        );
        let phase4_without_metadata = serde_json::to_vec(&Value::Object(
            phase4
                .iter()
                .filter(|(key, _)| key.as_str() != "persistenceMetadata")
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect(),
        ))
        .unwrap()
        .len();
        let metadata = phase4["persistenceMetadata"].as_object_mut().unwrap();
        let mut bytes = serde_json::to_vec(metadata).unwrap().len();
        bytes += phase4_without_metadata + ",\"persistenceMetadata\":".len() - 2;
        let mut index = 0usize;
        let mut last_key = String::new();

        loop {
            let key = format!("{}{index:06}", "界".repeat(122));
            let empty_entry_bytes = serde_json::to_vec(&json!({key.clone(): ""})).unwrap().len()
                - 2
                + usize::from(!metadata.is_empty());
            let full_entry_bytes = empty_entry_bytes + 4_096;
            if bytes + full_entry_bytes > target {
                break;
            }
            metadata.insert(key.clone(), json!("!".repeat(4_096)));
            bytes += full_entry_bytes;
            last_key = key;
            index += 1;
        }

        let key = format!("{}{index:06}", "界".repeat(122));
        let empty_entry_bytes =
            serde_json::to_vec(&json!({key.clone(): ""})).unwrap().len() - 2 + 1;
        let mut deficit = target - bytes;
        if deficit > 0 && deficit < empty_entry_bytes {
            let prior = metadata[&last_key].as_str().unwrap();
            metadata.insert(
                last_key.clone(),
                json!(&prior[..prior.len() - (empty_entry_bytes - deficit)]),
            );
            bytes -= empty_entry_bytes - deficit;
            deficit = target - bytes;
        }
        if deficit > 0 {
            metadata.insert(key, json!("!".repeat(deficit - empty_entry_bytes)));
        }

        let actual = serde_json::to_vec(&game["phase4"]).unwrap().len();
        if actual != target {
            let metadata = game["phase4"]["persistenceMetadata"]
                .as_object_mut()
                .unwrap();
            let calibration_key = last_key.clone();
            let prior = metadata[&calibration_key].as_str().unwrap();
            let calibrated = if actual > target {
                prior[..prior.len() - (actual - target)].to_string()
            } else {
                format!("{prior}{}", "!".repeat(target - actual))
            };
            metadata.insert(calibration_key, json!(calibrated));
        }
        assert_eq!(serde_json::to_vec(&game["phase4"]).unwrap().len(), target);
        game
    }

    #[test]
    fn phase4_shared_fixture_manifest_is_exact() {
        let directory =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/phase4-invalid");
        let mut actual = fs::read_dir(directory)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .collect::<Vec<_>>();
        actual.sort();
        assert_eq!(
            actual,
            PHASE4_INVALID_FIXTURES
                .iter()
                .map(|(name, _)| name.to_string())
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn phase4_shared_invalid_fixtures_have_stable_error_classes() {
        let directory =
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/phase4-invalid");
        for (name, expected) in PHASE4_INVALID_FIXTURES {
            let mut invalid = phase4_fixture(&fs::read_to_string(directory.join(name)).unwrap());
            invalid["revision"] = json!(1);
            let repository = SaveRepository::new(root(&format!("phase4-task8-{name}")));
            let error = match repository.commit_game(0, invalid) {
                Err(error) => error,
                Ok(()) => panic!("{name} unexpectedly accepted"),
            };
            assert!(
                error.contains(expected),
                "{name} expected {expected}, got {error}"
            );
        }
    }

    #[test]
    fn phase4_retains_task2_validation_regressions() {
        type Phase4Mutation = (&'static str, Box<dyn Fn(&mut Value)>);
        let cases: Vec<Phase4Mutation> = vec![
            (
                "duplicate-floor-id",
                Box::new(|value| value["phase4"]["floors"][1]["id"] = json!("floor:01")),
            ),
            (
                "unknown-room-floor",
                Box::new(|value| {
                    value["phase4"]["floors"][4]["rooms"][0]["floorId"] = json!("floor:unknown")
                }),
            ),
            (
                "unsafe-money",
                Box::new(|value| {
                    value["phase4"]["floors"][4]["rooms"][0]["committedBuildCostCents"] =
                        json!(JS_MAX_SAFE_INTEGER + 1)
                }),
            ),
            (
                "wrong-containing-floor",
                Box::new(|value| {
                    value["phase4"]["floors"][4]["rooms"][0]["floorId"] = json!("floor:06")
                }),
            ),
            (
                "malformed-record-key",
                Box::new(|value| {
                    let record = value["phase4"]["publicSpaces"].as_object_mut().unwrap();
                    let first = record.values().next().unwrap().clone();
                    record.insert("Bad Key".into(), first);
                }),
            ),
            (
                "non-object-record-value",
                Box::new(|value| {
                    let record = value["phase4"]["spaceBlueprints"].as_object_mut().unwrap();
                    let key = record.keys().next().unwrap().clone();
                    record.insert(key, json!("bad"));
                }),
            ),
            (
                "record-key-id-mismatch",
                Box::new(|value| {
                    let record = value["phase4"]["facilities"].as_object_mut().unwrap();
                    record.values_mut().next().unwrap()["id"] = json!("facility:mismatch");
                }),
            ),
            (
                "duplicate-record-value-id",
                Box::new(|value| {
                    let record = value["phase4"]["publicSpaces"].as_object_mut().unwrap();
                    let keys = record.keys().take(2).cloned().collect::<Vec<_>>();
                    let first_id = record[&keys[0]]["id"].clone();
                    record.get_mut(&keys[1]).unwrap()["id"] = first_id;
                }),
            ),
        ];
        assert_eq!(
            cases.iter().map(|(name, _)| *name).collect::<Vec<_>>(),
            PHASE4_TASK2_ERROR_CLASSES
                .iter()
                .map(|(name, _)| *name)
                .collect::<Vec<_>>()
        );
        for ((name, mutate), (_, expected)) in cases.into_iter().zip(PHASE4_TASK2_ERROR_CLASSES) {
            let mut invalid = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
            mutate(&mut invalid);
            let error = validate_game(&invalid).err().unwrap();
            assert!(
                error.contains(expected),
                "{name} expected {expected}, got {error}"
            );
        }
    }

    #[test]
    fn phase4_enforces_exact_serialized_json_size() {
        for (target, rejected) in [
            (PHASE4_MAX_JSON_BYTES - 1, false),
            (PHASE4_MAX_JSON_BYTES, false),
            (PHASE4_MAX_JSON_BYTES + 1, true),
            (8_630_528, true),
        ] {
            let game = phase4_fixture_with_serialized_bytes(target);
            let result = validate_game(&game);
            if rejected {
                assert!(
                    result.err().unwrap().contains("JSON超过大小限制"),
                    "{target} bytes"
                );
            } else {
                assert!(result.is_ok(), "{target} bytes");
            }
        }
    }

    #[test]
    fn phase4_rejects_graph_cardinality_and_item_containment_mutations() {
        type Phase4Mutation = (&'static str, &'static str, Box<dyn Fn(&mut Value)>);
        let cases: Vec<Phase4Mutation> = vec![
            (
                "duplicate-public-space-placement",
                "公共空间放置重复",
                Box::new(|value| {
                    let mut spaces = value["phase4"]["publicSpaces"]
                        .as_object_mut()
                        .unwrap()
                        .values_mut()
                        .take(2)
                        .collect::<Vec<_>>();
                    let floor_id = spaces[0]["floorId"].clone();
                    let placement_id = spaces[0]["localPlacementId"].clone();
                    spaces[1]["floorId"] = floor_id;
                    spaces[1]["localPlacementId"] = placement_id;
                }),
            ),
            (
                "duplicate-facility-ownership",
                "设施公共空间引用重复",
                Box::new(|value| {
                    let mut facilities = value["phase4"]["facilities"]
                        .as_object_mut()
                        .unwrap()
                        .values_mut()
                        .take(2)
                        .collect::<Vec<_>>();
                    let instance_id = facilities[0]["publicSpaceInstanceId"].clone();
                    let type_id = facilities[0]["type"].clone();
                    facilities[1]["publicSpaceInstanceId"] = instance_id;
                    facilities[1]["type"] = type_id;
                }),
            ),
            (
                "duplicate-permitted-type",
                "允许设施类型无效",
                Box::new(|value| {
                    let permitted = value["phase4"]["floorTemplates"]["template:facility:standard"]
                        ["publicSpaceSlots"][0]["permittedTypes"]
                        .as_array_mut()
                        .unwrap();
                    permitted.push(permitted[0].clone());
                }),
            ),
            (
                "item-outside-blueprint",
                "公共空间物品超出蓝图",
                Box::new(|value| {
                    let blueprint =
                        &mut value["phase4"]["spaceBlueprints"]["space-blueprint:all-day-dining"];
                    blueprint["placedItems"][0]["x"] = json!(127);
                    blueprint["placedItems"][0]["width"] = json!(2);
                }),
            ),
        ];
        for (name, expected, mutate) in cases {
            let mut invalid = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
            mutate(&mut invalid);
            let error = validate_game(&invalid).err().unwrap();
            assert!(
                error.contains(expected),
                "{name} expected {expected}, got {error}"
            );
        }

        let mut boundary = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        let blueprint =
            &mut boundary["phase4"]["spaceBlueprints"]["space-blueprint:all-day-dining"];
        blueprint["placedItems"][0]["x"] = json!(127);
        blueprint["placedItems"][0]["y"] = json!(63);
        assert!(validate_game(&boundary).is_ok());
    }

    #[test]
    fn phase4_validates_optional_public_space_slot_geometry() {
        type SlotMutation = (&'static str, &'static str, Box<dyn Fn(&mut Value)>);
        let cases: Vec<SlotMutation> = vec![
            (
                "partial",
                "公共空间槽位几何必须完整",
                Box::new(|slot| slot["anchorX"] = json!(0)),
            ),
            (
                "string",
                "公共空间槽位几何必须是安全整数",
                Box::new(|slot| {
                    slot["anchorX"] = json!("0");
                    slot["anchorY"] = json!(0);
                    slot["width"] = json!(1);
                    slot["height"] = json!(1);
                }),
            ),
            (
                "fraction",
                "公共空间槽位几何必须是安全整数",
                Box::new(|slot| {
                    slot["anchorX"] = json!(0.5);
                    slot["anchorY"] = json!(0);
                    slot["width"] = json!(1);
                    slot["height"] = json!(1);
                }),
            ),
            (
                "negative",
                "公共空间槽位几何必须是安全整数",
                Box::new(|slot| {
                    slot["anchorX"] = json!(-1);
                    slot["anchorY"] = json!(0);
                    slot["width"] = json!(1);
                    slot["height"] = json!(1);
                }),
            ),
            (
                "zero-size",
                "公共空间槽位几何必须是安全整数",
                Box::new(|slot| {
                    slot["anchorX"] = json!(0);
                    slot["anchorY"] = json!(0);
                    slot["width"] = json!(0);
                    slot["height"] = json!(1);
                }),
            ),
            (
                "out-of-bounds",
                "公共空间槽位几何超出楼层模板",
                Box::new(|slot| {
                    slot["anchorX"] = json!(23);
                    slot["anchorY"] = json!(23);
                    slot["width"] = json!(2);
                    slot["height"] = json!(2);
                }),
            ),
        ];
        for (name, expected, mutate) in cases {
            let mut invalid = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
            let slot = &mut invalid["phase4"]["floorTemplates"]["template:facility:standard"]
                ["publicSpaceSlots"][0];
            mutate(slot);
            let error = validate_game(&invalid).err().unwrap();
            assert!(
                error.contains(expected),
                "{name} expected {expected}, got {error}"
            );
        }

        let legacy = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        assert!(validate_game(&legacy).is_ok());
        let mut boundary = legacy;
        let slot = &mut boundary["phase4"]["floorTemplates"]["template:facility:standard"]
            ["publicSpaceSlots"][0];
        slot["anchorX"] = json!(16);
        slot["anchorY"] = json!(15);
        slot["width"] = json!(8);
        slot["height"] = json!(9);
        assert!(validate_game(&boundary).is_ok());
    }

    #[test]
    fn phase4_extension_ids_and_credential_keys_match_browser() {
        let mut extension = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        extension["phase4"]["persistenceMetadata"] =
            json!({"futureId": "Future ID", "futureIds": ["Future ID"]});
        assert!(validate_game(&extension).is_ok());

        for field in [
            "password",
            "secret",
            "credential",
            "apiKey",
            "APIKey",
            "ACCESS_TOKEN",
            "Api-Key",
        ] {
            let mut invalid = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
            invalid["phase4"]["persistenceMetadata"] = json!({field: "fixture"});
            let error = validate_game(&invalid).err().unwrap();
            assert!(error.contains("禁止持久化凭据"), "{field}: {error}");
        }
    }

    #[test]
    fn phase4_deep_extension_tree_has_a_controlled_error() {
        let mut nested = Value::Null;
        for _ in 0..100 {
            nested = json!({"child": nested});
        }
        let error = validate_phase4_tree(&nested).err().unwrap();
        assert!(error.contains("JSON嵌套过深"), "{error}");
    }

    #[test]
    fn phase4_rejects_catalog_and_envelope_mutations_with_stable_classes() {
        type Phase4Mutation = (&'static str, &'static str, Box<dyn Fn(&mut Value)>);
        let cases: Vec<Phase4Mutation> = vec![
            (
                "unknown-developed-offering",
                "目录引用无效",
                Box::new(|value| {
                    value["phase4"]["facilities"]["facility:floor:02:all-day-dining"]
                        ["developedOfferingIds"] = json!(["dish:unknown"]);
                }),
            ),
            (
                "unknown-signature-in-developed",
                "目录引用无效",
                Box::new(|value| {
                    let facility =
                        &mut value["phase4"]["facilities"]["facility:floor:02:all-day-dining"];
                    facility["developedOfferingIds"] = json!(["dish:unknown"]);
                    facility["policy"]["signatureOfferingId"] = json!("dish:unknown");
                }),
            ),
            (
                "wrong-offering-type",
                "目录引用无效",
                Box::new(|value| {
                    value["phase4"]["facilities"]["facility:floor:02:all-day-dining"]
                        ["developedOfferingIds"] = json!(["drink:cloud-negroni"]);
                }),
            ),
            (
                "wrong-signature-group",
                "目录引用无效",
                Box::new(|value| {
                    let facility =
                        &mut value["phase4"]["facilities"]["facility:floor:02:all-day-dining"];
                    facility["developedOfferingIds"] = json!(["drink:cloud-negroni"]);
                    facility["policy"]["signatureOfferingId"] = json!("drink:cloud-negroni");
                }),
            ),
            (
                "unknown-menu",
                "目录引用无效",
                Box::new(|value| {
                    value["phase4"]["facilities"]["facility:floor:02:all-day-dining"]
                        ["menuSelection"]["menuStructureId"] = json!("menu:unknown");
                }),
            ),
            (
                "incompatible-menu",
                "目录引用无效",
                Box::new(|value| {
                    value["phase4"]["facilities"]["facility:floor:02:all-day-dining"]
                        ["menuSelection"]["menuStructureId"] = json!("menu:bar-classics");
                }),
            ),
            (
                "unknown-positioning",
                "目录引用无效",
                Box::new(|value| {
                    value["phase4"]["facilities"]["facility:floor:02:all-day-dining"]["policy"]
                        ["positioningId"] = json!("positioning:unknown");
                }),
            ),
            (
                "unknown-price",
                "目录引用无效",
                Box::new(|value| {
                    value["phase4"]["facilities"]["facility:floor:02:all-day-dining"]["policy"]
                        ["priceBandId"] = json!("price-band:unknown");
                }),
            ),
            (
                "unknown-opening",
                "目录引用无效",
                Box::new(|value| {
                    value["phase4"]["facilities"]["facility:floor:02:all-day-dining"]["policy"]
                        ["openingPolicyId"] = json!("opening-policy:unknown");
                }),
            ),
            (
                "wrong-policy-group",
                "目录引用无效",
                Box::new(|value| {
                    let policy = &mut value["phase4"]["facilities"]
                        ["facility:floor:02:all-day-dining"]["policy"];
                    policy["positioningId"] = json!("positioning:restorative-wellness");
                    policy["openingPolicyId"] = json!("opening-policy:appointment-daily");
                }),
            ),
            (
                "65-templates",
                "楼层模板最多保留64项",
                Box::new(|value| {
                    let source =
                        value["phase4"]["floorTemplates"]["template:entrance:standard"].clone();
                    let record = value["phase4"]["floorTemplates"].as_object_mut().unwrap();
                    for index in 0..60 {
                        let id = format!("template:extra:{index:02}");
                        let mut template = source.clone();
                        template["id"] = json!(id);
                        record.insert(id, template);
                    }
                }),
            ),
            (
                "zero-template-columns",
                "楼层模板列数必须是安全整数",
                Box::new(|value| {
                    value["phase4"]["floorTemplates"]["template:guest:dense-ring"]["columns"] =
                        json!(0);
                }),
            ),
            (
                "oversized-template-rows",
                "楼层模板行数必须是安全整数",
                Box::new(|value| {
                    value["phase4"]["floorTemplates"]["template:guest:dense-ring"]["rows"] =
                        json!(513);
                }),
            ),
            (
                "wrong-cell-area",
                "楼层模板单元面积无效",
                Box::new(|value| {
                    value["phase4"]["floorTemplates"]["template:guest:dense-ring"]
                        ["cellAreaSquareMeters"] = json!(2);
                }),
            ),
            (
                "fractional-anchor",
                "客房横坐标必须是安全整数",
                Box::new(|value| {
                    value["phase4"]["floorTemplates"]["template:guest:dense-ring"]
                        ["roomPlacements"][0]["anchorX"] = json!(0.5);
                }),
            ),
            (
                "negative-anchor",
                "客房纵坐标必须是安全整数",
                Box::new(|value| {
                    value["phase4"]["floorTemplates"]["template:guest:dense-ring"]
                        ["roomPlacements"][0]["anchorY"] = json!(-1);
                }),
            ),
            (
                "zero-placement-width",
                "客房宽度必须是安全整数",
                Box::new(|value| {
                    value["phase4"]["floorTemplates"]["template:guest:dense-ring"]
                        ["roomPlacements"][0]["width"] = json!(0);
                }),
            ),
            (
                "placement-out-of-bounds",
                "客房放置超出楼层模板",
                Box::new(|value| {
                    let placement = &mut value["phase4"]["floorTemplates"]
                        ["template:guest:dense-ring"]["roomPlacements"][0];
                    placement["anchorX"] = json!(23);
                    placement["width"] = json!(2);
                }),
            ),
            (
                "blank-blueprint-name",
                "公共空间名称文本无效",
                Box::new(|value| {
                    value["phase4"]["spaceBlueprints"]["space-blueprint:bar"]["name"] = json!(" ");
                }),
            ),
            (
                "long-blueprint-name",
                "公共空间名称文本无效",
                Box::new(|value| {
                    value["phase4"]["spaceBlueprints"]["space-blueprint:bar"]["name"] =
                        json!("中".repeat(257));
                }),
            ),
        ];
        for (name, expected, mutate) in cases {
            let mut invalid = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
            mutate(&mut invalid);
            let error = validate_game(&invalid).err().unwrap();
            assert!(
                error.contains(expected),
                "{name} expected {expected}, got {error}"
            );
        }
    }

    #[test]
    fn phase4_scalar_and_forbidden_rules_match_browser() {
        let raw = include_str!("../tests/fixtures/phase4-valid.json");
        let exponent = raw.replacen("\"columns\": 24", "\"columns\": 1e2", 1);
        assert!(validate_game(&phase4_fixture(&exponent)).is_ok());
        assert_eq!(
            phase4_int(&phase4_fixture("1e2"), "测试数值", 0, JS_MAX_SAFE_INTEGER).unwrap(),
            100
        );
        assert!(phase4_int(
            &json!(9_007_199_254_740_992_i64),
            "测试数值",
            0,
            JS_MAX_SAFE_INTEGER
        )
        .is_err());
        assert!(phase4_int(
            &phase4_fixture("9.007199254740992e15"),
            "测试数值",
            0,
            JS_MAX_SAFE_INTEGER
        )
        .is_err());
        assert!(validate_phase4_money(&json!(9_007_199_254_740_992_i64)).is_err());
        assert!(validate_phase4_money(&phase4_fixture("9.007199254740992e15")).is_err());

        let mut unicode = phase4_fixture(raw);
        unicode["phase4"]["persistenceMetadata"] = json!({"description": "😀".repeat(3_000)});
        assert!(validate_game(&unicode).is_ok());
        unicode["phase4"]["persistenceMetadata"] = json!({"description": "中".repeat(4_097)});
        assert!(validate_game(&unicode)
            .err()
            .unwrap()
            .contains("文本超过长度限制"));

        let mut unicode_key = phase4_fixture(raw);
        unicode_key["phase4"]["persistenceMetadata"] = json!({"😀".repeat(100): "fixture"});
        assert!(validate_game(&unicode_key).is_ok());
        unicode_key["phase4"]["persistenceMetadata"] = json!({"中".repeat(129): "fixture"});
        assert!(validate_game(&unicode_key)
            .err()
            .unwrap()
            .contains("字段名超过长度限制"));

        for credential in [
            "password=hunter2",
            "secret: fixture",
            "credential=fixture",
            "api-key: fixture",
            "access_token=fixture",
            "Bearer abcdefghijklmnop",
            "secret phrase then secret=fixture",
        ] {
            let mut invalid = phase4_fixture(raw);
            invalid["phase4"]["persistenceMetadata"] = json!({"description": credential});
            assert!(
                validate_game(&invalid)
                    .err()
                    .unwrap()
                    .contains("禁止持久化凭据"),
                "{credential}"
            );
        }
        for description in ["notsecret=fixture", "Bearer short"] {
            let mut valid = phase4_fixture(raw);
            valid["phase4"]["persistenceMetadata"] = json!({"description": description});
            assert!(validate_game(&valid).is_ok(), "{description}");
        }
        for field in ["password", "secret", "credential", "apiKey", "access_token"] {
            let mut invalid = phase4_fixture(raw);
            invalid["phase4"]["persistenceMetadata"] = json!({field: "fixture"});
            assert!(
                validate_game(&invalid)
                    .err()
                    .unwrap()
                    .contains("禁止持久化凭据"),
                "{field}"
            );
        }
        let mut internal_padding = phase4_fixture(raw);
        internal_padding["phase4"]["persistenceMetadata"] =
            json!({"description": format!("{}={}", "A".repeat(64), "A".repeat(64))});
        assert!(validate_game(&internal_padding).is_ok());
        internal_padding["phase4"]["persistenceMetadata"] = json!({"description": "A".repeat(128)});
        assert!(validate_game(&internal_padding)
            .err()
            .unwrap()
            .contains("禁止持久化Base64数据"));
    }

    #[test]
    fn phase4_extension_numbers_match_browser_safe_range() {
        for number in [
            json!(9_007_199_254_740_992_i64),
            json!(-9_007_199_254_740_992_i64),
        ] {
            let mut invalid = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
            invalid["phase4"]["persistenceMetadata"] = json!({"futureScore": number});
            let error = validate_game(&invalid).err().unwrap();
            assert!(error.contains("数字必须是有限安全 JSON 数字"), "{error}");
        }

        let mut valid = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        valid["phase4"]["persistenceMetadata"] = json!({
            "positiveFraction": 0.5,
            "negativeFraction": -0.5,
            "maximum": JS_MAX_SAFE_INTEGER,
            "minimum": -JS_MAX_SAFE_INTEGER,
        });
        assert!(validate_game(&valid).is_ok());
    }

    #[test]
    fn phase4_compact_credential_values_match_browser() {
        for credential in [
            "apiKey=fixture",
            "apikey: fixture",
            "accessToken=fixture",
            "refreshToken: fixture",
            "authToken=fixture",
            "privateKey: fixture",
            "clientSecret=fixture",
        ] {
            let mut invalid = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
            invalid["phase4"]["persistenceMetadata"] = json!({"description": credential});
            let error = validate_game(&invalid).err().unwrap();
            assert!(error.contains("禁止持久化凭据"), "{credential}: {error}");
        }
    }

    #[test]
    fn phase4_bearer_credential_boundaries_match_browser() {
        for credential in [
            "Bearer abcdefghijkl",
            "Bearer\tabcdefghijkl",
            "Bearer\nabcdefghijkl",
            "Bearer   abcdefghijkl",
            "prefix Bearer abcdefghijkl",
            "Bearer abcdef+/=-xy",
        ] {
            let mut invalid = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
            invalid["phase4"]["persistenceMetadata"] = json!({"description": credential});
            let error = validate_game(&invalid).err().unwrap();
            assert!(error.contains("禁止持久化凭据"), "{credential:?}: {error}");
        }

        for description in [
            "xBearer abcdefghijkl",
            "_Bearer abcdefghijkl",
            "Bearer abcdefghijk",
            "Bearer   short",
        ] {
            let mut valid = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
            valid["phase4"]["persistenceMetadata"] = json!({"description": description});
            assert!(validate_game(&valid).is_ok(), "{description:?}");
        }
    }

    #[test]
    fn phase4_facility_nullable_fields_and_extension_money_match_browser() {
        for field in ["policy", "menuSelection"] {
            let mut invalid = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
            invalid["phase4"]["facilities"]
                .as_object_mut()
                .unwrap()
                .values_mut()
                .next()
                .unwrap()
                .as_object_mut()
                .unwrap()
                .remove(field);
            let error = validate_game(&invalid).err().unwrap();
            assert!(error.contains("结构无效"), "{field}: {error}");
        }

        for value in [json!(-1), json!(9_007_199_254_740_992_i64), json!(0.5)] {
            let mut invalid = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
            invalid["phase4"]["facilities"]
                .as_object_mut()
                .unwrap()
                .values_mut()
                .next()
                .unwrap()["futureCostCents"] = value;
            let error = validate_game(&invalid).err().unwrap();
            assert!(error.contains("futureCostCents必须是安全整数"), "{error}");
        }
    }

    #[test]
    fn phase4_only_maps_report_errors_to_report_arithmetic() {
        let mut invalid_loan = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        invalid_loan["operations"]["loans"] = json!([{
            "id": "loan:bad", "principalCents": 1, "outstandingCents": 0,
            "dailyInterestBps": 1, "minimumPaymentCents": 1
        }]);
        let loan_error = validate_game(&invalid_loan).err().unwrap();
        assert!(loan_error.contains("经营存档"), "{loan_error}");
        assert!(!loan_error.contains("经营报告算术"), "{loan_error}");

        let mut incomplete_segments =
            phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        incomplete_segments["operations"]["dailyReports"][0]["segments"]
            .as_array_mut()
            .unwrap()
            .pop();
        let segment_error = validate_game(&incomplete_segments).err().unwrap();
        assert!(segment_error.contains("经营存档"), "{segment_error}");
        assert!(!segment_error.contains("经营报告算术"), "{segment_error}");

        let mut invalid_report =
            phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        invalid_report["operations"]["dailyReports"][0]["revenueCents"] = json!(1_501);
        assert!(validate_game(&invalid_report)
            .err()
            .unwrap()
            .contains("经营报告算术不一致"));

        let mut invalid_aggregate =
            phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        invalid_aggregate["operations"]["weeklyReports"][0]["revenueCents"] = json!(10_501);
        let aggregate_error = validate_game(&invalid_aggregate).err().unwrap();
        assert!(
            aggregate_error.contains("经营报告算术不一致"),
            "{aggregate_error}"
        );
        assert!(
            !aggregate_error.starts_with("内容规模存档"),
            "{aggregate_error}"
        );

        let mut partial_categories =
            phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        partial_categories["operations"]["weeklyReports"][0]
            .as_object_mut()
            .unwrap()
            .remove("publicSpaceRevenueCents");
        let category_error = validate_game(&partial_categories).err().unwrap();
        assert!(
            category_error.contains("经营报告算术不一致"),
            "{category_error}"
        );
        assert!(
            !category_error.starts_with("内容规模存档"),
            "{category_error}"
        );

        let mut invalid_interest =
            phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        invalid_interest["operations"]["dailyReports"][0]["loanInterestCents"] = json!(11);
        let interest_error = validate_game(&invalid_interest).err().unwrap();
        assert!(
            !interest_error.starts_with("内容规模存档"),
            "{interest_error}"
        );
    }

    #[test]
    fn phase4_rejects_facility_history_after_current_day() {
        let game = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        let phase4 = game["phase4"].clone();
        let mut earlier_game = game.clone();
        earlier_game["currentDay"] = json!(29);

        assert!(validate_phase4(&phase4, &earlier_game)
            .err()
            .unwrap()
            .contains("设施历史日期无效"));
    }

    #[test]
    fn phase4_minimal_commits_and_reopens_shared_fixture() {
        let repository = SaveRepository::new(root("phase4-shared"));
        let mut game = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        let expected_phase4 = game["phase4"].clone();
        game["revision"] = json!(1);

        repository.commit_game(0, game).unwrap();

        let loaded = repository.load_game("phase4-shared").unwrap().unwrap();
        assert_eq!(loaded["phase4"], expected_phase4);
    }

    #[test]
    fn phase4_commits_and_reopens_public_space_in_snapshot_only_slot() {
        let repository = SaveRepository::new(root("phase4-snapshot-slot"));
        let mut game = phase4_fixture_with_snapshot_slot("space:snapshot-only");
        game["phase4"]["publicSpaces"]["public-space:floor:03:space:01"]["localPlacementId"] =
            json!("space:snapshot-only");
        game["revision"] = json!(1);

        repository.commit_game(0, game.clone()).unwrap();

        assert_eq!(repository.load_game("phase4-shared").unwrap(), Some(game));
    }

    #[test]
    fn phase4_rejects_public_space_excluded_by_applied_snapshot() {
        let mut game = phase4_fixture_with_snapshot_slot("space:01");
        game["phase4"]["floorTemplates"]["template-snapshot:floor:03"]["publicSpaceSlots"][0]
            ["permittedTypes"] = json!(["spa"]);

        assert!(validate_game(&game)
            .err()
            .unwrap()
            .contains("公共空间槽位或类型引用无效"));
    }

    #[test]
    fn phase4_minimal_rejects_null_envelope_like_browser_validation() {
        let mut invalid = game();
        invalid["phase4"] = Value::Null;

        assert!(validate_game(&invalid).is_err());
    }

    #[test]
    fn phase4_minimal_rejects_malformed_stable_ids() {
        let mut invalid = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        invalid["phase4"]["building"]["templateId"] = json!("Building Template");

        let error = validate_game(&invalid).err().unwrap();
        assert!(error.contains("稳定 ID"));
    }

    #[test]
    fn phase4_minimal_accepts_safe_integral_float_and_exponent_money() {
        for token in ["2500000.0", "25e5", "9007199254740991.0"] {
            let fixture = phase4_fixture_with_money_token(token);
            assert!(
                validate_game(&fixture).is_ok(),
                "safe money token rejected: {token}"
            );
        }
    }

    #[test]
    fn phase4_minimal_rejects_fractional_and_unsafe_money() {
        for token in [
            "2500000.5",
            "-1.0",
            "9007199254740992",
            "9007199254740992.0",
            "1e400",
        ] {
            let raw = phase4_fixture_json_with_money_token(token);
            match serde_json::from_str::<Value>(&raw) {
                Ok(fixture) => {
                    let error = validate_game(&fixture).err().unwrap();
                    assert!(
                        error.contains("施工金额必须是安全整数"),
                        "unexpected error for {token}: {error}"
                    );
                }
                Err(error) => assert_eq!(token, "1e400", "unexpected parse error: {error}"),
            }
        }
    }

    #[test]
    fn phase4_invalid_update_leaves_prior_revision_unchanged() {
        let repository = SaveRepository::new(root("phase4-rollback"));
        let mut valid = phase4_fixture(include_str!("../tests/fixtures/phase4-valid.json"));
        valid["revision"] = json!(1);
        repository.commit_game(0, valid.clone()).unwrap();

        for (name, raw, expected) in [
            (
                "unknown-catalog",
                include_str!("../tests/fixtures/phase4-invalid/unknown-catalog-reference.json"),
                "目录引用无效",
            ),
            (
                "bad-report",
                include_str!("../tests/fixtures/phase4-invalid/bad-report-arithmetic.json"),
                "经营报告算术不一致",
            ),
            (
                "excessive-flow",
                include_str!("../tests/fixtures/phase4-invalid/excessive-flow-events.json"),
                "流动事件最多保留150项",
            ),
            (
                "credential",
                include_str!("../tests/fixtures/phase4-invalid/forbidden-credential.json"),
                "禁止持久化凭据",
            ),
        ] {
            let mut invalid = phase4_fixture(raw);
            invalid["revision"] = json!(2);
            let error = repository.commit_game(1, invalid).unwrap_err();
            assert!(error.contains(expected), "{name}: {error}");
            assert_eq!(
                repository.load_game("phase4-shared").unwrap(),
                Some(valid.clone()),
                "{name} changed persisted state"
            );
        }
    }

    #[test]
    fn failed_phase4_initialization_preserves_raw_phase3_row() {
        let repository = SaveRepository::new(root("phase4-legacy-rollback"));
        let mut legacy = full_operations_game();
        legacy["revision"] = json!(1);
        legacy.as_object_mut().unwrap().remove("phase4");
        repository.commit_game(0, legacy).unwrap();

        let conn = repository.open("save-1").unwrap();
        let raw_before = conn
            .query_row(
                "SELECT revision, phase4_json, quote(operations_json), quote(phase2_json), quote(latest_report_json) FROM saves WHERE save_id='save-1'",
                [],
                |row| Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                )),
            )
            .unwrap();
        assert_eq!(raw_before.0, 1);
        assert!(raw_before.1.is_none());

        let mut invalid = phase4_fixture(include_str!(
            "../tests/fixtures/phase4-invalid/unknown-catalog-reference.json"
        ));
        invalid["revision"] = json!(2);
        invalid["saveId"] = json!("save-1");
        assert!(repository.commit_game(1, invalid).is_err());

        let raw_after = conn
            .query_row(
                "SELECT revision, phase4_json, quote(operations_json), quote(phase2_json), quote(latest_report_json) FROM saves WHERE save_id='save-1'",
                [],
                |row| Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                )),
            )
            .unwrap();
        assert_eq!(raw_after, raw_before);
    }

    #[test]
    fn current_v7_rejects_a_missing_phase4_schema_without_repair() {
        let repository = SaveRepository::new(root("phase4-old-schema"));
        repository.commit_game(0, game()).unwrap();
        let conn = repository.open("save-1").unwrap();
        conn.execute_batch(
            "DROP TRIGGER saves_phase4_json_insert_check;
             DROP TRIGGER saves_phase4_json_update_check;
             ALTER TABLE saves DROP COLUMN phase4_json;
             DELETE FROM schema_migrations WHERE version=6;",
        )
        .unwrap();
        drop(conn);

        let before = fs::read(repository.db_path("save-1")).unwrap();
        let error = repository.load_game("save-1").unwrap_err();
        assert!(error.contains("migration.validation-failed"), "{error}");
        assert_eq!(fs::read(repository.db_path("save-1")).unwrap(), before);
        let conn = Connection::open(repository.db_path("save-1")).unwrap();
        assert_eq!(
            conn.query_row::<i64, _, _>(
                "SELECT count(*) FROM pragma_table_info('saves') WHERE name='phase4_json'",
                [],
                |row| row.get(0),
            )
            .unwrap(),
            0
        );
    }

    #[test]
    fn current_v7_rejects_an_unconstrained_phase4_column_without_repair() {
        let repository = SaveRepository::new(root("phase4-unconstrained-schema"));
        repository.commit_game(0, game()).unwrap();
        let conn = repository.open("save-1").unwrap();
        conn.execute_batch(
            "DROP TRIGGER IF EXISTS saves_phase4_json_insert_check;
             DROP TRIGGER IF EXISTS saves_phase4_json_update_check;
             ALTER TABLE saves DROP COLUMN phase4_json;
             ALTER TABLE saves ADD COLUMN phase4_json TEXT;",
        )
        .unwrap();
        drop(conn);

        let before = fs::read(repository.db_path("save-1")).unwrap();
        let error = repository.open("save-1").unwrap_err();
        assert!(error.contains("migration.validation-failed"), "{error}");
        assert_eq!(fs::read(repository.db_path("save-1")).unwrap(), before);
    }
}
