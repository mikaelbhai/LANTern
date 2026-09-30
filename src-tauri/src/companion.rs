//! Browsing a companion device's whole filesystem.
//!
//! The one grant in this application wider than an explicitly published
//! share, and the one thing `trusted` was never allowed to mean — see
//! state.rs's own comment on `companions` for why the two are kept apart.
//! Reached only over the signalling link (`signaling.rs`'s native handling
//! of `fsbrowse`/`fsfetch`), never as an HTTP route the way a published
//! share is: this is not something a browser on the LAN should ever be
//! able to stumble into by guessing a URL.

use serde::Serialize;
use std::path::Path;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub size: u64,
    pub modified: u64,
}

/// Where a browse with no path lands: drive letters on Windows, since there
/// is no single filesystem root to start at; the literal root everywhere
/// else. Existence-checked rather than assumed — most machines do not have
/// a D: or an E:, and a phantom entry that fails the moment it is opened is
/// worse than a shorter, honest list.
pub fn roots() -> Vec<Entry> {
    #[cfg(windows)]
    {
        (b'A'..=b'Z')
            .filter_map(|b| {
                let letter = b as char;
                let root = format!("{letter}:\\");
                Path::new(&root).is_dir().then(|| Entry {
                    name: format!("{letter}:"),
                    path: root,
                    is_dir: true,
                    size: 0,
                    modified: 0,
                })
            })
            .collect()
    }
    #[cfg(not(windows))]
    {
        vec![Entry {
            name: "/".into(),
            path: "/".into(),
            is_dir: true,
            size: 0,
            modified: 0,
        }]
    }
}

/// One directory's contents, folders first, then alphabetical.
///
/// Best-effort on metadata: a file this account cannot read the modified
/// time of still belongs in the list, just with a 0 for the field nothing
/// could be read for — a permissions error on one entry must not hide
/// every other entry beside it.
pub fn list(path: &str) -> Result<Vec<Entry>, String> {
    let read = std::fs::read_dir(path).map_err(|e| e.to_string())?;
    let mut entries: Vec<Entry> = Vec::new();
    for item in read.flatten() {
        let Ok(meta) = item.metadata() else { continue };
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        entries.push(Entry {
            name: item.file_name().to_string_lossy().into_owned(),
            path: item.path().to_string_lossy().into_owned(),
            is_dir: meta.is_dir(),
            size: if meta.is_dir() { 0 } else { meta.len() },
            modified,
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_sort_before_files_then_alphabetically() {
        let dir = std::env::temp_dir().join(format!("lantern-companion-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("zzz_folder")).unwrap();
        std::fs::create_dir_all(dir.join("aaa_folder")).unwrap();
        std::fs::write(dir.join("aaa_file.txt"), b"x").unwrap();
        std::fs::write(dir.join("Bbb_file.txt"), b"x").unwrap();

        let entries = list(dir.to_str().unwrap()).unwrap();
        let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
        assert_eq!(names, vec!["aaa_folder", "zzz_folder", "aaa_file.txt", "Bbb_file.txt"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_missing_directory_is_an_error_not_a_panic() {
        assert!(list("D:/this/does/not/exist/at/all").is_err());
    }
}
