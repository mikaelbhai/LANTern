//! Tauri command surface. Mirrors `src/lib/bridge.ts` one-to-one.

use tauri::{AppHandle, Emitter, Manager, State};

use crate::model::{
    now_ms, ConnLayer, DiagStep, Initiator, Invite, NetInfo, Peer, PeerScope, PeerStatus,
    GameProgress, GameSession, PortMapping, Share, ShareMode, UpstreamInfo, WanLink,
    WatchParty,
};
use crate::state::AppState;
use crate::signaling::{self, Envelope};
use crate::{discovery, hosting, identity, media, net, shares, stun, upnp};

type Res<T> = Result<T, String>;

fn uid() -> String {
    uuid::Uuid::new_v4().to_string()
}

/* ------------------------------------------------------------- lifecycle */

/// Called by the frontend once it is ready. Services are already running by
/// then — this only reports the current network snapshot.
#[tauri::command]
pub async fn start_services(app: AppHandle, state: State<'_, AppState>) -> Res<()> {
    boot(app, (*state).clone());
    Ok(())
}

/// Brings up every background service.
///
/// This runs from `setup()` rather than waiting for the frontend to call in.
/// The app is meant to sit in the tray and stay reachable, and a window that is
/// hidden — or whose WebView failed to load — must not mean a device that
/// silently answers nothing. Guarded so it only ever happens once.
pub fn boot(app: AppHandle, state: AppState) {
    let already = state.with(|s| std::mem::replace(&mut s.services_started, true));
    if already {
        let info = state.with(|s| s.net.clone());
        let _ = app.emit("net:changed", &info);
        return;
    }
    let state = &state;

    // Snapshot the local network before anything binds to it.
    let ip = net::primary_ip();
    let mask = net::netmask_for(&ip);
    let gateway = net::gateway_for(&ip, &mask);
    let ifaces = net::interfaces();
    let multi_homed = ifaces.len() > 1;

    // Running a second instance on one machine is how peer-to-peer gets tested
    // without a second machine. An offset shifts every port, and a suffix gives
    // the instance its own data directory — and therefore its own identity.
    let offset: u16 = std::env::var("LANTERN_PORT_OFFSET")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(0);
    let instance_suffix = std::env::var("LANTERN_INSTANCE").unwrap_or_default();

    let (port, stun_port, host_port, device_name) = state.with(|s| {
        s.net.ip = ip.clone();
        s.net.subnet = mask.clone();
        s.net.gateway = gateway.clone();
        s.net.interfaces = ifaces;
        s.net.nat = net::detect_nat(&ip, &gateway, multi_homed);
        s.net.upstream = net::upstream_for(&ip, &gateway);
        s.net.upnp_available = false;

        s.net.port += offset;
        s.net.stun_port += offset;
        s.net.host_port += offset;

        let name = if instance_suffix.is_empty() {
            hostname()
        } else {
            format!("{}-{}", hostname(), instance_suffix)
        };
        (s.net.port, s.net.stun_port, s.net.host_port, name)
    });

    // Local history store and stable identity. A failure here is not fatal —
    // the app still runs, it just forgets things between launches.
    match app.path().app_data_dir() {
        Ok(dir) => {
            // A named instance gets its own directory, so it mints its own
            // device id rather than colliding with the primary one.
            let dir = if instance_suffix.is_empty() {
                dir
            } else {
                dir.join(format!("instance-{instance_suffix}"))
            };
            let id = identity::load_or_create(&dir);
            state.with(|s| {
                s.device_id = id;
                s.instance = device_name.clone();
            });
            state.with(|s| s.thumb_dir = Some(dir.join("thumbnails")));
            match crate::db::open(&dir) {
                Ok(conn) => {
                    // Blocks are read before anything can connect, so a device
                    // blocked in a previous session cannot slip a link in
                    // during startup.
                    let mut blocked = std::collections::HashSet::new();
                    if let Ok(mut stmt) = conn.prepare("SELECT device_id FROM blocked") {
                        if let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) {
                            blocked.extend(rows.flatten());
                        }
                    }
                    state.with(|s| {
                        s.blocked = blocked;
                        s.db = Some(conn);
                    });
                }
                Err(e) => eprintln!("history store unavailable: {e}"),
            }
        }
        Err(e) => eprintln!("no app data directory: {e}"),
    }

    // Bring previously published folders back, still running, and keep them
    // current as their contents change.
    {
        let restored = shares::restore(&state);
        if !restored.is_empty() {
            let all = state.with(|s| {
                s.shares = restored;
                s.shares.clone()
            });
            let _ = app.emit("host:changed", &all);
        }
        shares::watch(app.clone(), (*state).clone());
    }

    // Static host server for published folders.
    {
        let owned = (*state).clone();
        let app_for_host = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(e) = hosting::serve(owned, host_port).await {
                // A port that will not bind is the difference between an app
                // that works and one that looks fine and answers nothing. It
                // has to reach the window, not just stderr.
                let _ = app_for_host.emit(
                    "service:failed",
                    serde_json::json!({
                        "service": "hosting",
                        "port": host_port,
                        "detail": e.to_string(),
                    }),
                );
                eprintln!("host server stopped: {e}");
            }
        });
    }

    // Peer transport. This is what carries chat, presence and call setup —
    // without it the app discovers peers but can say nothing to them.
    {
        let links = state.with(|s| s.links.clone());
        let listener_app = app.clone();
        let listener_state = (*state).clone();
        let listener_links = links.clone();
        tauri::async_runtime::spawn(async move {
            let reporter = listener_app.clone();
            if let Err(e) =
                signaling::serve(listener_app, listener_state, listener_links, port).await
            {
                // The peer listener is the app. If it cannot bind, every other
                // symptom - no peers, calls that will not start, files that
                // never arrive - is downstream of this one line.
                let _ = reporter.emit(
                    "service:failed",
                    serde_json::json!({
                        "service": "signalling",
                        "port": port,
                        "detail": e.to_string(),
                    }),
                );
                eprintln!("peer listener stopped: {e}");
            }
        });
        signaling::reconcile(app.clone(), (*state).clone(), links);
    }

    // Local STUN, so ICE never has to leave the LAN.
    tauri::async_runtime::spawn(async move {
        if let Err(e) = stun::serve(stun_port).await {
            eprintln!("stun server stopped: {e}");
        }
    });

    // mDNS presence, announced on every address this device holds so peers on
    // any of its networks can find it.
    let (device_id, addresses) = state.with(|s| {
        (
            s.device_id.clone(),
            s.net.interfaces.iter().map(|i| i.ip.clone()).collect::<Vec<_>>(),
        )
    });
    match discovery::start(
        app.clone(),
        (*state).clone(),
        &device_id,
        &device_name,
        &addresses,
        port,
    ) {
        // The daemon must outlive this call or the service is withdrawn at once.
        Ok(daemon) => state.with(|s| s.daemon = Some(daemon)),
        Err(e) => eprintln!("mDNS unavailable: {e}"),
    }

    watch_network(app.clone(), (*state).clone());

    // Probe the router for UPnP. This runs detached because an unresponsive
    // gateway would otherwise hold up startup for the full SSDP timeout.
    {
        let app = app.clone();
        let owned = (*state).clone();
        let local_ip = ip.clone();
        tauri::async_runtime::spawn(async move {
            let gateways = upnp::discover_all(std::time::Duration::from_secs(4)).await;
            if gateways.is_empty() {
                return;
            }

            // Ask each uplink for its own external address.
            let mut links = Vec::new();
            for gateway in &gateways {
                if let Some(external_ip) = upnp::external_ip(gateway).await {
                    links.push(WanLink {
                        external_ip,
                        service: gateway.service_type.clone(),
                        published: false,
                    });
                }
            }

            let info = owned.with(|s| {
                s.net.upnp_available = true;
                if let Some(up) = s.net.upstream.as_mut() {
                    if let Some(first) = links.first() {
                        // The router knows its real WAN address; prefer it over
                        // the guess derived from the local subnet. The network
                        // it sits on has to be recomputed with it, or the panel
                        // would show a confirmed address inside an invented
                        // subnet.
                        up.router_wan_ip = first.external_ip.clone();
                        up.wan_confirmed = true;
                        up.wan_is_private = net::is_private_addr(&first.external_ip);
                        up.subnet = net::cidr_for(&first.external_ip, "255.255.255.0");
                        up.gateway = if up.wan_is_private {
                            // The upstream router's own address is not
                            // discoverable from here; .1 on its network is the
                            // convention, and it is labelled as an estimate.
                            first
                                .external_ip
                                .rsplit_once('.')
                                .map(|(prefix, _)| format!("{prefix}.1"))
                                .unwrap_or_default()
                        } else {
                            String::new()
                        };
                    }
                    up.wans = links.clone();
                }
                s.gateways = gateways;
                s.net.clone()
            });
            let _ = local_ip;
            let _ = app.emit("net:changed", &info);
        });
    }

    let info = state.with(|s| s.net.clone());
    let _ = app.emit("net:changed", &info);
}

