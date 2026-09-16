//! Peer-to-peer transport.
//!
//! Every device runs a listener and also dials the peers it discovers, so a
//! link exists as soon as either side notices the other. That matters across a
//! NAT: the side that can reach out establishes the session, and both
//! directions then ride it.
//!
//! Framing is newline-delimited JSON over plain TCP. Both ends are LANTern, so
//! a WebSocket handshake would buy nothing and cost a dependency; NDJSON is
//! trivially debuggable with netcat and impossible to get subtly wrong.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

use crate::state::AppState;

/// Internal envelope kind: a link came up. Never travels over the wire — it
/// is produced locally and consumed by the delivery task.
const LINKED: &str = "__linked";

/// Bumped only for changes older builds could not parse.
const PROTOCOL_VERSION: u8 = 1;

/// A keepalive, and the gap between them.
///
/// Its only job is to give the writer something to fail on. A link that
/// carries no traffic cannot discover that it has died, and these links are
/// quiet most of the time - nobody is messaging at three in the morning, which
/// is exactly when the Wi-Fi drops.
const PING: &str = "ping";
const HEARTBEAT: std::time::Duration = std::time::Duration::from_secs(15);

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    pub v: u8,
    /// Device id of the sender.
    pub from: String,
    /// "hello", "chat", "typing", "party", "game", "signal".
    pub kind: String,
    #[serde(default)]
    pub payload: serde_json::Value,
}

/// One registered link: a send channel plus the generation that owns it.
type Slot = (u64, mpsc::UnboundedSender<String>);

/// Open links, keyed by the peer's device id.
///
/// Each registration carries a generation number. Two links to the same peer
/// can exist briefly — both ends dial, so both ends accept — and the second
/// registration replaces the first. Teardown therefore has to prove it still
/// owns the slot before clearing it, or the losing link's cleanup silently
/// evicts the winner and the peer goes quiet while still looking connected.
#[derive(Clone, Default)]
pub struct Links {
    map: Arc<Mutex<HashMap<String, Slot>>>,
    next: Arc<AtomicU64>,
}

impl Links {
    /// Registers a link unconditionally, returning its generation.
    ///
    /// Only the tests use this; production goes through `claim`, which will
    /// not evict a link that won the simultaneous-dial race.
    #[cfg(test)]
    pub fn insert(&self, device_id: String, tx: mpsc::UnboundedSender<String>) -> u64 {
        let generation = self.next.fetch_add(1, Ordering::Relaxed);
        self.map
            .lock()
            .expect("links poisoned")
            .insert(device_id, (generation, tx));
        generation
    }

    /// Registers a link, replacing whatever held the slot.
    ///
    /// Checking `has` and then inserting cannot work: they take the lock
    /// twice, and between them the other direction can register. One lock,
    /// one decision.
    ///
    /// The newest connection always wins, and that is the whole rule. There
    /// used to be a second one - keep the link dialled by the lower device id,
    /// refuse the other - and it made calls and messages travel in one
    /// direction only.
    ///
    /// Two ids decide it: with `8f5df0eb…` calling `d3f05c7c…`, the dialler
    /// computes `me < peer` and the accepter computes `me > peer`, and for a
    /// link dialled by the *higher* id both come out false. Neither end is
    /// preferred, so whichever one already held an entry - a live link, or a
    /// dead one nothing had cleared - refused the connection and dropped it,
    /// while the other end accepted it. One end was then registered on a
    /// socket the other had just closed, and everything it sent went nowhere.
    /// A stale entry could wedge that direction permanently.
    ///
    /// Preferring one link was never needed for delivery. Both ends pump
    /// every connection they hold, so a receiver reads whichever socket the
    /// sender writes to, no matter which one it registered for its own
    /// traffic. The rule only ever avoided a duplicate connection, and it cost
    /// far more than it saved.
    ///
    /// Replacing freely is safe because teardown is generation-guarded: the
    /// link that has just been replaced cannot evict its replacement on the
    /// way out, and `reconcile` does not dial a peer that already has a link,
    /// so this does not churn.
    pub fn claim(
        &self,
        device_id: &str,
        tx: mpsc::UnboundedSender<String>,
        inbound: bool,
    ) -> Option<u64> {
        let mut map = self.map.lock().expect("links poisoned");
        if !inbound && map.contains_key(device_id) {
            // Something already carries traffic to them, and it was opened
            // from their side. Leave it be and read this one anyway.
            return None;
        }
        let generation = self.next.fetch_add(1, Ordering::Relaxed);
        map.insert(device_id.to_string(), (generation, tx));
        Some(generation)
    }

    /// Clears a link only if `generation` is still the registered one.
    pub fn remove(&self, device_id: &str, generation: u64) {
        let mut map = self.map.lock().expect("links poisoned");
        if map.get(device_id).is_some_and(|(g, _)| *g == generation) {
            map.remove(device_id);
        }
    }

