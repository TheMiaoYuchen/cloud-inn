mod persistence;

#[tauri::command]
fn load_game(app: tauri::AppHandle, save_id: String) -> Result<Option<serde_json::Value>, String> {
    use tauri::Manager;
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    persistence::SaveRepository::new(root).load_game(&save_id)
}

#[tauri::command]
fn commit_game(
    app: tauri::AppHandle,
    expected_revision: i64,
    game: serde_json::Value,
) -> Result<(), String> {
    use tauri::Manager;
    let root = app.path().app_data_dir().map_err(|e| e.to_string())?;
    persistence::SaveRepository::new(root).commit_game(expected_revision, game)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![load_game, commit_game])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
