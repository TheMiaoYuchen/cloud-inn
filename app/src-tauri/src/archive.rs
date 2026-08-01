//! Strict manifest validation and deterministic writing for `.cloudinn` archives.

use crate::reliability::{normalize_display_name, validate_current_save_database};
use crate::save_validation::{validate_asset_registry, validate_single_save_identity};
use rusqlite::{params, Connection, OpenFlags, TransactionBehavior};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

pub(crate) const ARCHIVE_FORMAT_VERSION: u32 = 1;
pub(crate) const MAX_ARCHIVE_ENTRIES: usize = 10_000;
pub(crate) const MAX_MANIFEST_BYTES: usize = 64 * 1_024 * 1_024;
pub(crate) const MAX_ARCHIVE_BYTES: u64 = 2 * 1_024 * 1_024 * 1_024;

const DATABASE_PATH: &str = "save/save.sqlite3";
const MANIFEST_PATH: &str = "manifest.json";
const ASSET_PREFIX: &str = "assets/sha256/";
const MAX_SAVE_ID_LENGTH: usize = 128;
const MAX_DISPLAY_NAME_BYTES: usize = 160;
const MAX_APPLICATION_VERSION_BYTES: usize = 128;
const MAX_RULESET_VERSION_BYTES: usize = 128;
const IMPORT_TOKEN_TTL_MS: i64 = 15 * 60 * 1_000;
const MAX_COMPRESSION_RATIO: u64 = 100;

/// The versioned manifest written as the only metadata entry in a `.cloudinn`
/// archive.  Payload deliberately excludes `manifest.json` itself.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArchiveManifest {
    pub(crate) format_version: u32,
    pub(crate) application_version: String,
    pub(crate) schema_version: u32,
    pub(crate) ruleset_version: String,
    pub(crate) source_save_id: String,
    pub(crate) display_name: String,
    pub(crate) created_at_ms: i64,
    pub(crate) payload: Vec<ArchivePayloadRecord>,
    pub(crate) referenced_assets: Vec<ArchiveAssetMetadata>,
}

/// One regular archive payload entry.  Its digest and length are rechecked
/// while streaming the ZIP entry; the manifest never describes directories.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArchivePayloadRecord {
    pub(crate) path: String,
    pub(crate) sha256: String,
    pub(crate) byte_length: u64,
}

/// The asset registry metadata which must agree exactly with its payload
/// record.  The content-addressed path is also checked against the digest.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ArchiveAssetMetadata {
    pub(crate) asset_id: String,
    pub(crate) path: String,
    pub(crate) mime_type: String,
    pub(crate) byte_length: u64,
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) sha256: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ArchiveManifestError {
    ManifestTooLarge,
    InvalidManifest,
    UnsupportedVersion,
    InvalidMetadata,
    TooManyPayloadEntries,
    ArchiveTooLarge,
    InvalidPayloadPath,
    DuplicatePayloadPath,
    CaseCollision,
    InvalidPayloadDigest,
    InvalidPayloadLength,
    MissingDatabasePayload,
    InvalidAssetMetadata,
    AssetPayloadMismatch,
}

impl fmt::Display for ArchiveManifestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::ManifestTooLarge => "归档清单超过限制",
            Self::InvalidManifest => "归档清单无效",
            Self::UnsupportedVersion => "归档版本不受支持",
            Self::InvalidMetadata => "归档元数据无效",
            Self::TooManyPayloadEntries => "归档文件数量超过限制",
            Self::ArchiveTooLarge => "归档内容超过限制",
            Self::InvalidPayloadPath => "归档载荷路径无效",
            Self::DuplicatePayloadPath => "归档包含重复载荷路径",
            Self::CaseCollision => "归档载荷路径大小写冲突",
            Self::InvalidPayloadDigest => "归档载荷摘要无效",
            Self::InvalidPayloadLength => "归档载荷长度无效",
            Self::MissingDatabasePayload => "归档缺少存档数据库",
            Self::InvalidAssetMetadata => "归档资源元数据无效",
            Self::AssetPayloadMismatch => "归档资源与载荷不一致",
        })
    }
}

impl std::error::Error for ArchiveManifestError {}

/// A filesystem payload selected from the already-frozen export snapshot.
/// `archive_path` is independently matched to the manifest before any bytes
/// are copied, so source filesystem names never become ZIP entry names.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ArchivePayloadFile {
    pub(crate) archive_path: String,
    pub(crate) source_path: PathBuf,
}

/// A sealed temporary archive.  Callers may validate it again and atomically
/// rename it to a player-selected destination, but must never append to it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct TemporaryArchive {
    pub(crate) path: PathBuf,
    pub(crate) sha256: String,
    pub(crate) byte_length: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ArchiveWriteError {
    InvalidManifest,
    PayloadPathMismatch,
    UnsafePayloadSource,
    PayloadIntegrityMismatch,
    ArchiveTooLarge,
    DestinationExists,
    Io,
}

impl fmt::Display for ArchiveWriteError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidManifest => "归档清单无效",
            Self::PayloadPathMismatch => "归档载荷与清单不匹配",
            Self::UnsafePayloadSource => "归档载荷来源无效",
            Self::PayloadIntegrityMismatch => "归档载荷校验失败",
            Self::ArchiveTooLarge => "归档内容超过限制",
            Self::DestinationExists => "目标文件已存在",
            Self::Io => "归档写入失败",
        })
    }
}

impl std::error::Error for ArchiveWriteError {}

/// Publishes a sealed archive to a native-dialog-selected destination without
/// replacing any existing filesystem object. A synced sibling is hard-linked
/// into place, giving regular files atomic no-clobber semantics on macOS.
pub(crate) fn publish_archive_to_new_destination(
    temporary: &TemporaryArchive,
    destination: &Path,
) -> Result<(), ArchiveWriteError> {
    if destination.extension().and_then(|value| value.to_str()) != Some("cloudinn") {
        return Err(ArchiveWriteError::Io);
    }
    let parent = destination.parent().ok_or(ArchiveWriteError::Io)?;
    require_plain_directory(parent)?;
    if destination.exists() || fs::symlink_metadata(destination).is_ok() {
        return Err(ArchiveWriteError::DestinationExists);
    }
    let source_metadata =
        fs::symlink_metadata(&temporary.path).map_err(|_| ArchiveWriteError::Io)?;
    if source_metadata.file_type().is_symlink()
        || !source_metadata.is_file()
        || source_metadata.len() != temporary.byte_length
        || sha256_file(&temporary.path)? != temporary.sha256
    {
        return Err(ArchiveWriteError::PayloadIntegrityMismatch);
    }
    let sibling = parent.join(format!(
        ".cloud-inn-publish-{}.cloudinn",
        uuid::Uuid::new_v4()
    ));
    let outcome = (|| {
        let mut source = File::open(&temporary.path).map_err(|_| ArchiveWriteError::Io)?;
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&sibling)
            .map_err(|_| ArchiveWriteError::Io)?;
        std::io::copy(&mut source, &mut output).map_err(|_| ArchiveWriteError::Io)?;
        output.sync_all().map_err(|_| ArchiveWriteError::Io)?;
        drop(output);
        if fs::metadata(&sibling)
            .map_err(|_| ArchiveWriteError::Io)?
            .len()
            != temporary.byte_length
            || sha256_file(&sibling)? != temporary.sha256
        {
            return Err(ArchiveWriteError::PayloadIntegrityMismatch);
        }
        fs::hard_link(&sibling, destination).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                ArchiveWriteError::DestinationExists
            } else {
                ArchiveWriteError::Io
            }
        })?;
        sync_directory(parent)?;
        Ok(())
    })();
    let _ = fs::remove_file(&sibling);
    outcome
}

/// Player-safe metadata returned after an import has been copied into
/// app-owned staging and completely validated. The filesystem path is never
/// exposed; the opaque token is the only handle accepted by the consume step.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportInspection {
    pub(crate) token: String,
    pub(crate) source_save_id: String,
    pub(crate) display_name: String,
    pub(crate) schema_version: u32,
    pub(crate) ruleset_version: String,
    pub(crate) archive_sha256: String,
    pub(crate) archive_byte_length: u64,
    pub(crate) expires_at_ms: i64,
}

