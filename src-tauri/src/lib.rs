//! LANTern native layer.
//!
//! Everything here runs on the device: mDNS discovery, a WebSocket signaling
//! server, a STUN server for ICE, a static HTTP server for published folders,
//! and SQLite for history. No component reaches the internet.

// Four modules are public because `src/bin/lantern-host.rs` — the process
// that keeps serving files after the window closes — is a separate binary
// that links this library. Everything else stays private to it.
mod audiotrack;
mod commands;
pub mod db;
mod discovery;
mod ebml;
pub mod hosting;
mod library;
mod identity;
mod media;
mod model;
mod mp4;
mod net;
mod phrase;
pub mod shares;
mod sidecar;
mod signaling;
pub mod state;
mod transfers;
mod stun;
#[cfg(desktop)]
mod hud;
#[cfg(desktop)]
mod tray;
mod upnp;

use state::AppState;
use tauri::Manager;

/// Shows or hides the corner popup.
///
/// Declared here rather than in `hud` so the command list handed to Tauri is
/// identical on every platform: `generate_handler!` cannot take a `cfg` per
/// entry, and a phone has no corner to put this in.
#[tauri::command]
fn hud_set(_app: tauri::AppHandle, _visible: bool, _height: f64) -> Result<(), String> {
    #[cfg(desktop)]
    return hud::set(_app, _visible, _height);
    #[cfg(not(desktop))]
    return Ok(());
}

#[tauri::command]
fn hud_resize(_app: tauri::AppHandle, _height: f64) -> Result<(), String> {
    #[cfg(desktop)]
    return hud::resize(_app, _height);
    #[cfg(not(desktop))]
    return Ok(());
}

#[tauri::command]
fn hud_open_app(_app: tauri::AppHandle) {
    #[cfg(desktop)]
    hud::open_app(_app);
}

