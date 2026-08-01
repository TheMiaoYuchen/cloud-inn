//! Strict manifest validation and deterministic writing for `.cloudinn` archives.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

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
            Self::Io => "归档写入失败",
        })
    }
}

impl std::error::Error for ArchiveWriteError {}

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
