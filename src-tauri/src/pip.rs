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
