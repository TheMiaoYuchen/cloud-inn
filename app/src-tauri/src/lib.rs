#[allow(dead_code)]
mod archive;
mod asset_protocol;
#[allow(dead_code)]
mod assets;
pub mod cross_database_validation;
pub mod generation_jobs;
mod keychain;
mod persistence;
#[allow(dead_code)]
mod provider;
pub mod provider_control;
// Recovery packages are introduced before the write coordinator wires them in.
#[allow(dead_code)]
mod recovery;
pub mod redaction;
mod reliability;
mod save_validation;
mod shell;
#[allow(dead_code)]
mod visual_runtime;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderHealthProjection {
    credential: keychain::ProviderTokenStatus,
    reachability: &'static str,
    primary_model_available: Option<bool>,
    fallback_model_available: Option<bool>,
    checked_at_ms: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<&'static str>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ArchiveExportProjection {
    archive_version: u32,
    suggested_file_name: String,
    byte_length: u64,
    sha256: String,
}

#[tauri::command]
fn check_provider(
    keychain: tauri::State<'_, keychain::PlatformKeychainService>,
    provider: tauri::State<'_, provider::ApiNebulaProvider>,
) -> ProviderHealthProjection {
    use keychain::ProviderCredentialState;
    let credential = keychain.status();
    let unavailable = |error_code| ProviderHealthProjection {
        credential,
        reachability: "unknown",
        primary_model_available: None,
        fallback_model_available: None,
        checked_at_ms: None,
        error_code: Some(error_code),
    };
    match credential.state() {
        ProviderCredentialState::Missing => return unavailable("keychain.missing"),
        ProviderCredentialState::Locked => return unavailable("keychain.locked"),
        ProviderCredentialState::Denied => return unavailable("keychain.denied"),
        ProviderCredentialState::Unavailable => return unavailable("keychain.unavailable"),
        ProviderCredentialState::Available => {}
    }
    let Ok(Some(token)) = keychain.read_token_for_native_provider() else {
        return unavailable("keychain.unavailable");
    };
    let checked_at_ms = current_time_ms().ok();
    match provider.check_health(token.expose_for_native_provider()) {
        Ok(health) => ProviderHealthProjection {
            credential,
            reachability: "reachable",
            primary_model_available: Some(health.primary_available),
            fallback_model_available: Some(health.fallback_available),
            checked_at_ms,
            error_code: None,
        },
        Err(error) => {
            let (reachability, error_code) = match error {
                provider::ProviderError::Authentication => {
                    ("reachable", "provider.authentication-failed")
                }
                provider::ProviderError::ModelUnavailable => {
                    ("reachable", "provider.model-unavailable")
                }
                provider::ProviderError::RateLimited { .. } => {
                    ("reachable", "network.rate-limited")
                }
                provider::ProviderError::NetworkUnavailable => {
                    ("unreachable", "network.unavailable")
                }
                provider::ProviderError::NeedsRetryConfirmation => {
                    ("unreachable", "network.timeout")
                }
                provider::ProviderError::SafetyRejected => {
                    ("reachable", "provider.safety-rejected")
                }
                provider::ProviderError::InvalidRequest => ("unknown", "provider.invalid-request"),
                provider::ProviderError::MalformedResponse
                | provider::ProviderError::ResponseTooLarge
                | provider::ProviderError::OriginRedirect => {
                    ("reachable", "provider.malformed-response")
                }
                provider::ProviderError::Transient { .. } => ("reachable", "network.unavailable"),
            };
            ProviderHealthProjection {
                credential,
                reachability,
                primary_model_available: None,
                fallback_model_available: None,
                checked_at_ms,
                error_code: Some(error_code),
            }
        }
    }
}

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
fn complete_close_handshake(
    window: tauri::WebviewWindow,
    handshake: tauri::State<'_, shell::CloseHandshake>,
) -> Result<(), redaction::SafeError> {
    handshake.authorize();
    window
        .close()
        .map_err(|_| redaction::SafeError::new("unknown.unexpected", "无法关闭窗口"))
}

