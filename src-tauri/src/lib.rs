//! LANTern native layer.
//!
//! Everything here runs on the device: mDNS discovery, a WebSocket signaling
//! server, a STUN server for ICE, a static HTTP server for published folders,
//! and SQLite for history. No component reaches the internet.

mod commands;
mod db;
mod discovery;
mod ebml;
mod hosting;
mod library;
mod identity;
mod media;
mod model;
mod net;
mod shares;
mod sidecar;
mod signaling;
mod state;
mod transfers;
mod stun;
#[cfg(desktop)]
mod tray;
mod upnp;

use state::AppState;
use tauri::Manager;

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
            commands::media_set_progress,
            commands::game_start,
            commands::game_report,
            commands::game_leave,
            commands::party_start,
            commands::party_sync,
            commands::party_leave,
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
                if tray::TRAY_IS_NATIVE {
                    api.prevent_close();
                    let _ = _window.hide();
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running LANTern");
}
