use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::fmt;
use std::fs::{self, File};
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// SHA-256 over every non-internal v7 table, index and trigger, ordered by
/// `(type, name)`. Each record contains length-prefixed type, name and
/// normalized SQL fields.
///
/// Normalization removes ASCII whitespace and statement terminators outside
/// quoted SQL tokens and folds only unquoted ASCII case. Quoted values remain
/// byte-exact so changes to CHECK values cannot hide behind normalization.
pub(crate) const SAVE_V7_SCHEMA_FINGERPRINT: &str =
    "0db0cdf1152afd85423644ebc2b48b360c2c7e624741a66446f8268aa1f9e368";

const MAX_ASSET_BYTES: u64 = 100_663_296;
const MAX_IMAGE_DIMENSION: u32 = 16_384;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SaveValidationError {
    Schema,
    Identity,
    AssetRegistry,
}

impl fmt::Display for SaveValidationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Schema => "存档结构校验失败",
            Self::Identity => "存档身份校验失败",
            Self::AssetRegistry => "存档资源校验失败",
        })
    }
}

impl std::error::Error for SaveValidationError {}

pub(crate) fn validate_v7_schema_fingerprint(
    connection: &Connection,
) -> Result<(), SaveValidationError> {
    let fingerprint = current_schema_fingerprint(connection)?;
    if fingerprint != SAVE_V7_SCHEMA_FINGERPRINT {
        return Err(SaveValidationError::Schema);
    }
    Ok(())
}

pub(crate) fn current_schema_fingerprint(
    connection: &Connection,
) -> Result<String, SaveValidationError> {
    let mut statement = connection
        .prepare(
            "SELECT type,name,sql
             FROM sqlite_schema
             WHERE type IN ('table','index','trigger')
               AND name NOT GLOB 'sqlite_*'
               AND sql IS NOT NULL
             ORDER BY type,name",
        )
        .map_err(|_| SaveValidationError::Schema)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|_| SaveValidationError::Schema)?;

    let mut hasher = Sha256::new();
    for row in rows {
        let (object_type, name, sql) = row.map_err(|_| SaveValidationError::Schema)?;
        hash_schema_field(&mut hasher, object_type.as_bytes());
        hash_schema_field(&mut hasher, name.as_bytes());
        hash_schema_field(&mut hasher, &normalize_schema_sql(&sql));
    }
    Ok(lower_hex(&hasher.finalize()))
}

fn hash_schema_field(hasher: &mut Sha256, field: &[u8]) {
    hasher.update((field.len() as u64).to_be_bytes());
    hasher.update(field);
}

fn normalize_schema_sql(sql: &str) -> Vec<u8> {
    #[derive(Clone, Copy)]
    enum Quote {
        Single,
        Double,
        Backtick,
        Bracket,
    }

    let bytes = sql.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut quote = None;
    let mut index = 0;
    while index < bytes.len() {
        let byte = bytes[index];
        if let Some(active) = quote {
            output.push(byte);
            let terminator = match active {
                Quote::Single => b'\'',
                Quote::Double => b'"',
                Quote::Backtick => b'`',
                Quote::Bracket => b']',
            };
            if byte == terminator {
                if !matches!(active, Quote::Bracket)
                    && bytes.get(index + 1).copied() == Some(terminator)
                {
                    output.push(terminator);
                    index += 1;
                } else {
                    quote = None;
                }
            }
        } else {
            quote = match byte {
                b'\'' => Some(Quote::Single),
                b'"' => Some(Quote::Double),
                b'`' => Some(Quote::Backtick),
                b'[' => Some(Quote::Bracket),
                _ => None,
            };
            if quote.is_some() {
                output.push(byte);
            } else if !byte.is_ascii_whitespace() && byte != b';' {
                output.push(byte.to_ascii_lowercase());
            }
        }
        index += 1;
    }
    output
}

pub(crate) fn validate_single_save_identity(
    connection: &Connection,
    expected_save_id: &str,
    allow_empty: bool,
) -> Result<(), SaveValidationError> {
    if expected_save_id.is_empty()
        || !expected_save_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
    {
        return Err(SaveValidationError::Identity);
    }

    let mut statement = connection
        .prepare("SELECT save_id FROM saves ORDER BY save_id LIMIT 2")
        .map_err(|_| SaveValidationError::Identity)?;
    let mut rows = statement
        .query([])
        .map_err(|_| SaveValidationError::Identity)?;
    let first = rows
        .next()
        .map_err(|_| SaveValidationError::Identity)?
        .map(|row| row.get::<_, String>(0))
        .transpose()
        .map_err(|_| SaveValidationError::Identity)?;
    let has_second = rows
        .next()
        .map_err(|_| SaveValidationError::Identity)?
        .is_some();

    match (first.as_deref(), has_second, allow_empty) {
        (None, false, true) => Ok(()),
        (Some(actual), false, _) if actual == expected_save_id => Ok(()),
        _ => Err(SaveValidationError::Identity),
    }
}

