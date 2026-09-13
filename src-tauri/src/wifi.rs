//! Joining a known network before anything else looks at the network.
//!
//! LANTern is only ever as useful as the LAN it is on, and a machine that
//! wakes up on the wrong network — or on none — looks broken in a way that has
//! nothing to do with LANTern: no peers, no shares, no streams, and no
//! explanation. On a desktop somebody notices and fixes it. On a machine being
//! reached from a phone in another room, nobody is there to notice.
//!
//! So this joins one chosen network at startup, and the constraint that makes
//! it defensible is that it can only join a network the machine has already
//! saved. LANTern never asks for a Wi-Fi password, never stores one, and never
//! sees one: the credentials stay where the operating system already keeps
//! them, and this does no more than ask for a network the machine could have
//! joined by itself. A network that is not saved cannot be chosen here, which
//! is enforced rather than merely offered.
//!
//! It is off unless somebody turns it on, and it does nothing at all when the
//! machine is already on the chosen network — which is nearly always, so
//! nearly always this costs one query and no delay.

use std::path::{Path, PathBuf};

/// How long to wait for the network to come up before carrying on.
///
/// Bounded, because startup is blocked for the duration. Associating takes a
/// second or two; anything past this is a network that is not coming back, and
/// holding the window shut while it does not is worse than starting without
/// it. Whatever the answer, LANTern still starts.
const PATIENCE: std::time::Duration = std::time::Duration::from_secs(10);
const POLL: std::time::Duration = std::time::Duration::from_millis(250);

/// Where the chosen network is remembered.
///
/// A file rather than the database, for the same reason the screen-sharing
/// switch uses one: this is read before the database is open. The network has
/// to be up before the app reads its own address, and by the time there is
/// somewhere to store a preference it is far too late to act on this one.
pub fn setting_path(dir: &Path) -> PathBuf {
    dir.join("startup-wifi")
}

/// The network to join at startup, if any.
pub fn preference(dir: &Path) -> Option<String> {
    std::fs::read_to_string(setting_path(dir))
        .ok()
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// Chooses a network, or `None` to turn this off.
///
/// Refuses a network the machine has not saved. Not because of the command —
/// nothing here goes near a shell — but because the promise this feature makes
/// is that it can only rejoin somewhere already known, and a promise enforced
/// in one place is a promise.
pub fn set_preference(dir: &Path, ssid: Option<&str>) -> Result<(), String> {
    match ssid.map(str::trim).filter(|s| !s.is_empty()) {
        Some(ssid) => {
            if !saved().iter().any(|s| s == ssid) {
                return Err(format!(
                    "this machine has not saved a network called {ssid} — connect to it once first"
                ));
            }
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
            std::fs::write(setting_path(dir), ssid).map_err(|e| e.to_string())
        }
        None => match std::fs::remove_file(setting_path(dir)) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        },
    }
}

/// What the startup step did.
pub enum Joined {
    /// Nothing was asked for.
    NotAsked,
    /// Already on it, which is the ordinary case and costs nothing.
    Already(String),
    Connected(String),
    Failed(String, String),
}

/// The startup step: join the chosen network if this machine is not on it.
pub fn ensure(dir: &Path) -> Joined {
    let Some(want) = preference(dir) else {
        return Joined::NotAsked;
    };
    if current().as_deref() == Some(want.as_str()) {
        return Joined::Already(want);
    }
    if let Err(e) = connect(&want) {
        return Joined::Failed(want, e);
    }

    // Asking is not arriving. The command returns the moment the request has
    // been accepted, and the address this machine is about to publish does not
    // exist until association finishes.
    let deadline = std::time::Instant::now() + PATIENCE;
    while std::time::Instant::now() < deadline {
        if current().as_deref() == Some(want.as_str()) {
            return Joined::Connected(want);
        }
        std::thread::sleep(POLL);
    }
    Joined::Failed(want, "the network did not come up in time".into())
}

/* ---------------------------------------------------------- asking the OS */

#[cfg(any(target_os = "windows", target_os = "macos"))]
fn run(program: &str, args: &[&str]) -> Option<String> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args);
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let out = cmd.output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Whether this platform can be asked at all.
///
/// Android cannot: since Android 10 an app may suggest a network and the
/// person decides, which is the right rule and leaves nothing for this to do.
pub fn supported() -> bool {
    cfg!(any(target_os = "windows", target_os = "macos"))
}

/// The network this machine is on, if it is on one.
pub fn current() -> Option<String> {
    #[cfg(target_os = "windows")]
    {
        parse_windows_ssid(&run("netsh", &["wlan", "show", "interfaces"])?)
    }
    #[cfg(target_os = "macos")]
    {
        parse_macos_ssid(&run("networksetup", &["-getairportnetwork", &wifi_device()])?)
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        None
    }
}

