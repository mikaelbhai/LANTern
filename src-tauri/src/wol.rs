//! Waking a machine that has gone to sleep.
//!
//! A LAN suite that can only talk to devices which are already awake is
//! missing the obvious trick: the network card of a sleeping machine is still
//! listening, and a particular pattern of bytes on the wire brings the whole
//! thing back. It costs one UDP packet and no agreement from the far end -
//! there is nothing to install, and it works on machines that have never heard
//! of LANTern.
//!
//! Two things about it are worth knowing before trusting it, and the window
//! says both rather than offering a button that quietly does nothing:
//!
//! The packet is not acknowledged. Nothing comes back, ever. "Sent" is the
//! only thing this can honestly report; whether the machine wakes depends on
//! its firmware and its operating system, and the only evidence is the device
//! reappearing on the network.
//!
//! And it needs a MAC address, which is only knowable while the machine is
//! awake. So the address has to be remembered from when it was last seen -
//! there is no way to look up a sleeping device.

use std::net::{IpAddr, Ipv4Addr, SocketAddr, UdpSocket};

/// The magic packet: six 0xFF bytes, then the target's MAC sixteen times.
///
/// Not a protocol so much as a pattern a network card recognises while the
/// rest of the machine is off. Nothing else about the packet matters - not
/// the port, not the source, not what carries it - which is why this is a
/// pure function returning bytes and not a network call.
pub fn magic_packet(mac: [u8; 6]) -> Vec<u8> {
    let mut packet = Vec::with_capacity(102);
    packet.extend_from_slice(&[0xFF; 6]);
    for _ in 0..16 {
        packet.extend_from_slice(&mac);
    }
    packet
}

/// Reads a MAC address written any of the ways people write them.
///
/// Windows uses dashes, everything else uses colons, and people paste both
/// with stray spaces and mixed case. Refusing one of those would be a
/// needless way to make the feature look broken.
pub fn parse_mac(text: &str) -> Option<[u8; 6]> {
    let cleaned: String = text
        .chars()
        .filter(|c| !matches!(c, ':' | '-' | '.' | ' ' | '_'))
        .collect();
    if cleaned.len() != 12 || !cleaned.chars().all(|c| c.is_ascii_hexdigit()) {
        return None;
    }
    let mut mac = [0u8; 6];
    for (i, byte) in mac.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&cleaned[i * 2..i * 2 + 2], 16).ok()?;
    }
    // All zeroes is what an unknown address parses to, and broadcasting a wake
    // for it would be a packet sent to nowhere reported as a success.
    if mac == [0; 6] {
        return None;
    }
    Some(mac)
}

/// The broadcast address for a network, given any address on it and its mask.
///
/// Sent alongside the global broadcast because routers and access points
/// differ in which they forward: 255.255.255.255 is dropped by some, and a
/// directed broadcast is dropped by others. Sending both is one extra packet
/// and removes a whole class of "it works on my network".
pub fn broadcast_for(ip: Ipv4Addr, mask: Ipv4Addr) -> Ipv4Addr {
    let (a, m) = (ip.octets(), mask.octets());
    Ipv4Addr::new(
        a[0] | !m[0],
        a[1] | !m[1],
        a[2] | !m[2],
        a[3] | !m[3],
    )
}

/// The ports a sleeping card is listening on.
///
/// 9 is the discard port and the usual choice; 7 is echo and some firmware
/// wants that instead. Neither is listened to by anything on a woken machine,
/// so sending to both costs nothing.
const PORTS: [u16; 2] = [9, 7];

