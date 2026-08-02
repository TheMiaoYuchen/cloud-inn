//! Pure validation and naming rules for content-addressed image assets.
//!
//! Asset bytes are stored only at the canonical path derived from their
//! lowercase SHA-256 digest.  Keeping these rules free of filesystem access
//! makes them safe to use both before writes and while validating a save.

use image::{ImageFormat, ImageReader};
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::Cursor;
use std::io::{self, Write};
use std::path::{Path, PathBuf};

/// This deliberately matches the read-side validation ceiling.  Keeping the
/// write path at or below that ceiling means a successfully staged asset can
/// always be reopened by a v7 save validator.
const MAX_ASSET_BYTES: usize = 100_663_296;
const MAX_IMAGE_DIMENSION: u32 = 16_384;
const STAGING_PREFIX: &str = ".cloud-inn-asset-stage-";

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

/// The immutable identity returned after an asset has reached its canonical
/// content-addressed path.  This is intentionally database-agnostic: the
/// coordinator is responsible for recording it in `assets` in the same save
/// transaction that references it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct StoredAsset {
    pub(crate) sha256: String,
    pub(crate) relative_path: String,
    pub(crate) mime_type: String,
    pub(crate) byte_length: u64,
    pub(crate) width: u32,
    pub(crate) height: u32,
}

pub(crate) fn planned_asset_path(
    bytes: &[u8],
    mime_type: &str,
) -> Result<(String, String), AssetStoreError> {
    let sha256 = lower_hex(&Sha256::digest(bytes));
    let relative_path = content_addressed_relative_path(&sha256, mime_type)
        .map_err(|_| AssetStoreError::InvalidAsset)?;
    Ok((sha256, relative_path))
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum AssetStoreError {
    InvalidAsset,
    Io,
}

impl fmt::Display for AssetStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::InvalidAsset => "资源内容校验失败",
            Self::Io => "资源写入失败",
        })
    }
}

impl std::error::Error for AssetStoreError {}

/// A narrow, app-owned writer for content-addressed image payloads.  It never
/// accepts a caller-selected filename and leaves no partial canonical file.
pub(crate) struct AssetStore {
    save_directory: PathBuf,
}

impl AssetStore {
    pub(crate) fn new(save_directory: impl Into<PathBuf>) -> Self {
        Self {
            save_directory: save_directory.into(),
        }
    }

    /// Verifies claimed MIME/dimensions against the exact encoded bytes, then
    /// publishes those bytes with a same-volume staging file and no-replace
    /// hard link.  `hard_link` is the commit point: it atomically fails rather
    /// than replacing an existing digest path.
    pub(crate) fn store(
        &self,
        bytes: &[u8],
        mime_type: &str,
        width: u32,
        height: u32,
    ) -> Result<StoredAsset, AssetStoreError> {
        let byte_length = bytes.len();
        if !(1..=MAX_ASSET_BYTES).contains(&byte_length)
            || !(1..=MAX_IMAGE_DIMENSION).contains(&width)
            || !(1..=MAX_IMAGE_DIMENSION).contains(&height)
            || validate_encoded_image(bytes, mime_type)? != (width, height)
        {
            return Err(AssetStoreError::InvalidAsset);
        }

        let sha256 = lower_hex(&Sha256::digest(bytes));
        let relative_path = content_addressed_relative_path(&sha256, mime_type)
            .map_err(|_| AssetStoreError::InvalidAsset)?;
        let prefix_directory = self.ensure_prefix_directory(&sha256)?;
        cleanup_staging_files(&prefix_directory)?;
        let canonical_path = self.save_directory.join(&relative_path);

        match fs::symlink_metadata(&canonical_path) {
            Ok(_) => verify_existing_asset(&canonical_path, bytes)?,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                self.write_new_asset(&prefix_directory, &canonical_path, bytes)?;
            }
            Err(_) => return Err(AssetStoreError::Io),
        }

