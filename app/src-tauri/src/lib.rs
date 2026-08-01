pub mod cross_database_validation;
pub mod generation_jobs;
mod keychain;
mod persistence;
pub mod provider_control;
pub mod redaction;
mod reliability;
mod save_validation;

#[tauri::command]
fn provider_token_status(
    service: tauri::State<'_, keychain::PlatformKeychainService>,
) -> keychain::ProviderTokenStatus {
    service.status()
}

#[tauri::command]
fn set_provider_token(
    service: tauri::State<'_, keychain::PlatformKeychainService>,
    token: String,
) -> Result<keychain::ProviderTokenStatus, redaction::SafeError> {
    service.set_token(token)
}

#[tauri::command]
fn delete_provider_token(
    service: tauri::State<'_, keychain::PlatformKeychainService>,
) -> Result<keychain::ProviderTokenStatus, redaction::SafeError> {
    service.delete_token()
}

#[tauri::command]
fn load_game(
    app: tauri::AppHandle,
    save_id: String,
) -> Result<Option<serde_json::Value>, redaction::SafeError> {
    use tauri::Manager;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| redaction::app_storage_error())?;
    persistence::SaveRepository::new(root)
        .load_game(&save_id)
        .map_err(redaction::persistence_load_error)
}

#[tauri::command]
fn commit_game(
    app: tauri::AppHandle,
    expected_revision: i64,
    game: serde_json::Value,
) -> Result<(), redaction::SafeError> {
    use tauri::Manager;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| redaction::app_storage_error())?;
    persistence::SaveRepository::new(root)
        .commit_game(expected_revision, game)
        .map_err(redaction::persistence_commit_error)
}

#[tauri::command]
fn list_saves(
    app: tauri::AppHandle,
) -> Result<Vec<persistence::SaveSummary>, redaction::SafeError> {
    use tauri::Manager;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| redaction::app_storage_error())?;
    persistence::SaveRepository::new(root).list_saves()
}

#[tauri::command]
fn create_save(
    app: tauri::AppHandle,
    display_name: Option<String>,
) -> Result<persistence::SaveSummary, redaction::SafeError> {
    use tauri::Manager;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| redaction::app_storage_error())?;
    persistence::SaveRepository::new(root).create_save(display_name)
}

#[tauri::command]
fn rename_save(
    app: tauri::AppHandle,
    save_id: String,
    display_name: String,
    expected_metadata_revision: i64,
) -> Result<persistence::SaveSummary, redaction::SafeError> {
    use tauri::Manager;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| redaction::app_storage_error())?;
    persistence::SaveRepository::new(root).rename_save(
        &save_id,
        display_name,
        expected_metadata_revision,
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    redaction::install_panic_hook();
    tauri::Builder::default()
        .setup(|app| {
            use tauri::Manager;
            let service = keychain::platform_service(&app.config().identifier)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            app.manage(service);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            load_game,
            commit_game,
            list_saves,
            create_save,
            rename_save,
            provider_token_status,
            set_provider_token,
            delete_provider_token
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