/// Native-only result of consuming an inspection token. Callers must import
/// from `extracted_save_directory`; they must not reopen the player-selected
/// archive. The directory contains only `save.sqlite3` and validated assets.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ConsumedImport {
    pub(crate) manifest: ArchiveManifest,
    pub(crate) extracted_save_directory: PathBuf,
    pub(crate) archive_sha256: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ImportedSave {
    pub(crate) save_id: String,
    pub(crate) display_name: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ArchiveImportError {
    InvalidSelection,
    ArchiveTooLarge,
    InvalidArchive,
    UnsupportedArchive,
    UnsafeEntry,
    IntegrityMismatch,
    InvalidDatabase,
    InsufficientSpace,
    InvalidToken,
    ExpiredToken,
    Io,
}

impl fmt::Display for ArchiveImportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidSelection => "所选归档无效",
            Self::ArchiveTooLarge => "归档内容超过限制",
            Self::InvalidArchive => "归档结构无效",
            Self::UnsupportedArchive => "归档格式不受支持",
            Self::UnsafeEntry => "归档包含不安全的文件",
            Self::IntegrityMismatch => "归档内容校验失败",
            Self::InvalidDatabase => "归档存档数据库无效",
            Self::InsufficientSpace => "可用磁盘空间不足",
            Self::InvalidToken => "导入确认已失效",
            Self::ExpiredToken => "导入确认已过期",
            Self::Io => "无法处理导入归档",
        })
    }
}

impl std::error::Error for ArchiveImportError {}

#[derive(Clone, Debug)]
struct StagedInspection {
    manifest: ArchiveManifest,
    archive_path: PathBuf,
    extracted_save_directory: PathBuf,
    sha256: String,
    byte_length: u64,
    expires_at_ms: i64,
}

/// Session-local import coordinator. A new instance creates a new native
/// session boundary, so tokens cannot survive process restart or be replayed
/// against another window/session.
pub(crate) struct ArchiveImportService {
    app_root: PathBuf,
    staging_root: PathBuf,
    session_id: String,
    inspections: Mutex<BTreeMap<String, StagedInspection>>,
}

impl ArchiveImportService {
    pub(crate) fn new(app_root: &Path) -> Result<Self, ArchiveImportError> {
        let staging_root = app_root.join("import-staging");
        ensure_plain_directory(app_root)?;
        ensure_plain_directory(&staging_root)?;
        Ok(Self {
            app_root: app_root.to_path_buf(),
            staging_root,
            session_id: uuid::Uuid::new_v4().to_string(),
            inspections: Mutex::new(BTreeMap::new()),
        })
    }

    /// Copies a dialog-selected regular file into immutable app-owned staging,
    /// then validates the exact copied bytes. No player path is retained.
    pub(crate) fn inspect_import(
        &self,
        selected_path: &Path,
        now_ms: i64,
    ) -> Result<ImportInspection, ArchiveImportError> {
        if now_ms < 0 {
            return Err(ArchiveImportError::InvalidSelection);
        }
        self.remove_expired(now_ms);
        let selected_metadata = fs::symlink_metadata(selected_path)
            .map_err(|_| ArchiveImportError::InvalidSelection)?;
        if selected_metadata.file_type().is_symlink()
            || !selected_metadata.is_file()
            || selected_metadata.len() == 0
            || selected_metadata.len() > MAX_ARCHIVE_BYTES
        {
            return Err(ArchiveImportError::InvalidSelection);
        }

        let token_id = uuid::Uuid::new_v4().to_string();
        let token = format!("{}.{token_id}", self.session_id);
        let token_directory = self.staging_root.join(&token_id);
        fs::create_dir(&token_directory).map_err(|_| ArchiveImportError::Io)?;
        let archive_path = token_directory.join("package.cloudinn");
        let extracted_save_directory = token_directory.join("payload");
        let outcome = (|| {
            let (sha256, byte_length) = copy_selected_archive(selected_path, &archive_path)?;
            if byte_length != selected_metadata.len() {
                return Err(ArchiveImportError::IntegrityMismatch);
            }
            fs::create_dir(&extracted_save_directory).map_err(|_| ArchiveImportError::Io)?;
            let manifest = validate_and_extract_archive(&archive_path, &extracted_save_directory)?;
            validate_imported_database(&manifest, &extracted_save_directory)?;
            let expires_at_ms = now_ms
                .checked_add(IMPORT_TOKEN_TTL_MS)
                .ok_or(ArchiveImportError::InvalidSelection)?;
            let staged = StagedInspection {
                manifest: manifest.clone(),
                archive_path,
                extracted_save_directory,
                sha256: sha256.clone(),
                byte_length,
                expires_at_ms,
            };
            self.inspections
                .lock()
                .map_err(|_| ArchiveImportError::Io)?
                .insert(token.clone(), staged);
            Ok(ImportInspection {
                token,
                source_save_id: manifest.source_save_id,
                display_name: manifest.display_name,
                schema_version: manifest.schema_version,
                ruleset_version: manifest.ruleset_version,
                archive_sha256: sha256,
                archive_byte_length: byte_length,
                expires_at_ms,
            })
        })();
        if outcome.is_err() {
            let _ = fs::remove_dir_all(&token_directory);
        }
        outcome
    }

    /// Invalidates the token before rechecking its staged archive, making the
    /// operation single-use even when validation or later import work fails.
    pub(crate) fn consume_import(
        &self,
        token: &str,
        now_ms: i64,
    ) -> Result<ConsumedImport, ArchiveImportError> {
        if !token.starts_with(&self.session_id) {
            return Err(ArchiveImportError::InvalidToken);
        }
        let staged = self
            .inspections
            .lock()
            .map_err(|_| ArchiveImportError::Io)?
            .remove(token)
            .ok_or(ArchiveImportError::InvalidToken)?;
        if now_ms > staged.expires_at_ms {
            let _ = fs::remove_dir_all(staged.archive_path.parent().unwrap_or(&self.staging_root));
            return Err(ArchiveImportError::ExpiredToken);
        }
        let token_directory = staged
            .archive_path
            .parent()
            .unwrap_or(&self.staging_root)
            .to_path_buf();
        let outcome = (|| {
            let metadata = fs::symlink_metadata(&staged.archive_path)
                .map_err(|_| ArchiveImportError::IntegrityMismatch)?;
            if metadata.file_type().is_symlink()
                || !metadata.is_file()
                || metadata.len() != staged.byte_length
                || sha256_file_import(&staged.archive_path)? != staged.sha256
            {
                return Err(ArchiveImportError::IntegrityMismatch);
            }
            let manifest = validate_archive_without_extracting(&staged.archive_path)?;
            if manifest != staged.manifest {
                return Err(ArchiveImportError::IntegrityMismatch);
            }
            validate_imported_database(&manifest, &staged.extracted_save_directory)?;
            Ok(ConsumedImport {
                manifest,
                extracted_save_directory: staged.extracted_save_directory,
                archive_sha256: staged.sha256,
            })
        })();
        if outcome.is_err() {
            let _ = fs::remove_dir_all(token_directory);
        }
        outcome
    }

    /// Re-keys a consumed, validated payload and publishes it as a fresh save.
    /// The destination is reserved with `create_dir`, assets move first and the
    /// database moves last, so the save catalog never observes a partial save
    /// and no existing directory can be replaced or merged.
    pub(crate) fn import_as_new_save(
        &self,
        consumed: ConsumedImport,
        display_name: Option<&str>,
        now_ms: i64,
    ) -> Result<ImportedSave, ArchiveImportError> {
        if now_ms < 0
            || !consumed
                .extracted_save_directory
                .starts_with(&self.staging_root)
        {
            return Err(ArchiveImportError::InvalidToken);
        }
        let chosen_name =
            normalize_display_name(display_name.unwrap_or(consumed.manifest.display_name.as_str()))
                .map_err(|_| ArchiveImportError::InvalidDatabase)?;
        let new_save_id = uuid::Uuid::new_v4().to_string();
        rekey_imported_database(
            &consumed.extracted_save_directory,
            &consumed.manifest.source_save_id,
            &new_save_id,
            &chosen_name,
            now_ms,
        )?;

        let saves_root = self.app_root.join("saves");
        ensure_plain_directory(&saves_root)?;
        let destination = saves_root.join(&new_save_id);
        fs::create_dir(&destination).map_err(|error| {
            if error.kind() == std::io::ErrorKind::AlreadyExists {
                ArchiveImportError::InvalidToken
            } else {
                ArchiveImportError::Io
            }
        })?;
        let result = publish_import_payload(
            &consumed.extracted_save_directory,
            &destination,
            &new_save_id,
        );
        if let Err(error) = result {
            let _ = fs::remove_dir(&destination);
            return Err(error);
        }
        if let Some(token_directory) = consumed.extracted_save_directory.parent() {
            let _ = fs::remove_file(token_directory.join("package.cloudinn"));
            let _ = fs::remove_dir(&consumed.extracted_save_directory);
            let _ = fs::remove_dir(token_directory);
        }
        Ok(ImportedSave {
            save_id: new_save_id,
            display_name: chosen_name,
        })
    }

