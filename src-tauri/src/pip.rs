//! Telling Android when a film is playing.
//!
//! A desktop pops the video itself out into a floating window. Android's
//! WebView cannot do that, so the whole app goes into the corner instead,
//! which comes to the same thing for the one purpose either serves: carrying
//! on watching while doing something else.
//!
//! The activity decides that when you leave, and it has to know whether
//! anything is playing. It used to ask the audio stack — `isMusicActive` — and
//! that is true of *any* sound on the device: a game's effects, another app's
//! music, a notification. So leaving LANTern while a game beeped put the whole
//! application in a floating window, which is picture-in-picture for something
//! that has no picture worth keeping.
//!
//! Now the player says so itself. A call still answers for itself through the
//! audio mode, which is exact: that mode is set by the media stack only while
//! a microphone is captured for a call.

/// Says whether a film is on screen, for the activity to read when you leave.
///
/// Does nothing where there is no activity to tell — every desktop, and an
/// Android build before the window has started.
pub fn set_playing(playing: bool) {
    #[cfg(target_os = "android")]
    {
        crate::apkinstall::with_activity(|env, class| {
            let _ = env.call_static_method(
                class,
                "setMediaPlaying",
                "(Z)V",
                &[jni::objects::JValue::Bool(u8::from(playing))],
            );
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = playing;
    }
}

/* --------------------------------------------------------- the other way */

/*
 * The PiP window's own play/pause button.
 *
 * Entering picture-in-picture used to ask for nothing but a shape - no
 * actions on the params Android was handed - so the floating window Android
 * drew had no button of its own to press, because Android only draws one
 * when something native asks for it. The web page's own controls are
 * exactly what a small floating window has no room for and no way to reach
 * with a finger; the system overlay is the only affordance left, and it was
 * simply never offered one.
 *
 * Kotlin owns the tap - Android delivers it as an Intent to the activity,
 * not as anything Rust ever sees on its own - so it has to reach back in.
 * There is no channel for that already, the way `set_playing` above has one
 * outward: this needs the running app itself, stashed once at startup,
 * because a raw JNI entry point has nothing else to reach it with.
 */
#[cfg(target_os = "android")]
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// Keeps a handle to the running app for `nativePipToggle` below to use.
///
/// Called once from `setup`. Everywhere else in this application reaches the
/// frontend through an `AppHandle` it was already holding; this is the one
/// place that has none, because a JNI entry point is called by the Java
/// runtime with nothing but what the method signature says it gets.
#[cfg(target_os = "android")]
pub fn stash_app_handle(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

/// Android's PiP button was pressed. Tells the player to toggle itself.
///
/// # Safety
///
/// Called by the Java runtime with arguments it constructed. Nothing else may
/// call it.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_app_lantern_desktop_MainActivity_nativePipToggle(
    _env: jni::JNIEnv,
    _this: jni::objects::JObject,
) {
    if let Some(app) = APP.get() {
        use tauri::Emitter;
        let _ = app.emit("pip:toggle", ());
    }
}
