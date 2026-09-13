//! Local network inspection: interfaces, subnet, gateway and NAT shape.

use std::net::{IpAddr, Ipv4Addr};

use crate::model::{Interface, NatType, SubnetClash, UpstreamInfo};

/// Enumerates usable IPv4 interfaces, skipping loopback and link-local.
pub fn interfaces() -> Vec<Interface> {
    let Ok(addrs) = if_addrs::get_if_addrs() else {
        return Vec::new();
    };

    addrs
        .into_iter()
        .filter(|i| !i.is_loopback())
        .filter_map(|i| match i.addr.ip() {
            IpAddr::V4(v4) if !v4.is_link_local() => {
                // The mask comes from the interface itself; asking the OS again
                // by address would just find this same entry.
                let mask = match &i.addr {
                    if_addrs::IfAddr::V4(v4addr) => v4addr.netmask.to_string(),
                    _ => "255.255.255.0".to_string(),
                };
                let ip = v4.to_string();
                Some(Interface {
                    kind: classify(&i.name),
                    name: i.name.clone(),
                    cidr: cidr_for(&ip, &mask),
                    ip,
                    mask,
                })
            }
            _ => None,
        })
        .collect()
}

fn classify(name: &str) -> String {
    let lower = name.to_ascii_lowercase();
    if lower.contains("wi-fi") || lower.contains("wlan") || lower.contains("wifi") {
        "wifi".into()
    } else if lower.contains("eth") || lower.contains("en") || lower.contains("lan") {
        "ethernet".into()
    } else {
        "other".into()
    }
}

/// Netmask of the interface carrying `ip`, as dotted quad.
pub fn netmask_for(ip: &str) -> String {
    let Ok(addrs) = if_addrs::get_if_addrs() else {
        return "255.255.255.0".into();
    };
    for iface in addrs {
        if let IpAddr::V4(v4) = iface.addr.ip() {
            if v4.to_string() == ip {
                if let if_addrs::IfAddr::V4(v4addr) = iface.addr {
                    return v4addr.netmask.to_string();
                }
            }
        }
    }
    "255.255.255.0".into()
}

/// The primary IPv4 address — the one a socket to an off-link address binds to.
pub fn primary_ip() -> String {
    // Connecting a UDP socket sends nothing but makes the OS pick the route it
    // would actually use, which is a more reliable answer than guessing from
    // the interface list.
    use std::net::UdpSocket;
    if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
        if sock.connect("192.0.2.1:9").is_ok() {
            if let Ok(addr) = sock.local_addr() {
                if let IpAddr::V4(v4) = addr.ip() {
                    if !v4.is_loopback() && !v4.is_unspecified() {
                        return v4.to_string();
                    }
                }
            }
        }
    }
    interfaces()
        .first()
        .map(|i| i.ip.clone())
        .unwrap_or_else(|| "127.0.0.1".into())
}

/// Conventional gateway guess: host .1 on the local subnet.
///
/// Reading the real routing table needs platform-specific APIs; on home and
/// office networks the router is almost always .1, and every consumer of this
/// value treats it as advisory.
pub fn gateway_for(ip: &str, mask: &str) -> String {
    let (Ok(addr), Ok(m)) = (ip.parse::<Ipv4Addr>(), mask.parse::<Ipv4Addr>()) else {
        return String::new();
    };
    let a = addr.octets();
    let mo = m.octets();
    let net = [a[0] & mo[0], a[1] & mo[1], a[2] & mo[2], a[3] & mo[3]];
    Ipv4Addr::new(net[0], net[1], net[2], net[3] | 1).to_string()
}

/// Subnet in CIDR form, e.g. "192.168.1.0/24".
pub fn cidr_for(ip: &str, mask: &str) -> String {
    let (Ok(addr), Ok(m)) = (ip.parse::<Ipv4Addr>(), mask.parse::<Ipv4Addr>()) else {
        return String::new();
    };
    let a = addr.octets();
    let mo = m.octets();
    let bits = u32::from_be_bytes(mo).count_ones();
    format!(
        "{}.{}.{}.{}/{}",
        a[0] & mo[0],
        a[1] & mo[1],
        a[2] & mo[2],
        a[3] & mo[3],
        bits
    )
}

