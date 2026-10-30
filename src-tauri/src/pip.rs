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

/// What the floating window needs to know about the film: whether it is
/// running, and how big its picture is. Android only.
pub fn set_video(playing: bool, width: i32, height: i32) {
    #[cfg(target_os = "android")]
    {
        crate::apkinstall::with_activity(|env, class| {
            let _ = env.call_static_method(
                class,
                "setPipVideo",
                "(ZII)V",
                &[
                    jni::objects::JValue::Bool(u8::from(playing)),
                    jni::objects::JValue::Int(width),
                    jni::objects::JValue::Int(height),
                ],
            );
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (playing, width, height);
    }
}

#[tauri::command]
pub fn pip_video_set(playing: bool, width: i32, height: i32) {
    set_video(playing, width, height);
}

/// Opens a video in whichever other app will take it - VLC first, when it is
/// there. Android only; returns whether anything was found to open it.
///
/// For a film whose sound this device cannot decode: another player brings its
/// own decoders. See `MainActivity.openInExternalPlayer`.
pub fn open_external(url: &str, title: &str, position_ms: i64) -> bool {
    #[cfg(target_os = "android")]
    {
        return crate::apkinstall::with_activity(|env, class| {
            let (Ok(url), Ok(title)) = (env.new_string(url), env.new_string(title)) else {
                return false;
            };
            env.call_static_method(
                class,
                "openInExternalPlayer",
                "(Ljava/lang/String;Ljava/lang/String;J)Z",
                &[
                    (&url).into(),
                    (&title).into(),
                    jni::objects::JValue::Long(position_ms),
                ],
            )
            .and_then(|v| v.z())
            .unwrap_or(false)
        })
        .unwrap_or(false);
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (url, title, position_ms);
        false
    }
}

#[tauri::command]
pub fn player_open_external(url: String, title: String, position_ms: i64) -> bool {
    open_external(&url, &title, position_ms)
}

/// Tells Android who decides which way up the screen is.
///
/// `sensor` rotates from the accelerometer whatever the system's auto-rotate
/// switch says, `locked` freezes the current orientation, `landscape` forces
/// sideways, and `system` gives rotation back to Android. The web layer
/// cannot do any of this on its own: `screen.orientation.lock` works only in
/// fullscreen and cannot override the auto-rotate switch.
///
/// Does nothing where there is no activity - every desktop.
pub fn set_orientation(mode: &str) {
    #[cfg(target_os = "android")]
    {
        crate::apkinstall::with_activity(|env, class| {
            if let Ok(arg) = env.new_string(mode) {
                let _ = env.call_static_method(
                    class,
                    "setOrientationMode",
                    "(Ljava/lang/String;)V",
                    &[(&arg).into()],
                );
            }
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = mode;
    }
}

/// Keeps the screen on while a film plays. Android only; see
/// `MainActivity.setKeepScreenOn` for why it is a window flag.
pub fn set_keep_awake(on: bool) {
    #[cfg(target_os = "android")]
    {
        crate::apkinstall::with_activity(|env, class| {
            let _ = env.call_static_method(
                class,
                "setKeepScreenOn",
                "(Z)V",
                &[jni::objects::JValue::Bool(u8::from(on))],
            );
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = on;
    }
}

/// Full brightness and no system bars while the full-screen player is up, with
/// the bars coming back when its controls do. Android only; see
/// `MainActivity.setPlayerScreen`.
pub fn set_player_screen(player: bool, bars: bool) {
    #[cfg(target_os = "android")]
    {
        crate::apkinstall::with_activity(|env, class| {
            let _ = env.call_static_method(
                class,
                "setPlayerScreen",
                "(ZZ)V",
                &[
                    jni::objects::JValue::Bool(u8::from(player)),
                    jni::objects::JValue::Bool(u8::from(bars)),
                ],
            );
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (player, bars);
    }
}

#[tauri::command]
pub fn player_screen_set(player: bool, bars: bool) {
    set_player_screen(player, bars);
}

#[tauri::command]
pub fn orientation_set(mode: String) {
    set_orientation(&mode);
}

#[tauri::command]
pub fn keep_awake_set(on: bool) {
    set_keep_awake(on);
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

/// The floating window was entered, left, or closed.
///
/// `mode` is "pip", "expanded" or "dismissed" - see
/// `MainActivity.onPictureInPictureModeChanged` for why the last two are not
/// the same thing.
///
/// # Safety
///
/// Called by the Java runtime with arguments it constructed. Nothing else may
/// call it.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_app_lantern_desktop_MainActivity_nativePipMode(
    mut env: jni::JNIEnv,
    _this: jni::objects::JObject,
    mode: jni::objects::JString,
) {
    let mode: String = env.get_string(&mode).map(|s| s.into()).unwrap_or_default();
    if let Some(app) = APP.get() {
        use tauri::Emitter;
        let _ = app.emit("pip:mode", mode);
    }
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
