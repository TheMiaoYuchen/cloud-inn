use crate::reliability::validate_current_save_database;
use crate::save_validation::{validate_asset_catalog, validate_single_save_identity};
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{Read, Take};
use std::path::PathBuf;
use std::sync::RwLock;
use tauri::http::{header, Method, Request, Response, StatusCode};

const MAX_ASSET_BYTES: u64 = 100_663_296;

pub struct AssetProtocolState {
    app_root: PathBuf,
    active_save_id: RwLock<Option<String>>,
}

impl AssetProtocolState {
    pub fn new(app_root: PathBuf) -> Self {
        Self {
            app_root,
            active_save_id: RwLock::new(None),
        }
    }

    pub fn activate(&self, save_id: &str) -> Result<(), ()> {
        if !valid_save_id(save_id) {
            return Err(());
        }
        let save_directory = self.app_root.join("saves").join(save_id);
        let database = save_directory.join("save.sqlite3");
        let directory_metadata = fs::symlink_metadata(&save_directory).map_err(|_| ())?;
        let database_metadata = fs::symlink_metadata(&database).map_err(|_| ())?;
        if directory_metadata.file_type().is_symlink()
            || !directory_metadata.is_dir()
            || database_metadata.file_type().is_symlink()
            || !database_metadata.is_file()
        {
            return Err(());
        }
        let connection = Connection::open_with_flags(
            database,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|_| ())?;
        connection
            .execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;")
            .map_err(|_| ())?;
        validate_current_save_database(&connection).map_err(|_| ())?;
        validate_single_save_identity(&connection, save_id, false).map_err(|_| ())?;
        validate_asset_catalog(&connection).map_err(|_| ())?;
        *self.active_save_id.write().map_err(|_| ())? = Some(save_id.to_owned());
        Ok(())
    }
}

pub fn respond(state: &AssetProtocolState, request: &Request<Vec<u8>>) -> Response<Vec<u8>> {
    if request.method() != Method::GET
        || request.uri().query().is_some()
        || request.uri().path() != "/"
    {
        return empty(StatusCode::NOT_FOUND);
    }
    let Some(asset_id) = request.uri().host() else {
        return empty(StatusCode::NOT_FOUND);
    };
    if !is_sha256(asset_id) {
        return empty(StatusCode::NOT_FOUND);
    }
    let Ok(active) = state.active_save_id.read() else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Some(save_id) = active.as_deref() else {
        return empty(StatusCode::NOT_FOUND);
    };
    let save_directory = state.app_root.join("saves").join(save_id);
    let database = save_directory.join("save.sqlite3");
    let Ok(directory_metadata) = fs::symlink_metadata(&save_directory) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Ok(database_metadata) = fs::symlink_metadata(&database) else {
        return empty(StatusCode::NOT_FOUND);
    };
    if directory_metadata.file_type().is_symlink()
        || !directory_metadata.is_dir()
        || database_metadata.file_type().is_symlink()
        || !database_metadata.is_file()
    {
        return empty(StatusCode::NOT_FOUND);
    }
    let Ok(connection) = Connection::open_with_flags(
        &database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    ) else {
        return empty(StatusCode::NOT_FOUND);
    };
    if connection
        .execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON;")
        .is_err()
        || validate_current_save_database(&connection).is_err()
        || validate_asset_catalog(&connection).is_err()
    {
        return empty(StatusCode::NOT_FOUND);
    }
    let asset = connection.query_row(
        "SELECT relative_path,mime_type,byte_length FROM assets WHERE asset_id=?1 AND sha256=?1",
        [asset_id],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?)),
    ).optional();
    let Ok(Some((relative_path, mime_type, byte_length))) = asset else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Ok(expected_length) = u64::try_from(byte_length) else {
        return empty(StatusCode::NOT_FOUND);
    };
    if !(1..=MAX_ASSET_BYTES).contains(&expected_length) {
        return empty(StatusCode::NOT_FOUND);
    }
    let path = save_directory.join(relative_path);
    let Ok(mut file) = File::open(&path) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Ok(opened) = file.metadata() else {
        return empty(StatusCode::NOT_FOUND);
    };
    let Ok(named) = fs::symlink_metadata(&path) else {
        return empty(StatusCode::NOT_FOUND);
    };
    if named.file_type().is_symlink() || !opened.is_file() || opened.len() != expected_length {
        return empty(StatusCode::NOT_FOUND);
    }
    let mut bytes = Vec::with_capacity(expected_length as usize);
    let mut bounded: Take<&mut File> = file.by_ref().take(expected_length + 1);
    if bounded.read_to_end(&mut bytes).is_err()
        || bytes.len() as u64 != expected_length
        || lower_hex(&Sha256::digest(&bytes)) != asset_id
    {
        return empty(StatusCode::NOT_FOUND);
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime_type)
        .header(
            header::CACHE_CONTROL,
            "private, max-age=31536000, immutable",
        )
        .header("X-Content-Type-Options", "nosniff")
        .body(bytes)
        .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR))
}

fn empty(status: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(status)
        .header(header::CACHE_CONTROL, "no-store")
        .header("X-Content-Type-Options", "nosniff")
        .body(Vec::new())
        .unwrap_or_else(|_| Response::new(Vec::new()))
}

fn valid_save_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::persistence::SaveRepository;
    use std::path::PathBuf;

    #[test]
    fn resolver_identity_and_save_scope_are_strict() {
        assert!(is_sha256(&"a".repeat(64)));
        assert!(!is_sha256(&"A".repeat(64)));
        assert!(!is_sha256("../asset"));
        assert!(valid_save_id("save-1"));
        assert!(!valid_save_id("../save-1"));
    }

    #[test]
    fn activation_requires_an_existing_valid_matching_save() {
        let root = TestRoot::new();
        let repository = SaveRepository::new(root.0.clone());
        let save = repository
            .create_save(Some("Asset Save".to_owned()))
            .unwrap();
        let state = AssetProtocolState::new(root.0.clone());

        assert!(state.activate(save.save_id()).is_ok());
        assert!(state.activate("missing-save").is_err());
        let mismatched = root.0.join("saves").join("mismatched-save");
        fs::create_dir(&mismatched).unwrap();
        fs::copy(
            root.0
                .join("saves")
                .join(save.save_id())
                .join("save.sqlite3"),
            mismatched.join("save.sqlite3"),
        )
        .unwrap();
        assert!(state.activate("mismatched-save").is_err());
        assert_eq!(
            state.active_save_id.read().unwrap().as_deref(),
            Some(save.save_id())
        );
    }

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "cloud-inn-asset-protocol-test-{}",
                uuid::Uuid::new_v4()
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
}