        Ok(StoredAsset {
            sha256,
            relative_path,
            mime_type: mime_type.to_owned(),
            byte_length: u64::try_from(byte_length).map_err(|_| AssetStoreError::InvalidAsset)?,
            width,
            height,
        })
    }

    fn ensure_prefix_directory(&self, sha256: &str) -> Result<PathBuf, AssetStoreError> {
        require_directory(&self.save_directory)?;
        let assets = ensure_child_directory(&self.save_directory, "assets")?;
        let sha256_directory = ensure_child_directory(&assets, "sha256")?;
        ensure_child_directory(&sha256_directory, &sha256[..2])
    }

    fn write_new_asset(
        &self,
        prefix_directory: &Path,
        canonical_path: &Path,
        bytes: &[u8],
    ) -> Result<(), AssetStoreError> {
        let staged = prefix_directory.join(format!("{STAGING_PREFIX}{}", uuid::Uuid::new_v4()));
        let outcome = (|| {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&staged)
                .map_err(|_| AssetStoreError::Io)?;
            file.write_all(bytes).map_err(|_| AssetStoreError::Io)?;
            file.sync_all().map_err(|_| AssetStoreError::Io)?;
            drop(file);
            seal_file(&staged)?;

            match fs::hard_link(&staged, canonical_path) {
                Ok(()) => {
                    fs::remove_file(&staged).map_err(|_| AssetStoreError::Io)?;
                    sync_directory(prefix_directory)?;
                    Ok(())
                }
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                    verify_existing_asset(canonical_path, bytes)?;
                    fs::remove_file(&staged).map_err(|_| AssetStoreError::Io)?;
                    Ok(())
                }
                Err(_) => Err(AssetStoreError::Io),
            }
        })();
        if outcome.is_err() {
            let _ = fs::remove_file(&staged);
        }
        outcome
    }
}

fn ensure_child_directory(parent: &Path, name: &str) -> Result<PathBuf, AssetStoreError> {
    let child = parent.join(name);
    match fs::symlink_metadata(&child) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_dir() => {
            Err(AssetStoreError::Io)
        }
        Ok(_) => Ok(child),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            match fs::create_dir(&child) {
                Ok(()) => sync_directory(parent)?,
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err(AssetStoreError::Io),
            }
            require_directory(&child)?;
            Ok(child)
        }
        Err(_) => Err(AssetStoreError::Io),
    }
}

fn cleanup_staging_files(directory: &Path) -> Result<(), AssetStoreError> {
    let mut removed = false;
    for entry in fs::read_dir(directory).map_err(|_| AssetStoreError::Io)? {
        let entry = entry.map_err(|_| AssetStoreError::Io)?;
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with(STAGING_PREFIX) {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path()).map_err(|_| AssetStoreError::Io)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(AssetStoreError::Io);
        }
        fs::remove_file(entry.path()).map_err(|_| AssetStoreError::Io)?;
        removed = true;
    }
    if removed {
        sync_directory(directory)?;
    }
    Ok(())
}

fn verify_existing_asset(path: &Path, expected: &[u8]) -> Result<(), AssetStoreError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| AssetStoreError::Io)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len()
            != u64::try_from(expected.len()).map_err(|_| AssetStoreError::InvalidAsset)?
    {
        return Err(AssetStoreError::Io);
    }
    if fs::read(path).map_err(|_| AssetStoreError::Io)? != expected {
        return Err(AssetStoreError::Io);
    }
    Ok(())
}

fn require_directory(path: &Path) -> Result<(), AssetStoreError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| AssetStoreError::Io)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(AssetStoreError::Io);
    }
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), AssetStoreError> {
    File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| AssetStoreError::Io)
}

#[cfg(unix)]
fn seal_file(path: &Path) -> Result<(), AssetStoreError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o444)).map_err(|_| AssetStoreError::Io)
}