#[tauri::command]
fn activate_asset_save(
    state: tauri::State<'_, asset_protocol::AssetProtocolState>,
    save_id: String,
) -> Result<(), redaction::SafeError> {
    state
        .activate(&save_id)
        .map_err(|_| redaction::SafeError::new("save.invalid-id", "存档标识无效"))
}

fn current_time_ms() -> Result<i64, redaction::SafeError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| redaction::SafeError::new("provider.control-invalid", "系统时间无效"))?
        .as_millis()
        .try_into()
        .map_err(|_| redaction::SafeError::new("provider.control-invalid", "系统时间无效"))
}

#[tauri::command]
fn get_provider_preferences(
    app: tauri::AppHandle,
) -> Result<provider_control::ProviderPreferencesProjection, redaction::SafeError> {
    use tauri::Manager;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| redaction::app_storage_error())?;
    let now_ms = current_time_ms()?;
    let store = provider_control::ProviderControlStore::new(root);
    drop(store.bootstrap(now_ms)?);
    store.get_preferences(now_ms)
}

#[tauri::command]
fn update_provider_preferences(
    app: tauri::AppHandle,
    expected_revision: i64,
    preferences: provider_control::WritableProviderPreferences,
) -> Result<provider_control::ProviderPreferencesProjection, redaction::SafeError> {
    use tauri::Manager;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| redaction::app_storage_error())?;
    let now_ms = current_time_ms()?;
    let store = provider_control::ProviderControlStore::new(root);
    drop(store.bootstrap(now_ms)?);
    store.update_preferences(expected_revision, preferences, now_ms)
}

fn spawn_visual_worker(app: tauri::AppHandle, save_id: String, job_id: String) {
    tauri::async_runtime::spawn_blocking(move || {
        use tauri::Manager;
        let service = app.state::<visual_runtime::VisualRuntimeService>();
        let keychain = app.state::<keychain::PlatformKeychainService>();
        let provider = app.state::<provider::ApiNebulaProvider>();
        // One opt-in automatic fallback may hand back a newly authorized
        // confirmation-state job. Looping is bounded by the three-attempt ceiling;
        // every iteration still consumes its own exact grant before I/O.
        for _ in 0..3 {
            let Ok(now_ms) = current_time_ms() else {
                return;
            };
            let Ok(job) = service.run_one(&save_id, &job_id, &keychain, &provider, now_ms) else {
                return;
            };
            let Ok(followup) = service.automatic_followup_ready(&job, now_ms) else {
                return;
            };
            if !followup {
                return;
            }
        }
    });
}

#[tauri::command]
fn enqueue_visual_job(
    app: tauri::AppHandle,
    service: tauri::State<'_, visual_runtime::VisualRuntimeService>,
    save_id: String,
    request: visual_runtime::VisualJobRequest,
    expected_revision: i64,
    target_fingerprint: String,
) -> Result<visual_runtime::VisualJobProjection, redaction::SafeError> {
    let job = service.enqueue_visual_job(
        &save_id,
        request,
        expected_revision,
        &target_fingerprint,
        current_time_ms()?,
    )?;
    spawn_visual_worker(app, save_id, job.job_id.clone());
    Ok(job)
}

#[tauri::command]
fn list_visual_jobs(
    service: tauri::State<'_, visual_runtime::VisualRuntimeService>,
    save_id: String,
) -> Result<Vec<visual_runtime::VisualJobProjection>, redaction::SafeError> {
    service.list_visual_jobs(&save_id)
}

#[tauri::command]
fn retry_visual_job(
    app: tauri::AppHandle,
    service: tauri::State<'_, visual_runtime::VisualRuntimeService>,
    save_id: String,
    job_id: String,
    expected_job_revision: i64,
) -> Result<visual_runtime::VisualJobProjection, redaction::SafeError> {
    let job =
        service.retry_visual_job(&save_id, &job_id, expected_job_revision, current_time_ms()?)?;
    spawn_visual_worker(app, save_id, job_id);
    Ok(job)
}

