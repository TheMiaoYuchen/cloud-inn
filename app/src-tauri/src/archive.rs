//! Strict, filesystem-free representation of a `.cloudinn` archive manifest.
//!
//! ZIP handling deliberately lives elsewhere.  This module only accepts the
//! small, declarative surface that a ZIP reader has already bounded and read.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

pub(crate) const ARCHIVE_FORMAT_VERSION: u32 = 1;
pub(crate) const MAX_ARCHIVE_ENTRIES: usize = 10_000;
pub(crate) const MAX_MANIFEST_BYTES: usize = 64 * 1_024 * 1_024;
pub(crate) const MAX_ARCHIVE_BYTES: u64 = 2 * 1_024 * 1_024 * 1_024;

const DATABASE_PATH: &str = "save/save.sqlite3";
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
}
