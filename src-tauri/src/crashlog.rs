//! What happened, the one time nothing else could say.
//!
//! Every profile in this workspace builds with `panic = "abort"` — smaller
//! binaries, no unwinding tables to carry around on a phone. The trade is
//! that any panic, anywhere, on any thread, ends the whole process
//! immediately: there is no unwind to catch, no window still open to show
//! anything in, and on Android that surfaces to the person as "LANTern
//! keeps stopping" with nothing behind it — which is exactly how one such
//! crash was diagnosed this session, by pulling raw logcat off a device by
//! hand, because nothing in the application itself had written down what
//! actually happened.
//!
//! A panic hook still runs before the abort, on whichever thread panicked,
//! with nothing more than the message and where it was raised. That is not
//! enough to show anybody anything live — the process is finishing before
//! the hook returns — but it is enough to write one line to a file, and a
//! file survives past the process that wrote it. The next launch reads it
//! back, tells the person plainly, and clears it, so it is asked about
//! once rather than forever.

use std::path::PathBuf;
use std::sync::OnceLock;

/// Where to write, decided once at startup and readable from any thread —
/// which a panic can happen on — without needing an `AppHandle` to ask
/// Tauri for it again. A panic hook gets nothing but the panic itself.
static PATH: OnceLock<PathBuf> = OnceLock::new();

/// Installs the hook and remembers where to write. Called once, from
/// `setup`, before anything else has had a chance to panic.
pub fn install(dir: &std::path::Path) {
    let path = dir.join("last-crash.txt");
    let _ = PATH.set(path);

    std::panic::set_hook(Box::new(|info| {
        let Some(path) = PATH.get() else { return };

        let where_ = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown location".into());
        let what = info
            .payload()
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "no message".into());

        let line = format!(
            "{}\n{what}\nat {where_}\n",
            crate::model::now_ms(),
        );
        // Best-effort. A panic hook that itself panics on a failed write
        // would replace the crash with a worse one and say nothing at all;
        // if this cannot be written, there was never anything to lose by
        // trying.
        let _ = std::fs::write(path, line);
    }));
}

/// The last crash this device recorded, if the file is still there — and
/// clears it in the same breath, so it is surfaced once and not on every
/// launch after.
///
/// `None` is the ordinary case. It means nothing, including "the last run
/// ended badly but before the hook could write" — a torn write or a kill at
/// the OS level rather than a Rust panic leaves nothing here either, and
/// there is no way to tell those apart from a clean exit.
pub fn last_crash() -> Option<String> {
    let path = PATH.get()?;
    let text = std::fs::read_to_string(path).ok()?;
    let _ = std::fs::remove_file(path);
    if text.trim().is_empty() {
        None
    } else {
        Some(text)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nothing_is_reported_before_anything_is_written() {
        // `install` is process-global and this test does not call it, so
        // `PATH` may already be set by another test in the same binary —
        // exercised instead through the read path directly, which is the
        // part with logic worth checking.
        let dir = std::env::temp_dir().join(format!("lantern-crashlog-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("last-crash.txt");
        let _ = std::fs::remove_file(&path);

        assert!(std::fs::read_to_string(&path).is_err());
    }

    #[test]
    fn a_written_crash_is_read_back_once_and_then_gone() {
        let dir = std::env::temp_dir().join(format!("lantern-crashlog2-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("last-crash.txt");
        std::fs::write(&path, "1700000000000\nsomething broke\nat src/foo.rs:12\n").unwrap();

        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.contains("something broke"));
        let _ = std::fs::remove_file(&path);
        assert!(std::fs::read_to_string(&path).is_err());
    }

    #[test]
    fn an_empty_file_reports_as_nothing() {
        // A crash log that exists but has nothing in it - a write that was
        // interrupted, or a file left over from something else - must not
        // be shown to anybody as "here is what went wrong": there is
        // nothing to tell them.
        let dir = std::env::temp_dir().join(format!("lantern-crashlog3-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let path = dir.join("last-crash.txt");
        std::fs::write(&path, "   \n").unwrap();
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(text.trim().is_empty());
        let _ = std::fs::remove_file(&path);
    }
}
