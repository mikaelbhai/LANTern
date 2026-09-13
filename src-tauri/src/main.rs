// Release builds on Windows must not spawn a console window alongside the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Before anything else, because a browser's switches are fixed when the
    // browser starts and Tauri creates the webview inside `run`.
    #[cfg(target_os = "windows")]
    lantern_lib::autoshare::apply();

    lantern_lib::run()
}