/// Follows this device between networks.
///
/// Switching Wi-Fi, unplugging Ethernet or a DHCP renewal all change the
/// address peers must reach us on — and the address baked into every stream
/// URL we have published. Polling is used rather than OS change notifications
/// because the three desktop platforms expose them very differently, and a few
/// seconds of lag is imperceptible here.
fn watch_network(app: AppHandle, state: AppState) {
    tauri::async_runtime::spawn(async move {
        let mut known: Vec<String> =
            state.with(|s| s.net.interfaces.iter().map(|i| i.ip.clone()).collect());

        loop {
            tokio::time::sleep(std::time::Duration::from_secs(4)).await;

            // Peers that have gone quiet are dropped here, because a device
            // that moved networks never withdraws its old advertisement.
            discovery::reap(&app, &state, 45_000);

            let interfaces = net::interfaces();
            let mut current: Vec<String> = interfaces.iter().map(|i| i.ip.clone()).collect();
            current.sort();

            let mut previous = known.clone();
            previous.sort();
            if current == previous {
                continue;
            }
            known = current.clone();

            let ip = net::primary_ip();
            let mask = net::netmask_for(&ip);
            let gateway = net::gateway_for(&ip, &mask);
            let multi_homed = interfaces.len() > 1;

            let (info, device_id, instance, port, daemon) = state.with(|s| {
                s.net.ip = ip.clone();
                s.net.subnet = mask.clone();
                s.net.gateway = gateway.clone();
                s.net.interfaces = interfaces.clone();
                s.net.nat = net::detect_nat(&ip, &gateway, multi_homed);
                s.net.upstream = net::upstream_for(&ip, &gateway);
                (
                    s.net.clone(),
                    s.device_id.clone(),
                    s.instance.clone(),
                    s.net.port,
                    s.daemon.clone(),
                )
            });

            if let Some(daemon) = daemon {
                discovery::reannounce(&daemon, &device_id, &instance, &current, port);
            }

            // Published stream URLs embed our address, so the library has to be
            // rebuilt or every title would point at where we used to be.
            let items = media::refresh(&state);

            let _ = app.emit("net:changed", &info);
            let _ = app.emit("media:changed", &items);
        }
    });
}

/// What this device calls itself on the network.
///
/// Android sets neither COMPUTERNAME nor HOSTNAME, so the old fallback made
/// every phone announce itself as the literal "lantern" - indistinguishable
/// from any other, and useless in a peer list. MainActivity puts the device's
/// own name in LANTERN_DEVICE_NAME before the Rust layer boots.
fn hostname() -> String {
    ["LANTERN_DEVICE_NAME", "COMPUTERNAME", "HOSTNAME"]
        .iter()
        .filter_map(|key| std::env::var(key).ok())
        .map(|value| value.trim().to_string())
        .find(|value| !value.is_empty())
        .unwrap_or_else(|| "lantern".into())
}

#[tauri::command]
pub fn host_os() -> String {
    std::env::consts::OS.to_string()
}

/* ------------------------------------------------------------------ net */

#[tauri::command]
pub fn net_info(state: State<'_, AppState>) -> NetInfo {
    state.with(|s| s.net.clone())
}

#[tauri::command]
pub fn net_set_relay_hub(app: AppHandle, state: State<'_, AppState>, on: bool) {
    let info = state.with(|s| {
        s.net.relay_hub = on;
        s.net.clone()
    });
    let _ = app.emit("net:changed", &info);
}

#[tauri::command]
pub fn net_set_bridging(app: AppHandle, state: State<'_, AppState>, on: bool) {
    let info = state.with(|s| {
        s.net.bridging = on;
        s.net.clone()
    });
    let _ = app.emit("net:changed", &info);
}

#[tauri::command]
pub fn net_set_port(app: AppHandle, state: State<'_, AppState>, port: u16) {
    let info = state.with(|s| {
        s.net.port = port;
        s.net.clone()
    });
    let _ = app.emit("net:changed", &info);
}

#[tauri::command]
pub fn net_add_manual_peer(
    app: AppHandle,
    state: State<'_, AppState>,
    ip: String,
    port: u16,
) -> Peer {
    let id = uid();
    let peer = Peer {
        id: id.clone(),
        device_id: id,
        name: ip.clone(),
        color: "#F5A623".into(),
        emoji: "🏮".into(),
        os: "unknown".into(),
        addresses: vec![ip.clone()],
        ip,
        port,
        layer: ConnLayer::Manual,
        latency_ms: 0.0,
        loss_pct: 0.0,
        status: PeerStatus::Available,
        status_message: None,
        last_seen: now_ms(),
        trusted: true,
        scope: PeerScope::Local,
        initiated_by: Initiator::Us,
    };
    state.with(|s| s.peers.insert(peer.id.clone(), peer.clone()));
    let _ = app.emit("peer:joined", &peer);
    peer
}

/// Adds a peer from a six-word pairing phrase.
///
/// The phrase is not a token to be looked up anywhere — it encodes the address
/// and port directly, so this decodes it and adds the peer exactly as typing
/// the address by hand would. A phrase that does not decode adds nothing
/// rather than dialling somewhere arbitrary, which is what it used to do.
#[tauri::command]
pub fn net_add_by_phrase(
    app: AppHandle,
    state: State<'_, AppState>,
    phrase: String,
) -> Result<Peer, String> {
    let (ip, port) = crate::phrase::decode(&phrase)
        .ok_or_else(|| "That is not a valid pairing phrase.".to_string())?;
    Ok(net_add_manual_peer(app, state, ip, port))
}

/// Re-announces this device and re-dials every peer we know of.
///
/// mDNS is multicast, and multicast is the first thing a network drops when it
/// is busy, roaming between access points, or run by a router that filters it.
/// When that happens the peer list can be wrong for as long as the next
/// announcement takes. This is the manual way to say "look again now" rather
/// than waiting it out.
///
/// Returns the number of peers known once the sweep has been kicked off.
#[tauri::command]
pub async fn net_refresh(app: AppHandle, state: State<'_, AppState>) -> Res<usize> {
    let owned = (*state).clone();

    // Announce ourselves again, so peers that missed us get another chance.
    let (daemon, device_id, instance, addresses, announce_port) = owned.with(|s| {
        (
            s.daemon.clone(),
            s.device_id.clone(),
            s.instance.clone(),
            s.net.interfaces.iter().map(|i| i.ip.clone()).collect::<Vec<_>>(),
            s.net.port,
        )
    });
    if let Some(daemon) = daemon {
        discovery::reannounce(&daemon, &device_id, &instance, &addresses, announce_port);
    }

    // Re-dial everything we know that has no live link.
    let (links, targets, port) = owned.with(|s| {
        (
            s.links.clone(),
            s.peers.values().cloned().collect::<Vec<_>>(),
            s.net.port,
        )
    });

    for peer in targets {
        if links.has(&peer.device_id) {
            continue;
        }
        let mut addresses = peer.addresses.clone();
        if !peer.ip.is_empty() && !addresses.contains(&peer.ip) {
            addresses.push(peer.ip.clone());
        }
        let peer_port = if peer.port == 0 { port } else { peer.port };
        for address in addresses {
            let app = app.clone();
            let state = owned.clone();
            let links = links.clone();
            tauri::async_runtime::spawn(async move {
                let _ = signaling::dial(app, state, links, address, peer_port).await;
            });
        }
    }

    let known = owned.with(|s| s.peers.len());
    let info = owned.with(|s| s.net.clone());
    let _ = app.emit("net:changed", &info);
    Ok(known)
}