    /// Closes a link outright, whatever generation it is on.
    ///
    /// Dropping the sender ends the pump on the other side of the channel,
    /// which closes the socket. Used when a device is blocked: a block that
    /// only applied to the next connection would leave the current one live.
    pub fn drop_link(&self, device_id: &str) {
        self.map.lock().expect("links poisoned").remove(device_id);
    }

    pub fn has(&self, device_id: &str) -> bool {
        self.map.lock().expect("links poisoned").contains_key(device_id)
    }

    pub fn connected(&self) -> Vec<String> {
        self.map.lock().expect("links poisoned").keys().cloned().collect()
    }

    /// Sends to one peer. False when there is no live link.
    pub fn send(&self, device_id: &str, envelope: &Envelope) -> bool {
        let Ok(line) = serde_json::to_string(envelope) else {
            return false;
        };
        let map = self.map.lock().expect("links poisoned");
        match map.get(device_id) {
            Some((_, tx)) => tx.send(line).is_ok(),
            None => false,
        }
    }

    /// Sends to every connected peer, returning how many received it.
    pub fn broadcast(&self, envelope: &Envelope) -> usize {
        let Ok(line) = serde_json::to_string(envelope) else {
            return 0;
        };
        let map = self.map.lock().expect("links poisoned");
        map.values().filter(|(_, tx)| tx.send(line.clone()).is_ok()).count()
    }
}

/// Accepts inbound peer connections for the lifetime of the process.
pub async fn serve(app: AppHandle, state: AppState, links: Links, port: u16) -> std::io::Result<()> {
    let listener = TcpListener::bind(("0.0.0.0", port)).await?;
    let inbound = spawn_delivery(app, state.clone());

    loop {
        let Ok((stream, addr)) = listener.accept().await else {
            continue;
        };
        let state = state.clone();
        let links = links.clone();
        let inbound = inbound.clone();
        tokio::spawn(async move {
            if let Err(e) = handle(state, links, stream, false, inbound).await {
                eprintln!("peer link from {addr} ended: {e}");
            }
        });
    }
}

/// Drains received envelopes onto the frontend event bus.
///
/// Keeping this out of the link loop is what lets the loop be tested without a
/// running Tauri application.
fn spawn_delivery(app: AppHandle, state: AppState) -> mpsc::UnboundedSender<Envelope> {
    let (tx, mut rx) = mpsc::unbounded_channel::<Envelope>();
    tokio::spawn(async move {
        while let Some(envelope) = rx.recv().await {
            // File envelopes carry bookkeeping, not just a UI event: the
            // offer has to become a transfer record before the frontend can
            // accept it, and that record is what holds the source URL.
            if envelope.kind == LINKED {
                register_peer(&app, &state, &envelope);
                continue;
            }
            if envelope.kind == "file" {
                if let Some(offer) = envelope.payload.get("offer") {
                    if let Ok(offer) = serde_json::from_value(offer.clone()) {
                        crate::transfers::record_offer(&app, &state, &envelope.from, offer);
                        continue;
                    }
                }
                if let Some(control) = envelope.payload.get("control") {
                    if let Ok(control) = serde_json::from_value(control.clone()) {
                        crate::transfers::apply_control(&app, &state, control);
                        continue;
                    }
                }
                continue;
            }

            // Input from a device driving this one. Applied here rather than
            // handed to the window: the window is not what is being
            // controlled, and routing it through the frontend would mean
            // input stopped arriving whenever the app was minimised - which
            // is exactly when somebody is driving it from another room.
            // The key a peer issues us, to present when reading their library.
            if envelope.kind == "key" {
                if let Some(key) = envelope.payload.get("key").and_then(|v| v.as_str()) {
                    let from = envelope.from.clone();
                    let key = key.to_string();
                    state.with(|s| s.held_keys.insert(from, key));
                }
                continue;
            }

            if envelope.kind == "input" {
                #[cfg(target_os = "windows")]
                {
                    let events: Vec<crate::input::RemoteEvent> = envelope
                        .payload
                        .get("events")
                        .and_then(|v| serde_json::from_value(v.clone()).ok())
                        .unwrap_or_default();
                    crate::commands::control_apply(&state, &envelope.from, events);
                }
                continue;
            }

            // A request to take control, or an answer to one. The decision is
            // made here so that a whitelisted device is granted even while
            // nothing is on screen to ask.
            if envelope.kind == "control" {
                handle_control(&app, &state, &envelope);
                continue;
            }

            // Being dealt into a game is what gives this device a session.
            //
            // Only the host ran `game_start`, so only the host had one - and
            // `game_move` refuses to send for a session it does not hold. So
            // every guest's move was dropped here, at the last step before the
            // wire, in every game: moves travelled from the host and never
            // back. Writing it down on arrival is what makes the guest a
            // player rather than an audience.
            if envelope.kind == "game" {
                if let Ok(mut session) =
                    serde_json::from_value::<crate::model::GameSession>(envelope.payload.clone())
                {
                    // The host wrote itself down as "me", which means the host
                    // where it was written and this device everywhere else.
                    // Spelling it out here keeps the host-only checks honest:
                    // `game_lobby` refuses anyone whose session does not say
                    // "me", and a guest holding the host's word for it would
                    // have been able to drive the table.
                    if session.host_id == "me" {
                        session.host_id = envelope.from.clone();
                    }
                    for seat in session.players.iter_mut() {
                        if seat == "me" {
                            *seat = envelope.from.clone();
                        }
                    }
                    state.with(|s| s.session = Some(session));
                }
            }

            deliver(&app, &envelope);
        }
    });
    tx
}