pub(crate) fn validate_asset_registry(
    connection: &Connection,
    save_dir: &Path,
) -> Result<(), SaveValidationError> {
    let mut statement = connection
        .prepare(
            "SELECT relative_path,sha256,mime_type,byte_length,width,height
             FROM assets
             ORDER BY asset_id",
        )
        .map_err(|_| SaveValidationError::AssetRegistry)?;
    let rows = statement
        .query_map([], |row| {
            Ok(AssetRecord {
                relative_path: row.get(0)?,
                sha256: row.get(1)?,
                mime_type: row.get(2)?,
                byte_length: row.get(3)?,
                width: row.get(4)?,
                height: row.get(5)?,
            })
        })
        .map_err(|_| SaveValidationError::AssetRegistry)?;

    for row in rows {
        validate_asset_record(
            save_dir,
            &row.map_err(|_| SaveValidationError::AssetRegistry)?,
        )?;
    }
    Ok(())
}

struct AssetRecord {
    relative_path: String,
    sha256: String,
    mime_type: String,
    byte_length: i64,
    width: i64,
    height: i64,
}

fn validate_asset_record(save_dir: &Path, record: &AssetRecord) -> Result<(), SaveValidationError> {
    if record.sha256.len() != 64
        || !record
            .sha256
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        return Err(SaveValidationError::AssetRegistry);
    }
    let extension = match record.mime_type.as_str() {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        _ => return Err(SaveValidationError::AssetRegistry),
    };
    let expected_relative_path = format!(
        "assets/sha256/{}/{}.{}",
        &record.sha256[..2],
        record.sha256,
        extension
    );
    if record.relative_path != expected_relative_path {
        return Err(SaveValidationError::AssetRegistry);
    }

    let byte_length =
        u64::try_from(record.byte_length).map_err(|_| SaveValidationError::AssetRegistry)?;
    let width = u32::try_from(record.width).map_err(|_| SaveValidationError::AssetRegistry)?;
    let height = u32::try_from(record.height).map_err(|_| SaveValidationError::AssetRegistry)?;
    if !(1..=MAX_ASSET_BYTES).contains(&byte_length)
        || !(1..=MAX_IMAGE_DIMENSION).contains(&width)
        || !(1..=MAX_IMAGE_DIMENSION).contains(&height)
    {
        return Err(SaveValidationError::AssetRegistry);
    }

    let assets_dir = save_dir.join("assets");
    let hash_dir = assets_dir.join("sha256");
    let prefix_dir = hash_dir.join(&record.sha256[..2]);
    for directory in [&assets_dir, &hash_dir, &prefix_dir] {
        let metadata =
            fs::symlink_metadata(directory).map_err(|_| SaveValidationError::AssetRegistry)?;
        if metadata.file_type().is_symlink() || !metadata.is_dir() {
            return Err(SaveValidationError::AssetRegistry);
        }
    }

    let path = save_dir.join(&record.relative_path);
    let metadata = fs::symlink_metadata(&path).map_err(|_| SaveValidationError::AssetRegistry)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() != byte_length {
        return Err(SaveValidationError::AssetRegistry);
    }

    let actual_sha256 = sha256_file(&path)?;
    if actual_sha256 != record.sha256 {
        return Err(SaveValidationError::AssetRegistry);
    }
    let (actual_width, actual_height) = image_dimensions(&path, &record.mime_type, byte_length)?;
    if actual_width != width || actual_height != height {
        return Err(SaveValidationError::AssetRegistry);
    }
    Ok(())
}

fn sha256_file(path: &Path) -> Result<String, SaveValidationError> {
    let mut file = File::open(path).map_err(|_| SaveValidationError::AssetRegistry)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| SaveValidationError::AssetRegistry)?;
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

fn image_dimensions(
    path: &Path,
    mime_type: &str,
    byte_length: u64,
) -> Result<(u32, u32), SaveValidationError> {
    match mime_type {
        "image/png" => png_dimensions(path),
        "image/jpeg" => jpeg_dimensions(path),
        "image/webp" => webp_dimensions(path, byte_length),
        _ => Err(SaveValidationError::AssetRegistry),
    }
}