    fn remove_expired(&self, now_ms: i64) {
        let Ok(mut inspections) = self.inspections.lock() else {
            return;
        };
        let expired = inspections
            .iter()
            .filter(|(_, staged)| now_ms > staged.expires_at_ms)
            .map(|(token, _)| token.clone())
            .collect::<Vec<_>>();
        for token in expired {
            if let Some(staged) = inspections.remove(&token) {
                let _ =
                    fs::remove_dir_all(staged.archive_path.parent().unwrap_or(&self.staging_root));
            }
        }
    }
}

fn ensure_plain_directory(path: &Path) -> Result<(), ArchiveImportError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(ArchiveImportError::Io)
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|_| ArchiveImportError::Io)?;
            let metadata = fs::symlink_metadata(path).map_err(|_| ArchiveImportError::Io)?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(ArchiveImportError::Io);
            }
            Ok(())
        }
        Err(_) => Err(ArchiveImportError::Io),
    }
}

fn copy_selected_archive(
    selected_path: &Path,
    staged_path: &Path,
) -> Result<(String, u64), ArchiveImportError> {
    let mut source = File::open(selected_path).map_err(|_| ArchiveImportError::InvalidSelection)?;
    let opened = source
        .metadata()
        .map_err(|_| ArchiveImportError::InvalidSelection)?;
    if !opened.is_file() || opened.len() == 0 || opened.len() > MAX_ARCHIVE_BYTES {
        return Err(ArchiveImportError::InvalidSelection);
    }
    let mut destination = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(staged_path)
        .map_err(|_| ArchiveImportError::Io)?;
    let mut hasher = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1_024];
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|_| ArchiveImportError::InvalidSelection)?;
        if read == 0 {
            break;
        }
        total = total
            .checked_add(u64::try_from(read).map_err(|_| ArchiveImportError::ArchiveTooLarge)?)
            .ok_or(ArchiveImportError::ArchiveTooLarge)?;
        if total > MAX_ARCHIVE_BYTES {
            return Err(ArchiveImportError::ArchiveTooLarge);
        }
        hasher.update(&buffer[..read]);
        destination
            .write_all(&buffer[..read])
            .map_err(|_| ArchiveImportError::Io)?;
    }
    if total != opened.len() {
        return Err(ArchiveImportError::IntegrityMismatch);
    }
    destination.sync_all().map_err(|_| ArchiveImportError::Io)?;
    drop(destination);
    let mut permissions = fs::metadata(staged_path)
        .map_err(|_| ArchiveImportError::Io)?
        .permissions();
    permissions.set_readonly(true);
    fs::set_permissions(staged_path, permissions).map_err(|_| ArchiveImportError::Io)?;
    Ok((lower_hex(&hasher.finalize()), total))
}

fn validate_and_extract_archive(
    archive_path: &Path,
    extracted_save_directory: &Path,
) -> Result<ArchiveManifest, ArchiveImportError> {
    let manifest = read_and_validate_archive_manifest(archive_path)?;
    let declared_bytes = manifest
        .payload
        .iter()
        .try_fold(0_u64, |total, payload| {
            total.checked_add(payload.byte_length)
        })
        .ok_or(ArchiveImportError::ArchiveTooLarge)?;
    let required_bytes = declared_bytes
        .checked_mul(2)
        .and_then(|value| value.checked_add(64 * 1_024 * 1_024))
        .ok_or(ArchiveImportError::ArchiveTooLarge)?;
    let available =
        fs2::available_space(extracted_save_directory).map_err(|_| ArchiveImportError::Io)?;
    if available < required_bytes {
        return Err(ArchiveImportError::InsufficientSpace);
    }
    scan_archive_payloads(archive_path, &manifest, Some(extracted_save_directory))?;
    Ok(manifest)
}

fn validate_archive_without_extracting(
    archive_path: &Path,
) -> Result<ArchiveManifest, ArchiveImportError> {
    let manifest = read_and_validate_archive_manifest(archive_path)?;
    scan_archive_payloads(archive_path, &manifest, None)?;
    Ok(manifest)
}

fn read_and_validate_archive_manifest(
    archive_path: &Path,
) -> Result<ArchiveManifest, ArchiveImportError> {
    let metadata = fs::symlink_metadata(archive_path).map_err(|_| ArchiveImportError::Io)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_ARCHIVE_BYTES
    {
        return Err(ArchiveImportError::InvalidArchive);
    }
    let file = File::open(archive_path).map_err(|_| ArchiveImportError::Io)?;
    let mut archive = ZipArchive::new(file).map_err(|_| ArchiveImportError::InvalidArchive)?;
    if archive.is_empty() || archive.len() > MAX_ARCHIVE_ENTRIES + 1 {
        return Err(ArchiveImportError::InvalidArchive);
    }
    let mut manifest_index = None;
    let mut folded_names = BTreeSet::new();
    for index in 0..archive.len() {
        let entry = archive
            .by_index_raw(index)
            .map_err(|_| ArchiveImportError::InvalidArchive)?;
        validate_zip_entry_metadata(&entry)?;
        let name = strict_entry_name(entry.name_raw())?;
        if !folded_names.insert(name.to_ascii_lowercase()) {
            return Err(ArchiveImportError::UnsafeEntry);
        }
        if name == MANIFEST_PATH {
            manifest_index = Some(index);
        }
    }
    let index = manifest_index.ok_or(ArchiveImportError::InvalidArchive)?;
    let entry = archive
        .by_index(index)
        .map_err(|_| ArchiveImportError::InvalidArchive)?;
    if entry.size() > u64::try_from(MAX_MANIFEST_BYTES).unwrap_or(u64::MAX) {
        return Err(ArchiveImportError::InvalidArchive);
    }
    let mut bytes = Vec::with_capacity(usize::try_from(entry.size()).unwrap_or(0));
    entry
        .take(u64::try_from(MAX_MANIFEST_BYTES).unwrap_or(u64::MAX) + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ArchiveImportError::InvalidArchive)?;
    parse_manifest(&bytes).map_err(|error| match error {
        ArchiveManifestError::UnsupportedVersion => ArchiveImportError::UnsupportedArchive,
        ArchiveManifestError::ArchiveTooLarge | ArchiveManifestError::ManifestTooLarge => {
            ArchiveImportError::ArchiveTooLarge
        }
        _ => ArchiveImportError::InvalidArchive,
    })
}

fn validate_zip_entry_metadata<R: Read + ?Sized>(
    entry: &zip::read::ZipFile<'_, R>,
) -> Result<(), ArchiveImportError> {
    if entry.encrypted() || entry.is_dir() || entry.compression() != CompressionMethod::Stored {
        return Err(ArchiveImportError::UnsupportedArchive);
    }
    if let Some(mode) = entry.unix_mode() {
        let file_type = mode & 0o170000;
        if file_type != 0 && file_type != 0o100000 {
            return Err(ArchiveImportError::UnsafeEntry);
        }
    }
    if entry.size() == 0 || entry.size() > MAX_ARCHIVE_BYTES {
        return Err(ArchiveImportError::ArchiveTooLarge);
    }
    let compressed = entry.compressed_size();
    if compressed == 0 || entry.size() > compressed.saturating_mul(MAX_COMPRESSION_RATIO) {
        return Err(ArchiveImportError::ArchiveTooLarge);
    }
    Ok(())
}

fn strict_entry_name(raw: &[u8]) -> Result<&str, ArchiveImportError> {
    if !raw.is_ascii() {
        return Err(ArchiveImportError::UnsafeEntry);
    }
    let name = std::str::from_utf8(raw).map_err(|_| ArchiveImportError::UnsafeEntry)?;
    validate_safe_relative_path(name).map_err(|_| ArchiveImportError::UnsafeEntry)?;
    Ok(name)
}

