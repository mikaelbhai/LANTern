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
//! Written against JNI rather than by adding a Kotlin entry point, because a
//! channel from Rust into the activity is machinery this app has done without
//! everywhere else, and one intent does not justify inventing one.

use jni::objects::{JObject, JString, JValue};

/// Read permission for the installer, and a task of its own to run in.
const FLAG_GRANT_READ_URI_PERMISSION: i32 = 0x0000_0001;
const FLAG_ACTIVITY_NEW_TASK: i32 = 0x1000_0000;

const APK_MIME: &str = "application/vnd.android.package-archive";

/// Asks Android to install the package at `path`.
///
/// Returning `Ok` means the installer was launched, not that anything was
/// installed: what happens next is a system dialogue this app cannot see the
/// answer to, and must not pretend to.
pub fn install(path: &std::path::Path) -> Result<(), String> {
    let ctx = ndk_context::android_context();

    // Safety: both pointers come from the runtime that is currently running
    // this code, and are valid for as long as the process is.
    let vm = unsafe { jni::JavaVM::from_raw(ctx.vm().cast()) }
        .map_err(|e| format!("no Java runtime: {e}"))?;
    let mut env = vm
        .attach_current_thread()
        .map_err(|e| format!("could not reach the Java runtime: {e}"))?;
    let context = unsafe { JObject::from_raw(ctx.context().cast()) };

    let result = (|| -> Result<(), jni::errors::Error> {
        // new File(path)
        let path_string = env.new_string(path.to_string_lossy().as_ref())?;
        let file = env.new_object(
            "java/io/File",
            "(Ljava/lang/String;)V",
            &[(&path_string).into()],
        )?;

        // The authority the manifest declares, which is the package name with
        // a suffix. Read from the running app rather than written down here,
        // so LANTV — a different package entirely — does not name LANTern's.
        let package = env
            .call_method(&context, "getPackageName", "()Ljava/lang/String;", &[])?
            .l()?;
        let package: String = env.get_string(&JString::from(package))?.into();
        let authority = env.new_string(format!("{package}.fileprovider"))?;

        // FileProvider.getUriForFile(context, authority, file)
        let uri = env
            .call_static_method(
                "androidx/core/content/FileProvider",
                "getUriForFile",
                "(Landroid/content/Context;Ljava/lang/String;Ljava/io/File;)Landroid/net/Uri;",
                &[(&context).into(), (&authority).into(), (&file).into()],
            )?
            .l()?;

        // new Intent(Intent.ACTION_VIEW).setDataAndType(uri, apk).addFlags(..)
        let action = env.new_string("android.intent.action.VIEW")?;
        let intent = env.new_object(
            "android/content/Intent",
            "(Ljava/lang/String;)V",
            &[(&action).into()],
        )?;

        let mime = env.new_string(APK_MIME)?;
        env.call_method(
            &intent,
            "setDataAndType",
            "(Landroid/net/Uri;Ljava/lang/String;)Landroid/content/Intent;",
            &[(&uri).into(), (&mime).into()],
        )?;
        env.call_method(
            &intent,
            "addFlags",
            "(I)Landroid/content/Intent;",
            &[JValue::Int(FLAG_GRANT_READ_URI_PERMISSION | FLAG_ACTIVITY_NEW_TASK)],
        )?;

        env.call_method(
            &context,
            "startActivity",
            "(Landroid/content/Intent;)V",
            &[(&intent).into()],
        )?;

        Ok(())
    })();

    // A Java exception left pending poisons every later JNI call in this
    // thread, so it is read and cleared here whatever happens next.
    if env.exception_check().unwrap_or(false) {
        let _ = env.exception_describe();
        let _ = env.exception_clear();
        return Err("Android refused the install request".into());
    }

    result.map_err(|e| format!("could not start the installer: {e}"))
}