/// Records a peer we have an open link to.
///
/// Discovery normally does this, but discovery is mDNS and mDNS is multicast:
/// it is routinely filtered, rate-limited or simply missed. A live link is
/// stronger evidence that a peer exists than any announcement, so it is
/// treated as such. An existing entry is refreshed rather than replaced, so
/// this never discards richer detail mDNS already provided.
fn register_peer(app: &AppHandle, state: &AppState, envelope: &Envelope) {
    let peer_id = envelope.from.clone();
    let name = envelope
        .payload
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Peer")
        .to_string();
    let address = envelope
        .payload
        .get("address")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();
    let local_address = envelope
        .payload
        .get("localAddress")
        .and_then(|v| v.as_str())
        .unwrap_or_default()
        .to_string();

    let (peer, is_new) = state.with(|s| {
        let port = s.net.port;
        match s.peers.get_mut(&peer_id) {
            Some(existing) => {
                existing.last_seen = crate::model::now_ms();
                existing.status = crate::model::PeerStatus::Available;
                if !address.is_empty() && !existing.addresses.contains(&address) {
                    existing.addresses.push(address.clone());
                }
                // Always the newest link's answer: the route can change under
                // us, and a stale one is worse than none.
                if !local_address.is_empty() {
                    existing.local_address = local_address.clone();
                }
                (existing.clone(), false)
            }
            None => {
                let peer = crate::model::Peer {
                    id: peer_id.clone(),
                    device_id: peer_id.clone(),
                    device_name: name.clone(),
                    name,
                    color: String::from("#F5A623"),
                    emoji: String::from("🏮"),
                    os: String::new(),
                    ip: address.clone(),
                    addresses: if address.is_empty() {
                        Vec::new()
                    } else {
                        vec![address.clone()]
                    },
                    port,
                    layer: crate::model::ConnLayer::Direct,
                    // Not measured yet. Zero would be rendered as a real reading of
                    // 0.0 ms, which is both impossible over a network and
                    // indistinguishable from a working measurement.
                    latency_ms: -1.0,
                    loss_pct: 0.0,
                    status: crate::model::PeerStatus::Available,
                    status_message: None,
                    last_seen: crate::model::now_ms(),
                    trusted: s.trusted.contains(&peer_id),
                    scope: crate::model::PeerScope::Local,
                    initiated_by: crate::model::Initiator::Them,
                    local_address: local_address.clone(),
                };
                s.peers.insert(peer_id.clone(), peer.clone());
                (peer, true)
            }
        }
    });

    let _ = app.emit(if is_new { "peer:joined" } else { "peer:updated" }, &peer);

    // Hand them a key over this link, which is authenticated, so that their
    // ordinary HTTP requests to our server can be attributed to them. Without
    // it the server cannot tell one peer from another, and an age restriction
    // it cannot attribute is one it cannot enforce.
    //
    // Minted fresh on every link rather than kept: a key that outlives the
    // connection is a key that outlives the device being on the network.
    {
        let key = uuid::Uuid::new_v4().simple().to_string();
        let (links, me) = state.with(|s| {
            s.issued_keys.insert(peer_id.clone(), key.clone());
            (s.links.clone(), s.device_id.clone())
        });
        links.send(
            &peer_id,
            &Envelope {
                v: 1,
                from: me,
                kind: "key".into(),
                payload: serde_json::json!({ "key": key }),
            },
        );
    }

    // A peer we can reach is a library we can read. Theatre showed only local
    // titles until something asked.
    crate::library::spawn_refresh(app, state);

    // Time the link now that there is one, rather than leaving the card
    // showing a placeholder until somebody presses ping. One handshake against
    // a peer that just spoke to us costs nothing.
    {
        let app = app.clone();
        let state = state.clone();
        let peer_id = envelope.from.clone();
        tauri::async_runtime::spawn(async move {
            let target = state.with(|s| {
                s.peers
                    .get(&peer_id)
                    .map(|p| (p.ip.clone(), p.port))
                    .filter(|(ip, port)| !ip.is_empty() && *port != 0)
            });
            let Some((ip, port)) = target else { return };

            let timeout = std::time::Duration::from_millis(1200);
            let Some(ms) = crate::net::probe_tcp(&ip, port, timeout).await else {
                return;
            };

            let peers = state.with(|s| {
                if let Some(p) = s.peers.get_mut(&peer_id) {
                    p.latency_ms = ms;
                }
                s.peers.values().cloned().collect::<Vec<_>>()
            });
            let _ = app.emit("peers:changed", &peers);
        });
    }
}