fn scan_archive_payloads(
    archive_path: &Path,
    manifest: &ArchiveManifest,
    extraction_root: Option<&Path>,
) -> Result<(), ArchiveImportError> {
    let expected = manifest
        .payload
        .iter()
        .map(|record| (record.path.as_str(), record))
        .collect::<BTreeMap<_, _>>();
    let file = File::open(archive_path).map_err(|_| ArchiveImportError::Io)?;
    let mut archive = ZipArchive::new(file).map_err(|_| ArchiveImportError::InvalidArchive)?;
    if archive.len() != expected.len() + 1 {
        return Err(ArchiveImportError::InvalidArchive);
    }
    let mut seen = BTreeSet::new();
    for index in 0..archive.len() {
        let mut entry = archive
            .by_index(index)
            .map_err(|_| ArchiveImportError::InvalidArchive)?;
        validate_zip_entry_metadata(&entry)?;
        let name = strict_entry_name(entry.name_raw())?.to_owned();
        if name == MANIFEST_PATH {
            continue;
        }
        let record = expected
            .get(name.as_str())
            .ok_or(ArchiveImportError::InvalidArchive)?;
        if !seen.insert(name.clone()) || entry.size() != record.byte_length {
            return Err(ArchiveImportError::IntegrityMismatch);
        }
        let mut destination = match extraction_root {
            Some(root) => Some(create_import_payload_file(root, &name)?),
            None => None,
        };
        let mut hasher = Sha256::new();
        let mut total = 0_u64;
        let mut buffer = [0_u8; 64 * 1_024];
        loop {
            let read = entry
                .read(&mut buffer)
                .map_err(|_| ArchiveImportError::InvalidArchive)?;
            if read == 0 {
                break;
            }
            total = total
                .checked_add(u64::try_from(read).map_err(|_| ArchiveImportError::ArchiveTooLarge)?)
                .ok_or(ArchiveImportError::ArchiveTooLarge)?;
            if total > record.byte_length {
                return Err(ArchiveImportError::IntegrityMismatch);
            }
            hasher.update(&buffer[..read]);
            if let Some(file) = destination.as_mut() {
                file.write_all(&buffer[..read])
                    .map_err(|_| ArchiveImportError::Io)?;
            }
        }
        if total != record.byte_length || lower_hex(&hasher.finalize()) != record.sha256 {
            return Err(ArchiveImportError::IntegrityMismatch);
        }
        if let Some(file) = destination {
            file.sync_all().map_err(|_| ArchiveImportError::Io)?;
        }
    }
    if seen.len() != expected.len() {
        return Err(ArchiveImportError::InvalidArchive);
    }
    Ok(())
}

fn create_import_payload_file(root: &Path, archive_path: &str) -> Result<File, ArchiveImportError> {
    let relative = if archive_path == DATABASE_PATH {
        PathBuf::from("save.sqlite3")
    } else {
        PathBuf::from(archive_path)
    };
    let destination = root.join(relative);
    let parent = destination
        .parent()
        .ok_or(ArchiveImportError::UnsafeEntry)?;
    fs::create_dir_all(parent).map_err(|_| ArchiveImportError::Io)?;
    let canonical_root = fs::canonicalize(root).map_err(|_| ArchiveImportError::Io)?;
    let canonical_parent = fs::canonicalize(parent).map_err(|_| ArchiveImportError::Io)?;
    if !canonical_parent.starts_with(&canonical_root) {
        return Err(ArchiveImportError::UnsafeEntry);
    }
    OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(destination)
        .map_err(|_| ArchiveImportError::Io)
}