fn png_dimensions(path: &Path) -> Result<(u32, u32), SaveValidationError> {
    let mut header = [0_u8; 24];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .map_err(|_| SaveValidationError::AssetRegistry)?;
    if header[..8] != [137, 80, 78, 71, 13, 10, 26, 10]
        || header[8..12] != [0, 0, 0, 13]
        || &header[12..16] != b"IHDR"
    {
        return Err(SaveValidationError::AssetRegistry);
    }
    bounded_dimensions(
        u32::from_be_bytes(header[16..20].try_into().unwrap_or_default()),
        u32::from_be_bytes(header[20..24].try_into().unwrap_or_default()),
    )
}

fn jpeg_dimensions(path: &Path) -> Result<(u32, u32), SaveValidationError> {
    let mut reader =
        BufReader::new(File::open(path).map_err(|_| SaveValidationError::AssetRegistry)?);
    let mut signature = [0_u8; 2];
    reader
        .read_exact(&mut signature)
        .map_err(|_| SaveValidationError::AssetRegistry)?;
    if signature != [0xff, 0xd8] {
        return Err(SaveValidationError::AssetRegistry);
    }

    loop {
        let marker = next_jpeg_marker(&mut reader)?;
        if matches!(marker, 0xd9 | 0xda) {
            return Err(SaveValidationError::AssetRegistry);
        }
        if marker == 0x01 || (0xd0..=0xd8).contains(&marker) {
            continue;
        }
        let mut length_bytes = [0_u8; 2];
        reader
            .read_exact(&mut length_bytes)
            .map_err(|_| SaveValidationError::AssetRegistry)?;
        let segment_length = u16::from_be_bytes(length_bytes);
        if segment_length < 2 {
            return Err(SaveValidationError::AssetRegistry);
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
            if segment_length < 7 {
                return Err(SaveValidationError::AssetRegistry);
            }
            let mut dimensions = [0_u8; 5];
            reader
                .read_exact(&mut dimensions)
                .map_err(|_| SaveValidationError::AssetRegistry)?;
            return bounded_dimensions(
                u32::from(u16::from_be_bytes([dimensions[3], dimensions[4]])),
                u32::from(u16::from_be_bytes([dimensions[1], dimensions[2]])),
            );
        }
        reader
            .seek(SeekFrom::Current(i64::from(segment_length - 2)))
            .map_err(|_| SaveValidationError::AssetRegistry)?;
    }
}

fn next_jpeg_marker(reader: &mut BufReader<File>) -> Result<u8, SaveValidationError> {
    let mut byte = [0_u8; 1];
    loop {
        reader
            .read_exact(&mut byte)
            .map_err(|_| SaveValidationError::AssetRegistry)?;
        if byte[0] != 0xff {
            continue;
        }
        loop {
            reader
                .read_exact(&mut byte)
                .map_err(|_| SaveValidationError::AssetRegistry)?;
            if byte[0] != 0xff {
                break;
            }
        }
        if byte[0] != 0x00 {
            return Ok(byte[0]);
        }
    }
}

fn webp_dimensions(path: &Path, byte_length: u64) -> Result<(u32, u32), SaveValidationError> {
    let mut header = [0_u8; 30];
    File::open(path)
        .and_then(|mut file| file.read_exact(&mut header))
        .map_err(|_| SaveValidationError::AssetRegistry)?;
    if &header[..4] != b"RIFF" || &header[8..12] != b"WEBP" {
        return Err(SaveValidationError::AssetRegistry);
    }
    let declared_length = u64::from(u32::from_le_bytes(
        header[4..8].try_into().unwrap_or_default(),
    )) + 8;
    if declared_length != byte_length {
        return Err(SaveValidationError::AssetRegistry);
    }

    match &header[12..16] {
        b"VP8X" if header[21..24] == [0, 0, 0] => bounded_dimensions(
            little_endian_u24(&header[24..27]) + 1,
            little_endian_u24(&header[27..30]) + 1,
        ),
        b"VP8 " if header[23..26] == [0x9d, 0x01, 0x2a] => bounded_dimensions(
            u32::from(u16::from_le_bytes([header[26], header[27]]) & 0x3fff),
            u32::from(u16::from_le_bytes([header[28], header[29]]) & 0x3fff),
        ),
        b"VP8L" if header[20] == 0x2f => {
            let packed = u32::from_le_bytes(header[21..25].try_into().unwrap_or_default());
            bounded_dimensions((packed & 0x3fff) + 1, ((packed >> 14) & 0x3fff) + 1)
        }
        _ => Err(SaveValidationError::AssetRegistry),
    }
}