const fn is_private(o: [u8; 4]) -> bool {
    o[0] == 10
        || (o[0] == 172 && o[1] >= 16 && o[1] <= 31)
        || (o[0] == 192 && o[1] == 168)
}

/// True when an address is in one of the private ranges.
///
/// The whole "is there a LAN above me" question reduces to this: if the
/// router's WAN address is private, something else is doing NAT above it.
pub fn is_private_addr(ip: &str) -> bool {
    ip.parse::<Ipv4Addr>()
        .map(|a| is_private(a.octets()))
        .unwrap_or(false)
}

/// Infers NAT shape from what the interfaces reveal.
///
/// Interfaces of ours that share one subnet with each other.
///
/// Two network cards on the same subnet is a misconfiguration, not a topology,
/// and it produces the most confusing symptom this application has: a device
/// that other machines can reach at one of its addresses and not the other,
/// changing with the weather. Which of the two answers an ARP request is not
/// something the operating system promises, so a peer learns whichever address
/// it happened to hear first and may be unable to open a connection to it.
///
/// It cost a day here. A phone could stream from this machine's wi-fi address
/// and got "no route to host" for its ethernet address; the addresses looked
/// like two networks that had been given the same numbers, and the real answer
/// was one network entered twice.
///
/// Returned as pairs of interface names so the window can name them.
pub fn same_subnet_clashes(interfaces: &[Interface]) -> Vec<SubnetClash> {
    let mut clashes = Vec::new();
    for (i, a) in interfaces.iter().enumerate() {
        for b in interfaces.iter().skip(i + 1) {
            if share_a_subnet(a, b) {
                clashes.push(SubnetClash { a: a.name.clone(), b: b.name.clone() });
            }
        }
    }
    clashes
}

/// Whether two interfaces address the same network.
///
/// Both masks are applied, not just one: a /24 sitting inside another card's
/// /16 is the same clash seen from one side only, and checking a single mask
/// finds it half the time.
fn share_a_subnet(a: &Interface, b: &Interface) -> bool {
    let (Some(ai), Some(bi)) = (octets(&a.ip), octets(&b.ip)) else {
        return false;
    };
    // A link-local address is what a card with no DHCP lease gives itself.
    // Every one of them is on 169.254/16, and two of those are not a clash -
    // they are two cards that are equally unplugged.
    if ai[0] == 169 && ai[1] == 254 {
        return false;
    }
    if bi[0] == 169 && bi[1] == 254 {
        return false;
    }

    [&a.mask, &b.mask].iter().any(|mask| {
        octets(mask).is_some_and(|m| {
            (0..4).all(|i| ai[i] & m[i] == bi[i] & m[i])
        })
    })
}

/// Whether this machine genuinely reaches two different networks.
///
/// The double-NAT signal, and not the same question as "has two cards": two
/// cards on one subnet reach one network, and answering yes to that made the
/// window report two routers in series where there was a duplicated cable.
pub fn spans_two_networks(interfaces: &[Interface]) -> bool {
    interfaces.iter().enumerate().any(|(i, a)| {
        // Link-local means no lease; it is not a network anybody is on.
        octets(&a.ip).is_some_and(|o| !(o[0] == 169 && o[1] == 254))
            && interfaces.iter().skip(i + 1).any(|b| {
                octets(&b.ip).is_some_and(|o| !(o[0] == 169 && o[1] == 254))
                    && !share_a_subnet(a, b)
            })
    })
}

fn octets(addr: &str) -> Option<[u8; 4]> {
    addr.parse::<Ipv4Addr>().ok().map(|a| a.octets())
}

/// A private local address whose gateway also sits on a private network is the
/// signature of two routers in series — the double-NAT case LANTern exists to
/// cross. Without probing the gateway's WAN side this is a best guess, which is
/// why the UI presents it as "detected" rather than authoritative.
pub fn detect_nat(ip: &str, gateway: &str, multi_homed: bool) -> NatType {
    let Ok(addr) = ip.parse::<Ipv4Addr>() else {
        return NatType::Unknown;
    };
    if !is_private(addr.octets()) {
        return NatType::Open;
    }
    if gateway.is_empty() {
        return NatType::Unknown;
    }
    // A device sitting on two *different* private networks is bridging two NAT
    // domains. Two cards on the same one is not that - it is one network
    // entered twice, and calling it double NAT sent the diagnosis in exactly
    // the wrong direction for a day.
    if multi_homed {
        return NatType::Double;
    }
    NatType::Moderate
}