/// Sends the packet, and says how many went out.
///
/// Every combination of address and port is tried, and failures are counted
/// rather than returned: a machine with an interface that will not broadcast
/// should still be woken through the one that will.
pub fn wake(mac: [u8; 6], broadcasts: &[Ipv4Addr]) -> Result<usize, String> {
    let packet = magic_packet(mac);
    let socket = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|e| format!("could not open a socket: {e}"))?;
    socket
        .set_broadcast(true)
        .map_err(|e| format!("could not broadcast: {e}"))?;

    let mut sent = 0;
    let mut targets: Vec<Ipv4Addr> = broadcasts.to_vec();
    if !targets.contains(&Ipv4Addr::BROADCAST) {
        targets.push(Ipv4Addr::BROADCAST);
    }

    for address in targets {
        for port in PORTS {
            if socket
                .send_to(&packet, SocketAddr::new(IpAddr::V4(address), port))
                .is_ok()
            {
                sent += 1;
            }
        }
    }

    if sent == 0 {
        return Err("nothing could be sent; the network refused every address".into());
    }
    Ok(sent)
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAC: [u8; 6] = [0x54, 0xAF, 0x97, 0xB3, 0x44, 0xD8];

    #[test]
    fn the_packet_is_the_shape_a_card_looks_for() {
        let packet = magic_packet(MAC);
        // Six times 0xFF, then the address sixteen times: 6 + 96.
        assert_eq!(packet.len(), 102);
        assert_eq!(&packet[..6], &[0xFF; 6]);
        for i in 0..16 {
            let at = 6 + i * 6;
            assert_eq!(&packet[at..at + 6], &MAC, "copy {i} is wrong");
        }
    }

    #[test]
    fn a_different_address_gives_a_different_packet() {
        assert_ne!(magic_packet(MAC), magic_packet([1, 2, 3, 4, 5, 6]));
    }

    #[test]
    fn addresses_are_read_however_they_are_written() {
        // The same address, written the four ways it turns up.
        for text in [
            "54:AF:97:B3:44:D8",
            "54-af-97-b3-44-d8",
            "54AF97B344D8",
            " 54:af:97:B3:44:d8 ",
        ] {
            assert_eq!(parse_mac(text), Some(MAC), "could not read {text}");
        }
    }

    #[test]
    fn and_nonsense_is_refused() {
        for text in [
            "",
            "54:AF:97:B3:44",          // too short
            "54:AF:97:B3:44:D8:FF",    // too long
            "54:AF:97:B3:44:GG",       // not hex
            "hello",
            "00:00:00:00:00:00",       // the address of nothing
        ] {
            assert_eq!(parse_mac(text), None, "{text} was accepted");
        }
    }

    #[test]
    fn the_broadcast_address_of_a_network() {
        assert_eq!(
            broadcast_for(Ipv4Addr::new(192, 168, 100, 67), Ipv4Addr::new(255, 255, 255, 0)),
            Ipv4Addr::new(192, 168, 100, 255),
        );
        assert_eq!(
            broadcast_for(Ipv4Addr::new(10, 4, 9, 2), Ipv4Addr::new(255, 255, 0, 0)),
            Ipv4Addr::new(10, 4, 255, 255),
        );
        // A /32 is its own broadcast, which is degenerate but must not panic.
        assert_eq!(
            broadcast_for(Ipv4Addr::new(10, 0, 0, 1), Ipv4Addr::new(255, 255, 255, 255)),
            Ipv4Addr::new(10, 0, 0, 1),
        );
    }

    /// Sends a real magic packet onto the real network and reads it back.
    ///
    /// The strongest check available without a second machine asleep in the
    /// room: it proves the bytes leave this process, cross the network stack,
    /// and arrive in the shape a network card is looking for. Everything after
    /// that is the far machine's firmware, which no test here can reach.
    ///
    /// Ignored by default because it needs a network and broadcasts to it.
    #[test]
    #[ignore = "puts a packet on the real network"]
    fn a_real_packet_goes_out_and_comes_back() {
        use std::time::Duration;

        let listener = UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 9))
            .expect("could not listen on the wake port");
        listener
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        listener.set_broadcast(true).unwrap();

        let sent = wake(MAC, &[Ipv4Addr::BROADCAST]).expect("could not send");
        assert!(sent > 0);

        let mut buffer = [0u8; 256];
        let (len, from) = listener
            .recv_from(&mut buffer)
            .expect("the packet never arrived");

        assert_eq!(len, 102, "arrived the wrong length from {from}");
        assert_eq!(&buffer[..6], &[0xFF; 6], "no synchronisation header");
        assert_eq!(&buffer[6..12], &MAC, "the address in it is not the one asked for");
        assert_eq!(&buffer[96..102], &MAC, "the last repeat is wrong");
    }

    /// Opens a socket and broadcasts, without needing a network to be there.
    ///
    /// The part that fails on a machine whose firewall or permissions
    /// disagree, separated out so it runs in an ordinary test pass.
    #[test]
    fn packets_can_actually_be_sent() {
        let sent = wake(MAC, &[Ipv4Addr::new(127, 255, 255, 255)]).expect("could not send");
        assert!(sent > 0, "the socket opened but nothing went out");
    }
}

