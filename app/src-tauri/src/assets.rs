//! Pure validation and naming rules for content-addressed image assets.
//!
//! Asset bytes are stored only at the canonical path derived from their
//! lowercase SHA-256 digest.  Keeping these rules free of filesystem access
//! makes them safe to use both before writes and while validating a save.

use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AssetPathError {
    InvalidSha256,
    UnsupportedMime,
    InvalidStoredPath,
}

impl fmt::Display for AssetPathError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidSha256 => "资源哈希无效",
            Self::UnsupportedMime => "资源类型无效",
            Self::InvalidStoredPath => "资源路径无效",
        })
    }
}

impl std::error::Error for AssetPathError {}

/// Returns the sole stored extension permitted for a supported image MIME.
pub(crate) fn stored_extension(mime_type: &str) -> Result<&'static str, AssetPathError> {
    match mime_type {
        "image/png" => Ok("png"),
        "image/jpeg" => Ok("jpg"),
        "image/webp" => Ok("webp"),
        _ => Err(AssetPathError::UnsupportedMime),
    }
}

/// Builds the only valid, portable relative path for an asset digest/MIME.
pub(crate) fn content_addressed_relative_path(
    sha256: &str,
    mime_type: &str,
) -> Result<String, AssetPathError> {
    validate_lowercase_sha256(sha256)?;
    let extension = stored_extension(mime_type)?;
    Ok(format!(
        "assets/sha256/{}/{}.{}",
        &sha256[..2],
        sha256,
        extension
    ))
}

/// Validates a database relative path against its content-addressed identity.
///
/// This deliberately compares the raw string rather than normalizing a path:
/// aliases such as `..`, duplicate separators, backslashes, or a change in
/// case must never point at the same asset.
pub(crate) fn validate_stored_asset_path(
    relative_path: &str,
    sha256: &str,
    mime_type: &str,
) -> Result<(), AssetPathError> {
    let expected = content_addressed_relative_path(sha256, mime_type)?;
    if relative_path == expected {
        Ok(())
    } else {
        Err(AssetPathError::InvalidStoredPath)
    }
}

pub(crate) fn validate_lowercase_sha256(sha256: &str) -> Result<(), AssetPathError> {
    if sha256.len() == 64
        && sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        Ok(())
    } else {
        Err(AssetPathError::InvalidSha256)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        content_addressed_relative_path, validate_lowercase_sha256, validate_stored_asset_path,
        AssetPathError,
    };

    const SHA256: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn builds_canonical_paths_for_every_supported_image_type() {
        assert_eq!(
            content_addressed_relative_path(SHA256, "image/png"),
            Ok(format!("assets/sha256/01/{SHA256}.png"))
        );
        assert_eq!(
            content_addressed_relative_path(SHA256, "image/jpeg"),
            Ok(format!("assets/sha256/01/{SHA256}.jpg"))
        );
        assert_eq!(
            content_addressed_relative_path(SHA256, "image/webp"),
            Ok(format!("assets/sha256/01/{SHA256}.webp"))
        );
    }

    #[test]
    fn rejects_uppercase_and_non_hex_digests() {
        let uppercase = format!("A{}", &SHA256[1..]);
        assert_eq!(
            validate_lowercase_sha256(&uppercase),
            Err(AssetPathError::InvalidSha256)
        );
        let non_hex = format!("g{}", &SHA256[1..]);
        assert_eq!(
            validate_lowercase_sha256(&non_hex),
            Err(AssetPathError::InvalidSha256)
        );
    }

    #[test]
    fn rejects_mime_case_and_unapproved_extensions() {
        assert_eq!(
            content_addressed_relative_path(SHA256, "Image/PNG"),
            Err(AssetPathError::UnsupportedMime)
        );
        assert_eq!(
            validate_stored_asset_path(
                &format!("assets/sha256/01/{SHA256}.jpeg"),
                SHA256,
                "image/jpeg"
            ),
            Err(AssetPathError::InvalidStoredPath)
        );
    }

    #[test]
    fn rejects_traversal_separator_and_case_aliases() {
        for invalid in [
            format!("assets/sha256/01/../{SHA256}.png"),
            format!("assets//sha256/01/{SHA256}.png"),
            format!("assets\\sha256\\01\\{SHA256}.png"),
            format!("Assets/sha256/01/{SHA256}.png"),
        ] {
            assert_eq!(
                validate_stored_asset_path(&invalid, SHA256, "image/png"),
                Err(AssetPathError::InvalidStoredPath),
                "{invalid}"
            );
        }
    }
}