/// Probes each connectivity layer for real and reports what it measured.
///
/// Every line this returns is the result of an attempt that was actually made.
/// A diagnostic that names a cause it never tested is worse than no diagnostic
/// at all: it sends you to the router when the problem is a host firewall, or
/// to the firewall when the address it tried simply no longer belongs to
/// anyone. Where a layer cannot be tested, it says so rather than guessing.
#[tauri::command]
pub async fn net_diagnose(state: State<'_, AppState>, peer_id: String) -> Res<Vec<DiagStep>> {
    let snapshot = state.with(|s| {
        s.peers.get(&peer_id).cloned().map(|p| {
            (
                p,
                s.net.clone(),
                s.mappings.clone(),
                s.links.clone(),
                s.gateways.len(),
            )
        })
    });
    let Some((peer, info, mappings, links, gateways)) = snapshot else {
        return Ok(vec![DiagStep {
            layer: ConnLayer::Manual,
            ok: false,
            detail: "Peer is no longer known — it may have gone offline mid-test".into(),
            rtt_ms: None,
        }]);
    };

    let timeout = std::time::Duration::from_millis(1200);
    let port = if peer.port == 0 { info.port } else { peer.port };

    // Every address this peer is known to answer on. A device on two networks
    // has several, and which one works is exactly what this test is for.
    let mut addresses = peer.addresses.clone();
    if !peer.ip.is_empty() && !addresses.contains(&peer.ip) {
        addresses.push(peer.ip.clone());
    }
    addresses.retain(|a| !a.is_empty() && a != "0.0.0.0");

    // Split by whether each address shares a subnet with one of our own.
    let mine: Vec<(String, String)> = info
        .interfaces
        .iter()
        .map(|i| (i.ip.clone(), net::netmask_for(&i.ip)))
        .collect();
    let (on_link, off_link): (Vec<String>, Vec<String>) = addresses
        .iter()
        .cloned()
        .partition(|a| mine.iter().any(|(ip, mask)| net::same_subnet(ip, a, mask)));

    let mut steps: Vec<DiagStep> = Vec::new();
    let mut reached = false;

    /* -- Direct: same broadcast domain, no router involved. */
    if on_link.is_empty() {
        let ours = mine
            .iter()
            .map(|(ip, _)| ip.as_str())
            .collect::<Vec<_>>()
            .join(", ");
        steps.push(DiagStep {
            layer: ConnLayer::Direct,
            ok: false,
            detail: if addresses.is_empty() {
                "No address on file for this peer yet".into()
            } else {
                format!(
                    "None of the peer's addresses ({}) are on a subnet this device is on ({})",
                    addresses.join(", "),
                    if ours.is_empty() { "none".to_string() } else { ours }
                )
            },
            rtt_ms: None,
        });
    } else {
        let mut hit: Option<(String, f64)> = None;
        for addr in &on_link {
            if let Some(rtt) = net::probe_tcp(addr, port, timeout).await {
                hit = Some((addr.clone(), rtt));
                break;
            }
        }
        match hit {
            Some((addr, rtt)) => {
                reached = true;
                steps.push(DiagStep {
                    layer: ConnLayer::Direct,
                    ok: true,
                    detail: format!("TCP {addr}:{port} accepted the connection"),
                    rtt_ms: Some(rtt),
                });
            }
            None => steps.push(DiagStep {
                layer: ConnLayer::Direct,
                ok: false,
                detail: format!(
                    "{} did not answer on port {port} within {} ms. The address is on this subnet, so the peer's host firewall or a stopped LANTern is the usual cause",
                    on_link.join(", "),
                    timeout.as_millis()
                ),
                rtt_ms: None,
            }),
        }
    }

    /* -- Routed: a different subnet, reached through a gateway. */
    if !reached {
        if off_link.is_empty() {
            steps.push(DiagStep {
                layer: ConnLayer::Routed,
                ok: false,
                detail: "No off-subnet address to route to".into(),
                rtt_ms: None,
            });
        } else {
            let mut hit: Option<(String, f64)> = None;
            for addr in &off_link {
                if let Some(rtt) = net::probe_tcp(addr, port, timeout).await {
                    hit = Some((addr.clone(), rtt));
                    break;
                }
            }
            match hit {
                Some((addr, rtt)) => {
                    reached = true;
                    steps.push(DiagStep {
                        layer: ConnLayer::Routed,
                        ok: true,
                        detail: format!(
                            "Reached {addr}:{port} across a subnet boundary{}",
                            if info.gateway.is_empty() {
                                String::new()
                            } else {
                                format!(" via gateway {}", info.gateway)
                            }
                        ),
                        rtt_ms: Some(rtt),
                    });
                }
                None => steps.push(DiagStep {
                    layer: ConnLayer::Routed,
                    ok: false,
                    detail: format!(
                        "{} unreachable on port {port} — no route, or the router between the two subnets is not forwarding",
                        off_link.join(", ")
                    ),
                    rtt_ms: None,
                }),
            }
        }
    }

    /* -- UPnP: whether this device's own inbound path is published. That is
          what a peer behind a further NAT would need to come back in on. */
    if !reached {
        let mapped = mappings.iter().find(|m| m.internal == info.port);
        steps.push(match (mapped, gateways) {
            (Some(m), _) => DiagStep {
                layer: ConnLayer::Upnp,
                ok: true,
                detail: format!(
                    "Gateway is forwarding external {} to {}:{} — inbound path is open",
                    m.external, info.ip, m.internal
                ),
                rtt_ms: None,
            },
            (None, 0) => DiagStep {
                layer: ConnLayer::Upnp,
                ok: false,
                detail: "No UPnP gateway responded to discovery on any WAN link".into(),
                rtt_ms: None,
            },
            (None, n) => DiagStep {
                layer: ConnLayer::Upnp,
                ok: false,
                detail: format!(
                    "{n} gateway(s) found but nothing is forwarding port {} yet — turn on Publish in the Network panel",
                    info.port
                ),
                rtt_ms: None,
            },
        });
    }

    /* -- Relay: a third device forwarding on our behalf. */
    if !reached {
        let others = links
            .connected()
            .into_iter()
            .filter(|id| *id != peer.device_id)
            .count();
        steps.push(DiagStep {
            layer: ConnLayer::Relayed,
            ok: false,
            detail: if info.relay_hub {
                format!(
                    "This device is a relay hub, but relaying needs a third device that can see both ends ({others} other link(s) open)"
                )
            } else if others == 0 {
                "No other device is linked to relay through".into()
            } else {
                format!("{others} other link(s) open, but none volunteered as a relay hub")
            },
            rtt_ms: None,
        });
    }

    /* -- Manual: an address the user entered by hand. */
    if !reached {
        let manual = peer.initiated_by == Initiator::Us;
        steps.push(DiagStep {
            layer: ConnLayer::Manual,
            ok: false,
            detail: if manual {
                format!("Manual address {}:{port} is on file but did not answer", peer.ip)
            } else {
                "No manual address on file — add one under Network → Add peer".into()
            },
            rtt_ms: None,
        });
    }

    // A live session outranks any probe: if messages are already flowing, say so.
    if links.has(&peer.device_id) {
        steps.push(DiagStep {
            layer: peer.layer,
            ok: true,
            detail: "A peer link to this device is open right now".into(),
            rtt_ms: Some(peer.latency_ms),
        });
    }

    Ok(steps)
}