/// The hardware address a local IP is answering on, from the ARP table.
///
/// Read from the system rather than announced by the peer, because the point
/// of knowing it is to wake a machine that is no longer running anything that
/// could tell us. It has to be recorded while the device is awake and kept.
///
/// Only meaningful on the local network: ARP does not cross a router, and a
/// device that needs routing to reach cannot be woken by a broadcast anyway.
pub fn mac_for(ip: &str) -> Option<String> {
    // Refuse anything that is not an address before it reaches a command line.
    let parsed: std::net::Ipv4Addr = ip.parse().ok()?;
    let ip = parsed.to_string();

    let output = arp_output(&ip)?;
    parse_arp(&output, &ip)
}

#[cfg(windows)]
fn arp_output(ip: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("arp")
        .args(["-a", ip])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(not(windows))]
fn arp_output(ip: &str) -> Option<String> {
    let out = std::process::Command::new("arp").args(["-n", ip]).output().ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Picks the hardware address out of whatever `arp` printed.
///
/// The two platforms disagree about nearly everything - column order,
/// separators, headings, whether the address is padded - so rather than
/// parsing a layout this finds the line mentioning the address we asked about
/// and takes the first thing on it shaped like a MAC. That survives both
/// formats and the several variations within each.
pub fn parse_arp(output: &str, ip: &str) -> Option<String> {
    for line in output.lines() {
        if !line.contains(ip) {
            continue;
        }
        for field in line.split_whitespace() {
            if looks_like_mac(field) {
                return Some(field.to_ascii_lowercase().replace('-', ":"));
            }
        }
    }
    None
}

fn looks_like_mac(field: &str) -> bool {
    let parts: Vec<&str> = if field.contains(':') {
        field.split(':').collect()
    } else if field.contains('-') {
        field.split('-').collect()
    } else {
        return false;
    };
    parts.len() == 6
        && parts
            .iter()
            .all(|p| p.len() == 2 && p.chars().all(|c| c.is_ascii_hexdigit()))
}

#[cfg(test)]
mod arp_tests {
    use super::*;

    #[test]
    fn reads_the_windows_table() {
        let output = "\nInterface: 192.168.100.67 --- 0x5\n  Internet Address      Physical Address      Type\n  192.168.100.147       ea-e2-cd-2a-09-d3     dynamic\n";
        assert_eq!(
            parse_arp(output, "192.168.100.147"),
            Some("ea:e2:cd:2a:09:d3".into()),
        );
    }

    #[test]
    fn reads_the_unix_table() {
        let output = "phone.lan (192.168.100.147) at ea:e2:cd:2a:09:d3 [ether] on wlan0\n";
        assert_eq!(
            parse_arp(output, "192.168.100.147"),
            Some("ea:e2:cd:2a:09:d3".into()),
        );
    }

    #[test]
    fn takes_the_line_for_the_address_asked_about() {
        // Several entries, and the wrong one would wake the wrong machine.
        let output = "  192.168.100.1         54-af-97-b3-44-d8     dynamic\n  192.168.100.147       ea-e2-cd-2a-09-d3     dynamic\n";
        assert_eq!(parse_arp(output, "192.168.100.1"), Some("54:af:97:b3:44:d8".into()));
        assert_eq!(parse_arp(output, "192.168.100.147"), Some("ea:e2:cd:2a:09:d3".into()));
    }

    #[test]
    fn an_address_that_is_not_there() {
        let output = "  192.168.100.1         54-af-97-b3-44-d8     dynamic\n";
        assert_eq!(parse_arp(output, "192.168.100.99"), None);
    }

    #[test]
    fn incomplete_entries_give_nothing() {
        // A device that has gone: the row survives with no address on it.
        let output = "? (192.168.100.147) at <incomplete> on wlan0\n";
        assert_eq!(parse_arp(output, "192.168.100.147"), None);
    }

    #[test]
    fn nothing_shaped_like_an_address_is_mistaken_for_one() {
        assert!(!looks_like_mac("192.168.100.1"));
        assert!(!looks_like_mac("dynamic"));
        assert!(!looks_like_mac(""));
        assert!(!looks_like_mac("aa:bb:cc:dd:ee"));
        assert!(!looks_like_mac("aa:bb:cc:dd:ee:ff:00"));
        assert!(!looks_like_mac("gg:bb:cc:dd:ee:ff"));
        assert!(looks_like_mac("aa:bb:cc:dd:ee:ff"));
        assert!(looks_like_mac("AA-BB-CC-DD-EE-FF"));
    }

    #[test]
    fn a_hostile_address_never_reaches_a_command_line() {
        // The address goes to `arp` as an argument, so it is parsed and
        // reprinted first rather than passed through.
        assert_eq!(mac_for("; rm -rf /"), None);
        assert_eq!(mac_for("192.168.1.1 && calc"), None);
        assert_eq!(mac_for(""), None);
    }
}

/* ------------------------------------------------ this machine's own address */

// Everything above is the sending end, and the sending end has a hole in it:
// it learns a target's address from the ARP table, and a phone cannot read the
// ARP table at all. So a phone never held the address of the machine it most
// wanted to wake. A sleeping machine cannot say what its address is, so it is
// told ahead of time - while it is awake, to the devices it has been paired
// with, over the link they already share.
//
// A magic packet is not authenticated: whoever holds the address can wake the
// machine. Pairing is the only gate there is, so the address is given to
// paired devices and nobody else.

use crate::model::Interface;
use serde::{Deserialize, Serialize};

/// One of this machine's own network addresses, as it tells a paired device.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct OwnAddress {
    pub mac: String,
    pub ip: String,
    /// "ethernet", "wifi" or "other" - Wi-Fi cards almost never wake a machine
    /// that is off, so the far end prefers the wired one when it has to choose.
    pub kind: String,
}

