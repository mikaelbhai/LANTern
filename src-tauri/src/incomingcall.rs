//! A full-screen call notification, for a phone that is not looking at
//! LANTern when a call arrives.
//!
//! `ringer.ts` already raises a plain notification for an incoming call and
//! rings a synthesised tone — but both run in the WebView's JS, and JS is
//! exactly what Android is free to throttle the moment the Activity is
//! stopped, even while the foreground service keeps the process itself
//! alive underneath it. A call that only rings while LANTern already
//! happens to be the thing on screen is not "rings no matter what app it's
//! on" — it is the same behaviour this app had before, just moved one
//! layer down. This is the native fallback, and it is answered the way a
//! real phone call is: a full-screen intent, over whatever was already
//! showing, with its own ringtone and vibration that do not depend on a
//! single line of JS having run.
//!
//! Declining is handled natively too, all the way to the wire — a "no"
//! should not need the JS call stack awake to say so.

/// Rings, full-screen, over whatever is on top. Desktop has no notion of a
/// call taking over the screen and keeps the existing in-app ring only.
pub fn notify(from: &str, call_id: &str, caller: &str, video: bool) {
    #[cfg(target_os = "android")]
    {
        crate::apkinstall::with_activity(|env, class| {
            let Ok(jfrom) = env.new_string(from) else { return };
            let Ok(jcallid) = env.new_string(call_id) else { return };
            let Ok(jcaller) = env.new_string(caller) else { return };
            let _ = env.call_static_method(
                class,
                "showIncomingCall",
                "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;Z)V",
                &[
                    jni::objects::JValue::Object(&jfrom),
                    jni::objects::JValue::Object(&jcallid),
                    jni::objects::JValue::Object(&jcaller),
                    jni::objects::JValue::Bool(video as u8),
                ],
            );
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (from, call_id, caller, video);
    }
}

/// The call ended before it was answered — hung up, declined from the other
/// end, or answered on a different device. Clears the notification so a
/// call that is over does not keep ringing.
pub fn cancel(call_id: &str) {
    #[cfg(target_os = "android")]
    {
        crate::apkinstall::with_activity(|env, class| {
            let Ok(jcallid) = env.new_string(call_id) else { return };
            let _ = env.call_static_method(
                class,
                "cancelIncomingCall",
                "(Ljava/lang/String;)V",
                &[jni::objects::JValue::Object(&jcallid)],
            );
        });
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = call_id;
    }
}

/* -------------------------------------------------------------- the other way */

/*
 * Declining from the notification, without opening the app.
 *
 * A real phone call can be declined with the screen still off; this asks
 * the same of a call it rang for natively. Kotlin's decline action needs
 * the running app to reach `links.send` at all - a raw JNI entry point is
 * called by the Java runtime with nothing but what the method signature
 * says it gets, so the app handle is stashed once at startup the same way
 * pip.rs's own JNI entry point already does, for the same reason.
 */
#[cfg(target_os = "android")]
static APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// Called once from `setup`.
#[cfg(target_os = "android")]
pub fn stash_app_handle(app: tauri::AppHandle) {
    let _ = APP.set(app);
}

/// The notification's Decline action was tapped. Sends the decline signal
/// straight to the wire and clears the notification — everything this needs
/// already runs on the app's own threads, so the call ends whether or not
/// anyone ever looks at the screen.
///
/// Bound to `CallDeclineReceiver`, not `MainActivity` — a broadcast receiver
/// is its own class, and the JNI export name has to name the class the
/// Kotlin `external fun` is actually declared on.
///
/// # Safety
///
/// Called by the Java runtime with arguments it constructed. Nothing else
/// may call it.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_app_lantern_desktop_CallDeclineReceiver_nativeDeclineCall(
    mut env: jni::JNIEnv,
    _this: jni::objects::JObject,
    from: jni::objects::JString,
    call_id: jni::objects::JString,
) {
    let Some(app) = APP.get() else { return };
    let Ok(from) = env.get_string(&from) else { return };
    let Ok(call_id) = env.get_string(&call_id) else { return };
    let from: String = from.into();
    let call_id: String = call_id.into();

    use tauri::Manager;
    let state = app.state::<crate::state::AppState>();
    let (links, me) = state.with(|s| (s.links.clone(), s.device_id.clone()));
    links.send(
        &from,
        &crate::signaling::Envelope {
            v: 1,
            from: me,
            kind: "signal".into(),
            payload: serde_json::json!({ "callId": call_id, "kind": "voice", "type": "decline" }),
        },
    );
    cancel(&call_id);
}
