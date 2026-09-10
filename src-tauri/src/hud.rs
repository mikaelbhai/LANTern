//! The corner popup.
//!
//! LANTern spends most of its life out of sight — closed to the tray, or
//! minimised behind whatever you are actually doing. That is the point of it:
//! a device on the network does not need a window open to be reachable. But it
//! also meant the moments that need an answer *now* — somebody ringing, a file
//! waiting to be accepted — happened somewhere you were not looking.
//!
//! So those moments get a small window of their own in the corner of the
//! screen. It is a real OS window rather than a notification because a
//! notification cannot hold a call: you need to answer, mute, hang up, and see
//! the thing still running a minute later.
//!
//! It holds no state and makes no decisions. The main window works out what
//! should be on it and pushes a snapshot over `hud:state`; the popup sends
//! back what was clicked over `hud:action`, and the main window does it. That
//! keeps one copy of the rules, and keeps this window's privileges down to
//! events and its own size — see `capabilities/hud.json`.

use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, Runtime, WebviewUrl,
    WebviewWindowBuilder,
};

pub const LABEL: &str = "hud";

/// Wide enough for a name and two buttons, narrow enough to ignore.
const WIDTH: f64 = 340.0;
/// Clear of the screen edge, and of the taskbar's own shadow.
const MARGIN: f64 = 14.0;
const MIN_HEIGHT: f64 = 76.0;
const MAX_HEIGHT: f64 = 460.0;

/// Creates the window if it is not there yet, without showing it.
fn ensure<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::WebviewWindow<R>> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Ok(w);
    }

    // The same bundle, told to render the popup instead of the application.
    // A second entry point would mean a second build; a hash costs nothing.
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html#hud".into()))
        .title("LANTern")
        .inner_size(WIDTH, MIN_HEIGHT)
        .resizable(false)
        .decorations(false)
        // Above whatever you were doing — a call you cannot see is a call you
        // will miss — but never stealing focus from it.
        .always_on_top(true)
        .focused(false)
        .visible(false)
        // It is not a place you alt-tab to; it belongs to the app in the tray.
        .skip_taskbar(true)
        .build()
}

/// Puts the window in the bottom-right corner of the screen it is on.
///
/// The *work* area, not the monitor: on Windows the taskbar is part of the
/// screen and a window placed against the true bottom edge sits underneath it.
fn place<R: Runtime>(window: &tauri::WebviewWindow<R>, height: f64) -> tauri::Result<()> {
    window.set_size(LogicalSize::new(WIDTH, height))?;

    let monitor = match window.primary_monitor()? {
        Some(m) => m,
        None => match window.current_monitor()? {
            Some(m) => m,
            // No monitor to speak of — leave it wherever it was rather than
            // guessing a position that could be off-screen.
            None => return Ok(()),
        },
    };

    let area = monitor.work_area();
    let scale = monitor.scale_factor();
    let w = (WIDTH * scale).round() as i32;
    let h = (height * scale).round() as i32;
    let m = (MARGIN * scale).round() as i32;

    let x = area.position.x + area.size.width as i32 - w - m;
    let y = area.position.y + area.size.height as i32 - h - m;
    window.set_position(PhysicalPosition::new(x, y))?;
    Ok(())
}

/// Shows or hides the popup. Called by the main window as things come and go.
pub fn set<R: Runtime>(app: AppHandle<R>, visible: bool, height: f64) -> Result<(), String> {
    if !visible {
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.hide();
        }
        return Ok(());
    }

    let window = ensure(&app).map_err(|e| e.to_string())?;
    let _ = place(&window, height.clamp(MIN_HEIGHT, MAX_HEIGHT));
    // Re-asserted on every show: another window going full-screen can knock a
    // topmost window out of that order on Windows, and it never gets it back.
    let _ = window.set_always_on_top(true);
    window.show().map_err(|e| e.to_string())?;
    Ok(())
}

/// The popup asking for a different height, having measured its own contents.
///
/// It does this itself because only it knows how tall the thing it drew is,
/// and guessing from the snapshot on the other side would be wrong the first
/// time somebody's name wrapped onto a second line.
pub fn resize<R: Runtime>(app: AppHandle<R>, height: f64) -> Result<(), String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        if w.is_visible().unwrap_or(false) {
            let _ = place(&w, height.clamp(MIN_HEIGHT, MAX_HEIGHT));
        }
    }
    Ok(())
}

/// Brings the application back, and takes the popup away.
pub fn open_app<R: Runtime>(app: AppHandle<R>) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.hide();
    }
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
    sync(&app);
}

/// Tells the main window whether it is currently out of sight.
///
/// Hidden to the tray and minimised are different states to the OS and the
/// same thing to the person using it: the window is not there. Both are
/// reported as one flag so the frontend has a single thing to react to.
pub fn sync<R: Runtime>(app: &AppHandle<R>) {
    let away = app
        .get_webview_window("main")
        .map(|w| {
            let visible = w.is_visible().unwrap_or(true);
            let minimized = w.is_minimized().unwrap_or(false);
            !visible || minimized
        })
        .unwrap_or(false);

    let _ = app.emit("main:away", away);
}
