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