fn validate_imported_database(
    manifest: &ArchiveManifest,
    save_directory: &Path,
) -> Result<(), ArchiveImportError> {
    let database_path = save_directory.join("save.sqlite3");
    let connection = Connection::open_with_flags(
        &database_path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    connection
        .execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;")
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    validate_current_save_database(&connection).map_err(|_| ArchiveImportError::InvalidDatabase)?;
    validate_single_save_identity(&connection, &manifest.source_save_id, false)
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    validate_asset_registry(&connection, save_directory)
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    let schema_version = connection
        .query_row("PRAGMA user_version", [], |row| row.get::<_, i64>(0))
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    let ruleset_version: String = connection
        .query_row(
            "SELECT ruleset_version FROM saves WHERE save_id=?1",
            [&manifest.source_save_id],
            |row| row.get(0),
        )
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    if u32::try_from(schema_version).ok() != Some(manifest.schema_version)
        || ruleset_version != manifest.ruleset_version
    {
        return Err(ArchiveImportError::InvalidDatabase);
    }
    validate_manifest_assets_against_database(&connection, manifest)?;
    Ok(())
}

fn validate_manifest_assets_against_database(
    connection: &Connection,
    manifest: &ArchiveManifest,
) -> Result<(), ArchiveImportError> {
    let mut statement = connection
        .prepare(
            "SELECT asset_id,relative_path,mime_type,byte_length,width,height,sha256
             FROM assets ORDER BY asset_id",
        )
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    let rows = statement
        .query_map([], |row| {
            Ok(ArchiveAssetMetadata {
                asset_id: row.get(0)?,
                path: row.get(1)?,
                mime_type: row.get(2)?,
                byte_length: row.get::<_, i64>(3)?.try_into().unwrap_or(u64::MAX),
                width: row.get::<_, i64>(4)?.try_into().unwrap_or(u32::MAX),
                height: row.get::<_, i64>(5)?.try_into().unwrap_or(u32::MAX),
                sha256: row.get(6)?,
            })
        })
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    let mut recorded = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    recorded.sort_unstable_by(|left, right| left.asset_id.cmp(&right.asset_id));
    let mut declared = manifest.referenced_assets.clone();
    declared.sort_unstable_by(|left, right| left.asset_id.cmp(&right.asset_id));
    if recorded != declared {
        return Err(ArchiveImportError::InvalidDatabase);
    }
    Ok(())
}

fn rekey_imported_database(
    save_directory: &Path,
    source_save_id: &str,
    new_save_id: &str,
    display_name: &str,
    now_ms: i64,
) -> Result<(), ArchiveImportError> {
    let database_path = save_directory.join("save.sqlite3");
    let metadata =
        fs::symlink_metadata(&database_path).map_err(|_| ArchiveImportError::InvalidDatabase)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(ArchiveImportError::InvalidDatabase);
    }
    let mut connection = Connection::open_with_flags(
        &database_path,
        OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    connection
        .execute_batch(
            "PRAGMA trusted_schema=OFF;
             PRAGMA foreign_keys=OFF;
             PRAGMA journal_mode=DELETE;",
        )
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;

    for table in [
        "room_instances",
        "room_blueprints",
        "daily_reports",
        "save_metadata",
        "generation_jobs",
        "saves",
    ] {
        let changed = transaction
            .execute(
                &format!("UPDATE {table} SET save_id=?1 WHERE save_id=?2"),
                params![new_save_id, source_save_id],
            )
            .map_err(|_| ArchiveImportError::InvalidDatabase)?;
        if matches!(table, "save_metadata" | "saves") && changed != 1 {
            return Err(ArchiveImportError::InvalidDatabase);
        }
    }

    transaction
        .execute(
            "UPDATE save_metadata
             SET display_name=?1,renamed_at_ms=MAX(created_at_ms,?2),metadata_revision=metadata_revision+1
             WHERE save_id=?3",
            params![display_name, now_ms, new_save_id],
        )
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;

    // Only known structured save-id fields are touched. Player-authored text
    // elsewhere in these documents remains byte-identical.
    for (table, column) in [
        ("saves", "phase2_json"),
        ("saves", "latest_report_json"),
        ("saves", "operations_json"),
        ("saves", "phase4_json"),
        ("daily_reports", "report_json"),
        ("generation_jobs", "request_json"),
    ] {
        transaction
            .execute(
                &format!(
                    "UPDATE {table}
                     SET {column}=json_set({column},'$.saveId',?1)
                     WHERE {column} IS NOT NULL
                       AND json_valid({column})
                       AND json_extract({column},'$.saveId')=?2"
                ),
                params![new_save_id, source_save_id],
            )
            .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    }

    transaction
        .execute("DELETE FROM asset_write_intents", [])
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    transaction
        .execute("DELETE FROM recovery_points", [])
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    transaction
        .execute(
            "UPDATE generation_jobs
             SET status=CASE
                   WHEN status IN ('checking-model','running-primary','running-fallback','staging-asset','retry-delay')
                     OR response_ambiguous=1
                     THEN 'needs-retry-confirmation'
                   WHEN status IN ('queued','blocked-no-credential','waiting-network','failed-retryable')
                     THEN 'needs-player-confirmation'
                   ELSE status
                 END,
                 next_attempt_at_ms=NULL,
                 lease_owner=NULL,
                 lease_until_ms=NULL,
                 response_ambiguous=CASE
                   WHEN status IN ('checking-model','running-primary','running-fallback','staging-asset','retry-delay')
                     OR response_ambiguous=1 THEN 1 ELSE response_ambiguous END,
                 job_revision=job_revision+1,
                 updated_at_ms=MAX(updated_at_ms,?1)",
            [now_ms],
        )
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    let revision = transaction
        .query_row(
            "SELECT revision FROM saves WHERE save_id=?1",
            [new_save_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    transaction
        .execute(
            "UPDATE runtime_session
             SET session_id=?1,clean_shutdown=1,last_durable_revision=?2,
                 coordinator_epoch=coordinator_epoch+1,
                 last_observed_wall_ms=?3,updated_at_ms=?3
             WHERE singleton=1",
            params![format!("import-{new_save_id}"), revision, now_ms],
        )
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;

    for table in [
        "saves",
        "room_blueprints",
        "room_instances",
        "daily_reports",
        "save_metadata",
        "generation_jobs",
    ] {
        let remaining = transaction
            .query_row(
                &format!("SELECT count(*) FROM {table} WHERE save_id=?1"),
                [source_save_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| ArchiveImportError::InvalidDatabase)?;
        if remaining != 0 {
            return Err(ArchiveImportError::InvalidDatabase);
        }
    }
    for (table, column) in [
        ("saves", "phase2_json"),
        ("saves", "latest_report_json"),
        ("saves", "operations_json"),
        ("saves", "phase4_json"),
        ("daily_reports", "report_json"),
        ("generation_jobs", "request_json"),
    ] {
        let remaining = transaction
            .query_row(
                &format!(
                    "SELECT count(*) FROM {table}
                     WHERE {column} IS NOT NULL AND json_valid({column})
                       AND json_extract({column},'$.saveId')=?1"
                ),
                [source_save_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|_| ArchiveImportError::InvalidDatabase)?;
        if remaining != 0 {
            return Err(ArchiveImportError::InvalidDatabase);
        }
    }
    transaction
        .execute_batch("PRAGMA foreign_key_check;")
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    let foreign_key_violations = transaction
        .query_row("SELECT count(*) FROM pragma_foreign_key_check", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    if foreign_key_violations != 0 {
        return Err(ArchiveImportError::InvalidDatabase);
    }
    transaction
        .commit()
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    connection
        .execute_batch("PRAGMA foreign_keys=ON; PRAGMA wal_checkpoint(TRUNCATE);")
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    validate_current_save_database(&connection).map_err(|_| ArchiveImportError::InvalidDatabase)?;
    validate_single_save_identity(&connection, new_save_id, false)
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    validate_asset_registry(&connection, save_directory)
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    drop(connection);
    File::open(&database_path)
        .and_then(|file| file.sync_all())
        .map_err(|_| ArchiveImportError::Io)?;
    sync_directory_import(save_directory)?;
    Ok(())
}

fn publish_import_payload(
    staging: &Path,
    destination: &Path,
    new_save_id: &str,
) -> Result<(), ArchiveImportError> {
    let staged_metadata = fs::symlink_metadata(staging).map_err(|_| ArchiveImportError::Io)?;
    let destination_metadata =
        fs::symlink_metadata(destination).map_err(|_| ArchiveImportError::Io)?;
    if staged_metadata.file_type().is_symlink()
        || !staged_metadata.is_dir()
        || destination_metadata.file_type().is_symlink()
        || !destination_metadata.is_dir()
    {
        return Err(ArchiveImportError::Io);
    }
    let assets = staging.join("assets");
    if assets.exists() {
        fs::rename(&assets, destination.join("assets")).map_err(|_| ArchiveImportError::Io)?;
    }
    let database = staging.join("save.sqlite3");
    fs::rename(&database, destination.join("save.sqlite3")).map_err(|_| ArchiveImportError::Io)?;
    sync_directory_import(destination)?;
    let connection = Connection::open_with_flags(
        destination.join("save.sqlite3"),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    connection
        .execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;")
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    validate_current_save_database(&connection).map_err(|_| ArchiveImportError::InvalidDatabase)?;
    validate_single_save_identity(&connection, new_save_id, false)
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    validate_asset_registry(&connection, destination)
        .map_err(|_| ArchiveImportError::InvalidDatabase)?;
    let parent = destination.parent().ok_or(ArchiveImportError::Io)?;
    sync_directory_import(parent)
}

fn sync_directory_import(path: &Path) -> Result<(), ArchiveImportError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ArchiveImportError::Io)
}

fn sha256_file_import(path: &Path) -> Result<String, ArchiveImportError> {
    let mut file = File::open(path).map_err(|_| ArchiveImportError::IntegrityMismatch)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1_024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| ArchiveImportError::IntegrityMismatch)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(lower_hex(&hasher.finalize()))
}

/// Writes a deterministic, manifest-first ZIP to a newly-created temporary
/// `.cloudinn` file in `temporary_directory`.
///
/// Every supplied record must match exactly one validated manifest payload.
/// Sources are read in bounded chunks and checked against the manifest's
/// length and SHA-256 while they are copied.  The fixed ZIP timestamp,
/// permissions, compression method and lexical entry order make equivalent
/// input produce byte-identical archive contents.
pub(crate) fn write_temporary_archive(
    temporary_directory: &Path,
    manifest: &ArchiveManifest,
    payload_files: &[ArchivePayloadFile],
) -> Result<TemporaryArchive, ArchiveWriteError> {
    validate_manifest(manifest).map_err(|_| ArchiveWriteError::InvalidManifest)?;
    require_plain_directory(temporary_directory)?;
    let manifest_bytes =
        serde_json::to_vec(manifest).map_err(|_| ArchiveWriteError::InvalidManifest)?;
    if manifest_bytes.len() > MAX_MANIFEST_BYTES {
        return Err(ArchiveWriteError::InvalidManifest);
    }

    let payload_by_path = match_payload_files(manifest, payload_files)?;
    ensure_output_size_bound(manifest, &manifest_bytes)?;
    let temporary_path = create_temporary_archive_path(temporary_directory)?;

    let outcome = (|| {
        let output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary_path)
            .map_err(|_| ArchiveWriteError::Io)?;
        let mut writer = ZipWriter::new(output);
        let options = SimpleFileOptions::DEFAULT
            .compression_method(CompressionMethod::Stored)
            .unix_permissions(0o100444);
        writer
            .start_file(MANIFEST_PATH, options)
            .map_err(|_| ArchiveWriteError::Io)?;
        writer
            .write_all(&manifest_bytes)
            .map_err(|_| ArchiveWriteError::Io)?;

        let mut payloads = manifest.payload.iter().collect::<Vec<_>>();
        payloads.sort_unstable_by(|left, right| left.path.cmp(&right.path));
        for payload in payloads {
            let source = payload_by_path
                .get(payload.path.as_str())
                .ok_or(ArchiveWriteError::PayloadPathMismatch)?;
            writer
                .start_file(&payload.path, options)
                .map_err(|_| ArchiveWriteError::Io)?;
            copy_and_verify_payload(&mut writer, source, payload)?;
        }

        let output = writer.finish().map_err(|_| ArchiveWriteError::Io)?;
        output.sync_all().map_err(|_| ArchiveWriteError::Io)?;
        let byte_length = output.metadata().map_err(|_| ArchiveWriteError::Io)?.len();
        drop(output);
        if byte_length > MAX_ARCHIVE_BYTES {
            return Err(ArchiveWriteError::ArchiveTooLarge);
        }
        sync_directory(temporary_directory)?;
        Ok(TemporaryArchive {
            sha256: sha256_file(&temporary_path)?,
            path: temporary_path.clone(),
            byte_length,
        })
    })();

    if outcome.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    outcome
}

fn match_payload_files<'a>(
    manifest: &ArchiveManifest,
    payload_files: &'a [ArchivePayloadFile],
) -> Result<BTreeMap<&'a str, &'a Path>, ArchiveWriteError> {
    if payload_files.len() != manifest.payload.len() {
        return Err(ArchiveWriteError::PayloadPathMismatch);
    }
    let mut sources = BTreeMap::new();
    for payload_file in payload_files {
        validate_safe_relative_path(&payload_file.archive_path)
            .map_err(|_| ArchiveWriteError::PayloadPathMismatch)?;
        if sources
            .insert(
                payload_file.archive_path.as_str(),
                payload_file.source_path.as_path(),
            )
            .is_some()
        {
            return Err(ArchiveWriteError::PayloadPathMismatch);
        }
    }
    if manifest
        .payload
        .iter()
        .any(|payload| !sources.contains_key(payload.path.as_str()))
    {
        return Err(ArchiveWriteError::PayloadPathMismatch);
    }
    Ok(sources)
}

fn ensure_output_size_bound(
    manifest: &ArchiveManifest,
    manifest_bytes: &[u8],
) -> Result<(), ArchiveWriteError> {
    let payload_bytes = manifest.payload.iter().try_fold(0_u64, |total, payload| {
        total.checked_add(payload.byte_length)
    });
    let entry_name_bytes = manifest
        .payload
        .iter()
        .try_fold(
            u64::try_from(MANIFEST_PATH.len()).unwrap_or(u64::MAX),
            |total, payload| {
                total.checked_add(u64::try_from(payload.path.len()).unwrap_or(u64::MAX))
            },
        )
        .ok_or(ArchiveWriteError::ArchiveTooLarge)?;
    // Stored ZIP entries require two headers; reserve a conservative fixed
    // amount for those headers and the central-directory terminator.
    let entry_count = u64::try_from(manifest.payload.len() + 1).unwrap_or(u64::MAX);
    let overhead = entry_count
        .checked_mul(128)
        .and_then(|total| total.checked_add(entry_name_bytes))
        .and_then(|total| total.checked_add(22))
        .ok_or(ArchiveWriteError::ArchiveTooLarge)?;
    let estimated = payload_bytes
        .and_then(|total| total.checked_add(u64::try_from(manifest_bytes.len()).ok()?))
        .and_then(|total| total.checked_add(overhead))
        .ok_or(ArchiveWriteError::ArchiveTooLarge)?;
    if estimated > MAX_ARCHIVE_BYTES {
        return Err(ArchiveWriteError::ArchiveTooLarge);
    }
    Ok(())
}

fn copy_and_verify_payload(
    destination: &mut ZipWriter<File>,
    source_path: &Path,
    expected: &ArchivePayloadRecord,
) -> Result<(), ArchiveWriteError> {
    let source_metadata = fs::symlink_metadata(source_path).map_err(|_| ArchiveWriteError::Io)?;
    if source_metadata.file_type().is_symlink() || !source_metadata.is_file() {
        return Err(ArchiveWriteError::UnsafePayloadSource);
    }
    if source_metadata.len() != expected.byte_length {
        return Err(ArchiveWriteError::PayloadIntegrityMismatch);
    }
    let mut source = File::open(source_path).map_err(|_| ArchiveWriteError::Io)?;
    let opened_metadata = source.metadata().map_err(|_| ArchiveWriteError::Io)?;
    if !opened_metadata.is_file() || opened_metadata.len() != expected.byte_length {
        return Err(ArchiveWriteError::PayloadIntegrityMismatch);
    }

    let mut hasher = Sha256::new();
    let mut byte_length = 0_u64;
    let mut buffer = [0_u8; 64 * 1_024];
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|_| ArchiveWriteError::Io)?;
        if read == 0 {
            break;
        }
        byte_length = byte_length
            .checked_add(
                u64::try_from(read).map_err(|_| ArchiveWriteError::PayloadIntegrityMismatch)?,
            )
            .ok_or(ArchiveWriteError::PayloadIntegrityMismatch)?;
        if byte_length > expected.byte_length {
            return Err(ArchiveWriteError::PayloadIntegrityMismatch);
        }
        hasher.update(&buffer[..read]);
        destination
            .write_all(&buffer[..read])
            .map_err(|_| ArchiveWriteError::Io)?;
    }
    if byte_length != expected.byte_length || lower_hex(&hasher.finalize()) != expected.sha256 {
        return Err(ArchiveWriteError::PayloadIntegrityMismatch);
    }
    Ok(())
}

