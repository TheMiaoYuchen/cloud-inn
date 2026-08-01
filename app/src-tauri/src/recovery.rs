use sha2::{Digest, Sha256};
use std::fmt;

pub(crate) const MAX_RECOVERY_ID_LENGTH: usize = 128;
pub(crate) const MAX_PAYLOAD_PATH_LENGTH: usize = 1_024;

/// An app-generated recovery identifier.  It deliberately contains no path
/// information: callers can only resolve it through the recovery catalog.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) struct RecoveryId(String);

impl RecoveryId {
    pub(crate) fn parse(value: impl Into<String>) -> Result<Self, RecoveryValidationError> {
        let value = value.into();
        if value.is_empty()
            || value.len() > MAX_RECOVERY_ID_LENGTH
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        {
            return Err(RecoveryValidationError::InvalidRecoveryId);
        }
        Ok(Self(value))
    }

    pub(crate) fn as_str(&self) -> &str {
        &self.0
    }
}

/// The only game mutations that create a player-visible automatic recovery
/// point.  Metadata, queue and checkpoint writes intentionally have no value
/// in this enum.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RecoveryReason {
    Construction,
    Settlement,
    VisualAdoption,
}

impl RecoveryReason {
    pub(crate) fn as_storage_value(self) -> &'static str {
        match self {
            Self::Construction => "construction",
            Self::Settlement => "settlement",
            Self::VisualAdoption => "visual-adoption",
        }
    }

    pub(crate) fn parse_storage_value(value: &str) -> Result<Self, RecoveryValidationError> {
        match value {
            "construction" => Ok(Self::Construction),
            "settlement" => Ok(Self::Settlement),
            "visual-adoption" => Ok(Self::VisualAdoption),
            _ => Err(RecoveryValidationError::InvalidReason),
        }
    }
}

/// A verified immutable package payload item. `sha256` is the hash of that
/// item, not of the aggregate package stream.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PayloadRecord {
    pub(crate) normalized_path: String,
    pub(crate) sha256: String,
    pub(crate) byte_length: u64,
}

impl PayloadRecord {
    pub(crate) fn new(
        normalized_path: impl Into<String>,
        sha256: impl Into<String>,
        byte_length: u64,
    ) -> Result<Self, RecoveryValidationError> {
        let record = Self {
            normalized_path: normalized_path.into(),
            sha256: sha256.into(),
            byte_length,
        };
        validate_payload_record(&record)?;
        Ok(record)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RecoveryValidationError {
    InvalidRecoveryId,
    InvalidReason,
    InvalidPayloadPath,
    InvalidPayloadDigest,
    InvalidPayloadLength,
    DuplicatePayloadPath,
}

impl fmt::Display for RecoveryValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidRecoveryId => "恢复点标识无效",
            Self::InvalidReason => "恢复点原因无效",
            Self::InvalidPayloadPath => "恢复包路径无效",
            Self::InvalidPayloadDigest => "恢复包摘要无效",
            Self::InvalidPayloadLength => "恢复包长度无效",
            Self::DuplicatePayloadPath => "恢复包包含重复路径",
        })
    }
}

impl std::error::Error for RecoveryValidationError {}

/// Produces the canonical byte stream used for a recovery package identity.
///
/// Records are sorted by their normalized UTF-8 path bytes. Each is encoded
/// exactly as `path NUL sha256 NUL byte_length LF`; this is deliberately not
/// JSON, so serialization settings cannot change the package identity.
pub(crate) fn canonical_payload_record_stream(
    records: &[PayloadRecord],
) -> Result<Vec<u8>, RecoveryValidationError> {
    let mut ordered = records.to_vec();
    for record in &ordered {
        validate_payload_record(record)?;
    }
    ordered.sort_unstable_by(|left, right| {
        left.normalized_path
            .as_bytes()
            .cmp(right.normalized_path.as_bytes())
    });
    if ordered
        .windows(2)
        .any(|records| records[0].normalized_path == records[1].normalized_path)
    {
        return Err(RecoveryValidationError::DuplicatePayloadPath);
    }

    let mut stream = Vec::new();
    for record in ordered {
        stream.extend_from_slice(record.normalized_path.as_bytes());
        stream.push(0);
        stream.extend_from_slice(record.sha256.as_bytes());
        stream.push(0);
        stream.extend_from_slice(record.byte_length.to_string().as_bytes());
        stream.push(b'\n');
    }
    Ok(stream)
}

pub(crate) fn package_sha256(records: &[PayloadRecord]) -> Result<String, RecoveryValidationError> {
    let stream = canonical_payload_record_stream(records)?;
    Ok(sha256_hex(&stream))
}

/// Hashes the exact emitted manifest bytes.  Do not deserialize and
/// reserialize before calling this function: formatting is part of the
/// immutable package identity.
pub(crate) fn manifest_sha256(manifest_bytes: &[u8]) -> String {
    sha256_hex(manifest_bytes)
}

