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

    /// Registers a link unless a preferred one already holds the slot.
    ///
    /// Checking `has` and then inserting cannot work: they take the lock
    /// twice, and between them the other direction can register. Both ends
    /// then decide *they* are the duplicate and drop, leaving the peer with a
    /// TCP connection that is established but registered nowhere — which
    /// looks, from the UI, like "no live link" to a device sitting right
    /// there. One lock, one decision.
    pub fn claim(
        &self,
        device_id: &str,
        tx: mpsc::UnboundedSender<String>,
        preferred: bool,
    ) -> Option<u64> {
        let mut map = self.map.lock().expect("links poisoned");
        if map.contains_key(device_id) && !preferred {
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

    let (peer, is_new) = state.with(|s| {
        let port = s.net.port;
        match s.peers.get_mut(&peer_id) {
            Some(existing) => {
                existing.last_seen = crate::model::now_ms();
                existing.status = crate::model::PeerStatus::Available;
                if !address.is_empty() && !existing.addresses.contains(&address) {
                    existing.addresses.push(address.clone());
                }
                (existing.clone(), false)
            }
            None => {
                let peer = crate::model::Peer {
                    id: peer_id.clone(),
                    device_id: peer_id.clone(),
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
                    latency_ms: 0.0,
                    loss_pct: 0.0,
                    status: crate::model::PeerStatus::Available,
                    status_message: None,
                    last_seen: crate::model::now_ms(),
                    trusted: false,
                    scope: crate::model::PeerScope::Local,
                    initiated_by: crate::model::Initiator::Them,
                };
                s.peers.insert(peer_id.clone(), peer.clone());
                (peer, true)
            }
        }
    });

    let _ = app.emit(if is_new { "peer:joined" } else { "peer:updated" }, &peer);

    // A peer we can reach is a library we can read. Theatre showed only local
    // titles until something asked.
    crate::library::spawn_refresh(app, state);
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

    // Both sides dial, so one peer can produce two links. Keep the one dialled
    // by the lower device id: each end computes that from the two ids alone
    // and reaches the same answer, so exactly one survives.
    //
    // The claim is conditional rather than absolute, because a peer that can
    // dial out but cannot be dialled — the NAT case this module exists for —
    // offers only one direction, and refusing it on principle would strand it.
    let preferred = if we_dialled {
        me.as_str() < peer_id.as_str()
    } else {
        me.as_str() > peer_id.as_str()
    };

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let Some(generation) = links.claim(&peer_id, tx, preferred) else {
        return Ok(());
    };

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
        payload: serde_json::json!({ "name": peer_name, "address": address }),
    });

    // Writer pump.
    let writer = tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            if write_half.write_all(format!("{line}\n").as_bytes()).await.is_err() {
                break;
            }
        }
    });

    // Read until the link ends, then always deregister it. Propagating the
    // read error directly with `?` used to skip the cleanup below, which left
    // a dead sender in the table: `send` reported success, the bytes went to a
    // channel nobody was draining, and the peer looked connected while every
    // message silently disappeared.
    let outcome = pump(&mut reader, &peer_id, &inbound).await;

    links.remove(&peer_id, generation);
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

/// Turns a received envelope into the frontend event it corresponds to.
fn deliver(app: &AppHandle, envelope: &Envelope) {
    let event = match envelope.kind.as_str() {
        "chat" => "message:received",
        "typing" => "typing",
        "party" => "party:changed",
        "game" => "game:session",
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