fn create_temporary_archive_path(directory: &Path) -> Result<PathBuf, ArchiveWriteError> {
    for _ in 0..16 {
        let candidate = directory.join(format!(
            ".cloud-inn-export-{}.cloudinn",
            uuid::Uuid::new_v4()
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(ArchiveWriteError::Io)
}

fn require_plain_directory(path: &Path) -> Result<(), ArchiveWriteError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| ArchiveWriteError::Io)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(ArchiveWriteError::Io);
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), ArchiveWriteError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| ArchiveWriteError::Io)
}

fn sha256_file(path: &Path) -> Result<String, ArchiveWriteError> {
    let mut file = File::open(path).map_err(|_| ArchiveWriteError::Io)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1_024];
    loop {
        let read = file.read(&mut buffer).map_err(|_| ArchiveWriteError::Io)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(lower_hex(&hasher.finalize()))
}

fn lower_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(char::from(DIGITS[usize::from(byte >> 4)]));
        output.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    output
}

pub(crate) fn parse_manifest(bytes: &[u8]) -> Result<ArchiveManifest, ArchiveManifestError> {
    if bytes.len() > MAX_MANIFEST_BYTES {
        return Err(ArchiveManifestError::ManifestTooLarge);
    }
    let manifest =
        serde_json::from_slice(bytes).map_err(|_| ArchiveManifestError::InvalidManifest)?;
    validate_manifest(&manifest)?;
    Ok(manifest)
}

pub(crate) fn validate_manifest(manifest: &ArchiveManifest) -> Result<(), ArchiveManifestError> {
    if manifest.format_version != ARCHIVE_FORMAT_VERSION {
        return Err(ArchiveManifestError::UnsupportedVersion);
    }
    validate_metadata(manifest)?;
    if manifest.payload.is_empty() || manifest.payload.len() > MAX_ARCHIVE_ENTRIES {
        return Err(ArchiveManifestError::TooManyPayloadEntries);
    }

    let mut payload_by_path = BTreeMap::new();
    let mut folded_paths = BTreeSet::new();
    let mut total_bytes = 0_u64;
    for record in &manifest.payload {
        validate_safe_relative_path(&record.path)?;
        let folded = record.path.to_ascii_lowercase();
        if !folded_paths.insert(folded) {
            return if payload_by_path.contains_key(record.path.as_str()) {
                Err(ArchiveManifestError::DuplicatePayloadPath)
            } else {
                Err(ArchiveManifestError::CaseCollision)
            };
        }
        validate_payload_record(record)?;
        total_bytes = total_bytes
            .checked_add(record.byte_length)
            .ok_or(ArchiveManifestError::ArchiveTooLarge)?;
        if total_bytes > MAX_ARCHIVE_BYTES {
            return Err(ArchiveManifestError::ArchiveTooLarge);
        }
        payload_by_path.insert(record.path.as_str(), record);
    }

    let database = payload_by_path
        .get(DATABASE_PATH)
        .ok_or(ArchiveManifestError::MissingDatabasePayload)?;
    if database.path != DATABASE_PATH {
        return Err(ArchiveManifestError::MissingDatabasePayload);
    }

    let mut asset_ids = BTreeSet::new();
    let mut asset_paths = BTreeSet::new();
    for asset in &manifest.referenced_assets {
        validate_asset_metadata(asset)?;
        if !asset_ids.insert(asset.asset_id.as_str()) || !asset_paths.insert(asset.path.as_str()) {
            return Err(ArchiveManifestError::InvalidAssetMetadata);
        }
        let payload = payload_by_path
            .get(asset.path.as_str())
            .ok_or(ArchiveManifestError::AssetPayloadMismatch)?;
        if payload.sha256 != asset.sha256 || payload.byte_length != asset.byte_length {
            return Err(ArchiveManifestError::AssetPayloadMismatch);
        }
    }

    if payload_by_path.len() != manifest.referenced_assets.len() + 1
        || payload_by_path
            .keys()
            .any(|path| path != &DATABASE_PATH && !path.starts_with(ASSET_PREFIX))
    {
        return Err(ArchiveManifestError::AssetPayloadMismatch);
    }
    Ok(())
}

fn validate_metadata(manifest: &ArchiveManifest) -> Result<(), ArchiveManifestError> {
    if !is_ascii_identifier(&manifest.source_save_id, MAX_SAVE_ID_LENGTH)
        || manifest.display_name.is_empty()
        || manifest.display_name.len() > MAX_DISPLAY_NAME_BYTES
        || manifest.application_version.is_empty()
        || manifest.application_version.len() > MAX_APPLICATION_VERSION_BYTES
        || manifest.ruleset_version.is_empty()
        || manifest.ruleset_version.len() > MAX_RULESET_VERSION_BYTES
        || manifest.schema_version == 0
        || manifest.created_at_ms < 0
    {
        return Err(ArchiveManifestError::InvalidMetadata);
    }
    Ok(())
}

fn validate_payload_record(record: &ArchivePayloadRecord) -> Result<(), ArchiveManifestError> {
    if !is_lowercase_sha256(&record.sha256) {
        return Err(ArchiveManifestError::InvalidPayloadDigest);
    }
    if record.byte_length == 0 {
        return Err(ArchiveManifestError::InvalidPayloadLength);
    }
    if record.path == DATABASE_PATH {
        return Ok(());
    }
    validate_asset_path(&record.path, &record.sha256)
}

