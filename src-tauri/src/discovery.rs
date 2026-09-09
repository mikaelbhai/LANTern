//! mDNS presence: announce this device and watch for others.
//!
//! Peers are tracked by the device id carried in the TXT record, never by
//! address. One machine on Ethernet and Wi-Fi resolves twice, and a machine
//! that changes network resolves at a new address — both must read as the same
//! peer, gaining an address rather than becoming a second entry.

use std::collections::HashMap;
use std::net::IpAddr;

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use tauri::{AppHandle, Emitter};

use crate::model::{now_ms, ConnLayer, Initiator, Peer, PeerScope, PeerStatus};
use crate::state::AppState;

pub const SERVICE_TYPE: &str = "_lantern._tcp.local.";

/// Registers this device and starts emitting peer events to the frontend.
///
/// The returned daemon must be kept alive; dropping it withdraws the service.
pub fn start(
    app: AppHandle,
    state: AppState,
    device_id: &str,
    instance: &str,
    addresses: &[String],
    port: u16,
) -> anyhow::Result<ServiceDaemon> {
    let daemon = ServiceDaemon::new()?;
    register(&daemon, device_id, instance, addresses, port)?;

    let receiver = daemon.browse(SERVICE_TYPE)?;
    let own_id = device_id.to_string();

    std::thread::spawn(move || {
        while let Ok(event) = receiver.recv() {
            match event {
                ServiceEvent::ServiceResolved(info) => {
                    let Some(peer_id) = info.get_property_val_str("id").map(str::to_string) else {
                        // Without an id we cannot tell devices apart, so ignore it
                        // rather than risk creating a duplicate that never merges.
                        continue;
                    };
                    if peer_id == own_id {
                        continue;
                    }

                    let name = info
                        .get_property_val_str("name")
                        .unwrap_or_else(|| info.get_fullname())
                        .to_string();

                    let found: Vec<String> = info
                        .get_addresses()
                        .iter()
                        .filter_map(|a| match a {
                            IpAddr::V4(v4) => Some(v4.to_string()),
                            _ => None,
                        })
                        .collect();
                    if found.is_empty() {
                        continue;
                    }

                    let (peer, is_new) = state.with(|s| {
                        match s.peers.get_mut(&peer_id) {
                            Some(existing) => {
                                // Same device, possibly on a new interface.
                                for addr in &found {
                                    if !existing.addresses.contains(addr) {
                                        existing.addresses.push(addr.clone());
                                    }
                                }
                                existing.name = name.clone();
                                existing.port = info.get_port();
                                existing.last_seen = now_ms();
                                // Prefer an address we can still reach.
                                if !found.contains(&existing.ip) {
                                    existing.ip = found[0].clone();
                                }
                                (existing.clone(), false)
                            }
                            None => {
                                let peer = Peer {
                                    id: peer_id.clone(),
                                    device_id: peer_id.clone(),
                                    name: name.clone(),
                                    color: String::from("#F5A623"),
                                    emoji: String::from("🏮"),
                                    os: info
                                        .get_property_val_str("os")
                                        .unwrap_or("unknown")
                                        .to_string(),
                                    ip: found[0].clone(),
                                    addresses: found.clone(),
                                    port: info.get_port(),
                                    layer: ConnLayer::Direct,
                                    // Not measured yet. Zero would be rendered as a real reading of
                    // 0.0 ms, which is both impossible over a network and
                    // indistinguishable from a working measurement.
                    latency_ms: -1.0,
                                    loss_pct: 0.0,
                                    status: PeerStatus::Available,
                                    status_message: None,
                                    last_seen: now_ms(),
                                    trusted: true,
                                    scope: PeerScope::Local,
                                    initiated_by: Initiator::Us,
                                };
                                s.peers.insert(peer_id.clone(), peer.clone());
                                (peer, true)
                            }
                        }
                    });

                    let _ = app.emit(if is_new { "peer:joined" } else { "peer:updated" }, &peer);
                }

                ServiceEvent::ServiceRemoved(_, fullname) => {
                    // A withdrawal names one advertisement. The device is only
                    // gone when nothing has been heard from it for a while, so
                    // the reaper decides — not this event.
                    let _ = fullname;
                }
                _ => {}
            }
        }
    });

    Ok(daemon)
}

fn register(
    daemon: &ServiceDaemon,
    device_id: &str,
    instance: &str,
    addresses: &[String],
    port: u16,
) -> anyhow::Result<()> {
    let host = format!("{}.local.", sanitize(instance));
    let mut props: HashMap<String, String> = HashMap::new();
    props.insert("id".into(), device_id.to_string());
    props.insert("name".into(), instance.to_string());
    props.insert("os".into(), std::env::consts::OS.to_string());
    props.insert("v".into(), env!("CARGO_PKG_VERSION").to_string());

    // Announce on every address this device holds, so peers on any of its
    // networks can find it.
    let joined = addresses.join(",");
    let info = ServiceInfo::new(
        SERVICE_TYPE,
        &sanitize(instance),
        &host,
        joined.as_str(),
        port,
        Some(props),
    )?;
    daemon.register(info)?;
    Ok(())
}

/// Re-announces this device, after its addresses change.
pub fn reannounce(
    daemon: &ServiceDaemon,
    device_id: &str,
    instance: &str,
    addresses: &[String],
    port: u16,
) {
    let _ = daemon.unregister(&format!("{}.{}", sanitize(instance), SERVICE_TYPE));
    if let Err(e) = register(daemon, device_id, instance, addresses, port) {
        eprintln!("could not re-announce after a network change: {e}");
    }
}

/// Drops peers that have gone quiet.
///
/// Silence is the only reliable signal: a device that switched networks stops
/// answering at its old address without ever withdrawing the advertisement.
pub fn reap(app: &AppHandle, state: &AppState, stale_after_ms: u64) {
    let now = now_ms();
    let dropped = state.with(|s| {
        // A peer with an open link is present, whatever mDNS says. Multicast
        // announcements get dropped routinely; reaping on that alone made
        // devices flicker in and out of the peer list while they were sitting
        // on a perfectly good connection the whole time.
        let linked = s.links.connected();
        let gone: Vec<String> = s
            .peers
            .values()
            .filter(|p| now.saturating_sub(p.last_seen) > stale_after_ms)
            .filter(|p| !linked.contains(&p.device_id))
            .map(|p| p.id.clone())
            .collect();
        for id in &gone {
            s.peers.remove(id);
        }
        gone
    });
    for id in dropped {
        let _ = app.emit("peer:left", &id);
    }
}

/// mDNS instance names may not contain dots or spaces.
fn sanitize(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' })
        .collect();
    if cleaned.is_empty() {
        "lantern".into()
    } else {
        cleaned
    }
}