/// Describes the network above our router, when there appears to be one.
pub fn upstream_for(ip: &str, gateway: &str) -> Option<UpstreamInfo> {
    let addr = ip.parse::<Ipv4Addr>().ok()?;
    if !is_private(addr.octets()) {
        return None;
    }
    let gw = gateway.parse::<Ipv4Addr>().ok()?;
    let g = gw.octets();

    // Assume the router's WAN sits on the neighbouring /24 — enough to give the
    // upstream scan a range to sweep. A real WAN address is filled in once the
    // gateway answers a UPnP GetExternalIPAddress query.
    let upstream_third = if g[2] == 0 { 1 } else { 0 };
    let wan = format!("{}.{}.{}.{}", g[0], g[1], upstream_third, 23);
    Some(UpstreamInfo {
        subnet: cidr_for(&wan, "255.255.255.0"),
        router_wan_ip: wan,
        // Nothing has been asked yet; this is the neighbouring-/24 estimate.
        wan_confirmed: false,
        wan_is_private: true,
        gateway: format!("{}.{}.{}.1", g[0], g[1], upstream_third),
        reachable: false,
        published: false,
        published_via: None,
        published_address: None,
        last_scan_at: None,
        hosts_scanned: 0,
        wans: Vec::new(),
    })
}

/// True when two IPv4 addresses sit on the same network under `mask`.
pub fn same_subnet(a: &str, b: &str, mask: &str) -> bool {
    let (Ok(a), Ok(b), Ok(m)) = (
        a.parse::<Ipv4Addr>(),
        b.parse::<Ipv4Addr>(),
        mask.parse::<Ipv4Addr>(),
    ) else {
        return false;
    };
    let m = u32::from(m);
    u32::from(a) & m == u32::from(b) & m
}

/// Times a TCP connect to `address:port`. `None` if it refused or timed out.
///
/// A completed handshake is the only evidence that actually means anything
/// here: it clears routing, the peer's host firewall, and a listener being
/// bound, all at once. ICMP would clear none of those — Windows drops inbound
/// echo on the Private profile by default, so a ping test would report a
/// perfectly healthy peer as unreachable.
pub async fn probe_tcp(address: &str, port: u16, timeout: std::time::Duration) -> Option<f64> {
    let started = std::time::Instant::now();
    match tokio::time::timeout(timeout, tokio::net::TcpStream::connect((address, port))).await {
        Ok(Ok(_)) => Some(started.elapsed().as_secs_f64() * 1000.0),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_subnet_follows_the_mask_not_the_octets() {
        assert!(same_subnet("192.168.100.67", "192.168.100.146", "255.255.255.0"));
        assert!(!same_subnet("192.168.100.67", "192.168.101.5", "255.255.255.0"));
        // A wider mask puts both of those on one network.
        assert!(same_subnet("192.168.100.67", "192.168.101.5", "255.255.0.0"));
        // A /25 splits a single /24 in two.
        assert!(!same_subnet("192.168.100.67", "192.168.100.146", "255.255.255.128"));
    }

    #[test]
    fn same_subnet_rejects_what_it_cannot_parse() {
        assert!(!same_subnet("not-an-ip", "192.168.1.1", "255.255.255.0"));
        assert!(!same_subnet("192.168.1.1", "", "255.255.255.0"));
        assert!(!same_subnet("192.168.1.1", "192.168.1.2", "nonsense"));
    }

    #[tokio::test]
    async fn probe_tcp_times_a_real_handshake_and_reports_a_refusal() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let _ = listener.accept().await;
        });

        let timeout = std::time::Duration::from_millis(1500);
        assert!(probe_tcp("127.0.0.1", port, timeout).await.is_some());

        // Nothing is bound here once the listener above is the only one open,
        // so the connect is refused rather than hanging.
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let dead = closed.local_addr().unwrap().port();
        drop(closed);
        assert!(probe_tcp("127.0.0.1", dead, timeout).await.is_none());
    }
}

#[cfg(test)]
mod subnet_tests {
    use super::*;

    fn iface(name: &str, ip: &str, mask: &str) -> Interface {
        Interface {
            name: name.into(),
            ip: ip.into(),
            kind: "ethernet".into(),
            mask: mask.into(),
            cidr: String::new(),
        }
    }