fn validate_asset_metadata(asset: &ArchiveAssetMetadata) -> Result<(), ArchiveManifestError> {
    if !is_ascii_identifier(&asset.asset_id, MAX_SAVE_ID_LENGTH)
        || !is_lowercase_sha256(&asset.sha256)
        || asset.byte_length == 0
        || asset.width == 0
        || asset.height == 0
    {
        return Err(ArchiveManifestError::InvalidAssetMetadata);
    }
    let extension = match asset.mime_type.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => return Err(ArchiveManifestError::InvalidAssetMetadata),
    };
    let expected = format!(
        "assets/sha256/{}/{}.{}",
        &asset.sha256[..2],
        asset.sha256,
        extension
    );
    if asset.path != expected {
        return Err(ArchiveManifestError::InvalidAssetMetadata);
    }
    Ok(())
}

fn validate_asset_path(path: &str, sha256: &str) -> Result<(), ArchiveManifestError> {
    let valid = ["png", "jpg", "webp"].into_iter().any(|extension| {
        path == format!("assets/sha256/{}/{}.{}", &sha256[..2], sha256, extension)
    });
    if valid {
        Ok(())
    } else {
        Err(ArchiveManifestError::InvalidPayloadPath)
    }
}

fn validate_safe_relative_path(path: &str) -> Result<(), ArchiveManifestError> {
    if path.is_empty()
        || !path.is_ascii()
        || path.starts_with('/')
        || path.contains('\\')
        || path.bytes().any(|byte| matches!(byte, 0 | b'\n' | b'\r'))
        || path
            .split('/')
            .any(|part| part.is_empty() || matches!(part, "." | ".."))
    {
        return Err(ArchiveManifestError::InvalidPayloadPath);
    }
    Ok(())
}

