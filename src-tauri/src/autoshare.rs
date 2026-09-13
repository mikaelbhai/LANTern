//! Sharing this screen without being asked, when that is what was chosen.
//!
//! Handing over a screen normally means answering the operating system's own
//! "which window would you like to share?" dialog, and no application can
//! answer it on your behalf — that is the point of it. Which is a problem for
//! the one case this exists for: nobody is at the machine, that is why it is
//! being driven from a phone.
//!
//! Chromium has a switch for exactly this, meant for kiosks and test rigs: it
//! pre-selects a capture source so the dialog never appears. WebView2 takes
//! Chromium's switches, so LANTern can be started with it.
//!
//! Two things make this defensible here and would not elsewhere. The webview
//! shows only LANTern's own pages, never a site, so there is no third party
//! who could ask for the screen and be silently given it. And a screen can
//! still only be sent to a device that has been granted control, which is a
//! decision somebody made deliberately.
//!
//! It is off unless turned on, it says plainly what it does, and because a
//! browser's switches are fixed when the browser starts, it takes effect at
//! the next launch rather than immediately.

/// The switch, and the source it picks.
///
/// "Entire screen" is the English label Chromium gives the whole-desktop
/// source. A machine running Windows in another language will not match it and
/// will show the picker as usual — which is the safe way for this to fail, and
/// is why the setting describes itself as an attempt.
const SWITCH: &str = "--auto-select-desktop-capture-source=Entire screen";

/// Where the preference lives.
///
/// A file of its own rather than the database, because this is read before
/// anything is initialised — the switch has to be in the environment before
/// the webview is created, and by the time the app has a database it is far
/// too late.
pub fn flag_path() -> Option<std::path::PathBuf> {
    let base = std::env::var_os("APPDATA").map(std::path::PathBuf::from)?;
    Some(base.join("app.lantern.desktop").join("autoshare"))
}

pub fn is_enabled() -> bool {
    flag_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .map(|v| v.trim() == "1")
        .unwrap_or(false)
}

pub fn set_enabled(on: bool) -> Result<(), String> {
    let path = flag_path().ok_or("nowhere to store the setting")?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    std::fs::write(&path, if on { "1" } else { "0" }).map_err(|e| e.to_string())
}

/// Puts the switch in the environment, before any webview exists.
///
/// Appends rather than replaces: Tauri passes switches of its own and losing
/// those would be a strange way to gain this one.
pub fn apply() {
    if !is_enabled() {
        return;
    }
    const KEY: &str = "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS";
    let existing = std::env::var(KEY).unwrap_or_default();
    if existing.contains("auto-select-desktop-capture-source") {
        return;
    }
    let combined = if existing.trim().is_empty() {
        SWITCH.to_string()
    } else {
        format!("{existing} {SWITCH}")
    };
    std::env::set_var(KEY, combined);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_switch_is_the_one_chromium_understands() {
        // Spelled out rather than built, because a typo here fails by showing
        // the picker - which looks exactly like the setting being off.
        assert!(SWITCH.starts_with("--auto-select-desktop-capture-source="));
        assert!(SWITCH.ends_with("Entire screen"));
    }

    #[test]
    fn it_is_off_unless_the_file_says_otherwise() {
        // Anything that is not exactly "1" leaves it off: a truncated write, a
        // half-written file, or a value from some future version all fail
        // closed rather than silently sharing a screen.
        for value in ["", "0", "yes", "true", "11", " "] {
            let on = value.trim() == "1";
            assert!(!on, "{value:?} enabled it");
        }
        assert!("1".trim() == "1");
        // A trailing newline is what most editors leave behind.
        assert!("1\n".trim() == "1");
    }
}
