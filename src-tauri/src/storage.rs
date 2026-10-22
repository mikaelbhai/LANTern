//! Android's "All files access".
//!
//! Browsing a linked phone's storage lists folders fine and then shows almost
//! nothing in them: since scoped storage an app sees only the media it has
//! been granted and its own files, so PDFs, documents and every other app's
//! downloads are simply absent from a directory listing - not refused, absent,
//! which looks exactly like an empty phone. `MANAGE_EXTERNAL_STORAGE` is the
//! one grant that lifts that, and it is a Settings switch rather than a
//! dialog, so the app can only take the person to it and re-check afterwards.
//!
//! Desktop has no such restriction and answers "already fine".

/// Whether this process can see all files, not just its own and its media.
pub fn all_files_access() -> bool {
    #[cfg(target_os = "android")]
    {
        crate::apkinstall::with_activity(|env, class| {
            env.call_static_method(class, "allFilesAccess", "()Z", &[])
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

/// Opens the Settings page that grants it. Fire-and-forget: the answer is a
/// switch this app cannot see flipped, so the caller re-checks afterwards.
pub fn request_all_files_access() {
    #[cfg(target_os = "android")]
    {
        crate::apkinstall::with_activity(|env, class| {
            let _ = env.call_static_method(class, "requestAllFilesAccess", "()V", &[]);
        });
    }
}

#[tauri::command]
pub fn storage_all_files() -> bool {
    all_files_access()
}

#[tauri::command]
pub fn storage_request_all_files() {
    request_all_files_access();
}