/// A hardware address written the one way this app stores them.
pub fn format_mac(mac: [u8; 6]) -> String {
    mac.iter()
        .map(|b| format!("{b:02x}"))
        .collect::<Vec<_>>()
        .join(":")
}

/// Whether two addresses are on the same network under a mask.
fn same_network(a: Ipv4Addr, b: Ipv4Addr, mask: Ipv4Addr) -> bool {
    let (a, b, m) = (a.octets(), b.octets(), mask.octets());
    (0..4).all(|i| a[i] & m[i] == b[i] & m[i])
}

/// Which of a peer's announced addresses to wake it by.
///
/// The one on a network this device is also on, because a broadcast does not
/// cross a router; failing that, a wired one, because a Wi-Fi card is the least
/// likely to be listening while the machine is off.
pub fn choose_address(announced: &[OwnAddress], mine: &[Interface]) -> Option<String> {
    let shared = |a: &OwnAddress| {
        let Ok(theirs) = a.ip.parse::<Ipv4Addr>() else {
            return false;
        };
        mine.iter().any(|i| match (i.ip.parse::<Ipv4Addr>(), i.mask.parse::<Ipv4Addr>()) {
            (Ok(ip), Ok(mask)) => same_network(theirs, ip, mask),
            _ => false,
        })
    };
    let usable: Vec<&OwnAddress> = announced
        .iter()
        .filter(|a| parse_mac(&a.mac).is_some())
        .collect();
    let wired = |a: &&OwnAddress| a.kind == "ethernet";
    usable
        .iter()
        .copied()
        .find(|a| shared(a) && wired(&a))
        .or_else(|| usable.iter().copied().find(|a| shared(a)))
        .or_else(|| usable.iter().copied().find(wired))
        .or_else(|| usable.first().copied())
        .and_then(|a| parse_mac(&a.mac))
        .map(format_mac)
}

/// A network adapter as Windows lists it.
#[derive(Debug, Clone, PartialEq)]
pub struct Adapter {
    pub name: String,
    pub mac: String,
    pub up: bool,
    pub description: String,
}