/// Dials a peer we have discovered but are not yet linked to.
pub async fn dial(
    app: AppHandle,
    state: AppState,
    links: Links,
    address: String,
    port: u16,
) -> std::io::Result<()> {
    let stream = tokio::time::timeout(
        std::time::Duration::from_secs(4),
        TcpStream::connect((address.as_str(), port)),
    )
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "dial timed out"))??;

    let inbound = spawn_delivery(app, state.clone());
    handle(state, links, stream, true, inbound).await
}

/// Runs one link: handshake, then pump messages until it closes.
async fn handle(
    state: AppState,
    links: Links,
    stream: TcpStream,
    we_dialled: bool,
    inbound: mpsc::UnboundedSender<Envelope>,
) -> std::io::Result<()> {
    let _ = stream.set_nodelay(true);
    let address = stream
        .peer_addr()
        .map(|a| a.ip().to_string())
        .unwrap_or_default();
    // Which of our addresses the routing table actually used to reach them.
    // Guessing this from the interface list is exactly what cannot be done
    // when two of them share a network's addresses.
    let local_address = stream
        .local_addr()
        .map(|a| a.ip().to_string())
        .unwrap_or_default();
    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half).lines();

    let (me, my_name) = state.with(|s| (s.device_id.clone(), s.instance.clone()));

    // The dialler speaks first; the listener answers. Doing it in a fixed order
    // avoids both sides waiting on each other.
    let hello = Envelope {
        v: PROTOCOL_VERSION,
        from: me.clone(),
        kind: "hello".into(),
        payload: serde_json::json!({ "name": my_name }),
    };
    if we_dialled {
        write_half
            .write_all(format!("{}\n", serde_json::to_string(&hello).unwrap()).as_bytes())
            .await?;
    }

    // Identify the other end before trusting anything it sends.
    let Some(first) = reader.next_line().await? else {
        return Ok(());
    };
    let Ok(peer_hello) = serde_json::from_str::<Envelope>(&first) else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "peer did not open with a hello",
        ));
    };
    if peer_hello.kind != "hello" || peer_hello.from.is_empty() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "malformed hello",
        ));
    }
    let peer_id = peer_hello.from.clone();
    let peer_name = peer_hello
        .payload
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("Peer")
        .to_string();

    // Our own advertisement can come back to us on a multi-homed host.
    if peer_id == me {
        return Ok(());
    }

    // A blocked device gets nothing. This is the narrowest point every other
    // feature passes through — chat, calls, file offers and library requests
    // all ride this link — so refusing here refuses all of them at once,
    // rather than each screen having to remember to check.
    if state.with(|s| s.blocked.contains(&peer_id)) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            "device is blocked",
        ));
    }

    if !we_dialled {
        write_half
            .write_all(format!("{}\n", serde_json::to_string(&hello).unwrap()).as_bytes())
            .await?;
    }

    // Both sides dial, so one peer can produce two links, and the one *they*
    // opened is the one to send over. It proves they can reach us and were
    // alive a moment ago; dialling out proves only that a socket opened.
    //
    // A connection that does not take the slot is still read to the end, so
    // they can reach us over it either way. Dropping it is what used to wedge
    // a direction permanently.
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let claim = links.claim(&peer_id, tx, !we_dialled);
    // A generation nothing can match, so the guarded removal below is a no-op
    // for a connection that never held the slot.
    let generation = claim.unwrap_or(u64::MAX);

    // A peer we are talking to is a peer we know about, whether or not mDNS
    // ever found it. Multicast is unreliable in exactly the conditions this
    // app is built for — a phone that misses announcements still has a
    // perfectly good TCP link, and should not show an empty network.
    //
    // Routed through the delivery channel rather than done here: that task
    // holds both the app handle and the state, and keeping this function free
    // of Tauri is what lets the link loop be tested without an application.
    let _ = inbound.send(Envelope {
        v: PROTOCOL_VERSION,
        from: peer_id.clone(),
        kind: LINKED.into(),
        payload: serde_json::json!({
            "name": peer_name,
            "address": address,
            "localAddress": local_address,
        }),
    });

    // A socket can die without either end being told - a Wi-Fi adapter that
    // drops, an address that moves - and TCP leaves that half-open. The reader
    // below then never returns, so the cleanup after it never runs, so the
    // sender stays in the table and `send` keeps reporting success into a
    // channel nobody drains. That is a peer that looks connected while every
    // message vanishes, and it never recovers, because `reconcile` skips any
    // peer that already has a link.
    //
    // So the writer deregisters the moment a write fails, which is what lets
    // the link be dialled again. Generation-guarded: a write failing on a
    // socket that has already been replaced must not evict its replacement.
    let writer = {
        let links = links.clone();
        let peer_id = peer_id.clone();
        tokio::spawn(async move {
            while let Some(line) = rx.recv().await {
                if write_half
                    .write_all(format!("{line}
").as_bytes())
                    .await
                    .is_err()
                {
                    links.remove(&peer_id, generation);
                    break;
                }
            }
        })
    };

    // And something to fail on while the link is idle.
    //
    // Nothing is ever torn down for *not receiving* these. An older peer does
    // not send them, and dropping a working link because the far side is an
    // earlier version would be a worse fault than the one this fixes.
    let heartbeat = {
        let links = links.clone();
        let peer_id = peer_id.clone();
        let me = me.clone();
        let carries_traffic = claim.is_some();
        tokio::spawn(async move {
            // Only the link that holds the slot needs proving; the other one
            // is read-only and has nothing to fail on.
            if !carries_traffic {
                return;
            }
            loop {
                tokio::time::sleep(HEARTBEAT).await;
                let still_linked = links.send(
                    &peer_id,
                    &Envelope {
                        v: PROTOCOL_VERSION,
                        from: me.clone(),
                        kind: PING.into(),
                        payload: serde_json::Value::Null,
                    },
                );
                if !still_linked {
                    break;
                }
            }
        })
    };

    // Read until the link ends, then always deregister it. Propagating the
    // read error directly with `?` used to skip the cleanup below, which left
    // a dead sender in the table: `send` reported success, the bytes went to a
    // channel nobody was draining, and the peer looked connected while every
    // message silently disappeared.
    let outcome = pump(&mut reader, &peer_id, &inbound).await;

    links.remove(&peer_id, generation);
    heartbeat.abort();
    writer.abort();
    outcome
}

/// Reads envelopes off one link until it closes or errors.
async fn pump(
    reader: &mut tokio::io::Lines<BufReader<tokio::net::tcp::OwnedReadHalf>>,
    peer_id: &str,
    inbound: &mpsc::UnboundedSender<Envelope>,
) -> std::io::Result<()> {
    while let Some(line) = reader.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(envelope) = serde_json::from_str::<Envelope>(&line) else {
            continue;
        };
        // A keepalive has arrived, and did its job by arriving.
        if envelope.kind == PING {
            continue;
        }
        // A peer may only speak for itself.
        if envelope.from != peer_id {
            continue;
        }
        if inbound.send(envelope).is_err() {
            break;
        }
    }
    Ok(())
}

