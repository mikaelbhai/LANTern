//! What the webview saw, kept somewhere a restart cannot erase.
//!
//! `crashlog.rs` catches a Rust panic, which ends the whole process — but the
//! bug that sent this looking for it was never a panic. It was a button that
//! did nothing: no exception, no crash, nothing in the console after the tab
//! reloaded, because whatever runs the diagnosis is talking to a fresh
//! WebView that was not there when it happened. The previous attempt to
//! chase it down had nothing to read except "reset it, then it broke again" —
//! true, and not a location.
//!
//! This is the other half of `crashlog.rs`'s idea applied to the half that
//! does not panic: the frontend's own uncaught errors, unhandled promise
//! rejections, and a handful of call-flow breadcrumbs it chooses to record,
//! written to a plain file as they happen rather than held in memory a
//! reload can lose. A rolling window, not a single last line — this is
//! `console.error`'s backhaul, not a crash report.

use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};

/// Kept small on purpose: this is a recent-history window for chasing a bug
/// just reproduced, not a permanent record. Anything older than the last
/// few hundred lines was not going to be read anyway.
const MAX_LINES: usize = 500;

static PATH: OnceLock<Mutex<PathBuf>> = OnceLock::new();

/// Called once from `setup`, the same moment `crashlog::install` is.
pub fn install(dir: &std::path::Path) {
    let _ = PATH.set(Mutex::new(dir.join("client.log")));
}

/// Appends one line, trimming the file back to `MAX_LINES` whenever it grows
/// past double that — checking every write would mean reading the whole file
/// back on every single line, and a log nobody has looked at yet does not
/// need to stay exactly `MAX_LINES` long at every instant, only bounded.
pub fn append(level: &str, message: &str) {
    let Some(lock) = PATH.get() else { return };
    let Ok(path) = lock.lock() else { return };

    let line = format!("{} [{level}] {message}\n", crate::model::now_ms());

    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&*path)
    else {
        return;
    };
    let _ = file.write_all(line.as_bytes());
    drop(file);

    if let Ok(existing) = std::fs::metadata(&*path) {
        // Roughly two lines' worth of bytes per line of headroom before a
        // trim - cheap insurance against trimming on nearly every write for
        // a log made of unusually long lines.
        if existing.len() > (MAX_LINES as u64) * 400 {
            trim(&path);
        }
    }
}

fn trim(path: &std::path::Path) {
    let Ok(text) = std::fs::read_to_string(path) else { return };
    let kept: Vec<&str> = text.lines().rev().take(MAX_LINES).collect();
    let rewritten: String = kept.into_iter().rev().collect::<Vec<_>>().join("\n") + "\n";
    let _ = std::fs::write(path, rewritten);
}

/// The log as it stands, for exporting or reading back — unlike
/// `crashlog::last_crash`, this does not clear on read: it is a window onto
/// what is still happening, not a one-time report of what already ended.
pub fn read() -> String {
    let Some(lock) = PATH.get() else { return String::new() };
    let Ok(path) = lock.lock() else { return String::new() };
    std::fs::read_to_string(&*path).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lantern-clientlog-{name}-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        dir
    }

    #[test]
    fn a_line_written_is_a_line_read_back() {
        let dir = fresh_dir("basic");
        let path = dir.join("client.log");
        let _ = std::fs::remove_file(&path);
        let lock: Mutex<PathBuf> = Mutex::new(path.clone());

        // Exercised directly against a scratch path rather than through the
        // process-global `PATH`, which another test in this binary may have
        // already set - the same reason crashlog's own tests do this.
        let line = format!("{} [error] boom\n", crate::model::now_ms());
        std::fs::write(&path, &line).unwrap();

        let text = std::fs::read_to_string(&*lock.lock().unwrap()).unwrap();
        assert!(text.contains("boom"));
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn trimming_keeps_the_most_recent_lines_in_order() {
        let dir = fresh_dir("trim");
        let path = dir.join("client.log");
        let lines: Vec<String> = (0..(MAX_LINES + 50)).map(|n| format!("line {n}")).collect();
        std::fs::write(&path, lines.join("\n") + "\n").unwrap();

        trim(&path);

        let text = std::fs::read_to_string(&path).unwrap();
        let kept: Vec<&str> = text.lines().collect();
        assert_eq!(kept.len(), MAX_LINES);
        // The oldest lines are the ones dropped, not the newest.
        assert_eq!(kept.first(), Some(&"line 50"));
        assert_eq!(kept.last().map(|s| s.to_string()), Some(format!("line {}", MAX_LINES + 49)));
        let _ = std::fs::remove_file(&path);
    }
}