#[cfg(not(unix))]
fn seal_file(path: &Path) -> Result<(), AssetStoreError> {
    let mut permissions = fs::metadata(path)
        .map_err(|_| AssetStoreError::Io)?
        .permissions();
    permissions.set_readonly(true);
    fs::set_permissions(path, permissions).map_err(|_| AssetStoreError::Io)
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

fn image_dimensions(bytes: &[u8], mime_type: &str) -> Result<(u32, u32), AssetStoreError> {
    match mime_type {
        "image/png" => png_dimensions(bytes),
        "image/jpeg" => jpeg_dimensions(bytes),
        "image/webp" => webp_dimensions(bytes),
        _ => Err(AssetStoreError::InvalidAsset),
    }
}

/// Fully decodes the encoded image after the cheap header check.  Header-only
/// sniffing accepts truncated payloads and is not sufficient for bytes that
/// will later be handed to the WebView image decoder.
pub(crate) fn validate_encoded_image(
    bytes: &[u8],
    mime_type: &str,
) -> Result<(u32, u32), AssetStoreError> {
    let expected_format = match mime_type {
        "image/png" => ImageFormat::Png,
        "image/jpeg" => ImageFormat::Jpeg,
        "image/webp" => ImageFormat::WebP,
        _ => return Err(AssetStoreError::InvalidAsset),
    };
    let header_dimensions = image_dimensions(bytes, mime_type)?;
    let mut reader = ImageReader::with_format(Cursor::new(bytes), expected_format);
    let mut limits = image::Limits::default();
    limits.max_image_width = Some(MAX_IMAGE_DIMENSION);
    limits.max_image_height = Some(MAX_IMAGE_DIMENSION);
    limits.max_alloc = Some((MAX_ASSET_BYTES as u64).saturating_mul(8));
    reader.limits(limits);
    let decoded = reader.decode().map_err(|_| AssetStoreError::InvalidAsset)?;
    let dimensions = (decoded.width(), decoded.height());
    if dimensions != header_dimensions
        || u64::from(dimensions.0).saturating_mul(u64::from(dimensions.1))
            > u64::from(MAX_IMAGE_DIMENSION).saturating_mul(u64::from(MAX_IMAGE_DIMENSION))
    {
        return Err(AssetStoreError::InvalidAsset);
    }
    Ok(dimensions)
}

fn png_dimensions(bytes: &[u8]) -> Result<(u32, u32), AssetStoreError> {
    if bytes.len() < 24
        || bytes[..8] != [137, 80, 78, 71, 13, 10, 26, 10]
        || bytes[8..12] != [0, 0, 0, 13]
        || &bytes[12..16] != b"IHDR"
    {
        return Err(AssetStoreError::InvalidAsset);
    }
    bounded_dimensions(
        u32::from_be_bytes(bytes[16..20].try_into().unwrap_or_default()),
        u32::from_be_bytes(bytes[20..24].try_into().unwrap_or_default()),
    )
}

fn jpeg_dimensions(bytes: &[u8]) -> Result<(u32, u32), AssetStoreError> {
    if bytes.len() < 4 || bytes[..2] != [0xff, 0xd8] {
        return Err(AssetStoreError::InvalidAsset);
    }
    let mut index = 2;
    while index < bytes.len() {
        while index < bytes.len() && bytes[index] != 0xff {
            index += 1;
        }
        while index < bytes.len() && bytes[index] == 0xff {
            index += 1;
        }
        if index >= bytes.len() {
            break;
        }
        let marker = bytes[index];
        index += 1;
        if marker == 0x00 || marker == 0x01 || (0xd0..=0xd8).contains(&marker) {
            continue;
        }
        if index + 2 > bytes.len() {
            break;
        }
        let length = usize::from(u16::from_be_bytes([bytes[index], bytes[index + 1]]));
        if length < 2 || index + length > bytes.len() {
            break;
        }
        if matches!(
            marker,
            0xc0 | 0xc1
                | 0xc2
                | 0xc3
                | 0xc5
                | 0xc6
                | 0xc7
                | 0xc9
                | 0xca
                | 0xcb
                | 0xcd
                | 0xce
                | 0xcf
        ) {
            if length < 7 {
                break;
            }
            return bounded_dimensions(
                u32::from(u16::from_be_bytes([bytes[index + 5], bytes[index + 6]])),
                u32::from(u16::from_be_bytes([bytes[index + 3], bytes[index + 4]])),
            );
        }
        index += length;
    }
    Err(AssetStoreError::InvalidAsset)
}

fn webp_dimensions(bytes: &[u8]) -> Result<(u32, u32), AssetStoreError> {
    if bytes.len() < 30 || &bytes[..4] != b"RIFF" || &bytes[8..12] != b"WEBP" {
        return Err(AssetStoreError::InvalidAsset);
    }
    if usize::try_from(u32::from_le_bytes(
        bytes[4..8].try_into().unwrap_or_default(),
    ))
    .ok()
    .and_then(|length| length.checked_add(8))
        != Some(bytes.len())
    {
        return Err(AssetStoreError::InvalidAsset);
    }
    match &bytes[12..16] {
        b"VP8X" if bytes[21..24] == [0, 0, 0] => bounded_dimensions(
            little_endian_u24(&bytes[24..27]) + 1,
            little_endian_u24(&bytes[27..30]) + 1,
        ),
        b"VP8 " if bytes[23..26] == [0x9d, 0x01, 0x2a] => bounded_dimensions(
            u32::from(u16::from_le_bytes([bytes[26], bytes[27]]) & 0x3fff),
            u32::from(u16::from_le_bytes([bytes[28], bytes[29]]) & 0x3fff),
        ),
        b"VP8L" if bytes[20] == 0x2f => {
            let packed = u32::from_le_bytes(bytes[21..25].try_into().unwrap_or_default());
            bounded_dimensions((packed & 0x3fff) + 1, ((packed >> 14) & 0x3fff) + 1)
        }
        _ => Err(AssetStoreError::InvalidAsset),
    }
}

fn little_endian_u24(bytes: &[u8]) -> u32 {
    u32::from(bytes[0]) | (u32::from(bytes[1]) << 8) | (u32::from(bytes[2]) << 16)
}

fn bounded_dimensions(width: u32, height: u32) -> Result<(u32, u32), AssetStoreError> {
    if !(1..=MAX_IMAGE_DIMENSION).contains(&width) || !(1..=MAX_IMAGE_DIMENSION).contains(&height) {
        return Err(AssetStoreError::InvalidAsset);
    }
    Ok((width, height))
}

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
        content_addressed_relative_path, lower_hex, validate_encoded_image,
        validate_lowercase_sha256, validate_stored_asset_path, AssetPathError, AssetStore,
        AssetStoreError, STAGING_PREFIX,
    };
    use base64::Engine as _;
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    const SHA256: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

    struct TestRoot(std::path::PathBuf);

    impl TestRoot {
        fn new(label: &str) -> Self {
            let id = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "cloud-inn-assets-{label}-{}-{id}",
                std::process::id()
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
        ];
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes
    }

    fn valid_png() -> Vec<u8> {
        base64::engine::general_purpose::STANDARD
            .decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=")
            .unwrap()
    }

    fn jpeg_header(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = vec![0xff, 0xd8, 0xff, 0xc0, 0, 7, 8];
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes
    }

    fn webp_header(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![0; 30];
        bytes[..4].copy_from_slice(b"RIFF");
        bytes[4..8].copy_from_slice(&22_u32.to_le_bytes());
        bytes[8..12].copy_from_slice(b"WEBP");
        bytes[12..16].copy_from_slice(b"VP8X");
        for (offset, value) in [width - 1, height - 1].into_iter().enumerate() {
            let start = 24 + offset * 3;
            let encoded = value.to_le_bytes();
            bytes[start..start + 3].copy_from_slice(&encoded[..3]);
        }
        bytes
    }

    #[test]
    fn rejects_header_valid_but_truncated_supported_images() {
        for (bytes, mime_type) in [
            (png_header(1, 1), "image/png"),
            (jpeg_header(1, 1), "image/jpeg"),
            (webp_header(1, 1), "image/webp"),
        ] {
            assert_eq!(
                validate_encoded_image(&bytes, mime_type),
                Err(AssetStoreError::InvalidAsset),
                "{mime_type} header without a decodable image payload must be rejected"
            );
        }
    }

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

    #[test]
    fn asset_store_deduplicates_identical_verified_content() {
        let root = TestRoot::new("dedupe");
        let bytes = valid_png();
        let store = AssetStore::new(&root.0);
        let first = store.store(&bytes, "image/png", 1, 1).unwrap();
        let second = store.store(&bytes, "image/png", 1, 1).unwrap();
        let digest = lower_hex(&Sha256::digest(&bytes));

        assert_eq!(first, second);
        assert_eq!(first.sha256, digest);
        assert_eq!(fs::read(root.0.join(&first.relative_path)).unwrap(), bytes);
        assert_eq!(
            fs::read_dir(root.0.join("assets/sha256").join(&digest[..2]))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn asset_store_rejects_invalid_bytes_mime_and_claimed_dimensions() {
        let root = TestRoot::new("invalid");
        let store = AssetStore::new(&root.0);
        assert_eq!(
            store.store(b"not an image", "image/png", 1, 1),
            Err(AssetStoreError::InvalidAsset)
        );
        assert_eq!(
            store.store(&png_header(1, 1), "image/gif", 1, 1),
            Err(AssetStoreError::InvalidAsset)
        );
        assert_eq!(
            store.store(&png_header(1, 1), "image/png", 2, 1),
            Err(AssetStoreError::InvalidAsset)
        );
    }

    #[test]
    fn asset_store_removes_only_its_stale_staging_file_before_retry() {
        let root = TestRoot::new("staging-cleanup");
        let bytes = valid_png();
        let digest = lower_hex(&Sha256::digest(&bytes));
        let prefix = root.0.join("assets/sha256").join(&digest[..2]);
        fs::create_dir_all(&prefix).unwrap();
        let stale = prefix.join(format!("{STAGING_PREFIX}interrupted"));
        fs::write(&stale, b"partial").unwrap();

        let stored = AssetStore::new(&root.0)
            .store(&bytes, "image/png", 1, 1)
            .unwrap();

        assert!(!stale.exists());
        assert!(root.0.join(stored.relative_path).is_file());
    }
}