/// The adapters out of `Get-NetAdapter | ConvertTo-Json`.
///
/// PowerShell prints one adapter as an object and several as an array, so both
/// shapes are read; a byte-order mark in front of either is not a reason to
/// find nothing.
pub fn parse_adapters(json: &str) -> Vec<Adapter> {
    let value: serde_json::Value = match serde_json::from_str(json.trim_start_matches('\u{feff}').trim()) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let items = match value {
        serde_json::Value::Array(items) => items,
        object @ serde_json::Value::Object(_) => vec![object],
        _ => Vec::new(),
    };
    let text = |v: &serde_json::Value, key: &str| {
        v.get(key).and_then(|x| x.as_str()).unwrap_or_default().to_string()
    };
    items
        .iter()
        .filter_map(|item| {
            let mac = parse_mac(&text(item, "MacAddress"))?;
            Some(Adapter {
                name: text(item, "Name"),
                mac: format_mac(mac),
                up: text(item, "Status").eq_ignore_ascii_case("up"),
                description: text(item, "InterfaceDescription"),
            })
        })
        .collect()
}

/// `1` / `0` as `Get-NetAdapterAdvancedProperty` prints a registry value.
pub fn parse_flag(text: &str) -> Option<bool> {
    match text.trim() {
        "1" => Some(true),
        "0" => Some(false),
        _ => None,
    }
}

/// Whether a device is on `powercfg /devicequery wake_armed` - the list of
/// things Windows will let wake the machine right now.
pub fn parse_wake_armed(output: &str, description: &str) -> bool {
    !description.is_empty()
        && output
            .lines()
            .any(|line| line.trim().eq_ignore_ascii_case(description.trim()))
}

/// Fast Startup from `reg query ... /v HiberbootEnabled`.
pub fn parse_hiberboot(output: &str) -> Option<bool> {
    let line = output.lines().find(|l| l.contains("HiberbootEnabled"))?;
    match line.split_whitespace().last()? {
        "0x1" | "1" => Some(true),
        "0x0" | "0" => Some(false),
        _ => None,
    }
}

/// An adapter or device name that is safe to put inside a PowerShell string.
///
/// These come from Windows' own listing, not from anybody on the network, but
/// they end up in a command that runs elevated, so anything that could end the
/// string or start another command is refused rather than escaped.
pub fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && !name
            .chars()
            .any(|c| c.is_control() || matches!(c, '\'' | '"' | '`' | '$' | ';' | '&' | '|' | '<' | '>' | '{' | '}'))
}

#[cfg(windows)]
fn run(program: &str, args: &[&str]) -> Option<String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new(program)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    Some(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(windows)]
fn powershell(script: &str) -> Option<String> {
    run("powershell", &["-NoProfile", "-NonInteractive", "-Command", script])
}

#[cfg(windows)]
fn physical_adapters() -> Vec<Adapter> {
    powershell(
        "Get-NetAdapter -Physical | Select-Object Name,MacAddress,Status,InterfaceDescription | ConvertTo-Json -Compress",
    )
    .map(|text| parse_adapters(&text))
    .unwrap_or_default()
}

/// `own_addresses`, remembered for as long as the set of networks is the same.
///
/// Looking them up runs PowerShell, which is the better part of a second, and
/// it would otherwise run again for every paired device that links.
pub fn own_addresses_cached(interfaces: &[Interface]) -> Vec<OwnAddress> {
    use std::sync::Mutex;
    static CACHE: Mutex<Option<(String, Vec<OwnAddress>)>> = Mutex::new(None);
    let key = interfaces
        .iter()
        .map(|i| format!("{}={}", i.name, i.ip))
        .collect::<Vec<_>>()
        .join(",");
    if let Ok(guard) = CACHE.lock() {
        if let Some((k, found)) = guard.as_ref() {
            if *k == key {
                return found.clone();
            }
        }
    }
    let found = own_addresses(interfaces);
    // An empty answer is a lookup that failed as often as a machine with
    // nothing to say, and is not worth remembering.
    if !found.is_empty() {
        if let Ok(mut guard) = CACHE.lock() {
            *guard = Some((key, found.clone()));
        }
    }
    found
}