/// Sweeps the network above this one for other LANTern devices.
///
/// mDNS does not cross a router, so a device one hop up is invisible to
/// discovery however well it is working. This dials the app's port across the
/// upstream subnet and reports which addresses answer.
///
/// The previous version set `hosts_scanned = 254` and `reachable = true`
/// without contacting anything, so the screen described a sweep that had not
/// happened. What it reports now is what it did.
#[tauri::command]
pub async fn net_scan_upstream(app: AppHandle, state: State<'_, AppState>) -> Res<Vec<Peer>> {
    let Some((gateway, port)) = state.with(|s| {
        s.net
            .upstream
            .as_ref()
            .map(|up| (up.gateway.clone(), s.net.port))
    }) else {
        return Ok(Vec::new());
    };

    // The /24 the upstream gateway sits on. Anything wider would take minutes
    // and anything narrower would miss most of it.
    let Some(prefix) = gateway.rsplit_once('.').map(|(head, _)| head.to_string()) else {
        return Ok(Vec::new());
    };

    // 254 dials at once would exhaust the socket table on Windows; in batches
    // the whole sweep still finishes in a couple of seconds.
    let timeout = std::time::Duration::from_millis(400);
    let mut answered: Vec<String> = Vec::new();
    let mut scanned = 0u32;

    for chunk in (1..=254u8).collect::<Vec<_>>().chunks(32) {
        let mut batch = tokio::task::JoinSet::new();
        for host in chunk {
            let address = format!("{prefix}.{host}");
            batch.spawn(async move {
                crate::net::probe_tcp(&address, port, timeout)
                    .await
                    .map(|_| address)
            });
        }
        while let Some(joined) = batch.join_next().await {
            scanned += 1;
            if let Ok(Some(address)) = joined {
                answered.push(address);
            }
        }
    }

    let info = state.with(|s| {
        if let Some(up) = s.net.upstream.as_mut() {
            up.reachable = !answered.is_empty();
            up.last_scan_at = Some(now_ms());
            up.hosts_scanned = scanned;
        }
        s.net.clone()
    });
    let _ = app.emit("net:changed", &info);

    // Addresses that answered on the right port are candidates, not peers.
    // Dialling them starts the same handshake a discovered peer goes through,
    // and they appear once they have introduced themselves — this sweep never
    // invents a peer from an open socket.
    let owned = state.inner().clone();
    let links = owned.with(|s| s.links.clone());
    for address in &answered {
        let app = app.clone();
        let state = owned.clone();
        let links = links.clone();
        let address = address.clone();
        tauri::async_runtime::spawn(async move {
            let _ = signaling::dial(app, state, links, address, port).await;
        });
    }

    Ok(state.with(|s| {
        s.peers
            .values()
            .filter(|p| answered.iter().any(|a| p.ip == *a || p.addresses.contains(a)))
            .cloned()
            .collect()
    }))
}

/// Opens (or closes) a mapping on our own router so devices upstream can
/// initiate to this one — the direction a NAT blocks by default.
#[tauri::command]
pub async fn net_publish_upstream(
    app: AppHandle,
    state: State<'_, AppState>,
    on: bool,
) -> Res<Option<UpstreamInfo>> {
    let (gateways, port, ip) =
        state.with(|s| (s.gateways.clone(), s.net.port, s.net.ip.clone()));

    if gateways.is_empty() {
        return Err(
            "No UPnP gateway answered. Forward port 7979 on the router manually instead."
                .into(),
        );
    }

    // Map on every uplink. A dual-WAN router may answer on whichever link it
    // is currently favouring, so mapping only one leaves inbound broken half
    // the time — and in a way that looks intermittent rather than misconfigured.
    let mut mapped: Vec<String> = Vec::new();
    let mut failures: Vec<String> = Vec::new();

    for gateway in &gateways {
        let mut ok = true;
        for proto in ["TCP", "UDP"] {
            let outcome = if on {
                // TCP carries signaling; UDP carries media. Both need the hole.
                upnp::add_port_mapping(gateway, port, port, &ip, proto, "LANTern").await
            } else {
                upnp::delete_port_mapping(gateway, port, proto).await
            };
            if let Err(e) = outcome {
                if on {
                    ok = false;
                    failures.push(e);
                }
            }
        }
        if ok && on {
            if let Some(external) = upnp::external_ip(gateway).await {
                mapped.push(external);
            }
        }
    }

    // Every link refusing is a real failure; some succeeding is still useful.
    if on && mapped.is_empty() {
        return Err(failures
            .first()
            .cloned()
            .unwrap_or_else(|| "The router refused the mapping".into()));
    }

    let info = state.with(|s| {
        if let Some(up) = s.net.upstream.as_mut() {
            up.published = on;
            up.published_via = on.then(|| "upnp".to_string());
            up.published_address = on.then(|| format!("{}:{}", up.router_wan_ip, port));
            for wan in up.wans.iter_mut() {
                wan.published = on && mapped.contains(&wan.external_ip);
            }
        }
        if on {
            s.mappings.push(PortMapping {
                id: uid(),
                external: port,
                internal: port,
                proto: "TCP".into(),
                description: "LANTern upstream reachability".into(),
                expires_at: None,
            });
        } else {
            s.mappings
                .retain(|m| m.description != "LANTern upstream reachability");
        }
        s.net.clone()
    });
    let _ = app.emit("net:changed", &info);
    Ok(info.upstream)
}

/// Records a port forward the user configured on the router by hand.
///
/// Nothing is asked of the gateway here — LANTern simply takes the user's word
/// that the hole exists, so the rest of the app can act on it. This is the
/// fallback whenever UPnP is off, which is common on business and ISP routers.
#[tauri::command]
pub fn net_publish_upstream_manual(
    app: AppHandle,
    state: State<'_, AppState>,
    on: bool,
) -> Option<UpstreamInfo> {
    let info = state.with(|s| {
        let port = s.net.port;
        if let Some(up) = s.net.upstream.as_mut() {
            up.published = on;
            up.published_via = on.then(|| "manual".to_string());
            up.published_address = on.then(|| format!("{}:{}", up.router_wan_ip, port));
        }
        s.net.clone()
    });
    let _ = app.emit("net:changed", &info);
    info.upstream
}

#[tauri::command]
pub fn net_invite(state: State<'_, AppState>) -> Invite {
    let (ip, port) = state.with(|s| (s.net.ip.clone(), s.net.port));
    Invite {
        // Derived from this device's own address. It used to be a constant,
        // which meant every device in the world offered the same phrase and
        // none of them could be reached by it.
        phrase: crate::phrase::encode(&ip, port).unwrap_or_default(),
        payload: format!("lantern://connect?ip={ip}&port={port}"),
    }
}

#[tauri::command]
pub fn net_upnp_list(state: State<'_, AppState>) -> Vec<PortMapping> {
    state.with(|s| s.mappings.clone())
}

#[tauri::command]
pub fn net_upnp_open(state: State<'_, AppState>, internal: u16, proto: String) -> PortMapping {
    let mapping = PortMapping {
        id: uid(),
        external: internal,
        internal,
        proto,
        description: "LANTern".into(),
        expires_at: None,
    };
    state.with(|s| s.mappings.push(mapping.clone()));
    mapping
}

#[tauri::command]
pub fn net_upnp_close(state: State<'_, AppState>, id: String) {
    state.with(|s| s.mappings.retain(|m| m.id != id));
}

/* ---------------------------------------------------------------- peers */

#[tauri::command]
pub fn peers_list(state: State<'_, AppState>) -> Vec<Peer> {
    state.with(|s| s.peers.values().cloned().collect())
}

/// Times a real handshake to a peer.
///
/// This used to hand back the latency already on the record, which made the
/// button a no-op dressed as a measurement: pressing it after a peer went away
/// still showed the reading from when it was there. It now dials the peer's
/// own port and reports what the connection actually cost, and writes the
/// figure back so the rest of the UI agrees with it.
///
/// Every known address is tried, not just the current one: a device with both
/// Wi-Fi and Ethernet answers on whichever is up, and the first that responds
/// is the one worth reporting.
#[tauri::command]
pub async fn peers_ping(app: AppHandle, state: State<'_, AppState>, peer_id: String) -> Res<f64> {
    let Some((addresses, port)) = state.with(|s| {
        s.peers.get(&peer_id).map(|p| {
            let mut addresses = p.addresses.clone();
            if !p.ip.is_empty() && !addresses.contains(&p.ip) {
                addresses.insert(0, p.ip.clone());
            }
            (addresses, p.port)
        })
    }) else {
        return Ok(999.0);
    };

    let timeout = std::time::Duration::from_millis(1200);
    let mut best: Option<f64> = None;
    for address in addresses {
        if let Some(ms) = crate::net::probe_tcp(&address, port, timeout).await {
            best = Some(best.map_or(ms, |b: f64| b.min(ms)));
        }
    }

    // A peer that does not answer is unreachable, and saying so is more use
    // than a stale number that looks like a healthy link.
    let latency = best.unwrap_or(999.0);
    state.with(|s| {
        if let Some(p) = s.peers.get_mut(&peer_id) {
            p.latency_ms = latency;
            if best.is_none() {
                p.status = PeerStatus::Offline;
            }
        }
    });

    let peers: Vec<Peer> = state.with(|s| s.peers.values().cloned().collect());
    let _ = app.emit("peers:changed", &peers);

    Ok(latency)
}

