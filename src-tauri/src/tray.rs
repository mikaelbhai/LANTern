//! System tray presence.
//!
//! LANTern is only useful while it is running — it has to stay reachable for
//! peers to message, call or stream from this device. So on Windows and Linux
//! it lives in the tray: closing the window hides it rather than quitting, and
//! by default the app starts hidden so a login-time launch is unobtrusive.
//! Quitting is explicit, from the tray menu.

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime};

/// Platforms where a tray is the expected place for a background app to live.
pub const TRAY_IS_NATIVE: bool = cfg!(any(target_os = "windows", target_os = "linux"));

pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Open LANTern", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Hide to tray", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "Quit LANTern", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &sep, &quit])?;

    TrayIconBuilder::with_id("lantern-tray")
        .icon(app.default_window_icon().cloned().ok_or_else(|| {
            tauri::Error::AssetNotFound("default window icon".into())
        })?)
        .tooltip("LANTern — your local network, illuminated")
        .menu(&menu)
        // The menu belongs on right-click; a left click should just restore.
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "show" => restore(app),
            "hide" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.hide();
                }
                crate::hud::sync(app);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                restore(tray.app_handle());
            }
        })
        .build(app)?;

    Ok(())
}

pub fn restore<R: Runtime>(app: &AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    // The window being back is what takes the corner popup away.
    crate::hud::sync(app);
}