/// This machine's own addresses, one per network it is on.
///
/// A virtual adapter, a VPN or a link-local address is not something a packet
/// can wake a machine by, so only physical adapters with an address are listed.
pub fn own_addresses(interfaces: &[Interface]) -> Vec<OwnAddress> {
    #[cfg(windows)]
    {
        let adapters = physical_adapters();
        interfaces
            .iter()
            .filter_map(|i| {
                let adapter = adapters.iter().find(|a| a.name.eq_ignore_ascii_case(&i.name))?;
                Some(OwnAddress { mac: adapter.mac.clone(), ip: i.ip.clone(), kind: i.kind.clone() })
            })
            .collect()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        interfaces
            .iter()
            .filter_map(|i| {
                let text = std::fs::read_to_string(format!("/sys/class/net/{}/address", i.name)).ok()?;
                let mac = parse_mac(&text)?;
                // What Android answers for a radio it will not name.
                if mac == [0x02, 0, 0, 0, 0, 0] {
                    return None;
                }
                Some(OwnAddress { mac: format_mac(mac), ip: i.ip.clone(), kind: i.kind.clone() })
            })
            .collect()
    }
    #[cfg(target_os = "macos")]
    {
        interfaces
            .iter()
            .filter_map(|i| {
                if !i.name.chars().all(|c| c.is_ascii_alphanumeric()) {
                    return None;
                }
                let out = std::process::Command::new("ifconfig").arg(&i.name).output().ok()?;
                let text = String::from_utf8_lossy(&out.stdout).into_owned();
                let mac = text
                    .lines()
                    .find_map(|l| l.trim().strip_prefix("ether "))
                    .and_then(|rest| rest.split_whitespace().next())
                    .and_then(parse_mac)?;
                Some(OwnAddress { mac: format_mac(mac), ip: i.ip.clone(), kind: i.kind.clone() })
            })
            .collect()
    }
}

/// Whether this machine is set up to be woken, and by what.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WakeStatus {
    /// Windows only for now; elsewhere the address is announced but nothing
    /// is checked or changed.
    pub supported: bool,
    pub adapter: String,
    pub mac: String,
    pub wired: bool,
    /// The adapter's own "Wake on Magic Packet" setting.
    pub magic_packet: Option<bool>,
    /// Whether Windows lets that adapter wake the machine.
    pub device_may_wake: Option<bool>,
    /// A "shut down" with Fast Startup on is a hibernate, which some adapters
    /// do not wake from. Waking from sleep is not affected.
    pub fast_startup: Option<bool>,
    /// How many paired devices this address has been given to, filled in by
    /// the command rather than here.
    pub shared_with: usize,
}

/// The adapter to wake this machine by: the wired one that is up, else any
/// that is up, else the first physical one.
#[cfg(windows)]
fn pick_adapter(interfaces: &[Interface]) -> Option<(Adapter, bool)> {
    let adapters = physical_adapters();
    let kind_of = |a: &Adapter| {
        interfaces
            .iter()
            .find(|i| i.name.eq_ignore_ascii_case(&a.name))
            .map(|i| i.kind.clone())
    };
    let wired = |a: &Adapter| kind_of(a).as_deref() == Some("ethernet");
    let chosen = adapters
        .iter()
        .find(|a| a.up && wired(a))
        .or_else(|| adapters.iter().find(|a| a.up))
        .or_else(|| adapters.first())?
        .clone();
    let is_wired = wired(&chosen) || chosen.description.to_ascii_lowercase().contains("ethernet")
        || chosen.description.to_ascii_lowercase().contains("gbe");
    Some((chosen, is_wired))
}