#[tauri::command]
pub fn peers_trust(state: State<'_, AppState>, peer_id: String, trusted: bool) {
    state.with(|s| {
        if let Some(p) = s.peers.get_mut(&peer_id) {
            p.trusted = trusted;
        }
    });
}

/* ----------------------------------------------------------------- chat */

/// Sends a message to the room's members over their peer links.
///
/// Returns how many peers it actually reached, so the UI can tell the
/// difference between "sent" and "nobody was listening".
#[tauri::command]
pub fn chat_send(
    state: State<'_, AppState>,
    room_id: String,
    payload: serde_json::Value,
    member_ids: Vec<String>,
) -> usize {
    let (links, me) = state.with(|s| (s.links.clone(), s.device_id.clone()));
    let envelope = Envelope {
        v: 1,
        from: me,
        kind: "chat".into(),
        payload: serde_json::json!({ "roomId": room_id, "message": payload }),
    };

    // Deliver only to the room's members. Broadcasting would put every direct
    // message in front of every device on the network — the recipients would
    // filter it out, but it would still have been sent to them.
    if member_ids.is_empty() {
        return links.broadcast(&envelope);
    }
    member_ids
        .iter()
        .filter(|id| links.send(id, &envelope))
        .count()
}

#[tauri::command]
pub fn chat_typing(state: State<'_, AppState>, room_id: String) {
    let (links, me) = state.with(|s| (s.links.clone(), s.device_id.clone()));
    links.broadcast(&Envelope {
        v: 1,
        from: me.clone(),
        kind: "typing".into(),
        payload: serde_json::json!({ "roomId": room_id, "peerId": me }),
    });
}

#[tauri::command]
pub fn chat_react(state: State<'_, AppState>, message_id: String, emoji: String) {
    let (links, me) = state.with(|s| (s.links.clone(), s.device_id.clone()));
    links.broadcast(&Envelope {
        v: 1,
        from: me,
        kind: "chat".into(),
        payload: serde_json::json!({ "reaction": { "messageId": message_id, "emoji": emoji } }),
    });
}

/// Which peers currently have a live link.
#[tauri::command]
pub fn peers_linked(state: State<'_, AppState>) -> Vec<String> {
    state.with(|s| s.links.connected())
}

/* ---------------------------------------------------------------- files */

#[tauri::command]
pub fn files_offer(
    app: AppHandle,
    state: State<'_, AppState>,
    peer_id: String,
    paths: Vec<String>,
) -> Vec<crate::model::Transfer> {
    let paths = paths.into_iter().map(std::path::PathBuf::from).collect();
    crate::transfers::offer(&app, &state, &peer_id, paths)
}

/// Starts (or resumes) pulling a file a peer has offered.
///
/// `dir` is where the person receiving it wants it: a folder they picked for
/// this transfer, or the one they set as their usual. Empty means the
/// platform's downloads folder, which is what happens when nobody has said.
#[tauri::command]
pub fn files_accept(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    dir: Option<String>,
) {
    state.with(|s| {
        s.download_into.insert(id.clone(), dir.clone());
    });
    let owned = (*state).clone();
    tauri::async_runtime::spawn(crate::transfers::accept(app, owned, id));
}

/// Pausing is cooperative — the streaming loop checks this state between
/// chunks, so the partial file on disk stays valid and resuming continues
/// from the byte it reached.
#[tauri::command]
pub fn files_pause(app: AppHandle, state: State<'_, AppState>, id: String) {
    state.with(|s| {
        if let Some(t) = s.transfers.iter_mut().find(|t| t.id == id && t.state == "active") {
            t.state = "paused".into();
        }
    });
    crate::transfers::emit_one(&app, &state, &id);
}

#[tauri::command]
pub fn files_resume(app: AppHandle, state: State<'_, AppState>, id: String) {
    state.with(|s| {
        if let Some(t) = s.transfers.iter_mut().find(|t| t.id == id) {
            t.state = "queued".into();
        }
    });
    let owned = (*state).clone();
    tauri::async_runtime::spawn(crate::transfers::accept(app, owned, id));
}

#[tauri::command]
pub fn files_cancel(app: AppHandle, state: State<'_, AppState>, id: String) {
    let peer = state.with(|s| {
        s.offers.revoke(&id);
        if let Some(t) = s.transfers.iter_mut().find(|t| t.id == id) {
            t.state = "cancelled".into();
            return Some(t.peer_id.clone());
        }
        None
    });
    crate::transfers::emit_one(&app, &state, &id);

    // Tell the other end, so a sender stops holding the file open and a
    // receiver stops fetching.
    if let Some(peer) = peer {
        let (links, me) = state.with(|s| (s.links.clone(), s.device_id.clone()));
        links.send(
            &peer,
            &Envelope {
                v: 1,
                from: me,
                kind: "file".into(),
                payload: serde_json::json!({
                    "control": { "transferId": id, "action": "cancel" }
                }),
            },
        );
    }
}

/// Names and sizes for a set of absolute paths.
///
/// The native file dialog returns paths only. The staging list wants to show
/// what is about to be sent, and asking the frontend to guess a size from a
/// path is not something it can do.
#[tauri::command]
pub fn files_stat(paths: Vec<String>) -> Vec<serde_json::Value> {
    paths
        .into_iter()
        .filter_map(|p| {
            let path = std::path::PathBuf::from(&p);
            let meta = std::fs::metadata(&path).ok()?;
            if !meta.is_file() {
                return None;
            }
            Some(serde_json::json!({
                "path": p,
                "name": path.file_name().and_then(|n| n.to_str()).unwrap_or("file"),
                "size": meta.len(),
            }))
        })
        .collect()
}

/// Every transfer this session knows about.
#[tauri::command]
pub fn files_list(state: State<'_, AppState>) -> Vec<crate::model::Transfer> {
    state.with(|s| s.transfers.clone())
}

#[tauri::command]
pub fn files_reveal(app: AppHandle, path: String) {
    reveal(&app, &path);
}

#[tauri::command]
pub fn files_open(app: AppHandle, path: String) {
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_path(path, None::<&str>);
}

fn reveal(app: &AppHandle, path: &str) {
    use tauri_plugin_opener::OpenerExt;
    // Selecting the file is friendlier than opening its folder, where it
    // could be one of thousands.
    if app.opener().reveal_item_in_dir(path).is_ok() {
        return;
    }
    let p = std::path::Path::new(path);
    let dir = p.parent().unwrap_or(p).to_string_lossy().to_string();
    let _ = app.opener().open_path(dir, None::<&str>);
}

/// Remembers which audio and subtitle language a title was being watched in.
///
/// An empty string means "off" for subtitles and "the file's default" for
/// audio; both are real choices worth restoring, so they are stored rather
/// than treated as absent.
#[tauri::command]
pub fn media_set_tracks(
    state: State<'_, AppState>,
    id: String,
    audio_lang: String,
    subtitle_lang: String,
) {
    state.with(|s| {
        for item in s.media.iter_mut() {
            if item.get("id").and_then(|v| v.as_str()) != Some(id.as_str()) {
                continue;
            }
            if let Some(obj) = item.as_object_mut() {
                obj.insert("audioLang".into(), serde_json::Value::from(audio_lang.clone()));
                obj.insert(
                    "subtitleLang".into(),
                    serde_json::Value::from(subtitle_lang.clone()),
                );
            }
        }
    });

    media::save_tracks(&state, &id, Some(&audio_lang), Some(&subtitle_lang));
}

/* -------------------------------------------- browsing a peer's folders */