/// One side of the control handshake.
///
/// The asking device sends `ask`; this machine either grants it outright,
/// because it is on the always-allow list, or puts the question on screen.
/// The answer comes back as `granted` or `denied`, and either side can send
/// `ended`.
fn handle_control(app: &AppHandle, state: &crate::state::AppState, envelope: &Envelope) {
    use crate::input::Request;

    let op = envelope.payload.get("op").and_then(|v| v.as_str()).unwrap_or("");
    let from = envelope.from.clone();

    match op {
        "ask" => {
            // A blocked device may not even raise a dialog. Being asked
            // repeatedly is itself a way to make somebody press yes.
            if state.with(|s| s.blocked.contains(&from)) {
                return;
            }
            let decision = state.with(|s| s.control.request(&from));
            match decision {
                Request::Granted => {
                    // Granted without asking, because this device is on the
                    // always-allow list. The secret for the screen goes with
                    // it, exactly as it does when somebody presses the button.
                    let (links, me, token, port) = state.with(|s| {
                        (
                            s.links.clone(),
                            s.device_id.clone(),
                            s.control.token().to_string(),
                            s.net.host_port,
                        )
                    });
                    links.send(
                        &from,
                        &Envelope {
                            v: 1,
                            from: me,
                            kind: "control".into(),
                            payload: serde_json::json!({
                                "op": "granted", "token": token, "port": port,
                            }),
                        },
                    );
                }
                Request::Busy => {
                    let (links, me) = state.with(|s| (s.links.clone(), s.device_id.clone()));
                    links.send(
                        &from,
                        &Envelope {
                            v: 1,
                            from: me,
                            kind: "control".into(),
                            payload: serde_json::json!({ "op": "busy" }),
                        },
                    );
                }
                Request::Ask => {}
            }
        }
        "ended" => {
            state.with(|s| {
                s.control.drop_peer(&from);
                #[cfg(target_os = "windows")]
                {
                    if let Some(injector) = s.injector.as_mut() {
                        injector.release_all();
                    }
                    s.injector = None;
                }
            });
        }
        _ => {}
    }

    // The controlling side needs to hear the answer, and this side needs to
    // redraw whatever it is showing about the session.
    let mut payload = envelope.payload.clone();
    if let Some(object) = payload.as_object_mut() {
        object.insert("from".into(), serde_json::Value::String(from));
    }
    let _ = app.emit("control:message", payload);
    let _ = app.emit("control:changed", crate::commands::control_status_of(state));
}