pub fn status(interfaces: &[Interface]) -> WakeStatus {
    #[cfg(windows)]
    {
        let Some((adapter, wired)) = pick_adapter(interfaces) else {
            return WakeStatus { supported: true, ..Default::default() };
        };
        let magic_packet = if safe_name(&adapter.name) {
            powershell(&format!(
                "(Get-NetAdapterAdvancedProperty -Name '{}' -RegistryKeyword '*WakeOnMagicPacket' -ErrorAction SilentlyContinue).RegistryValue",
                adapter.name
            ))
            .and_then(|t| parse_flag(&t))
        } else {
            None
        };
        let device_may_wake = run("powercfg", &["/devicequery", "wake_armed"])
            .map(|out| parse_wake_armed(&out, &adapter.description));
        let fast_startup = run(
            "reg",
            &[
                "query",
                r"HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Power",
                "/v",
                "HiberbootEnabled",
            ],
        )
        .and_then(|out| parse_hiberboot(&out));
        WakeStatus {
            supported: true,
            adapter: adapter.name,
            mac: adapter.mac,
            wired,
            magic_packet,
            device_may_wake,
            fast_startup,
            shared_with: 0,
        }
    }
    #[cfg(not(windows))]
    {
        let first = own_addresses(interfaces).into_iter().next();
        WakeStatus {
            supported: false,
            mac: first.as_ref().map(|a| a.mac.clone()).unwrap_or_default(),
            wired: first.as_ref().map(|a| a.kind == "ethernet").unwrap_or(false),
            ..Default::default()
        }
    }
}

/// Turns on what Windows needs to wake this machine for a magic packet:
/// the adapter's own setting, and permission for it to wake the machine.
///
/// Both need an administrator, so one elevated PowerShell does both and
/// Windows asks for the approval itself - this app never holds it. Fast Startup
/// and the firmware setting are not touched; they are reported instead.
#[cfg(windows)]
pub fn enable(interfaces: &[Interface]) -> Result<(), String> {
    let Some((adapter, _)) = pick_adapter(interfaces) else {
        return Err("no network adapter was found".into());
    };
    if !safe_name(&adapter.name) || !safe_name(&adapter.description) {
        return Err("that adapter's name cannot be passed on safely".into());
    }
    let inner = format!(
        "$ErrorActionPreference='Stop'; \
         Set-NetAdapterAdvancedProperty -Name '{name}' -RegistryKeyword '*WakeOnMagicPacket' -RegistryValue 1; \
         powercfg /deviceenablewake '{description}'; exit $LASTEXITCODE",
        name = adapter.name,
        description = adapter.description,
    );
    run_elevated(&inner)
}

/// Runs a PowerShell script as administrator, through one UAC prompt.
///
/// UTF-16 little-endian, base64: the encoding -EncodedCommand wants, and the
/// reason nothing in the script has to survive another layer of quoting.
#[cfg(windows)]
pub(crate) fn run_elevated(inner: &str) -> Result<(), String> {
    let bytes: Vec<u8> = inner.encode_utf16().flat_map(|u| u.to_le_bytes()).collect();
    let encoded = base64_encode(&bytes);
    let outer = format!(
        "$p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden \
         -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','{encoded}'; exit $p.ExitCode"
    );
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let out = std::process::Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &outer])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        return Ok(());
    }
    let said = String::from_utf8_lossy(&out.stderr);
    if said.to_ascii_lowercase().contains("canceled") || said.to_ascii_lowercase().contains("cancelled") {
        return Err("the Windows prompt was declined".into());
    }
    Err("Windows would not apply the change".into())
}

#[cfg(not(windows))]
pub fn enable(_interfaces: &[Interface]) -> Result<(), String> {
    Err("this is set in the system's own network settings on this platform".into())
}