/// Everything a peer is publishing.
#[tauri::command]
pub async fn peers_shares(
    state: State<'_, AppState>,
    peer_id: String,
) -> Res<Vec<serde_json::Value>> {
    let owned = (*state).clone();
    Ok(crate::library::peer_shares(&owned, &peer_id).await)
}

/// One directory inside a peer's published folder.
///
/// `path` is relative to the share; empty is its root.
#[tauri::command]
pub async fn peers_browse(
    state: State<'_, AppState>,
    peer_id: String,
    slug: String,
    path: String,
) -> Res<serde_json::Value> {
    let owned = (*state).clone();
    Ok(crate::library::peer_listing(&owned, &peer_id, &slug, &path)
        .await
        .unwrap_or_else(|| serde_json::json!({ "entries": [] })))
}

/* ------------------------------------------------------ who may reach us */

/// Blocks or unblocks a device.
///
/// A block is refused at the signalling link, which every other feature runs
/// over, so it covers messages, calls, file offers and library access
/// together. The peer is dropped from the list and its live link closed, so
/// the effect is immediate rather than "from the next reconnection".
#[tauri::command]
pub fn peers_block(app: AppHandle, state: State<'_, AppState>, peer_id: String, blocked: bool) {
    let device_id = state.with(|s| {
        s.peers
            .get(&peer_id)
            .map(|p| p.device_id.clone())
            .unwrap_or_else(|| peer_id.clone())
    });
    let name = state.with(|s| {
        s.peers
            .get(&peer_id)
            .map(|p| p.name.clone())
            .unwrap_or_default()
    });

    state.with(|s| {
        if blocked {
            s.blocked.insert(device_id.clone());
            s.peers.remove(&peer_id);
            if let Some(db) = s.db.as_ref() {
                let _ = db.execute(
                    "INSERT INTO blocked (device_id, name, blocked_at) VALUES (?1, ?2, ?3)
                     ON CONFLICT(device_id) DO UPDATE SET name = ?2",
                    rusqlite::params![device_id, name, crate::model::now_ms() as i64],
                );
            }
        } else {
            s.blocked.remove(&device_id);
            if let Some(db) = s.db.as_ref() {
                let _ = db.execute(
                    "DELETE FROM blocked WHERE device_id = ?1",
                    rusqlite::params![device_id],
                );
            }
        }
    });

    // Close any link it already has, or a block would only apply next time.
    if blocked {
        let links = state.with(|s| s.links.clone());
        links.drop_link(&device_id);
    }

    let peers: Vec<Peer> = state.with(|s| s.peers.values().cloned().collect());
    let _ = app.emit("peers:changed", &peers);
}

/// Every device currently refused, for the list in Settings.
#[tauri::command]
pub fn peers_blocked(state: State<'_, AppState>) -> Vec<serde_json::Value> {
    state.with(|s| {
        let Some(db) = s.db.as_ref() else {
            return Vec::new();
        };
        let Ok(mut stmt) = db.prepare("SELECT device_id, name, blocked_at FROM blocked ORDER BY blocked_at DESC")
        else {
            return Vec::new();
        };
        let rows = stmt.query_map([], |r| {
            Ok(serde_json::json!({
                "deviceId": r.get::<_, String>(0)?,
                "name": r.get::<_, String>(1)?,
                "blockedAt": r.get::<_, i64>(2)?,
            }))
        });
        rows.map(|rows| rows.flatten().collect()).unwrap_or_default()
    })
}

/* ------------------------------------------------- network reachability */

/// One network this device is attached to, and whether Windows trusts it.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub alias: String,
    /// "Private", "Public" or "DomainAuthenticated".
    pub category: String,
    /// True when peers on this network cannot reach us because of it.
    pub blocks_peers: bool,
}

/// Runs a PowerShell snippet and returns its output.
///
/// Windows-only by nature: this is asking a question only Windows can answer.
#[cfg(windows)]
fn powershell(script: &str) -> Option<String> {
    use std::os::windows::process::CommandExt;
    use std::process::Command;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    let out = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", script])
        .creation_flags(CREATE_NO_WINDOW)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8(out.stdout).ok()
}

/// The networks this device is on, and whether any of them is blocking peers.
///
/// A "Public" network in Windows means "do not let anything in", and the
/// firewall rules LANTern installs are scoped to Private. The result is a
/// device that can reach out — so discovery, messages and calls all work —
/// while every attempt by a peer to open a connection to it is dropped.
/// Nothing in the app fails loudly; a phone simply shows an empty library.
///
/// This is the check behind offering to change it.
#[tauri::command]
pub fn net_connection_profiles() -> Vec<ConnectionProfile> {
    #[cfg(windows)]
    {
        // One line per adapter: alias, then category.
        let script = "Get-NetConnectionProfile | ForEach-Object { \"$($_.InterfaceAlias)`t$($_.NetworkCategory)\" }";
        let Some(text) = powershell(script) else {
            return Vec::new();
        };

        return text
            .lines()
            .filter_map(|line| {
                let (alias, category) = line.trim_end().split_once('\t')?;
                if alias.is_empty() {
                    return None;
                }
                Some(ConnectionProfile {
                    alias: alias.to_string(),
                    category: category.to_string(),
                    blocks_peers: category.eq_ignore_ascii_case("Public"),
                })
            })
            .collect();
    }

    #[cfg(not(windows))]
    Vec::new()
}

/// Asks Windows to treat one network as Private.
///
/// This is a change to the machine's firewall posture, so it is never done
/// quietly: the command is run elevated, which means Windows shows its own
/// consent prompt naming the action, and the user can refuse it there. LANTern
/// only ever offers — it cannot make the change on its own.
///
/// Private is the correct setting for a home or office network, and the one
/// Windows itself asks about when a network is first joined. It is what makes
/// a machine reachable by the other devices on it, which is the whole point of
/// this application.
#[tauri::command]
pub fn net_set_private(alias: String) -> Result<(), String> {
    #[cfg(windows)]
    {
        // Only an adapter Windows itself just named. The alias reaches a shell,
        // so it is matched against the live list rather than trusted, and a
        // name that is not on it is refused outright.
        let known = net_connection_profiles();
        if !known.iter().any(|p| p.alias == alias) {
            return Err("no such network on this device".into());
        }
        if alias.contains(['\'', '"', '`', ';', '&', '|', '$', '\n', '\r']) {
            return Err("that network name cannot be used safely".into());
        }

        use std::os::windows::process::CommandExt;
        use std::process::Command;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;

        // -Verb RunAs is the elevation prompt. Without it the call fails with
        // access denied, because changing a network's category is an
        // administrative action.
        let inner = format!(
            "Set-NetConnectionProfile -InterfaceAlias '{alias}' -NetworkCategory Private"
        );
        let script = format!(
            "Start-Process powershell -Verb RunAs -WindowStyle Hidden -Wait \
             -ArgumentList '-NoProfile','-NonInteractive','-Command',\"{inner}\""
        );

        let status = Command::new("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .creation_flags(CREATE_NO_WINDOW)
            .status()
            .map_err(|e| format!("could not ask Windows: {e}"))?;

        if !status.success() {
            return Err("Windows refused, or the prompt was dismissed.".into());
        }
        return Ok(());
    }

    #[cfg(not(windows))]
    {
        let _ = alias;
        Err("Only Windows has network profiles.".into())
    }
}

/* --------------------------------------------------------------- updates */

/// Where a downloaded installer is kept until it is run.
///
/// Under the app's own data directory rather than Downloads: this is a file
/// the app fetched and is about to execute, and it should not be sitting in a
/// shared folder where something else could swap it first.
fn update_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("no cache directory: {e}"))?
        .join("updates");
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not create {dir:?}: {e}"))?;
    Ok(dir)
}

/// Names the file the next `update_stage` call will write.
///
/// Split from the transfer itself because the bytes arrive as a raw body with
/// no room for arguments alongside them — sending a 17 MB installer as a JSON
/// array of numbers would cost several times its own size in the process.
#[tauri::command]
pub fn update_begin(state: State<'_, AppState>, name: String) -> Result<(), String> {
    // A name from a release asset should be a plain filename; anything with a
    // separator in it is refused rather than sanitised, because there is no
    // legitimate reason for one to be there.
    if name.is_empty()
        || name.contains(['/', '\\', '\0'])
        || name.contains("..")
        || name.len() > 128
    {
        return Err("refusing an update file with a suspicious name".into());
    }
    state.with(|s| s.pending_update = Some(name));
    Ok(())
}