fn little_endian_u24(bytes: &[u8]) -> u32 {
    u32::from(bytes[0]) | (u32::from(bytes[1]) << 8) | (u32::from(bytes[2]) << 16)
}

fn bounded_dimensions(width: u32, height: u32) -> Result<(u32, u32), SaveValidationError> {
    if !(1..=MAX_IMAGE_DIMENSION).contains(&width) || !(1..=MAX_IMAGE_DIMENSION).contains(&height) {
        return Err(SaveValidationError::AssetRegistry);
    }
    Ok((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_ROOT: AtomicU64 = AtomicU64::new(1);

    struct TestRoot(std::path::PathBuf);

    impl TestRoot {
        fn new(label: &str) -> Self {
            let id = NEXT_ROOT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "cloud-inn-save-validation-{label}-{}-{id}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create test root");
            Self(path)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn create_current_schema(connection: &Connection) {
        connection
            .execute_batch(include_str!("../migrations/001_initial.sql"))
            .expect("initial schema");
        connection
            .execute_batch(
                "CREATE UNIQUE INDEX IF NOT EXISTS room_blueprints_save_blueprint
                   ON room_blueprints(save_id, blueprint_id);
                 ALTER TABLE room_blueprints ADD COLUMN openings_json TEXT;
                 ALTER TABLE saves ADD COLUMN operations_json TEXT;
                 CREATE TRIGGER IF NOT EXISTS saves_phase4_json_insert_check
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
            .expect("legacy migrations");
        connection
            .execute_batch(include_str!("../migrations/007_reliability.sql"))
            .expect("v7 schema");
    }

    fn insert_save(connection: &Connection, save_id: &str) {
        connection
            .execute(
                "INSERT INTO saves(
                   save_id,schema_version,ruleset_version,revision,phase,current_day,
                   cash_cents,rate_cents,updated_at
                 ) VALUES(?1,1,'1',0,'design',0,1,1,'now')",
                [save_id],
            )
            .expect("insert save");
    }

    fn png_header(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = vec![
            137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, b'I', b'H', b'D', b'R',
        ];
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes
    }

    fn jpeg_bytes(width: u16, height: u16) -> Vec<u8> {
        let mut bytes = vec![0xff, 0xd8, 0xff, 0xc0, 0, 17, 8];
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&[3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9]);
        bytes
    }

    fn webp_vp8x_bytes(width: u32, height: u32) -> Vec<u8> {
        let mut bytes = Vec::from(b"RIFF".as_slice());
        bytes.extend_from_slice(&22_u32.to_le_bytes());
        bytes.extend_from_slice(b"WEBPVP8X");
        bytes.extend_from_slice(&10_u32.to_le_bytes());
        bytes.extend_from_slice(&[0x10, 0, 0, 0]);
        for dimension in [width - 1, height - 1] {
            bytes.extend_from_slice(&dimension.to_le_bytes()[..3]);
        }
        bytes
    }

    fn insert_asset(
        connection: &Connection,
        save_dir: &Path,
        bytes: &[u8],
        width: i64,
        height: i64,
        mime_type: &str,
        extension: &str,
    ) -> (String, std::path::PathBuf) {
        let sha256 = lower_hex(&Sha256::digest(bytes));
        let relative_path = format!("assets/sha256/{}/{}.{}", &sha256[..2], sha256, extension);
        let path = save_dir.join(&relative_path);
        fs::create_dir_all(path.parent().expect("asset parent")).expect("create asset tree");
        fs::write(&path, bytes).expect("write asset");
        connection
            .execute(
                "INSERT INTO assets(
                   asset_id,relative_path,sha256,mime_type,byte_length,width,height,created_at_ms
                 ) VALUES('asset-1',?1,?2,?3,?4,?5,?6,0)",
                params![
                    relative_path,
                    sha256,
                    mime_type,
                    i64::try_from(bytes.len()).unwrap(),
                    width,
                    height
                ],
            )
            .expect("insert asset");
        (sha256, path)
    }

    #[test]
    fn v7_schema_matches_frozen_fingerprint() {
        let connection = Connection::open_in_memory().unwrap();
        create_current_schema(&connection);

        assert_eq!(
            current_schema_fingerprint(&connection).unwrap(),
            SAVE_V7_SCHEMA_FINGERPRINT
        );
        assert_eq!(validate_v7_schema_fingerprint(&connection), Ok(()));
    }

    #[test]
    fn schema_normalization_preserves_quoted_check_values() {
        assert_eq!(
            normalize_schema_sql(" CREATE TABLE T ( value TEXT CHECK (value = 'A B') ); "),
            b"createtablet(valuetextcheck(value='A B'))"
        );
        assert_ne!(
            normalize_schema_sql("CREATE TABLE t(value TEXT CHECK(value='A B'))"),
            normalize_schema_sql("CREATE TABLE t(value TEXT CHECK(value='a b'))")
        );
    }

    #[test]
    fn same_named_weakened_table_fails_schema_fingerprint() {
        let connection = Connection::open_in_memory().unwrap();
        create_current_schema(&connection);
        connection
            .execute_batch("DROP TABLE assets; CREATE TABLE assets(asset_id TEXT);")
            .unwrap();

        assert_eq!(
            validate_v7_schema_fingerprint(&connection),
            Err(SaveValidationError::Schema)
        );
    }

    #[test]
    fn save_identity_allows_only_empty_or_one_expected_row() {
        let connection = Connection::open_in_memory().unwrap();
        create_current_schema(&connection);
        assert_eq!(
            validate_single_save_identity(&connection, "save-1", true),
            Ok(())
        );
        assert_eq!(
            validate_single_save_identity(&connection, "save-1", false),
            Err(SaveValidationError::Identity)
        );

        insert_save(&connection, "save-1");
        assert_eq!(
            validate_single_save_identity(&connection, "save-1", false),
            Ok(())
        );
        assert_eq!(
            validate_single_save_identity(&connection, "save-2", false),
            Err(SaveValidationError::Identity)
        );
        insert_save(&connection, "save-2");
        assert_eq!(
            validate_single_save_identity(&connection, "save-1", false),
            Err(SaveValidationError::Identity)
        );
    }

    #[test]
    fn asset_registry_accepts_matching_content_addressed_png() {
        let root = TestRoot::new("asset-ok");
        let connection = Connection::open_in_memory().unwrap();
        create_current_schema(&connection);
        let bytes = png_header(17, 23);
        insert_asset(&connection, &root.0, &bytes, 17, 23, "image/png", "png");

        assert_eq!(validate_asset_registry(&connection, &root.0), Ok(()));
    }

    #[test]
    fn asset_registry_accepts_supported_jpeg_and_webp_magic() {
        let cases = [
            ("jpeg", jpeg_bytes(17, 23), "image/jpeg", "jpg"),
            ("webp", webp_vp8x_bytes(17, 23), "image/webp", "webp"),
        ];
        for (label, bytes, mime_type, extension) in cases {
            let root = TestRoot::new(label);
            let connection = Connection::open_in_memory().unwrap();
            create_current_schema(&connection);
            insert_asset(&connection, &root.0, &bytes, 17, 23, mime_type, extension);
            assert_eq!(
                validate_asset_registry(&connection, &root.0),
                Ok(()),
                "{label}"
            );
        }
    }

    #[test]
    fn asset_registry_rejects_hash_magic_and_dimension_mismatch() {
        for (label, mutation) in ["hash", "magic", "dimension"].into_iter().enumerate() {
            let root = TestRoot::new(mutation);
            let connection = Connection::open_in_memory().unwrap();
            create_current_schema(&connection);
            let bytes = png_header(17, 23);
            let (_sha256, path) =
                insert_asset(&connection, &root.0, &bytes, 17, 23, "image/png", "png");
            match label {
                0 => {
                    let mut changed = bytes.clone();
                    changed[23] ^= 1;
                    fs::write(path, changed).unwrap();
                }
                1 => {
                    connection
                        .execute("UPDATE assets SET mime_type='image/webp'", [])
                        .unwrap();
                }
                _ => {
                    connection
                        .execute("UPDATE assets SET width=18", [])
                        .unwrap();
                }
            }
            assert_eq!(
                validate_asset_registry(&connection, &root.0),
                Err(SaveValidationError::AssetRegistry),
                "{mutation}"
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn asset_registry_rejects_symlinked_asset() {
        use std::os::unix::fs::symlink;

        let root = TestRoot::new("asset-symlink");
        let connection = Connection::open_in_memory().unwrap();
        create_current_schema(&connection);
        let bytes = png_header(17, 23);
        let (_sha256, path) =
            insert_asset(&connection, &root.0, &bytes, 17, 23, "image/png", "png");
        let target = root.0.join("outside.png");
        fs::write(&target, bytes).unwrap();
        fs::remove_file(&path).unwrap();
        symlink(&target, &path).unwrap();

        assert_eq!(
            validate_asset_registry(&connection, &root.0),
            Err(SaveValidationError::AssetRegistry)
        );
    }
}