fn is_ascii_identifier(value: &str, maximum_length: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum_length
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::SaveRepository;
    use std::fs;
    use zip::ZipArchive;

    const SHA_A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const SHA_B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    fn valid_manifest() -> ArchiveManifest {
        ArchiveManifest {
            format_version: 1,
            application_version: "1.2.3".into(),
            schema_version: 7,
            ruleset_version: "phase5".into(),
            source_save_id: "save_01".into(),
            display_name: "Cloud Inn".into(),
            created_at_ms: 1,
            payload: vec![
                ArchivePayloadRecord {
                    path: DATABASE_PATH.into(),
                    sha256: SHA_A.into(),
                    byte_length: 11,
                },
                ArchivePayloadRecord {
                    path: format!("assets/sha256/bb/{SHA_B}.png"),
                    sha256: SHA_B.into(),
                    byte_length: 12,
                },
            ],
            referenced_assets: vec![ArchiveAssetMetadata {
                asset_id: "asset_01".into(),
                path: format!("assets/sha256/bb/{SHA_B}.png"),
                mime_type: "image/png".into(),
                byte_length: 12,
                width: 1,
                height: 1,
                sha256: SHA_B.into(),
            }],
        }
    }

    #[test]
    fn parses_a_complete_v1_manifest_and_rejects_unknown_fields() {
        let manifest = valid_manifest();
        let bytes = serde_json::to_vec(&manifest).unwrap();
        assert_eq!(parse_manifest(&bytes).unwrap(), manifest);
        let invalid = br#"{"formatVersion":1,"unexpected":true}"#;
        assert_eq!(
            parse_manifest(invalid),
            Err(ArchiveManifestError::InvalidManifest)
        );
    }

    #[test]
    fn rejects_future_versions_and_invalid_payload_paths() {
        let mut manifest = valid_manifest();
        manifest.format_version = 2;
        assert_eq!(
            validate_manifest(&manifest),
            Err(ArchiveManifestError::UnsupportedVersion)
        );
        for invalid_path in [
            "/save/save.sqlite3",
            "save\\save.sqlite3",
            "save/\0save.sqlite3",
            "save/数据库.sqlite3",
            "save/../save.sqlite3",
            "manifest.json",
        ] {
            let mut manifest = valid_manifest();
            manifest.payload[0].path = invalid_path.into();
            assert_eq!(
                validate_manifest(&manifest),
                Err(ArchiveManifestError::InvalidPayloadPath)
            );
        }
    }

    #[test]
    fn rejects_duplicate_and_case_colliding_payload_paths() {
        let mut duplicate = valid_manifest();
        duplicate.payload.push(duplicate.payload[0].clone());
        assert_eq!(
            validate_manifest(&duplicate),
            Err(ArchiveManifestError::DuplicatePayloadPath)
        );

        let mut collision = valid_manifest();
        collision.payload.push(ArchivePayloadRecord {
            path: "Save/save.sqlite3".into(),
            sha256: SHA_A.into(),
            byte_length: 1,
        });
        assert_eq!(
            validate_manifest(&collision),
            Err(ArchiveManifestError::CaseCollision)
        );
    }

    #[test]
    fn asset_metadata_must_exactly_match_its_payload() {
        let mut manifest = valid_manifest();
        manifest.referenced_assets[0].sha256 = SHA_A.into();
        manifest.referenced_assets[0].path = format!("assets/sha256/aa/{SHA_A}.png");
        assert_eq!(
            validate_manifest(&manifest),
            Err(ArchiveManifestError::AssetPayloadMismatch)
        );

        let mut manifest = valid_manifest();
        manifest.referenced_assets[0].byte_length = 13;
        assert_eq!(
            validate_manifest(&manifest),
            Err(ArchiveManifestError::AssetPayloadMismatch)
        );
    }

    #[test]
    fn validates_digest_length_and_declared_total_bounds() {
        let mut manifest = valid_manifest();
        manifest.payload[0].sha256 = "A".repeat(64);
        assert_eq!(
            validate_manifest(&manifest),
            Err(ArchiveManifestError::InvalidPayloadDigest)
        );

        let mut manifest = valid_manifest();
        manifest.payload[0].byte_length = 0;
        assert_eq!(
            validate_manifest(&manifest),
            Err(ArchiveManifestError::InvalidPayloadLength)
        );

        let mut manifest = valid_manifest();
        manifest.payload[0].byte_length = MAX_ARCHIVE_BYTES;
        assert_eq!(
            validate_manifest(&manifest),
            Err(ArchiveManifestError::ArchiveTooLarge)
        );
    }

    #[test]
    fn writes_a_deterministic_verified_archive_round_trip() {
        let directory = test_directory();
        let database_bytes = b"cloud inn portable sqlite snapshot";
        let asset_bytes = b"cloud inn deterministic image payload";
        let database_path = directory.0.join("portable.sqlite3");
        let asset_path = directory.0.join("asset.png");
        fs::write(&database_path, database_bytes).unwrap();
        fs::write(&asset_path, asset_bytes).unwrap();

        let database_sha256 = lower_hex(&Sha256::digest(database_bytes));
        let asset_sha256 = lower_hex(&Sha256::digest(asset_bytes));
        let asset_archive_path =
            format!("assets/sha256/{}/{}.png", &asset_sha256[..2], asset_sha256);
        let manifest = ArchiveManifest {
            format_version: ARCHIVE_FORMAT_VERSION,
            application_version: "1.2.3".into(),
            schema_version: 7,
            ruleset_version: "phase5".into(),
            source_save_id: "save_01".into(),
            display_name: "Cloud Inn".into(),
            created_at_ms: 1,
            payload: vec![
                ArchivePayloadRecord {
                    path: DATABASE_PATH.into(),
                    sha256: database_sha256,
                    byte_length: u64::try_from(database_bytes.len()).unwrap(),
                },
                ArchivePayloadRecord {
                    path: asset_archive_path.clone(),
                    sha256: asset_sha256.clone(),
                    byte_length: u64::try_from(asset_bytes.len()).unwrap(),
                },
            ],
            referenced_assets: vec![ArchiveAssetMetadata {
                asset_id: "asset_01".into(),
                path: asset_archive_path.clone(),
                mime_type: "image/png".into(),
                byte_length: u64::try_from(asset_bytes.len()).unwrap(),
                width: 1,
                height: 1,
                sha256: asset_sha256,
            }],
        };
        let payloads = vec![
            ArchivePayloadFile {
                archive_path: asset_archive_path.clone(),
                source_path: asset_path,
            },
            ArchivePayloadFile {
                archive_path: DATABASE_PATH.into(),
                source_path: database_path,
            },
        ];

        let first = write_temporary_archive(&directory.0, &manifest, &payloads).unwrap();
        let second = write_temporary_archive(&directory.0, &manifest, &payloads).unwrap();
        assert_eq!(
            first
                .path
                .extension()
                .and_then(|extension| extension.to_str()),
            Some("cloudinn")
        );
        assert_eq!(first.byte_length, fs::metadata(&first.path).unwrap().len());
        assert_eq!(first.sha256, sha256_file(&first.path).unwrap());
        assert_eq!(
            fs::read(&first.path).unwrap(),
            fs::read(&second.path).unwrap()
        );

        let mut archive = ZipArchive::new(File::open(&first.path).unwrap()).unwrap();
        assert_eq!(archive.len(), 3);
        assert_eq!(archive.by_index(0).unwrap().name(), MANIFEST_PATH);
        assert_eq!(archive.by_index(1).unwrap().name(), asset_archive_path);
        assert_eq!(archive.by_index(2).unwrap().name(), DATABASE_PATH);
        let mut manifest_bytes = Vec::new();
        archive
            .by_name(MANIFEST_PATH)
            .unwrap()
            .read_to_end(&mut manifest_bytes)
            .unwrap();
        assert_eq!(parse_manifest(&manifest_bytes).unwrap(), manifest);
        let mut restored_database = Vec::new();
        archive
            .by_name(DATABASE_PATH)
            .unwrap()
            .read_to_end(&mut restored_database)
            .unwrap();
        assert_eq!(restored_database, database_bytes);
        let mut restored_asset = Vec::new();
        archive
            .by_name(&asset_archive_path)
            .unwrap()
            .read_to_end(&mut restored_asset)
            .unwrap();
        assert_eq!(restored_asset, asset_bytes);
    }

    #[test]
    fn rejects_payload_paths_that_do_not_exactly_match_the_manifest() {
        let directory = test_directory();
        let database_path = directory.0.join("portable.sqlite3");
        fs::write(&database_path, b"cloud inn portable sqlite snapshot").unwrap();
        let mut manifest = valid_manifest();
        manifest.payload.truncate(1);
        manifest.referenced_assets.clear();
        let error = write_temporary_archive(
            &directory.0,
            &manifest,
            &[ArchivePayloadFile {
                archive_path: "save/other.sqlite3".into(),
                source_path: database_path,
            }],
        )
        .unwrap_err();
        assert_eq!(error, ArchiveWriteError::PayloadPathMismatch);
    }

    #[test]
    fn publishes_without_replacing_an_existing_destination() {
        let directory = test_directory();
        let payload_path = directory.0.join("portable.sqlite3");
        let bytes = b"sealed archive payload";
        fs::write(&payload_path, bytes).unwrap();
        let digest = lower_hex(&Sha256::digest(bytes));
        let manifest = ArchiveManifest {
            format_version: ARCHIVE_FORMAT_VERSION,
            application_version: "1.0.0".into(),
            schema_version: 7,
            ruleset_version: "phase5".into(),
            source_save_id: "save_01".into(),
            display_name: "Cloud Inn".into(),
            created_at_ms: 1,
            payload: vec![ArchivePayloadRecord {
                path: DATABASE_PATH.into(),
                sha256: digest,
                byte_length: u64::try_from(bytes.len()).unwrap(),
            }],
            referenced_assets: Vec::new(),
        };
        let archive = write_temporary_archive(
            &directory.0,
            &manifest,
            &[ArchivePayloadFile {
                archive_path: DATABASE_PATH.into(),
                source_path: payload_path,
            }],
        )
        .unwrap();
        let destination = directory.0.join("hotel.cloudinn");
        publish_archive_to_new_destination(&archive, &destination).unwrap();
        let first = fs::read(&destination).unwrap();
        assert_eq!(
            publish_archive_to_new_destination(&archive, &destination),
            Err(ArchiveWriteError::DestinationExists)
        );
        assert_eq!(fs::read(&destination).unwrap(), first);
    }

    #[test]
    fn import_inspection_is_staged_session_bound_and_single_use() {
        let source = test_directory();
        let app_root = source.0.join("app-root");
        fs::create_dir(&app_root).unwrap();
        let repository = SaveRepository::new(app_root.clone());
        repository.create_save(Some("可移植云栈".into())).unwrap();
        let saves_root = app_root.join("saves");
        let save_entry = fs::read_dir(&saves_root).unwrap().next().unwrap().unwrap();
        let save_id = save_entry.file_name().to_str().unwrap().to_owned();
        let database_path = save_entry.path().join("save.sqlite3");
        let database_bytes = fs::read(&database_path).unwrap();
        let digest = lower_hex(&Sha256::digest(&database_bytes));
        let manifest = ArchiveManifest {
            format_version: ARCHIVE_FORMAT_VERSION,
            application_version: "0.1.0".into(),
            schema_version: 7,
            ruleset_version: "prototype-v1".into(),
            source_save_id: save_id.clone(),
            display_name: "可移植云栈".into(),
            created_at_ms: 1,
            payload: vec![ArchivePayloadRecord {
                path: DATABASE_PATH.into(),
                sha256: digest,
                byte_length: u64::try_from(database_bytes.len()).unwrap(),
            }],
            referenced_assets: Vec::new(),
        };
        let export_directory = source.0.join("exports");
        fs::create_dir(&export_directory).unwrap();
        let archive = write_temporary_archive(
            &export_directory,
            &manifest,
            &[ArchivePayloadFile {
                archive_path: DATABASE_PATH.into(),
                source_path: database_path,
            }],
        )
        .unwrap();

        let service = ArchiveImportService::new(&app_root).unwrap();
        let inspection = service.inspect_import(&archive.path, 1_000).unwrap();
        assert_eq!(inspection.source_save_id, save_id);
        assert!(!inspection.token.contains(archive.path.to_str().unwrap()));
        let consumed = service.consume_import(&inspection.token, 2_000).unwrap();
        assert_eq!(consumed.manifest.display_name, "可移植云栈");
        assert!(consumed
            .extracted_save_directory
            .join("save.sqlite3")
            .is_file());
        let imported = service
            .import_as_new_save(consumed, Some("可移植云栈副本"), 2_000)
            .unwrap();
        assert_ne!(imported.save_id, save_id);
        assert_eq!(imported.display_name, "可移植云栈副本");
        let original_bytes = fs::read(save_entry.path().join("save.sqlite3")).unwrap();
        assert_eq!(original_bytes, database_bytes);
        let imported_directory = app_root.join("saves").join(&imported.save_id);
        let imported_connection =
            Connection::open(imported_directory.join("save.sqlite3")).unwrap();
        validate_current_save_database(&imported_connection).unwrap();
        validate_single_save_identity(&imported_connection, &imported.save_id, false).unwrap();
        assert_eq!(
            service.consume_import(&inspection.token, 2_001),
            Err(ArchiveImportError::InvalidToken)
        );
        let other_session = ArchiveImportService::new(&app_root).unwrap();
        assert_eq!(
            other_session.consume_import(&inspection.token, 2_002),
            Err(ArchiveImportError::InvalidToken)
        );

        let expiring = service.inspect_import(&archive.path, 10_000).unwrap();
        assert_eq!(
            service.consume_import(&expiring.token, 10_000 + IMPORT_TOKEN_TTL_MS + 1),
            Err(ArchiveImportError::ExpiredToken)
        );

        let tampered = service.inspect_import(&archive.path, 20_000).unwrap();
        let staged_path = service
            .inspections
            .lock()
            .unwrap()
            .get(&tampered.token)
            .unwrap()
            .archive_path
            .clone();
        let mut staged_bytes = fs::read(&staged_path).unwrap();
        staged_bytes.extend_from_slice(b"tamper");
        fs::remove_file(&staged_path).unwrap();
        fs::write(&staged_path, staged_bytes).unwrap();
        assert_eq!(
            service.consume_import(&tampered.token, 20_001),
            Err(ArchiveImportError::IntegrityMismatch)
        );
    }

    #[test]
    fn import_consumption_detects_staged_archive_tampering_and_expires_tokens() {
        let source = test_directory();
        let app_root = source.0.join("app-root");
        fs::create_dir(&app_root).unwrap();
        let service = ArchiveImportService::new(&app_root).unwrap();
        let selected = source.0.join("not-a-zip.cloudinn");
        fs::write(&selected, b"not a zip").unwrap();
        assert_eq!(
            service.inspect_import(&selected, 1),
            Err(ArchiveImportError::InvalidArchive)
        );
    }

    struct TestDirectory(PathBuf);

    impl Drop for TestDirectory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn test_directory() -> TestDirectory {
        let path =
            std::env::temp_dir().join(format!("cloud-inn-archive-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        TestDirectory(path)
    }
}
