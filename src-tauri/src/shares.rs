//! Persistent folder shares.
//!
//! A share is meant to be standing infrastructure, not a one-off send: it
//! survives restarts, comes back running, and keeps its counts current as the
//! folder underneath it changes. That is what makes "share this directory"
//! something you do once rather than every session.

use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tauri::{AppHandle, Emitter};

use crate::model::Share;
use crate::state::AppState;

/// Totals for a directory tree.
#[derive(Debug, Clone, Copy, Default)]
pub struct DirStats {
    pub files: u64,
    pub bytes: u64,
}

/// Walks a directory and totals what is in it.
///
/// Iterative rather than recursive, and bounded, so a deep tree or a symlink
/// loop cannot blow the stack or hang the caller.
pub fn scan_dir(root: &Path) -> DirStats {
    let mut stats = DirStats::default();
    let mut queue: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];

    while let Some((dir, depth)) = queue.pop() {
        if depth > 12 || stats.files > 200_000 {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                queue.push((entry.path(), depth + 1));
            } else if meta.is_file() {
                stats.files += 1;
                stats.bytes += meta.len();
            }
        }
    }
    stats
}

const VIDEO_EXTS: [&str; 7] = ["mp4", "webm", "mkv", "mov", "m4v", "avi", "ogv"];

/// Counts playable video files, to spot a folder that belongs in the Theatre.
pub fn count_videos(root: &Path) -> u64 {
    let mut count = 0u64;
    let mut queue: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];

    while let Some((dir, depth)) = queue.pop() {
        if depth > 8 || count > 10_000 {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                queue.push((path, depth + 1));
                continue;
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if VIDEO_EXTS.contains(&ext.as_str()) {
                count += 1;
            }
        }
    }
    count
}

/// Refreshes a share's counts from disk and tells the frontend.
pub fn refresh(app: &AppHandle, state: &AppState, share_id: &str) {
    let path = state.with(|s| {
        s.shares
            .iter()
            .find(|sh| sh.id == share_id)
            .map(|sh| PathBuf::from(&sh.path))
    });
    let Some(path) = path else { return };
    let stats = scan_dir(&path);

    let all = state.with(|s| {
        if let Some(sh) = s.shares.iter_mut().find(|sh| sh.id == share_id) {
            sh.file_count = stats.files;
            sh.total_bytes = stats.bytes;
        }
        s.shares.clone()
    });
    let _ = app.emit("host:changed", &all);

    // A media folder that gained or lost files changes the Theatre too.
    let is_media = state.with(|s| {
        s.shares
            .iter()
            .any(|sh| sh.id == share_id && sh.mode == crate::model::ShareMode::Media)
    });
    if is_media {
        let items = crate::media::refresh(state);
        let _ = app.emit("media:changed", &items);
    }
}

/// Watches every shared folder and refreshes the one that changed.
///
/// Filesystem events arrive in bursts — a copy of a hundred files is a hundred
/// events — so changes are coalesced into one rescan per folder per second.
pub fn watch(app: AppHandle, state: AppState) {
    std::thread::spawn(move || {
        let (tx, rx) = mpsc::channel();
        let mut watcher = match RecommendedWatcher::new(
            move |res: notify::Result<notify::Event>| {
                if let Ok(event) = res {
                    let _ = tx.send(event);
                }
            },
            notify::Config::default(),
        ) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("folder watching unavailable: {e}");
                return;
            }
        };

        let mut watched: Vec<PathBuf> = Vec::new();
        let mut last_scan: Vec<(String, Instant)> = Vec::new();

        loop {
            // Pick up folders added since the last pass.
            let current = state.with(|s| {
                s.shares
                    .iter()
                    .map(|sh| (sh.id.clone(), PathBuf::from(&sh.path)))
                    .collect::<Vec<_>>()
            });

            for (_, path) in &current {
                if !watched.contains(path) && path.is_dir() {
                    if watcher.watch(path, RecursiveMode::Recursive).is_ok() {
                        watched.push(path.clone());
                    }
                }
            }
            watched.retain(|p| {
                let still = current.iter().any(|(_, path)| path == p);
                if !still {
                    let _ = watcher.unwatch(p);
                }
                still
            });

            // Drain whatever arrived, then rescan the affected shares.
            let mut touched: Vec<String> = Vec::new();
            while let Ok(event) = rx.recv_timeout(Duration::from_secs(1)) {
                for changed in &event.paths {
                    for (id, root) in &current {
                        if changed.starts_with(root) && !touched.contains(id) {
                            touched.push(id.clone());
                        }
                    }
                }
            }

            let now = Instant::now();
            for id in touched {
                let recent = last_scan
                    .iter()
                    .any(|(seen, at)| *seen == id && now.duration_since(*at) < Duration::from_secs(1));
                if recent {
                    continue;
                }
                last_scan.retain(|(seen, _)| *seen != id);
                last_scan.push((id.clone(), now));
                refresh(&app, &state, &id);
            }
        }
    });
}

