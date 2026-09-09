// Release builds on Windows must not spawn a console window alongside the app.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    lantern_lib::run()
}