/// Every network this machine has saved.
pub fn saved() -> Vec<String> {
    #[cfg(target_os = "windows")]
    {
        run("netsh", &["wlan", "show", "profiles"])
            .map(|out| parse_windows_profiles(&out))
            .unwrap_or_default()
    }
    #[cfg(target_os = "macos")]
    {
        run(
            "networksetup",
            &["-listpreferredwirelessnetworks", &wifi_device()],
        )
        .map(|out| parse_macos_networks(&out))
        .unwrap_or_default()
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Vec::new()
    }
}

/// Joins a saved network.
pub fn connect(ssid: &str) -> Result<(), String> {
    if !saved().iter().any(|s| s == ssid) {
        return Err(format!("{ssid} is not a saved network on this machine"));
    }
    #[cfg(target_os = "windows")]
    {
        run("netsh", &["wlan", "connect", &format!("name={ssid}")])
            .map(|_| ())
            .ok_or_else(|| "could not ask Windows to connect".to_string())
    }
    #[cfg(target_os = "macos")]
    {
        // No password argument, deliberately. macOS reads the one it already
        // has, and a password this app never handles is one it cannot leak.
        run("networksetup", &["-setairportnetwork", &wifi_device(), ssid])
            .map(|_| ())
            .ok_or_else(|| "could not ask macOS to connect".to_string())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        Err("this platform does not let an app choose the network".into())
    }
}

/// The Wi-Fi interface's device name, which is not always en0.
#[cfg(target_os = "macos")]
fn wifi_device() -> String {
    // "Hardware Port: Wi-Fi", and the device on the line after it.
    let Some(out) = run("networksetup", &["-listallhardwareports"]) else {
        return "en0".into();
    };
    let lines: Vec<&str> = out.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        if line.trim_start().starts_with("Hardware Port:") && line.contains("Wi-Fi") {
            if let Some(dev) = lines.get(i + 1).and_then(|l| l.split_once(':')) {
                let dev = dev.1.trim();
                if !dev.is_empty() {
                    return dev.to_string();
                }
            }
        }
    }
    "en0".into()
}

/* ------------------------------------------------------------ the parsing */

/// Every profile name out of `netsh wlan show profiles`.
///
/// Read by shape rather than by label. The label is translated — a German
/// Windows says "Profil für alle Benutzer" — and matching the English would
/// mean this feature simply does not exist outside English. What is not
/// translated is the layout: an indented key, a colon, and the name.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_windows_profiles(out: &str) -> Vec<String> {
    let mut found: Vec<String> = Vec::new();
    for line in out.lines() {
        // Section headings are flush left; the profiles under them are not.
        if !line.starts_with(' ') && !line.starts_with('\t') {
            continue;
        }
        let Some((_, name)) = line.split_once(':') else {
            continue;
        };
        let name = name.trim();
        if name.is_empty() || found.iter().any(|f| f == name) {
            continue;
        }
        found.push(name.to_string());
    }
    found
}