/// Writes the downloaded installer to disk.
///
/// The bytes were fetched, and their SHA-256 checked against the digest GitHub
/// published, by the webview — the only part of this application with a TLS
/// stack, deliberately. This end only stores what it is given.
#[tauri::command]
pub fn update_stage(
    app: AppHandle,
    state: State<'_, AppState>,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let name = state
        .with(|s| s.pending_update.clone())
        .ok_or_else(|| "no update was announced".to_string())?;

    let tauri::ipc::InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected the installer as a raw body".into());
    };
    if bytes.is_empty() {
        return Err("the download was empty".into());
    }

    let path = update_dir(&app)?.join(&name);
    std::fs::write(&path, bytes).map_err(|e| format!("could not write {path:?}: {e}"))?;

    state.with(|s| s.pending_update = None);
    Ok(path.to_string_lossy().to_string())
}

/// Hands the installer to the operating system.
///
/// LANTern does not install anything itself. On Windows this launches the
/// setup program, which asks its own questions; on Android it opens the
/// package installer, which asks for permission and shows what is being
/// replaced. The running app then quits out of the way where it needs to.
#[tauri::command]
pub fn update_launch(app: AppHandle, path: String) -> Result<(), String> {
    // Only a file this app staged is eligible. A path from anywhere else is a
    // request to run an arbitrary program, which this command is not for.
    let staged = update_dir(&app)?;
    let target = std::path::PathBuf::from(&path);
    let ok = target
        .canonicalize()
        .ok()
        .zip(staged.canonicalize().ok())
        .map(|(t, dir)| t.starts_with(dir))
        .unwrap_or(false);
    if !ok {
        return Err("that file was not staged by the updater".into());
    }

    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(target.to_string_lossy().to_string(), None::<&str>)
        .map_err(|e| format!("could not start the installer: {e}"))
}

/// Whether this device can switch audio tracks.
///
/// The UI asks before offering the control, so a device without ffmpeg
/// explains why rather than presenting a menu that fails on selection.
#[tauri::command]
pub fn media_can_switch_audio() -> bool {
    crate::audiotrack::ffmpeg_path().is_some()
}

/* -------------------------------------------------------------- profile */

/// Stores this device's profile picture.
///
/// Held as PNG bytes and served over the same HTTP server everything else
/// goes through. It deliberately does not travel in the peer handshake: a
/// 500x500 image is a few hundred kilobytes, and the handshake is a single
/// line of JSON on a link that chat, calls and games all share.
#[tauri::command]
pub fn profile_set_avatar(app: AppHandle, state: State<'_, AppState>, png: Vec<u8>) -> Res<()> {
    // A picture that will not fit in memory twice is not a picture.
    if png.len() > 4 * 1024 * 1024 {
        return Err("that image is too large".into());
    }
    let empty = png.is_empty();
    state.with(|s| s.avatar = if empty { None } else { Some(png) });

    if let Ok(dir) = app.path().app_data_dir() {
        let file = dir.join("avatar.png");
        let saved = state.with(|s| s.avatar.clone());
        match saved {
            Some(bytes) => {
                let _ = std::fs::write(&file, bytes);
            }
            None => {
                let _ = std::fs::remove_file(&file);
            }
        }
    }

    // Peers cache by URL, so the version marker is what makes them re-fetch.
    let info = state.with(|s| s.net.clone());
    let _ = app.emit("net:changed", &info);
    Ok(())
}

/// True when this device has a picture set.
#[tauri::command]
pub fn profile_has_avatar(state: State<'_, AppState>) -> bool {
    state.with(|s| s.avatar.is_some())
}

/* ---------------------------------------------------------------- calls */

/// Forwards one WebRTC signalling message to a peer.
///
/// Deliberately opaque: offers, answers and ICE candidates are all just JSON
/// the webview produced and the far webview consumes. Rust has no reason to
/// understand SDP, and parsing it here would only add a second place for the
/// format to go out of date.
///
/// Returns false when there is no live link, so the caller can fail the call
/// immediately instead of waiting for a ring that can never be heard.
#[tauri::command]
pub fn call_signal(
    state: State<'_, AppState>,
    peer_id: String,
    payload: serde_json::Value,
) -> bool {
    let (links, me) = state.with(|s| (s.links.clone(), s.device_id.clone()));
    links.send(
        &peer_id,
        &Envelope {
            v: 1,
            from: me,
            kind: "signal".into(),
            payload,
        },
    )
}

/* -------------------------------------------------------------- hosting */

#[tauri::command]
pub fn host_list(state: State<'_, AppState>) -> Vec<Share> {
    state.with(|s| s.shares.clone())
}

#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn host_create(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    path: String,
    slug: String,
    mode: ShareMode,
    require_phrase: bool,
    allow_upload: bool,
    file_count: u64,
    total_bytes: u64,
) -> Share {
    // Trust the filesystem over the caller: the frontend's counts come from a
    // file picker, which may have been filtered or may not know the real tree.
    let scanned = shares::scan_dir(std::path::Path::new(&path));
    let real = scanned.files > 0 || scanned.bytes > 0;

    let share = Share {
        id: uid(),
        name,
        path,
        slug,
        mode,
        running: true,
        require_phrase,
        phrase: require_phrase.then(|| "copper signal quiet river".to_string()),
        allow_upload,
        file_count: if real { scanned.files } else { file_count },
        total_bytes: if real { scanned.bytes } else { total_bytes },
        created_at: now_ms(),
        requests: 0,
        bytes_served: 0,
        active_viewers: 0,
        last_request_at: None,
    };

    shares::save(&state, &share);
    let all = state.with(|s| {
        s.shares.push(share.clone());
        s.shares.clone()
    });
    let _ = app.emit("host:changed", &all);

    if share.mode == ShareMode::Media {
        let items = media::refresh(&state);
        let _ = app.emit("media:changed", &items);
    }
    share
}

#[tauri::command]
pub fn host_set_running(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    running: bool,
) -> Option<Share> {
    let (found, all) = state.with(|s| {
        let found = s.shares.iter_mut().find(|sh| sh.id == id).map(|sh| {
            sh.running = running;
            if !running {
                sh.active_viewers = 0;
            }
            sh.clone()
        });
        (found, s.shares.clone())
    });
    if let Some(sh) = found.as_ref() {
        shares::save(&state, sh);
    }
    let _ = app.emit("host:changed", &all);
    found
}

#[tauri::command]
pub fn host_update(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    patch: serde_json::Value,
) -> Option<Share> {
    let (found, all) = state.with(|s| {
        let found = s.shares.iter_mut().find(|sh| sh.id == id).map(|sh| {
            if let Some(v) = patch.get("allowUpload").and_then(|v| v.as_bool()) {
                sh.allow_upload = v;
            }
            if let Some(v) = patch.get("requirePhrase").and_then(|v| v.as_bool()) {
                sh.require_phrase = v;
            }
            if let Some(v) = patch.get("name").and_then(|v| v.as_str()) {
                sh.name = v.to_string();
            }
            sh.clone()
        });
        (found, s.shares.clone())
    });
    if let Some(sh) = found.as_ref() {
        shares::save(&state, sh);
    }
    let _ = app.emit("host:changed", &all);
    found
}

#[tauri::command]
pub fn host_remove(app: AppHandle, state: State<'_, AppState>, id: String) {
    shares::forget(&state, &id);
    let all = state.with(|s| {
        s.shares.retain(|sh| sh.id != id);
        s.shares.clone()
    });
    let _ = app.emit("host:changed", &all);
}

/// Inspects a folder before it is published, so the UI can preselect a
/// sensible serving mode and show real totals rather than the picker's guess.
#[tauri::command]
pub fn host_probe(path: String) -> serde_json::Value {
    let root = std::path::Path::new(&path);
    let stats = shares::scan_dir(root);
    let has_index = root.join("index.html").is_file();
    let videos = shares::count_videos(root);

    serde_json::json!({
        "exists": root.is_dir(),
        "fileCount": stats.files,
        "totalBytes": stats.bytes,
        "hasIndexHtml": has_index,
        "videoCount": videos,
    })
}

