use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::menu::{Menu, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{App, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

const STATE_FILE: &str = "window-state.json";
const MAX_STATE_BYTES: u64 = 4_096;
const MIN_WIDTH: u32 = 1_100;
const MIN_HEIGHT: u32 = 720;

#[derive(Clone, Default)]
pub struct CloseHandshake(Arc<AtomicBool>);

impl CloseHandshake {
    pub fn authorize(&self) {
        self.0.store(true, Ordering::Release);
    }

    fn claim_or_force(&self) -> bool {
        self.0.swap(true, Ordering::AcqRel)
    }

    fn retry_after_failed_emit(&self) {
        self.0.store(false, Ordering::Release);
    }
}

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
        let close_handshake = CloseHandshake::default();
        app.manage(close_handshake.clone());
        if let Ok(root) = app.path().app_data_dir() {
            restore_window(&window, &root);
            let state_root = root.clone();
            let state_window = window.clone();
            window.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    if close_handshake.claim_or_force() {
                        save_window(&state_window, &state_root);
                    } else {
                        api.prevent_close();
                        if state_window.emit("cloudinn-close-requested", ()).is_err() {
                            close_handshake.retry_after_failed_emit();
                        }
                    }
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
    if id == "cloudinn-quit" {
        let _ = window.close();
        return;
    }
    let route = match id {
        "cloudinn-new-save"
        | "cloudinn-open-save"
        | "cloudinn-rename-save"
        | "cloudinn-import"
        | "cloudinn-export"
        | "cloudinn-saves" => Some("#/saves"),
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
    let quit = MenuItemBuilder::with_id("cloudinn-quit", "退出 Cloud Inn")
        .accelerator("CmdOrCtrl+Q")
        .build(app)?;
    let app_menu = SubmenuBuilder::new(app, "Cloud Inn")
        .about(None)
        .separator()
        .text("cloudinn-diagnostics", "诊断与 AI 设置…")
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .item(&quit)
        .build()?;
    let file_menu = SubmenuBuilder::new(app, "文件")
        .text("cloudinn-new-save", "新建存档…")
        .text("cloudinn-open-save", "打开存档…")
        .text("cloudinn-rename-save", "重命名当前存档…")
        .separator()
        .text("cloudinn-import", "导入 .cloudinn…")
        .text("cloudinn-export", "导出当前存档…")
        .separator()
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
    let view_menu = SubmenuBuilder::new(app, "显示").fullscreen().build()?;
    let help_menu = SubmenuBuilder::new(app, "帮助")
        .text("cloudinn-diagnostics", "Cloud Inn 诊断…")
        .build()?;
    MenuBuilder::new(app)
        .items(&[
            &app_menu,
            &file_menu,
            &edit_menu,
            &view_menu,
            &window_menu,
            &help_menu,
        ])
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
    let Some(monitor) = monitors
        .iter()
        .find(|monitor| {
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
        })
        .or_else(|| monitors.first())
    else {
        return;
    };
    state.width = state
        .width
        .clamp(MIN_WIDTH.min(monitor.size().width), monitor.size().width);
    state.height = state
        .height
        .clamp(MIN_HEIGHT.min(monitor.size().height), monitor.size().height);
    if !rectangles_intersect(
        state,
        WindowState {
            x: monitor.position().x,
            y: monitor.position().y,
            width: monitor.size().width,
            height: monitor.size().height,
        },
    ) {
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
    let state = WindowState {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    };
    let Ok(bytes) = serde_json::to_vec(&state) else {
        return;
    };
    if fs::create_dir_all(root).is_err() {
        return;
    }
    let partial = root.join(format!(".window-state-{}.partial", uuid::Uuid::new_v4()));
    let Ok(mut file) = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&partial)
    else {
        return;
    };
    if file.write_all(&bytes).is_err() || file.sync_all().is_err() {
        let _ = fs::remove_file(&partial);
        return;
    }
    drop(file);
    if fs::rename(&partial, root.join(STATE_FILE)).is_ok() {
        if let Ok(directory) = fs::File::open(root) {
            let _ = directory.sync_all();
        }
    } else {
        let _ = fs::remove_file(&partial);
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
        let monitor = WindowState {
            x: 0,
            y: 0,
            width: 1440,
            height: 900,
        };
        assert!(rectangles_intersect(
            WindowState {
                x: -900,
                y: 20,
                width: 1100,
                height: 720
            },
            monitor
        ));
        assert!(!rectangles_intersect(
            WindowState {
                x: 1600,
                y: 20,
                width: 1100,
                height: 720
            },
            monitor
        ));
    }

    #[test]
    fn close_handshake_allows_frontend_ack_or_a_second_close_request() {
        let handshake = CloseHandshake::default();
        assert!(!handshake.claim_or_force());
        assert!(handshake.claim_or_force());

        let acknowledged = CloseHandshake::default();
        acknowledged.authorize();
        assert!(acknowledged.claim_or_force());

        let failed_emit = CloseHandshake::default();
        assert!(!failed_emit.claim_or_force());
        failed_emit.retry_after_failed_emit();
        assert!(!failed_emit.claim_or_force());
    }
}