    /// Exactly what this machine looked like while the diagnosis went wrong.
    fn the_machine_that_caused_this() -> Vec<Interface> {
        vec![
            iface("Ethernet", "192.168.100.67", "255.255.255.0"),
            iface("Wi-Fi", "192.168.100.141", "255.255.255.0"),
        ]
    }

    #[test]
    fn two_cards_on_one_subnet_is_a_clash() {
        let found = same_subnet_clashes(&the_machine_that_caused_this());
        assert_eq!(found.len(), 1, "{found:?}");
        assert_eq!(found[0].a, "Ethernet");
        assert_eq!(found[0].b, "Wi-Fi");
    }

    /// And it is not two networks, which is what it was reported as.
    #[test]
    fn and_it_is_not_two_networks() {
        assert!(
            !spans_two_networks(&the_machine_that_caused_this()),
            "one network entered twice was called double NAT",
        );
    }

    #[test]
    fn genuinely_separate_networks_are_not_a_clash() {
        let ifaces = vec![
            iface("Ethernet", "192.168.100.67", "255.255.255.0"),
            iface("Wi-Fi", "10.0.0.5", "255.255.255.0"),
        ];
        assert!(same_subnet_clashes(&ifaces).is_empty());
        assert!(spans_two_networks(&ifaces), "two real networks were missed");
    }

    #[test]
    fn one_card_is_neither() {
        let ifaces = vec![iface("Ethernet", "192.168.100.67", "255.255.255.0")];
        assert!(same_subnet_clashes(&ifaces).is_empty());
        assert!(!spans_two_networks(&ifaces));
    }

    /// A card with no lease gives itself a 169.254 address. Two of those are
    /// two cards that are equally unplugged, not a misconfiguration - and this
    /// machine has three of them sitting there at all times.
    #[test]
    fn unplugged_cards_are_not_a_clash() {
        let ifaces = vec![
            iface("Ethernet", "192.168.100.67", "255.255.255.0"),
            iface("Local Area Connection* 9", "169.254.173.127", "255.255.0.0"),
            iface("Local Area Connection* 10", "169.254.157.240", "255.255.0.0"),
            iface("Bluetooth", "169.254.243.183", "255.255.0.0"),
        ];
        assert!(
            same_subnet_clashes(&ifaces).is_empty(),
            "{:?}",
            same_subnet_clashes(&ifaces),
        );
        assert!(
            !spans_two_networks(&ifaces),
            "unplugged cards were counted as a second network",
        );
    }

    /// A /24 inside another card's /16 is the same fault seen from one side.
    /// Checking a single mask finds it half the time, which is worse than not
    /// checking at all because it depends which card is listed first.
    #[test]
    fn a_narrow_subnet_inside_a_wide_one() {
        let narrow_first = vec![
            iface("Ethernet", "10.0.5.20", "255.255.255.0"),
            iface("VPN", "10.0.9.3", "255.255.0.0"),
        ];
        let wide_first = vec![
            iface("VPN", "10.0.9.3", "255.255.0.0"),
            iface("Ethernet", "10.0.5.20", "255.255.255.0"),
        ];
        assert_eq!(same_subnet_clashes(&narrow_first).len(), 1);
        assert_eq!(
            same_subnet_clashes(&wide_first).len(),
            1,
            "found only in one order",
        );
    }

    #[test]
    fn three_cards_two_of_them_clashing() {
        let ifaces = vec![
            iface("Ethernet", "192.168.100.67", "255.255.255.0"),
            iface("Wi-Fi", "192.168.100.141", "255.255.255.0"),
            iface("VPN", "10.8.0.2", "255.255.255.0"),
        ];
        assert_eq!(same_subnet_clashes(&ifaces).len(), 1);
        // The VPN really is a second network, so this is both things at once.
        assert!(spans_two_networks(&ifaces));
    }

    #[test]
    fn nonsense_addresses_do_not_panic() {
        let ifaces = vec![
            iface("Broken", "", ""),
            iface("Odd", "not an address", "255.255.255.0"),
            iface("Ethernet", "192.168.100.67", ""),
        ];
        let _ = same_subnet_clashes(&ifaces);
        let _ = spans_two_networks(&ifaces);
    }
}