/// Asks for the main window's visibility to be re-announced.
///
/// Window events cover every later change, but not the state the application
/// starts in — launched at login it is hidden and nothing has happened yet.
/// The frontend calls this once it is listening.
#[tauri::command]
fn hud_sync(_app: tauri::AppHandle) {
    #[cfg(desktop)]
    hud::sync(&_app);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // A second launch must not become a second process. Without this it would
    // start, fail to bind 7979 because the first instance already holds it,
    // and then sit there showing an empty peer list with no listener behind
    // it - indistinguishable, from the window, from a network that is simply
    // quiet. Focus what is already running instead.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        if let Some(window) = app.get_webview_window("main") {
            let _ = window.show();
            let _ = window.unminimize();
            let _ = window.set_focus();
        }
    }));

    // Launching at login starts hidden, so the app is reachable without ever
    // stealing focus. There is no equivalent on a phone.
    #[cfg(desktop)]
    let builder = builder.plugin(tauri_plugin_autostart::init(
        tauri_plugin_autostart::MacosLauncher::LaunchAgent,
        Some(vec!["--hidden"]),
    ));

    builder
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_notification::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            commands::start_services,
            commands::host_os,
            commands::profile_set_avatar,
            commands::profile_has_avatar,
            commands::net_info,
            commands::net_set_relay_hub,
            commands::net_set_bridging,
            commands::net_set_port,
            commands::net_add_manual_peer,
            commands::net_add_by_phrase,
            commands::net_diagnose,
            commands::net_refresh,
            commands::net_scan_upstream,
            commands::net_publish_upstream,
            commands::net_publish_upstream_manual,
            commands::net_invite,
            commands::net_upnp_list,
            commands::net_upnp_open,
            commands::net_upnp_close,
            commands::peers_list,
            commands::peers_ping,
            commands::peers_trust,
            commands::peers_linked,
            commands::chat_send,
            commands::chat_typing,
            commands::chat_react,
            commands::call_signal,
            commands::files_offer,
            commands::files_accept,
            commands::files_list,
            commands::files_stat,
            commands::files_pause,
            commands::files_resume,
            commands::files_cancel,
            commands::files_reveal,
            commands::files_open,
            commands::host_list,
            commands::host_create,
            commands::host_set_running,
            commands::host_update,
            commands::host_remove,
            commands::host_rescan,
            commands::host_probe,
            commands::host_open,
            commands::tray_supported,
            commands::window_hide_to_tray,
            commands::window_show,
            commands::autostart_get,
            commands::autostart_set,
            commands::media_list,
            commands::media_scan,
            commands::media_can_switch_audio,
            commands::media_set_tracks,
            commands::service_get,
            commands::service_set,
            commands::service_running,
            commands::peers_shares,
            commands::peers_browse,
            commands::peers_block,
            commands::peers_blocked,
            commands::net_connection_profiles,
            commands::net_set_private,
            commands::update_begin,
            commands::update_stage,
            commands::update_launch,
            commands::media_set_progress,
            commands::game_start,
            commands::game_report,
            commands::game_move,
            commands::game_send,
            commands::game_leave,
            commands::party_start,
            commands::party_sync,
            commands::party_leave,
            hud_set,
            hud_resize,
            hud_open_app,
            hud_sync,
        ])
        .setup(|app| {
            // Services come up with the process, not with the window.
            let state = app.state::<AppState>();
            commands::boot(app.handle().clone(), (*state).clone());

            #[cfg(desktop)]
            if tray::TRAY_IS_NATIVE {
                tray::build(app.handle())?;
                // Start hidden so launching at login does not steal focus. The
                // tray icon is the affordance that brings it back.
                if std::env::args().any(|a| a == "--hidden") {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.hide();
                    }
                }
            }
            Ok(())
        })
        .on_window_event(|_window, _event| {
            // Closing the window parks the app in the tray instead of quitting,
            // so peers can still reach this device. Quit lives in the tray menu.
            // On mobile the OS owns the lifecycle, so there is nothing to do.
            #[cfg(desktop)]
            if let tauri::WindowEvent::CloseRequested { api, .. } = _event {
                if tray::TRAY_IS_NATIVE && _window.label() == "main" {
                    api.prevent_close();
                    let _ = _window.hide();
                }
            }

            // Whether the main window is out of sight decides whether the
            // corner popup should be. There is no "minimised" event, so the
            // state is read back after anything that could have changed it.
            #[cfg(desktop)]
            if _window.label() == "main" {
                if matches!(
                    _event,
                    tauri::WindowEvent::Resized(_)
                        | tauri::WindowEvent::Focused(_)
                        | tauri::WindowEvent::CloseRequested { .. }
                ) {
                    hud::sync(&_window.app_handle().clone());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while running LANTern")
        .run(|app, event| {
            // Only one process can hold the hosting port. While the app is
            // open it should be this one, so a detached host from a previous
            // session is stopped before anything else happens.
            if let tauri::RunEvent::Ready = event {
                commands::stop_host_service(app);
            }

            // On the way out, hand hosting back — if that was asked for. The
            // host waits for the port, because this process is still holding
            // it as it exits.
            #[cfg(desktop)]
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                let state = app.state::<state::AppState>();
                let keep = state.with(|s| {
                    s.db.as_ref()
                        .and_then(|db| {
                            db.query_row(
                                "SELECT value FROM preferences WHERE key = 'keep_hosting'",
                                [],
                                |r| r.get::<_, String>(0),
                            )
                            .ok()
                        })
                        .map(|v| v == "1")
                        .unwrap_or(false)
                });
                if keep {
                    commands::start_host_service(app, &state);
                }
            }
        });
}

/* ------------------------------------------------------- container probing */

// Re-exported so the `probe_file` example - and anything else that wants to
// ask what is inside a file - can do it without going through the app.

pub use ebml::{Probe, Track};

pub fn is_matroska_path(path: &std::path::Path) -> bool {
    ebml::is_matroska(path)
}

pub fn probe_matroska(path: &std::path::Path) -> std::io::Result<Probe> {
    ebml::probe(path)
}

pub fn probe_mp4(path: &std::path::Path) -> std::io::Result<Probe> {
    mp4::probe(path)
}
