//! Where a call comes out of, on a phone.
//!
//! A voice call with no picture is held against the ear, and a phone is built
//! for that: the small speaker at the top is aimed at an ear rather than a
//! room, and the microphone the call stack chooses in that mode is the one at
//! the bottom, by the mouth, with the echo cancelling that goes with it. A
//! video call is the opposite — held away and looked at — so it belongs out
//! loud.
//!
//! The webview cannot choose either. It hands its audio to the platform and
//! the platform decides, so the decision has to be made out here.
//!
//! Nothing to do on a desktop, which has one pair of speakers and one
//! microphone and no notion of holding it to your face.

/// Sends call audio to the earpiece, or back out to the loudspeaker.
///
/// Returns whether the route was taken. A device with no earpiece — a tablet,
/// a television — has nothing to route to, and is left alone rather than
/// silenced.
pub fn set_earpiece(earpiece: bool) -> bool {
    #[cfg(target_os = "android")]
    {
        crate::apkinstall::with_activity(|env, class| {
            env.call_static_method(
                class,
                "setEarpiece",
                "(Z)Z",
                &[jni::objects::JValue::Bool(u8::from(earpiece))],
            )
            .and_then(|v| v.z())
            .unwrap_or(false)
        })
        .unwrap_or(false)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = earpiece;
        false
    }
}

/// Hands the audio stack back when the call ends.
///
/// Leaving a phone in call routing is how it ends up playing music through
/// the earpiece afterwards.
pub fn reset() {
    #[cfg(target_os = "android")]
    {
        crate::apkinstall::with_activity(|env, class| {
            let _ = env.call_static_method(class, "clearCallAudio", "()V", &[]);
        });
    }
}