/// Rescans a share's folder on demand.
#[tauri::command]
pub fn host_rescan(app: AppHandle, state: State<'_, AppState>, id: String) {
    shares::refresh(&app, &state, &id);
}

#[tauri::command]
pub fn host_open(app: AppHandle, url: String) {
    use tauri_plugin_opener::OpenerExt;
    let _ = app.opener().open_url(url, None::<&str>);
}

/* ----------------------------------------------------------------- games */

#[tauri::command]
pub fn game_start(
    app: AppHandle,
    state: State<'_, AppState>,
    game: String,
    peer_ids: Vec<String>,
    seed: u64,
) -> GameSession {
    let mut players = vec!["me".to_string()];
    players.extend(peer_ids);

    let session = GameSession {
        id: uid(),
        game,
        seed,
        host_id: "me".into(),
        players,
        started_at: now_ms(),
        progress: std::collections::HashMap::new(),
        winner_id: None,
    };
    state.with(|s| s.session = Some(session.clone()));

    let (links, me) = state.with(|s| (s.links.clone(), s.device_id.clone()));
    links.broadcast(&Envelope {
        v: 1,
        from: me,
        kind: "game".into(),
        payload: serde_json::to_value(&session).unwrap_or_default(),
    });

    let _ = app.emit("game:session", &session);
    session
}

/// Records this player's progress and reports the race back.
#[tauri::command]
pub fn game_report(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    completion: f64,
    moves: u32,
    elapsed_ms: u64,
    finished: bool,
) -> Option<GameSession> {
    let updated = state.with(|s| {
        let Some(session) = s.session.as_mut() else {
            return None;
        };
        if session.id != session_id {
            return None;
        }
        session.progress.insert(
            "me".into(),
            GameProgress {
                peer_id: "me".into(),
                completion,
                moves,
                elapsed_ms,
                finished,
                finished_at: finished.then(now_ms),
            },
        );
        // First past the post takes it.
        if finished && session.winner_id.is_none() {
            session.winner_id = Some("me".into());
        }
        Some(session.clone())
    });

    if let Some(session) = updated.as_ref() {
        let (links, me) = state.with(|s| (s.links.clone(), s.device_id.clone()));
        links.broadcast(&Envelope {
            v: 1,
            from: me,
            kind: "game".into(),
            payload: serde_json::to_value(session).unwrap_or_default(),
        });
        let _ = app.emit("game:session", session);
    }
    updated
}

#[tauri::command]
pub fn game_leave(app: AppHandle, state: State<'_, AppState>, session_id: String) {
    let cleared = state.with(|s| {
        if s.session.as_ref().map(|x| x.id == session_id).unwrap_or(false) {
            s.session = None;
            true
        } else {
            false
        }
    });
    if cleared {
        let _ = app.emit("game:session", serde_json::Value::Null);
    }
}

/* ----------------------------------------------------------------- party */

#[tauri::command]
pub fn party_start(
    app: AppHandle,
    state: State<'_, AppState>,
    item_id: String,
    member_ids: Vec<String>,
) -> WatchParty {
    let party = WatchParty {
        id: uid(),
        item_id,
        host_id: "me".into(),
        members: member_ids,
        playing: true,
        position_sec: 0.0,
        updated_at: now_ms(),
    };
    state.with(|s| s.party = Some(party.clone()));

    let (links, me) = state.with(|s| (s.links.clone(), s.device_id.clone()));
    links.broadcast(&Envelope {
        v: 1,
        from: me,
        kind: "party".into(),
        payload: serde_json::to_value(&party).unwrap_or_default(),
    });

    let _ = app.emit("party:changed", &party);
    party
}

/// Broadcasts the host's transport state to everyone following along.
#[tauri::command]
pub fn party_sync(
    app: AppHandle,
    state: State<'_, AppState>,
    party_id: String,
    playing: bool,
    position_sec: f64,
) {
    let updated = state.with(|s| {
        let Some(p) = s.party.as_mut() else { return None };
        if p.id != party_id {
            return None;
        }
        p.playing = playing;
        p.position_sec = position_sec;
        p.updated_at = now_ms();
        Some(p.clone())
    });
    if let Some(p) = updated {
        // Tell the followers, then reflect it locally.
        let (links, me) = state.with(|s| (s.links.clone(), s.device_id.clone()));
        links.broadcast(&Envelope {
            v: 1,
            from: me,
            kind: "party".into(),
            payload: serde_json::to_value(&p).unwrap_or_default(),
        });
        let _ = app.emit("party:changed", &p);
    }
}

#[tauri::command]
pub fn party_leave(app: AppHandle, state: State<'_, AppState>, party_id: String) {
    let cleared = state.with(|s| {
        if s.party.as_ref().map(|p| p.id == party_id).unwrap_or(false) {
            s.party = None;
            true
        } else {
            false
        }
    });
    if cleared {
        let _ = app.emit("party:changed", serde_json::Value::Null);
    }
}

/* ---------------------------------------------------------------- tray */

#[tauri::command]
pub fn tray_supported() -> bool {
    #[cfg(desktop)]
    {
        crate::tray::TRAY_IS_NATIVE
    }
    #[cfg(not(desktop))]
    {
        false
    }
}

#[tauri::command]
pub fn window_hide_to_tray(_app: AppHandle) {
    #[cfg(desktop)]
    {
        if !crate::tray::TRAY_IS_NATIVE {
            return;
        }
        if let Some(w) = _app.get_webview_window("main") {
            let _ = w.hide();
        }
    }
}

#[tauri::command]
pub fn window_show(_app: AppHandle) {
    #[cfg(desktop)]
    crate::tray::restore(&_app);
}

#[tauri::command]
pub fn autostart_get(_app: AppHandle) -> bool {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        _app.autolaunch().is_enabled().unwrap_or(false)
    }
    // A phone has no login-item concept; the toggle reports off and stays off.
    #[cfg(not(desktop))]
    {
        false
    }
}

#[tauri::command]
pub fn autostart_set(_app: AppHandle, _enabled: bool) -> Res<bool> {
    #[cfg(desktop)]
    {
        use tauri_plugin_autostart::ManagerExt;
        let manager = _app.autolaunch();
        let result = if _enabled {
            manager.enable()
        } else {
            manager.disable()
        };
        result.map_err(|e| e.to_string())?;
        Ok(manager.is_enabled().unwrap_or(_enabled))
    }
    #[cfg(not(desktop))]
    {
        Ok(false)
    }
}

/* ------------------------------------------------------------- theatre */

#[tauri::command]
pub fn media_list(state: State<'_, AppState>) -> Vec<serde_json::Value> {
    let cached = state.with(|s| s.media.clone());
    if cached.is_empty() {
        // Nothing scanned yet this session — build it now so a freshly opened
        // Theatre is never empty when shares exist.
        media::refresh(&state)
    } else {
        cached
    }
}

/// Re-reads every media share on the network and rebuilds the library.
///
/// "On the network" was aspirational until now: this rebuilt only local
/// shares, so Theatre showed nothing on a device that published nothing, no
/// matter what its peers were sharing.
#[tauri::command]
pub async fn media_scan(app: AppHandle, state: State<'_, AppState>) -> Res<Vec<serde_json::Value>> {
    crate::library::refresh_all(app, (*state).clone()).await;
    Ok(state.with(|s| s.media.clone()))
}

#[tauri::command]
pub fn media_set_progress(state: State<'_, AppState>, id: String, progress_sec: f64) {
    let duration = state.with(|s| {
        let mut duration = 0.0;
        for item in s.media.iter_mut() {
            if item.get("id").and_then(|v| v.as_str()) == Some(id.as_str()) {
                duration = item
                    .get("durationSec")
                    .and_then(|v| v.as_f64())
                    .unwrap_or(0.0);
                if let Some(obj) = item.as_object_mut() {
                    obj.insert("progressSec".into(), serde_json::Value::from(progress_sec));
                }
            }
        }
        duration
    });

    // Written through to the database, not just held in memory. Losing your
    // place on restart is the difference between "Continue watching" being a
    // feature and being an empty row.
    media::save_progress(&state, &id, progress_sec, duration);
}
