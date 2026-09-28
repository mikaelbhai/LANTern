//! Exempting LANTern from Android's battery optimizer.
//!
//! The foreground service (see `LanternService.kt`) is what is meant to keep
//! this device reachable while backgrounded, but the optimizer is a second,
//! independent gate: it can still doze the process between wakeups even with
//! a foreground service running, which looks from a peer's side exactly like
//! the earlier foreground-service crash did — reachable one moment, gone the
//! next, for a reason nothing in the interface names. Desktop has no such
//! optimizer, so this is Android-only and answers "already fine" everywhere
//! else rather than asking a question that has no meaning there.

/// Whether the optimizer currently leaves this process alone.
pub fn unrestricted() -> bool {
    #[cfg(target_os = "android")]
    {
        crate::apkinstall::with_activity(|env, class| {
            env.call_static_method(class, "batteryUnrestricted", "()Z", &[])
                .and_then(|v| v.z())
                .unwrap_or(false)
        })
        .unwrap_or(false)
    }
    #[cfg(not(target_os = "android"))]
    {
        true
    }
}

/// Opens the system dialogue that grants the exemption. Fire-and-forget: the
/// answer is a system dialogue this app cannot see the result of, and the
/// caller re-checks `unrestricted()` rather than being told one here.
pub fn request_unrestricted() {
    #[cfg(target_os = "android")]
    {
        crate::apkinstall::with_activity(|env, class| {
            let _ = env.call_static_method(class, "requestBatteryUnrestricted", "()V", &[]);
        });
    }
}