#[tauri::command]
fn choose_visual_fallback(
    app: tauri::AppHandle,
    service: tauri::State<'_, visual_runtime::VisualRuntimeService>,
    save_id: String,
    job_id: String,
    expected_job_revision: i64,
    choice: visual_runtime::FallbackChoice,
) -> Result<visual_runtime::VisualJobProjection, redaction::SafeError> {
    let job = service.choose_visual_fallback(
        &save_id,
        &job_id,
        expected_job_revision,
        choice,
        current_time_ms()?,
    )?;
    spawn_visual_worker(app, save_id, job_id);
    Ok(job)
}

#[tauri::command]
fn cancel_visual_job(
    service: tauri::State<'_, visual_runtime::VisualRuntimeService>,
    save_id: String,
    job_id: String,
    expected_job_revision: i64,
) -> Result<visual_runtime::VisualJobProjection, redaction::SafeError> {
    service.cancel_visual_job(&save_id, &job_id, expected_job_revision, current_time_ms()?)
}

#[tauri::command]
fn confirm_visual_send(
    app: tauri::AppHandle,
    service: tauri::State<'_, visual_runtime::VisualRuntimeService>,
    save_id: String,
    job_id: String,
    expected_job_revision: i64,
) -> Result<visual_runtime::VisualJobProjection, redaction::SafeError> {
    let job = service.confirm_visual_send(
        &save_id,
        &job_id,
        expected_job_revision,
        current_time_ms()?,
    )?;
    spawn_visual_worker(app, save_id, job_id);
    Ok(job)
}

#[tauri::command]
fn confirm_visual_adoption(
    service: tauri::State<'_, visual_runtime::VisualRuntimeService>,
    save_id: String,
    job_id: String,
    expected_job_revision: i64,
    expected_revision: i64,
    target_fingerprint: String,
) -> Result<visual_runtime::VisualAdoptionResult, redaction::SafeError> {
    service.confirm_visual_adoption(
        &save_id,
        &job_id,
        expected_job_revision,
        expected_revision,
        &target_fingerprint,
        current_time_ms()?,
    )
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

#[tauri::command]
fn list_recovery_points(
    app: tauri::AppHandle,
    save_id: String,
) -> Result<Vec<persistence::RecoveryPointSummary>, redaction::SafeError> {
    use tauri::Manager;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| redaction::app_storage_error())?;
    persistence::SaveRepository::new(root).list_recovery_points(&save_id)
}

#[tauri::command]
fn restore_recovery_point(
    app: tauri::AppHandle,
    save_id: String,
    recovery_id: String,
) -> Result<persistence::RestoreRecoveryResult, redaction::SafeError> {
    use tauri::Manager;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| redaction::app_storage_error())?;
    persistence::SaveRepository::new(root).restore_recovery_point(&save_id, &recovery_id)
}

fn archive_import_error(error: archive::ArchiveImportError) -> redaction::SafeError {
    use archive::ArchiveImportError as Error;
    let code = match error {
        Error::InvalidSelection
        | Error::InvalidArchive
        | Error::UnsafeEntry
        | Error::IntegrityMismatch
        | Error::InvalidDatabase => "archive.invalid",
        Error::ArchiveTooLarge => "archive.too-large",
        Error::UnsupportedArchive => "archive.unsupported-version",
        Error::InsufficientSpace => "archive.insufficient-space",
        Error::InvalidToken | Error::ExpiredToken => "archive.expired-inspection",
        Error::Io => "archive.import-failed",
    };
    redaction::SafeError::new(code, "无法导入 Cloud Inn 归档")
}

fn archive_export_error(error: archive::ArchiveWriteError) -> redaction::SafeError {
    let code = match error {
        archive::ArchiveWriteError::DestinationExists => "archive.conflict",
        archive::ArchiveWriteError::ArchiveTooLarge => "archive.too-large",
        _ => "archive.export-failed",
    };
    redaction::SafeError::new(code, "无法导出 Cloud Inn 归档")
}