#[cfg(windows)]
fn base64_encode(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

#[cfg(test)]
mod own_address_tests {
    use super::*;

    fn iface(name: &str, ip: &str, kind: &str) -> Interface {
        Interface {
            name: name.into(),
            ip: ip.into(),
            kind: kind.into(),
            mask: "255.255.255.0".into(),
            cidr: String::new(),
        }
    }

    fn own(mac: &str, ip: &str, kind: &str) -> OwnAddress {
        OwnAddress { mac: mac.into(), ip: ip.into(), kind: kind.into() }
    }

    #[test]
    fn the_address_on_a_shared_network_is_the_one_used() {
        let announced = [
            own("aa:aa:aa:aa:aa:01", "10.0.0.5", "ethernet"),
            own("aa:aa:aa:aa:aa:02", "192.168.100.117", "ethernet"),
        ];
        let mine = [iface("wlan0", "192.168.100.147", "wifi")];
        assert_eq!(choose_address(&announced, &mine), Some("aa:aa:aa:aa:aa:02".into()));
    }

    #[test]
    fn a_wired_address_beats_wifi_when_both_are_reachable() {
        let announced = [
            own("aa:aa:aa:aa:aa:01", "192.168.100.60", "wifi"),
            own("aa:aa:aa:aa:aa:02", "192.168.100.117", "ethernet"),
        ];
        let mine = [iface("wlan0", "192.168.100.147", "wifi")];
        assert_eq!(choose_address(&announced, &mine), Some("aa:aa:aa:aa:aa:02".into()));
    }

    #[test]
    fn with_no_shared_network_a_wired_address_is_still_offered() {
        let announced = [
            own("aa:aa:aa:aa:aa:01", "10.1.1.2", "wifi"),
            own("aa:aa:aa:aa:aa:02", "10.2.2.2", "ethernet"),
        ];
        assert_eq!(choose_address(&announced, &[]), Some("aa:aa:aa:aa:aa:02".into()));
    }

    #[test]
    fn nonsense_addresses_are_never_chosen() {
        let announced = [own("not-a-mac", "192.168.100.117", "ethernet"), own("00:00:00:00:00:00", "192.168.100.2", "ethernet")];
        assert_eq!(choose_address(&announced, &[iface("e", "192.168.100.147", "ethernet")]), None);
    }

    #[test]
    fn reads_what_get_netadapter_prints_for_one_adapter_and_for_several() {
        // Real output from a machine with a wired and a USB Wi-Fi adapter.
        let one = r#"{"Name":"Ethernet","MacAddress":"74-56-3C-8D-CF-30","Status":"Up","InterfaceDescription":"Realtek PCIe GbE Family Controller"}"#;
        let a = parse_adapters(one);
        assert_eq!(a.len(), 1);
        assert_eq!(a[0].mac, "74:56:3c:8d:cf:30");
        assert!(a[0].up);

        let two = r#"[{"Name":"Wi-Fi","MacAddress":"00-0C-43-17-2C-25","Status":"Disconnected","InterfaceDescription":"802.11n USB Wireless LAN Card"},
                       {"Name":"Ethernet","MacAddress":"74-56-3C-8D-CF-30","Status":"Up","InterfaceDescription":"Realtek PCIe GbE Family Controller"}]"#;
        let b = parse_adapters(&format!("\u{feff}{two}"));
        assert_eq!(b.len(), 2);
        assert!(!b[0].up);
        assert_eq!(b[1].description, "Realtek PCIe GbE Family Controller");

        assert!(parse_adapters("").is_empty());
        assert!(parse_adapters("not json").is_empty());
    }

    #[test]
    fn the_adapter_setting_and_the_wake_list_are_read_as_printed() {
        assert_eq!(parse_flag("1\r\n"), Some(true));
        assert_eq!(parse_flag("0"), Some(false));
        assert_eq!(parse_flag(""), None);

        let armed = "HID Keyboard Device (001)\r\nRealtek PCIe GbE Family Controller\r\nHID-compliant mouse (002)\r\n";
        assert!(parse_wake_armed(armed, "Realtek PCIe GbE Family Controller"));
        assert!(!parse_wake_armed(armed, "802.11n USB Wireless LAN Card"));
        assert!(!parse_wake_armed(armed, ""));

        let reg = "\r\nHKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Power\r\n    HiberbootEnabled    REG_DWORD    0x1\r\n";
        assert_eq!(parse_hiberboot(reg), Some(true));
        assert_eq!(parse_hiberboot("    HiberbootEnabled    REG_DWORD    0x0"), Some(false));
        assert_eq!(parse_hiberboot("nothing"), None);
    }

    #[test]
    fn a_name_that_could_start_another_command_is_refused() {
        assert!(safe_name("Ethernet"));
        assert!(safe_name("Intel(R) Ethernet Connection (7) I219-V"));
        assert!(safe_name("Realtek USB GbE Family Controller #2"));
        for bad in ["", "x'; calc; '", "a`b", "$(calc)", "a;b", "a|b", "a\nb", "a\"b"] {
            assert!(!safe_name(bad), "{bad:?} was accepted");
        }
    }

    #[cfg(windows)]
    #[test]
    fn base64_matches_the_standard_vectors() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
    }
}