fn validate_payload_record(record: &PayloadRecord) -> Result<(), RecoveryValidationError> {
    validate_normalized_payload_path(&record.normalized_path)?;
    if !is_lowercase_sha256(&record.sha256) {
        return Err(RecoveryValidationError::InvalidPayloadDigest);
    }
    if record.byte_length == 0 {
        return Err(RecoveryValidationError::InvalidPayloadLength);
    }
    Ok(())
}

fn validate_normalized_payload_path(path: &str) -> Result<(), RecoveryValidationError> {
    if path.is_empty()
        || path.len() > MAX_PAYLOAD_PATH_LENGTH
        || path.starts_with('/')
        || path.contains('\\')
        || path.bytes().any(|byte| matches!(byte, 0 | b'\n' | b'\r'))
    {
        return Err(RecoveryValidationError::InvalidPayloadPath);
    }

    for component in path.split('/') {
        if component.is_empty()
            || matches!(component, "." | "..")
            || !component
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        {
            return Err(RecoveryValidationError::InvalidPayloadPath);
        }
    }
    Ok(())
}

fn is_lowercase_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn sha256_hex(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let digest = Sha256::digest(bytes);
    let mut encoded = String::with_capacity(digest.len() * 2);
    for byte in digest {
        encoded.push(char::from(HEX[usize::from(byte >> 4)]));
        encoded.push(char::from(HEX[usize::from(byte & 0x0f)]));
    }
    encoded
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B: &str = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

    #[test]
    fn opaque_recovery_ids_are_bounded_and_path_free() {
        let id = RecoveryId::parse("recovery_01-A").unwrap();
        assert_eq!(id.as_str(), "recovery_01-A");
        for invalid in ["", "../backup", "backup/name", "backup\\name", "with space"] {
            assert_eq!(
                RecoveryId::parse(invalid).unwrap_err(),
                RecoveryValidationError::InvalidRecoveryId,
                "{invalid:?} should not be a recovery ID"
            );
        }
        assert_eq!(
            RecoveryId::parse("a".repeat(MAX_RECOVERY_ID_LENGTH + 1)).unwrap_err(),
            RecoveryValidationError::InvalidRecoveryId
        );
    }

    #[test]
    fn recovery_reasons_are_closed_and_round_trip_to_storage() {
        for reason in [
            RecoveryReason::Construction,
            RecoveryReason::Settlement,
            RecoveryReason::VisualAdoption,
        ] {
            assert_eq!(
                RecoveryReason::parse_storage_value(reason.as_storage_value()).unwrap(),
                reason
            );
        }
        assert_eq!(
            RecoveryReason::parse_storage_value("checkpoint").unwrap_err(),
            RecoveryValidationError::InvalidReason
        );
    }

    #[test]
    fn canonical_stream_sorts_records_and_has_a_fixed_package_digest() {
        let records = [
            PayloadRecord::new("b", B, 42).unwrap(),
            PayloadRecord::new("a", A, 1).unwrap(),
        ];
        let stream = canonical_payload_record_stream(&records).unwrap();
        assert_eq!(
            stream,
            b"a\x00aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\x001\nb\x00bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\x0042\n"
        );
        assert_eq!(
            package_sha256(&records).unwrap(),
            "87461b48f42583bdccd332fd95888a382d8610174639548883c229a7837b0fd8"
        );
    }

    #[test]
    fn canonical_stream_rejects_duplicate_or_non_normalized_records() {
        let duplicate = [
            PayloadRecord::new("database.sqlite3", A, 1).unwrap(),
            PayloadRecord::new("database.sqlite3", B, 2).unwrap(),
        ];
        assert_eq!(
            canonical_payload_record_stream(&duplicate).unwrap_err(),
            RecoveryValidationError::DuplicatePayloadPath
        );

        for path in [
            "/database.sqlite3",
            "assets//item",
            "assets/../item",
            "assets\\item",
        ] {
            assert_eq!(
                PayloadRecord::new(path, A, 1).unwrap_err(),
                RecoveryValidationError::InvalidPayloadPath,
                "{path:?} should be rejected"
            );
        }
        assert_eq!(
            PayloadRecord::new("database.sqlite3", "A".repeat(64), 1).unwrap_err(),
            RecoveryValidationError::InvalidPayloadDigest
        );
        assert_eq!(
            PayloadRecord::new("database.sqlite3", A, 0).unwrap_err(),
            RecoveryValidationError::InvalidPayloadLength
        );
    }

    #[test]
    fn manifest_digest_covers_exact_bytes_not_semantic_json() {
        let compact = br#"{"entries":["database.sqlite3"]}"#;
        let with_newline = b"{\"entries\":[\"database.sqlite3\"]}\n";
        assert_eq!(
            manifest_sha256(with_newline),
            "8dd6702fa6968f38249e331d52a2e2a5fdc8ef6adc0f0174afcfbbee17b3323d"
        );
        assert_ne!(manifest_sha256(compact), manifest_sha256(with_newline));
    }
}