/// The SSID out of `netsh wlan show interfaces`, when it says there is one.
#[cfg_attr(not(target_os = "windows"), allow(dead_code))]
fn parse_windows_ssid(out: &str) -> Option<String> {
    out.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        // Exactly SSID. The neighbouring line is the BSSID, which is the
        // access point's address and a plausible-looking wrong answer.
        if !key.trim().eq_ignore_ascii_case("SSID") {
            return None;
        }
        let value = value.trim();
        (!value.is_empty()).then(|| value.to_string())
    })
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_macos_ssid(out: &str) -> Option<String> {
    // "Current Wi-Fi Network: HomeNet", or a sentence saying there is none.
    let line = out.lines().find(|l| l.contains("Current Wi-Fi Network"))?;
    let value = line.split_once(':')?.1.trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn parse_macos_networks(out: &str) -> Vec<String> {
    out.lines()
        .skip(1) // "Preferred networks on en0:"
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_profiles_windows_lists() {
        let out = concat!(
            "\r\nProfiles on interface Wi-Fi:\r\n\r\n",
            "Group policy profiles (read only)\r\n",
            "---------------------------------\r\n",
            "    <None>\r\n\r\n",
            "User profiles\r\n-------------\r\n",
            "    All User Profile     : HomeNet\r\n",
            "    All User Profile     : Cafe 5G\r\n",
            "    All User Profile     : HomeNet\r\n",
        );
        // "<None>" has no colon and is skipped; the repeat is not listed twice.
        assert_eq!(parse_windows_profiles(out), vec!["HomeNet", "Cafe 5G"]);
    }

    /// A Windows that is not in English must still work: the labels are
    /// translated and the shape is not, so only the shape is read.
    #[test]
    fn a_translated_windows_still_lists_its_profiles() {
        let out = concat!(
            "\r\nProfile auf Schnittstelle WLAN:\r\n\r\n",
            "Benutzerprofile\r\n---------------\r\n",
            "    Profil f\u{fc}r alle Benutzer: Zuhause\r\n",
        );
        assert_eq!(parse_windows_profiles(out), vec!["Zuhause"]);
    }

    #[test]
    fn reads_the_network_windows_is_on() {
        let out = concat!(
            "\r\nThere is 1 interface on the system:\r\n\r\n",
            "    Name                   : Wi-Fi\r\n",
            "    State                  : connected\r\n",
            "    SSID                   : HomeNet\r\n",
            "    BSSID                  : ea:e2:cd:2a:09:d3\r\n",
        );
        assert_eq!(parse_windows_ssid(out).as_deref(), Some("HomeNet"));
    }

    /// The access point's address is not the network's name, and it sits on
    /// the very next line.
    #[test]
    fn the_access_point_is_not_the_network() {
        let out = concat!(
            "    BSSID                  : ea:e2:cd:2a:09:d3\r\n",
            "    SSID                   : HomeNet\r\n",
        );
        assert_eq!(parse_windows_ssid(out).as_deref(), Some("HomeNet"));
    }

    #[test]
    fn a_disconnected_machine_is_on_no_network() {
        let out = concat!(
            "\r\nThere is 1 interface on the system:\r\n\r\n",
            "    Name                   : Wi-Fi\r\n",
            "    State                  : disconnected\r\n",
        );
        assert_eq!(parse_windows_ssid(out), None);
        assert_eq!(parse_windows_ssid(""), None);
        assert_eq!(
            parse_windows_ssid("There is no wireless interface on the system.\r\n"),
            None
        );
    }

    #[test]
    fn reads_what_macos_says() {
        assert_eq!(
            parse_macos_ssid("Current Wi-Fi Network: HomeNet\n").as_deref(),
            Some("HomeNet")
        );
        assert_eq!(
            parse_macos_ssid("You are not associated with an AirPort network.\n"),
            None
        );
        assert_eq!(
            parse_macos_networks("Preferred networks on en0:\n\tHomeNet\n\tCafe 5G\n"),
            vec!["HomeNet", "Cafe 5G"]
        );
    }

    /// A network name may contain the separator, and cutting at the last colon
    /// rather than the first would rename it.
    #[test]
    fn a_colon_in_the_name_survives() {
        assert_eq!(
            parse_windows_ssid("    SSID                   : Bob: the network\r\n").as_deref(),
            Some("Bob: the network")
        );
        assert_eq!(
            parse_windows_profiles("    All User Profile     : Bob: the network\r\n"),
            vec!["Bob: the network"]
        );
    }

    /// Turning it off is not a failure, however many times it is done.
    #[test]
    fn choosing_nothing_clears_it() {
        let dir = std::env::temp_dir().join(format!("lantern-wifi-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(preference(&dir), None);
        set_preference(&dir, None).unwrap();
        set_preference(&dir, None).unwrap();
        assert_eq!(preference(&dir), None);

        // A name written by hand is read back without its whitespace.
        std::fs::write(setting_path(&dir), "  HomeNet \n").unwrap();
        assert_eq!(preference(&dir).as_deref(), Some("HomeNet"));

        // An empty file is off, not a network with no name.
        std::fs::write(setting_path(&dir), "   ").unwrap();
        assert_eq!(preference(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// The promise: a network this machine has never saved cannot be chosen,
    /// because LANTern has no password to offer and never will have.
    #[test]
    fn an_unknown_network_cannot_be_chosen() {
        let dir = std::env::temp_dir().join(format!("lantern-wifi-{}", uuid::Uuid::new_v4()));
        let unknown = "a network nobody has ever joined";
        let err = set_preference(&dir, Some(unknown)).expect_err("an unsaved network was accepted");
        assert!(err.contains("has not saved"), "{err}");
        assert!(connect(unknown).is_err());
        // And nothing was written on the way to refusing.
        assert_eq!(preference(&dir), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Against the real machine, because every fixture above is a guess at
    /// what the tool prints until one of them is checked. Reads only: it asks
    /// what the machine is on and what it has saved, and joins nothing.
    #[test]
    #[ignore = "asks the real machine"]
    fn what_this_machine_actually_says() {
        println!("supported: {}", supported());
        println!("on: {:?}", current());
        println!("saved: {:?}", saved());
        assert!(
            !supported() || !saved().is_empty() || current().is_none(),
            "a machine on a network with no saved profiles means the parsing missed something",
        );
    }

    #[test]
    fn nothing_chosen_means_nothing_happens() {
        let dir = std::env::temp_dir().join(format!("lantern-wifi-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(matches!(ensure(&dir), Joined::NotAsked));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