/* ------------------------------------------------------------ persistence */

pub fn save(state: &AppState, share: &Share) {
    state.with(|s| {
        let Some(db) = s.db.as_ref() else { return };
        let _ = db.execute(
            "INSERT INTO shares
                (id, name, path, slug, mode, running, require_phrase, phrase,
                 allow_upload, file_count, total_bytes, created_at, requests, bytes_served)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
             ON CONFLICT(id) DO UPDATE SET
                name = ?2, path = ?3, slug = ?4, mode = ?5, running = ?6,
                require_phrase = ?7, phrase = ?8, allow_upload = ?9,
                file_count = ?10, total_bytes = ?11",
            rusqlite::params![
                share.id,
                share.name,
                share.path,
                share.slug,
                mode_str(share),
                share.running as i64,
                share.require_phrase as i64,
                share.phrase,
                share.allow_upload as i64,
                share.file_count as i64,
                share.total_bytes as i64,
                share.created_at as i64,
                share.requests as i64,
                share.bytes_served as i64,
            ],
        );
    });
}

pub fn forget(state: &AppState, id: &str) {
    state.with(|s| {
        if let Some(db) = s.db.as_ref() {
            let _ = db.execute("DELETE FROM shares WHERE id = ?1", rusqlite::params![id]);
        }
    });
}

/// Restores previously published folders on startup.
///
/// A folder that has since been moved or deleted is dropped rather than
/// restored broken — a share pointing at nothing would 404 confusingly.
pub fn restore(state: &AppState) -> Vec<Share> {
    state.with(|s| {
        let Some(db) = s.db.as_ref() else {
            return Vec::new();
        };
        let Ok(mut stmt) = db.prepare(
            "SELECT id, name, path, slug, mode, running, require_phrase, phrase,
                    allow_upload, file_count, total_bytes, created_at, requests, bytes_served
             FROM shares",
        ) else {
            return Vec::new();
        };

        let rows = stmt.query_map([], |row| {
            Ok(Share {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                slug: row.get(3)?,
                mode: mode_from(&row.get::<_, String>(4)?),
                running: row.get::<_, i64>(5)? != 0,
                require_phrase: row.get::<_, i64>(6)? != 0,
                phrase: row.get(7)?,
                allow_upload: row.get::<_, i64>(8)? != 0,
                file_count: row.get::<_, i64>(9)? as u64,
                total_bytes: row.get::<_, i64>(10)? as u64,
                created_at: row.get::<_, i64>(11)? as u64,
                requests: row.get::<_, i64>(12)? as u64,
                bytes_served: row.get::<_, i64>(13)? as u64,
                active_viewers: 0,
                last_request_at: None,
            })
        });

        match rows {
            Ok(iter) => iter
                .flatten()
                .filter(|sh| Path::new(&sh.path).is_dir())
                .collect(),
            Err(_) => Vec::new(),
        }
    })
}

fn mode_str(share: &Share) -> &'static str {
    use crate::model::ShareMode::*;
    match share.mode {
        Files => "files",
        Site => "site",
        App => "app",
        Media => "media",
    }
}

fn mode_from(raw: &str) -> crate::model::ShareMode {
    use crate::model::ShareMode::*;
    match raw {
        "site" => Site,
        "app" => App,
        "media" => Media,
        _ => Files,
    }
}
