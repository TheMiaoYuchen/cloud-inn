use serde::{Deserialize, Serialize};
use std::fs;
use std::path::Path;
use tauri::menu::{Menu, MenuBuilder, SubmenuBuilder};
use tauri::{App, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

const STATE_FILE: &str = "window-state.json";
const MAX_STATE_BYTES: u64 = 4_096;
const MIN_WIDTH: u32 = 1_100;
const MIN_HEIGHT: u32 = 720;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WindowState {
    x: i32,
    y: i32,
    width: u32,
    height: u32,
}

pub fn install(app: &mut App) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    app.set_menu(menu)?;
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(root) = app.path().app_data_dir() {
            restore_window(&window, &root);
            let state_root = root.clone();
            let state_window = window.clone();
            window.on_window_event(move |event| {
                if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                    save_window(&state_window, &state_root);
                }
            });
        }
    }
    Ok(())
}

pub fn handle_menu(app: &tauri::AppHandle, id: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let route = match id {
        "cloudinn-saves" => Some("#/saves"),
        "cloudinn-recovery" => Some("#/saves"),
        "cloudinn-diagnostics" => Some("#/diagnostics"),
        _ => None,
    };
    if let Some(route) = route {
        let _ = window.eval(format!("window.location.hash={route:?}"));
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn build_menu(app: &App) -> tauri::Result<Menu<tauri::Wry>> {
    let app_menu = SubmenuBuilder::new(app, "Cloud Inn")
        .about(None)
        .separator()
        .text("cloudinn-diagnostics", "诊断与 AI 设置…")
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;
    let file_menu = SubmenuBuilder::new(app, "文件")
        .text("cloudinn-saves", "存档管理…")
        .text("cloudinn-recovery", "恢复点…")
        .separator()
        .close_window()
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;
    let window_menu = SubmenuBuilder::new(app, "窗口")
        .minimize()
        .maximize()
        .separator()
        .fullscreen()
        .build()?;
    MenuBuilder::new(app)
        .items(&[&app_menu, &file_menu, &edit_menu, &window_menu])
        .build()
}

fn restore_window(window: &WebviewWindow, root: &Path) {
    let path = root.join(STATE_FILE);
    let Ok(metadata) = fs::symlink_metadata(&path) else {
        return;
    };
    if !metadata.file_type().is_file() || metadata.len() > MAX_STATE_BYTES {
        return;
    }
    let Ok(bytes) = fs::read(path) else { return };
    let Ok(mut state) = serde_json::from_slice::<WindowState>(&bytes) else {
        return;
    };
    let Ok(monitors) = window.available_monitors() else {
        return;
    };
    let Some(monitor) = monitors.iter().find(|monitor| {
        let position = monitor.position();
        let size = monitor.size();
        rectangles_intersect(
            state,
            WindowState {
                x: position.x,
                y: position.y,
                width: size.width,
                height: size.height,
            },
        )
    }).or_else(|| monitors.first()) else { return };
    state.width = state.width.clamp(MIN_WIDTH, monitor.size().width);
    state.height = state.height.clamp(MIN_HEIGHT, monitor.size().height);
    if !rectangles_intersect(state, WindowState {
        x: monitor.position().x,
        y: monitor.position().y,
        width: monitor.size().width,
        height: monitor.size().height,
    }) {
        state.x = monitor.position().x + ((monitor.size().width - state.width) / 2) as i32;
        state.y = monitor.position().y + ((monitor.size().height - state.height) / 2) as i32;
    }
    let _ = window.set_size(PhysicalSize::new(state.width, state.height));
    let _ = window.set_position(PhysicalPosition::new(state.x, state.y));
}

fn save_window(window: &WebviewWindow, root: &Path) {
    let (Ok(position), Ok(size)) = (window.outer_position(), window.outer_size()) else {
        return;
    };
    let state = WindowState { x: position.x, y: position.y, width: size.width, height: size.height };
    let Ok(bytes) = serde_json::to_vec(&state) else { return };
    if fs::create_dir_all(root).is_err() { return; }
    let partial = root.join(".window-state.partial");
    if fs::write(&partial, bytes).is_ok() {
        let _ = fs::rename(partial, root.join(STATE_FILE));
    }
}

fn rectangles_intersect(left: WindowState, right: WindowState) -> bool {
    let left_right = i64::from(left.x) + i64::from(left.width);
    let left_bottom = i64::from(left.y) + i64::from(left.height);
    let right_right = i64::from(right.x) + i64::from(right.width);
    let right_bottom = i64::from(right.y) + i64::from(right.height);
    left_right > i64::from(right.x) + 100
        && right_right > i64::from(left.x) + 100
        && left_bottom > i64::from(right.y) + 100
        && right_bottom > i64::from(left.y) + 100
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_requires_a_visible_area_on_a_monitor() {
        let monitor = WindowState { x: 0, y: 0, width: 1440, height: 900 };
        assert!(rectangles_intersect(WindowState { x: -900, y: 20, width: 1100, height: 720 }, monitor));
        assert!(!rectangles_intersect(WindowState { x: 1600, y: 20, width: 1100, height: 720 }, monitor));
    }
}
