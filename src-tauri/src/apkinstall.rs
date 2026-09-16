//! Handing a staged package to Android's installer.
//!
//! There is no plugin for this, and the one that looks like it is not it. The
//! opener plugin builds `ACTION_VIEW` from whatever string it is given, with
//! no MIME type and no permission grant, which is right for a web address and
//! cannot install an APK. Three separate things stop it:
//!
//! - A bare path has no scheme, so nothing on the device claims the intent.
//! - A `file://` URI throws `FileUriExposedException`; Android stopped
//!   accepting those from one app to another in Nougat.
//! - The staged file lives in this app's private cache, which the package
//!   installer is a different process and cannot read at all.
//!
//! So the file is handed over as a `content://` URI minted by the FileProvider
//! declared in the manifest, carrying a read grant that lasts as long as the
//! installer needs it. `file_paths.xml` already exposes `updates/` for exactly
//! this.
//!
//! Two things about *reaching* Java from here were wrong before, and both had
//! the same shape: assuming something is lying around that is not.
//!
//! - `ndk_context` was asked for the virtual machine and the context. Nothing
//!   in this app's stack fills it in - it is populated by `ndk-glue`, which
//!   belongs to a way of starting an Android app that Tauri does not use - so
//!   it returned a pair of null pointers and the first call through them
//!   failed with "the resource id is invalid". Instead the activity hands its
//!   own runtime over as it starts, which is the one moment both are certainly
//!   real.
//!
//! - `FileProvider` was looked up by name from this thread. A thread attached
//!   from Rust gets the *system* class loader, which knows the framework and
//!   nothing this app ships, so that lookup could only ever have failed too.
//!   The class reference is therefore taken on the activity's own thread, at
//!   registration, and the intent is built in Kotlin - on the far side of a
//!   single static method - where the app's classes are simply in scope.

use jni::objects::{GlobalRef, JClass, JObject, JString};
use std::sync::OnceLock;

/// What it takes to call back into the app, captured while the app is calling
/// us and therefore known to be valid.
struct Runtime {
    vm: jni::JavaVM,
    /// `MainActivity`, resolved through the app's class loader rather than the
    /// system one a Rust thread would otherwise get.
    activity: GlobalRef,
}

static RUNTIME: OnceLock<Runtime> = OnceLock::new();

/// Called once by `MainActivity` as it starts.
///
/// # Safety
///
/// Called by the Java runtime with arguments it constructed. Nothing else may
/// call it.
#[no_mangle]
pub extern "system" fn Java_app_lantern_desktop_MainActivity_nativeRegisterInstaller(
    env: jni::JNIEnv,
    this: JObject,
) {
    let Ok(vm) = env.get_java_vm() else { return };
    let Ok(class) = env.get_object_class(&this) else {
        return;
    };
    let Ok(activity) = env.new_global_ref(&class) else {
        return;
    };
    let _ = RUNTIME.set(Runtime { vm, activity });
}

/// Runs something against the activity, when Android has handed it over.
///
/// The registration above is the only route from here into the app's own
/// classes, so anything else that needs one borrows it rather than asking for
/// a second. `None` means the activity has not started yet, or this is not
/// Android at all, and the caller decides what that means.
pub(crate) fn with_activity<R>(
    run: impl FnOnce(&mut jni::AttachGuard<'_>, &JClass) -> R,
) -> Option<R> {
    let runtime = RUNTIME.get()?;
    let mut env = runtime.vm.attach_current_thread().ok()?;
    // Safety: as in `install` - a global reference to a live class, and
    // `JClass` owns nothing, so nothing is released twice.
    let class = unsafe { JClass::from_raw(runtime.activity.as_raw()) };
    let out = run(&mut env, &class);
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
    }
    Some(out)
}

/// Asks Android to install the package at `path`.
///
/// Returning `Ok` means the installer was launched, not that anything was
/// installed: what happens next is a system dialogue this app cannot see the
/// answer to, and must not pretend to.
pub fn install(path: &std::path::Path) -> Result<(), String> {
    let runtime = RUNTIME
        .get()
        .ok_or("this build cannot reach Android's installer")?;

    let mut env = runtime
        .vm
        .attach_current_thread()
        .map_err(|e| format!("could not reach the Java runtime: {e}"))?;

    // Safety: the reference was taken from a live class and is held global,
    // so it is valid until the process ends. `JClass` owns nothing and frees
    // nothing, so nothing is released twice.
    let class = unsafe { JClass::from_raw(runtime.activity.as_raw()) };

    let outcome = (|| -> Result<String, jni::errors::Error> {
        let arg = env.new_string(path.to_string_lossy().as_ref())?;
        let returned = env
            .call_static_method(
                &class,
                "installPackage",
                "(Ljava/lang/String;)Ljava/lang/String;",
                &[(&arg).into()],
            )?
            .l()?;
        Ok(env.get_string(&JString::from(returned))?.into())
    })();

    // A Java exception left pending poisons every later JNI call in this
    // thread, so it is read and cleared here whatever happens next.
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
        return Err("Android refused the install request".into());
    }

    // Kotlin reports trouble by returning it, rather than by throwing across
    // the boundary: an exception is far more expensive to read from here than
    // a string is, and there is nothing useful to do with one that a message
    // does not also say.
    match outcome.map_err(|e| format!("could not start the installer: {e}"))? {
        message if message.is_empty() => Ok(()),
        message => Err(message),
    }
}