/// Turns a received envelope into the frontend event it corresponds to.
fn deliver(app: &AppHandle, envelope: &Envelope) {
    let event = match envelope.kind.as_str() {
        "chat" => "message:received",
        "typing" => "typing",
        "party" => "party:changed",
        "game" => "game:session",
        "gamemove" => "game:move",
        "gamestate" => "game:state",
        "gameintent" => "game:intent",
        "gamelobby" => "game:lobby",
        "signal" => "call:state",
        _ => return,
    };

    // Stamp the sender onto the payload. Room, call and party ids are minted
    // locally on whichever device created them, so they mean nothing to the
    // receiver on their own — what the far side can always act on is *who*
    // sent this. Without it an inbound message cannot be attributed to a peer
    // or routed to the right conversation.
    let mut payload = envelope.payload.clone();
    match payload.as_object_mut() {
        Some(fields) => {
            fields.insert("from".into(), serde_json::Value::String(envelope.from.clone()));
        }
        None => {
            payload = serde_json::json!({ "from": envelope.from, "payload": payload });
        }
    }
    let _ = app.emit(event, &payload);
}

/// Keeps links up: dials any known peer we are not connected to.
///
/// Running continuously rather than only on discovery means a link that drops —
/// a sleeping laptop, a flaky switch — comes back on its own.
pub fn reconcile(app: AppHandle, state: AppState, links: Links) {
    tauri::async_runtime::spawn(async move {
        loop {
            let (peers, port) = state.with(|s| {
                (
                    s.peers
                        .values()
                        .map(|p| (p.device_id.clone(), p.addresses.clone(), p.port))
                        .collect::<Vec<_>>(),
                    s.net.port,
                )
            });

            for (device_id, addresses, peer_port) in peers {
                if device_id.is_empty() || links.has(&device_id) {
                    continue;
                }
                // Try each address the peer advertises; one may be on a network
                // we cannot reach.
                for address in addresses {
                    if links.has(&device_id) {
                        break;
                    }
                    let app = app.clone();
                    let state = state.clone();
                    let links = links.clone();
                    let _ = dial(app, state, links, address, peer_port.max(port)).await;
                }
            }

            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    /// Being dealt into a game, from the guest's side.
    ///
    /// `game_move` refuses to send for a session the native layer does not
    /// hold, and only the host ever ran `game_start` - so every guest's move
    /// was dropped one step before the wire, in every game. Moves travelled
    /// out from the host and never came back.
    mod dealt_in {
        use crate::model::GameSession;

        /// What the dispatch does with an inbound `game` envelope, in the one
        /// respect that matters: whose table it says this is.
        fn qualify(mut session: GameSession, from: &str) -> GameSession {
            if session.host_id == "me" {
                session.host_id = from.to_string();
            }
            for seat in session.players.iter_mut() {
                if seat == "me" {
                    *seat = from.to_string();
                }
            }
            session
        }

        fn dealt_by(host: &str, guest: &str) -> GameSession {
            // Exactly what the host puts on the wire: itself as "me".
            let announced = GameSession {
                id: "s1".into(),
                game: "chess".into(),
                seed: 7,
                host_id: "me".into(),
                players: vec!["me".into(), guest.into()],
                started_at: 0,
                progress: std::collections::HashMap::new(),
                winner_id: None,
                waiting: Vec::new(),
                next_game: None,
            };
            qualify(announced, host)
        }

        #[test]
        fn the_guest_ends_up_holding_the_same_session_id() {
            let session = dealt_by("host-device", "guest-device");
            // Which is all `game_move` compares, and all it needed.
            assert_eq!(session.id, "s1");
        }

        /// The host-only gate reads `host_id == "me"`. A guest that stored the
        /// host's word for it verbatim would have passed that gate and been
        /// able to drive the table.
        #[test]
        fn but_does_not_come_to_believe_it_is_the_host() {
            let session = dealt_by("host-device", "guest-device");
            assert_ne!(session.host_id, "me");
            assert_eq!(session.host_id, "host-device");
        }

        #[test]
        fn and_the_seats_name_real_devices() {
            let session = dealt_by("host-device", "guest-device");
            assert_eq!(session.players, vec!["host-device", "guest-device"]);
            assert!(!session.players.iter().any(|p| p == "me"));
        }
    }

    /// Reads the next envelope a peer actually sent.
    ///
    /// The delivery channel also carries `__linked`, produced locally when a
    /// link comes up so the peer can be registered. It is not traffic, and a
    /// test asserting on "the first envelope" would otherwise be asserting on
    /// LANTern talking to itself.
    async fn next_from_peer(
        rx: &mut mpsc::UnboundedReceiver<Envelope>,
    ) -> Envelope {
        loop {
            let envelope = tokio::time::timeout(std::time::Duration::from_secs(2), rx.recv())
                .await
                .expect("timed out waiting for an envelope")
                .expect("channel closed");
            if envelope.kind != LINKED {
                return envelope;
            }
        }
    }

    use super::*;

    /// Builds a state with a known identity.
    fn node(device_id: &str) -> AppState {
        let state = AppState::new();
        state.with(|s| {
            s.device_id = device_id.to_string();
            s.instance = device_id.to_string();
        });
        state
    }

    /// Two real nodes over a real socket: handshake, then a message each way.
    #[tokio::test]
    async fn two_nodes_link_and_exchange_messages() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let server_state = node("device-server");
        let server_links = Links::default();
        let (server_tx, mut server_rx) = mpsc::unbounded_channel::<Envelope>();

        {
            let state = server_state.clone();
            let links = server_links.clone();
            tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let _ = handle(state, links, stream, false, server_tx).await;
            });
        }

        let client_state = node("device-client");
        let client_links = Links::default();
        let (client_tx, mut client_rx) = mpsc::unbounded_channel::<Envelope>();

        {
            let state = client_state.clone();
            let links = client_links.clone();
            tokio::spawn(async move {
                let stream = TcpStream::connect(addr).await.unwrap();
                let _ = handle(state, links, stream, true, client_tx).await;
            });
        }

        // Give the handshake a moment to complete on both ends.
        for _ in 0..50 {
            if client_links.has("device-server") && server_links.has("device-client") {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        assert!(client_links.has("device-server"), "client never linked");
        assert!(server_links.has("device-client"), "server never linked");

        // Client to server.
        assert!(client_links.send(
            "device-server",
            &Envelope {
                v: PROTOCOL_VERSION,
                from: "device-client".into(),
                kind: "chat".into(),
                payload: serde_json::json!({ "body": "from the client" }),
            }
        ));
        let got = next_from_peer(&mut server_rx).await;
        assert_eq!(got.from, "device-client");
        assert_eq!(got.payload["body"], "from the client");

        // Server back to client, over the same link.
        assert!(server_links.send(
            "device-client",
            &Envelope {
                v: PROTOCOL_VERSION,
                from: "device-server".into(),
                kind: "chat".into(),
                payload: serde_json::json!({ "body": "and back" }),
            }
        ));
        let got = next_from_peer(&mut client_rx).await;
        assert_eq!(got.from, "device-server");
        assert_eq!(got.payload["body"], "and back");
    }

    /// A peer must not be able to attribute a message to someone else.
    #[tokio::test]
    async fn a_peer_cannot_speak_for_another_device() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let (server_tx, mut server_rx) = mpsc::unbounded_channel::<Envelope>();
        let server_links = Links::default();
        {
            let state = node("device-server");
            let links = server_links.clone();
            tokio::spawn(async move {
                let (stream, _) = listener.accept().await.unwrap();
                let _ = handle(state, links, stream, false, server_tx).await;
            });
        }

        // Speak the protocol by hand so we can forge the `from` field.
        let mut stream = TcpStream::connect(addr).await.unwrap();
        let hello = serde_json::json!({
            "v": 1, "from": "device-impostor", "kind": "hello",
            "payload": { "name": "impostor" }
        });
        stream
            .write_all(format!("{hello}\n").as_bytes())
            .await
            .unwrap();

        let forged = serde_json::json!({
            "v": 1, "from": "device-somebody-else", "kind": "chat",
            "payload": { "body": "spoofed" }
        });
        stream
            .write_all(format!("{forged}\n").as_bytes())
            .await
            .unwrap();

        let honest = serde_json::json!({
            "v": 1, "from": "device-impostor", "kind": "chat",
            "payload": { "body": "legitimate" }
        });
        stream
            .write_all(format!("{honest}\n").as_bytes())
            .await
            .unwrap();

        // The forged frame must be dropped, and the honest one still arrive.
        let got = next_from_peer(&mut server_rx).await;
        assert_eq!(
            got.payload["body"], "legitimate",
            "a spoofed sender was delivered: {got:?}"
        );
    }

    #[test]
    fn a_link_registry_routes_to_the_right_peer() {
        let links = Links::default();
        let (tx_a, mut rx_a) = mpsc::unbounded_channel();
        let (tx_b, mut rx_b) = mpsc::unbounded_channel();
        let gen_a = links.insert("peer-a".into(), tx_a);
        links.insert("peer-b".into(), tx_b);

        let envelope = Envelope {
            v: PROTOCOL_VERSION,
            from: "me".into(),
            kind: "chat".into(),
            payload: serde_json::json!({ "body": "hello" }),
        };

        assert!(links.send("peer-a", &envelope));
        assert!(rx_a.try_recv().is_ok(), "peer-a should have received it");
        assert!(rx_b.try_recv().is_err(), "peer-b should not have");

        assert!(!links.send("nobody", &envelope), "unknown peer must report failure");

        assert_eq!(links.broadcast(&envelope), 2);
        assert!(rx_a.try_recv().is_ok());
        assert!(rx_b.try_recv().is_ok());

        links.remove("peer-a", gen_a);
        assert!(!links.has("peer-a"));
        assert!(links.has("peer-b"));
    }

    /// The bug this guards against made a peer look connected while every
    /// A new connection always takes the slot, however it was dialled.
    ///
    /// The old rule kept the link dialled by the lower device id and refused
    /// the other, which sounds symmetric and is not: for a link dialled by the
    /// *higher* id, neither end computes itself preferred. Whichever end
    /// already held an entry - live or long dead - refused the connection and
    /// dropped it while the other end accepted it, leaving one end writing to
    /// a socket the other had closed. Calls rang in one direction and messages
    /// travelled in one direction, which is exactly how it presented.
    #[test]
    fn a_link_the_peer_opened_takes_the_slot() {
        let links = Links::default();

        // A link this machine opened, of the kind that can point at nothing.
        let (stale_tx, stale_rx) = mpsc::unbounded_channel();
        let stale = links.claim("peer", stale_tx, false).expect("an empty slot takes any link");
        drop(stale_rx);

        // Then the peer reaches us, which is worth more than our own attempt.
        let (live_tx, mut live_rx) = mpsc::unbounded_channel();
        let live = links.claim("peer", live_tx, true).expect("an inbound link always takes the slot");
        assert_ne!(stale, live, "each registration needs its own generation");

        let envelope = Envelope {
            v: PROTOCOL_VERSION,
            from: "me".into(),
            kind: "chat".into(),
            payload: serde_json::json!({ "body": "routed" }),
        };
        assert!(links.send("peer", &envelope), "nothing was registered to send to");
        assert!(
            live_rx.try_recv().is_ok(),
            "the stale entry kept the slot and the message went nowhere",
        );
    }

    /// A dead socket deregisters itself, and must not take a live one with it.
    ///
    /// The writer now removes the link when a write fails, because a half-open
    /// socket never wakes the reader and the cleanup after it never runs. That
    /// removal has to be generation-guarded: by the time a dying socket
    /// notices, the peer may already have been dialled again, and evicting the
    /// replacement would be the same silent-disappearance fault one step on.
    #[test]
    fn a_dead_socket_cannot_evict_the_link_that_replaced_it() {
        let links = Links::default();
        let (first_tx, _first_rx) = mpsc::unbounded_channel();
        let first = links.insert("peer".into(), first_tx);
        let (second_tx, _second_rx) = mpsc::unbounded_channel();
        let second = links.insert("peer".into(), second_tx);

        links.remove("peer", first);
        assert!(links.has("peer"), "the replacement was evicted by its predecessor");

        links.remove("peer", second);
        assert!(!links.has("peer"), "the live link was never cleared");
    }

    /// message vanished: both ends dial, the second registration replaces the
    /// first, and then the first link's teardown cleared the slot the second
    /// one was using.
    #[test]
    fn a_replaced_link_cannot_evict_the_one_that_replaced_it() {
        let links = Links::default();
        let (old_tx, _old_rx) = mpsc::unbounded_channel();
        let (new_tx, mut new_rx) = mpsc::unbounded_channel();

        let stale = links.insert("peer".into(), old_tx);
        let live = links.insert("peer".into(), new_tx);
        assert_ne!(stale, live, "each registration needs its own generation");

        // The losing link tears down after the winner has taken the slot.
        links.remove("peer", stale);

        assert!(links.has("peer"), "teardown of the replaced link evicted the live one");

        let envelope = Envelope {
            v: PROTOCOL_VERSION,
            from: "me".into(),
            kind: "chat".into(),
            payload: serde_json::json!({ "body": "still routed" }),
        };
        assert!(links.send("peer", &envelope));
        assert!(new_rx.try_recv().is_ok(), "message went to the dead link");

        // The live link's own teardown does clear it.
        links.remove("peer", live);
        assert!(!links.has("peer"));
    }

    #[test]
    fn envelopes_round_trip_as_ndjson() {
        let envelope = Envelope {
            v: PROTOCOL_VERSION,
            from: "device-1".into(),
            kind: "chat".into(),
            payload: serde_json::json!({ "body": "line one", "roomId": "r1" }),
        };
        let line = serde_json::to_string(&envelope).unwrap();
        assert!(!line.contains('\n'), "a frame must never contain a newline");

        let back: Envelope = serde_json::from_str(&line).unwrap();
        assert_eq!(back.from, "device-1");
        assert_eq!(back.kind, "chat");
        assert_eq!(back.payload["body"], "line one");
    }
}