#[tauri::command]
fn export_save(
    app: tauri::AppHandle,
    save_id: String,
) -> Result<ArchiveExportProjection, redaction::SafeError> {
    use tauri::Manager;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| redaction::app_storage_error())?;
    let prepared = persistence::SaveRepository::new(root).prepare_save_export(&save_id)?;
    let selected = rfd::FileDialog::new()
        .add_filter("Cloud Inn 归档", &["cloudinn"])
        .set_file_name(&prepared.suggested_filename)
        .save_file();
    let result = match selected {
        Some(destination) => {
            archive::publish_archive_to_new_destination(&prepared.archive, &destination)
                .map_err(archive_export_error)
                .map(|()| ArchiveExportProjection {
                    archive_version: archive::ARCHIVE_FORMAT_VERSION,
                    suggested_file_name: prepared.suggested_filename,
                    byte_length: prepared.archive.byte_length,
                    sha256: prepared.archive.sha256.clone(),
                })
        }
        None => Err(redaction::SafeError::new("archive.cancelled", "已取消导出")),
    };
    let _ = std::fs::remove_file(&prepared.archive.path);
    result
}

#[tauri::command]
fn inspect_import(
    service: tauri::State<'_, archive::ArchiveImportService>,
) -> Result<archive::ImportInspection, redaction::SafeError> {
    let selected = rfd::FileDialog::new()
        .add_filter("Cloud Inn 归档", &["cloudinn"])
        .pick_file()
        .ok_or_else(|| redaction::SafeError::new("archive.cancelled", "已取消导入"))?;
    service
        .inspect_import(&selected, current_time_ms()?)
        .map_err(archive_import_error)
}

#[tauri::command]
fn import_save(
    app: tauri::AppHandle,
    service: tauri::State<'_, archive::ArchiveImportService>,
    token: String,
    display_name: Option<String>,
) -> Result<persistence::SaveSummary, redaction::SafeError> {
    use tauri::Manager;
    let now_ms = current_time_ms()?;
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| redaction::app_storage_error())?;
    // Finish every fallible installation-wide prerequisite before consuming
    // the single-use token or publishing a new save. Once publication commits,
    // the command can construct its already-validated projection infallibly.
    drop(provider_control::ProviderControlStore::new(root).bootstrap(now_ms)?);
    let consumed = service
        .consume_import(&token, now_ms)
        .map_err(archive_import_error)?;
    let imported = service
        .import_as_new_save(consumed, display_name.as_deref(), now_ms)
        .map_err(archive_import_error)?;
    Ok(persistence::SaveSummary::from_imported(imported))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    redaction::install_panic_hook();
    tauri::Builder::default()
        .register_uri_scheme_protocol("cloudinn-asset", |context, request| {
            use tauri::Manager;
            let state = context
                .app_handle()
                .state::<asset_protocol::AssetProtocolState>();
            asset_protocol::respond(&state, &request)
        })
        .setup(|app| {
            use tauri::Manager;
            let service = keychain::platform_service(&app.config().identifier)
                .map_err(|error| std::io::Error::other(error.to_string()))?;
            app.manage(service);
            app.manage(
                provider::ApiNebulaProvider::new()
                    .map_err(|error| std::io::Error::other(error.to_string()))?,
            );
            let app_root = app.path().app_data_dir()?;
            app.manage(
                archive::ArchiveImportService::new(&app_root)
                    .map_err(|error| std::io::Error::other(error.to_string()))?,
            );
            app.manage(asset_protocol::AssetProtocolState::new(app_root.clone()));
            app.manage(visual_runtime::VisualRuntimeService::new(app_root));
            shell::install(app)?;
            Ok(())
        })
        .on_menu_event(|app, event| shell::handle_menu(app, event.id().as_ref()))
        .invoke_handler(tauri::generate_handler![
            load_game,
            commit_game,
            list_saves,
            create_save,
            rename_save,
            list_recovery_points,
            restore_recovery_point,
            export_save,
            inspect_import,
            import_save,
            provider_token_status,
            set_provider_token,
            delete_provider_token,
            complete_close_handshake,
            activate_asset_save,
            get_provider_preferences,
            update_provider_preferences,
            enqueue_visual_job,
            list_visual_jobs,
            retry_visual_job,
            choose_visual_fallback,
            cancel_visual_job,
            confirm_visual_send,
            confirm_visual_adoption,
            check_provider
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
