//! The owner key: one phone that administers the machines that agreed to it.
//!
//! Dormant in every build until its owner switches it on, on that device, by
//! putting a file named `owner-key.enabled` in the data folder - by hand on
//! Windows, and on Android over adb (`run-as` on the debug-signed APK), which is
//! the point: reaching that folder takes physical or debugging access to the
//! device, and nothing in LANTern, local or remote, can create the file. Until
//! it exists there is no menu, every command refuses, and the envelope kinds
//! below get the silence any unknown kind gets, so a stranger's device asking
//! for owner access learns nothing, not even that the code is there.
//!
//! Removing the file switches it off again at once, and takes back any rights
//! a key held at that moment.
//!
//! The one rule the rest of this follows: a key has power over a machine only
//! because a person at that machine agreed to it, there, with a PIN typed on
//! the key. Nothing here grants anything by asking, by being on the network, or
//! by claiming a device id - ids are whatever a peer says in its hello.
//!
//! So the key is a keypair, and rights are granted for one live link at a time:
//!
//! - **Enrolment** (once per machine): the key asks; the machine's person
//!   allows and a PIN appears; the PIN is typed on the key, which signs it and
//!   both device ids with its private key. The machine stores the public key.
//! - **Every link** after that: the machine challenges with a fresh nonce; only
//!   the holder of the private key can sign it; a good signature puts the
//!   peer's device id into the in-memory `trusted` and `companions` sets until
//!   that link closes. Nothing is written to the trusted or companion tables,
//!   so restarting, or a stranger claiming the same id on another link, leaves
//!   no standing grant behind.
//!
//! What this does not defend against: someone on the same network who sits in
//! the middle of the link as it forms and relays the challenge and the answer
//! between the real machine and the real phone. Links have no channel binding
//! (the transport is plain TCP), which is true of every trust decision in this
//! application; it needs the attacker present, active and fast, not merely
//! on the network.

use std::collections::{HashMap, HashSet};

use ring::rand::{SecureRandom, SystemRandom};
use ring::signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::model::now_ms;
use crate::signaling::Envelope;
use crate::state::AppState;

/// How long a request waits for its person, and a shown PIN for its typist.
const REQUEST_TTL_MS: u64 = 3 * 60 * 1000;
/// A challenge is answered in the time it takes a link to say hello twice.
const CHALLENGE_TTL_MS: u64 = 10_000;
/// A PIN is six digits; this is what keeps that from being guessable.
const MAX_PIN_TRIES: u8 = 5;
const MAX_NAME: usize = 40;

/// The key a machine agreed to.
#[derive(Clone, Debug)]
pub struct Enrolled {
    pub pubkey: String,
    pub name: String,
    pub enrolled_at: u64,
}

/// A request waiting on the machine's person, then on the PIN.
#[derive(Clone, Debug)]
pub struct Incoming {
    pub from: String,
    pub name: String,
    pub pubkey: String,
    pub pin: Option<String>,
    pub expires: u64,
    pub tries: u8,
}

#[derive(Default)]
pub struct OwnerState {
    /// The key this machine agreed to, if any (one to start with).
    pub enrolled: Option<Enrolled>,
    pub incoming: Option<Incoming>,
    /// The machine this device, as the key, is waiting on, and until when.
    pub outgoing: Option<(String, u64)>,
    /// Outstanding challenges: device -> (nonce, when it lapses).
    pub challenges: HashMap<String, (String, u64)>,
    /// Devices whose proof is good on a link that is still open.
    pub proven: HashSet<String>,
    /// The data folder, where the marker file is looked for.
    pub dir: Option<std::path::PathBuf>,
}

/// The file whose presence switches the owner key on.
pub const MARKER: &str = "owner-key.enabled";

pub fn set_dir(state: &AppState, dir: &std::path::Path) {
    state.with(|s| s.owner.dir = Some(dir.to_path_buf()));
}

/// Whether the owner key is switched on here.
///
/// Looked at each time rather than remembered, so that deleting the file is all
/// it takes to turn it off: a key that is connected at that moment loses what
/// it held before this returns.
pub fn enabled(state: &AppState) -> bool {
    let on = state.with(|s| s.owner.dir.as_ref().is_some_and(|d| d.join(MARKER).exists()));
    if !on {
        let live: Vec<String> = state.with(|s| s.owner.proven.iter().cloned().collect());
        for device in live {
            revoke(state, &device);
        }
    }
    on
}

/* ------------------------------------------------------------- primitives */

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 || !s.is_ascii() {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&s[i..i + 2], 16).ok())
        .collect()
}

/// Six words that stand for a public key, for two people to compare by eye.
///
/// Not the key: six words is 48 bits and a key is 256. Enough to notice that
/// the key on the phone is not the one the machine is showing.
pub fn fingerprint(pubkey_hex: &str) -> String {
    let digest = Sha256::digest(pubkey_hex.as_bytes());
    digest[..6]
        .iter()
        .map(|b| crate::phrase::WORDS[*b as usize])
        .collect::<Vec<_>>()
        .join(" ")
}

fn clean_name(name: &str) -> String {
    name.chars().filter(|c| !c.is_control()).take(MAX_NAME).collect::<String>().trim().to_string()
}

fn token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn six_digits() -> String {
    let bytes = uuid::Uuid::new_v4().into_bytes();
    let n = u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]) % 1_000_000;
    format!("{n:06}")
}

/// What the key signs to enrol: the PIN it was shown, and the two devices.
fn enrol_message(pin: &str, key_device: &str, machine: &str) -> Vec<u8> {
    format!("lantern-owner-enrol-v1|{pin}|{key_device}|{machine}").into_bytes()
}

/// What the key signs to answer a challenge. Naming the machine and the key's
/// own device means an answer made for one machine is no use to another.
fn proof_message(nonce: &str, machine: &str, key_device: &str) -> Vec<u8> {
    format!("lantern-owner-v1|{nonce}|{machine}|{key_device}").into_bytes()
}

fn verify(pubkey_hex: &str, message: &[u8], sig_hex: &str) -> bool {
    let (Some(key), Some(sig)) = (unhex(pubkey_hex), unhex(sig_hex)) else {
        return false;
    };
    UnparsedPublicKey::new(&ED25519, &key).verify(message, &sig).is_ok()
}

/// This device's keypair, made on first use when `create` says to.
fn keypair(state: &AppState, create: bool) -> Option<Ed25519KeyPair> {
    let read = |state: &AppState| {
        state.with(|s| {
            s.db.as_ref().and_then(|db| {
                db.query_row("SELECT seed FROM owner_identity WHERE id = 1", [], |r| {
                    r.get::<_, Vec<u8>>(0)
                })
                .ok()
            })
        })
    };
    let seed = match read(state) {
        Some(seed) => seed,
        None if create => {
            let mut fresh = [0u8; 32];
            SystemRandom::new().fill(&mut fresh).ok()?;
            state.with(|s| {
                if let Some(db) = s.db.as_ref() {
                    // OR IGNORE, then read back: two callers racing end up
                    // with the same key rather than one overwriting the other.
                    let _ = db.execute(
                        "INSERT OR IGNORE INTO owner_identity (id, seed) VALUES (1, ?1)",
                        rusqlite::params![fresh.to_vec()],
                    );
                }
            });
            read(state)?
        }
        None => return None,
    };
    Ed25519KeyPair::from_seed_unchecked(&seed).ok()
}

pub fn public_hex(state: &AppState, create: bool) -> Option<String> {
    keypair(state, create).map(|k| hex(k.public_key().as_ref()))
}

fn sign(state: &AppState, message: &[u8]) -> Option<String> {
    keypair(state, false).map(|k| hex(k.sign(message).as_ref()))
}

fn name_of(state: &AppState, device: &str) -> String {
    state.with(|s| {
        s.peers
            .values()
            .find(|p| p.device_id == device)
            .map(|p| p.name.clone())
            .unwrap_or_default()
    })
}

fn send(state: &AppState, to: &str, kind: &str, payload: Value) {
    let (links, me) = state.with(|s| (s.links.clone(), s.device_id.clone()));
    links.send(to, &Envelope { v: 1, from: me, kind: kind.into(), payload });
}

type Emit<'a> = &'a dyn Fn(&str, Value);

/* ------------------------------------------------------- machine: rights */

fn persisted(state: &AppState, table: &str, device: &str) -> bool {
    state.with(|s| {
        s.db.as_ref()
            .map(|db| {
                db.query_row(
                    &format!("SELECT 1 FROM {table} WHERE device_id = ?1"),
                    rusqlite::params![device],
                    |_| Ok(()),
                )
                .is_ok()
            })
            .unwrap_or(false)
    })
}

/// Puts a device whose proof held into the sets the serving code reads, in
/// memory only.
pub(crate) fn grant(state: &AppState, device: &str) {
    state.with(|s| {
        s.trusted.insert(device.to_string());
        s.companions.insert(device.to_string());
        s.owner.proven.insert(device.to_string());
    });
}

/// Takes back what `grant` gave, except anything the person set deliberately
/// and the tables remember: a device the household trusted before it was ever
/// a key is still trusted when it stops being one.
pub(crate) fn revoke(state: &AppState, device: &str) {
    let keep_trusted = persisted(state, "trusted", device);
    let keep_companion = persisted(state, "companions", device);
    state.with(|s| {
        if s.owner.proven.remove(device) {
            if !keep_trusted {
                s.trusted.remove(device);
            }
            if !keep_companion {
                s.companions.remove(device);
                s.control.forget(device);
            }
        }
        s.owner.challenges.remove(device);
    });
}

/// A link to `device` has closed. Rights go with the last link, not the first
/// to close: both ends dial, so two exist briefly, and the loser's teardown
/// must not strip the winner (see `Links::claim`).
pub(crate) fn link_closed(state: &AppState, device: &str) {
    let still = state.with(|s| s.links.has(device));
    if !still {
        revoke(state, device);
    }
}

/// Loads the key this machine agreed to. Called at boot.
pub fn load(state: &AppState) {
    let row = state.with(|s| {
        s.db.as_ref().and_then(|db| {
            db.query_row(
                "SELECT pubkey, name, enrolled_at FROM owner_keys ORDER BY enrolled_at DESC LIMIT 1",
                [],
                |r| {
                    Ok(Enrolled {
                        pubkey: r.get(0)?,
                        name: r.get(1)?,
                        enrolled_at: r.get::<_, i64>(2)? as u64,
                    })
                },
            )
            .ok()
        })
    });
    state.with(|s| s.owner.enrolled = row);
}

/* ------------------------------------------- machine: enrolment requests */

fn on_request(state: &AppState, from: &str, payload: &Value, emit: Emit) {
    let Some(pubkey) = payload.get("pubkey").and_then(|v| v.as_str()) else {
        return;
    };
    if unhex(pubkey).map(|k| k.len()) != Some(32) {
        return;
    }
    let name = clean_name(payload.get("name").and_then(|v| v.as_str()).unwrap_or_default());
    let now = now_ms();
    let taken = state.with(|s| {
        // One at a time: a second device asking while a person is deciding
        // about the first must not replace what they are looking at.
        if s.owner.incoming.as_ref().is_some_and(|i| i.expires > now && i.from != from) {
            return true;
        }
        s.owner.incoming = Some(Incoming {
            from: from.to_string(),
            name: if name.is_empty() { "A device".into() } else { name.clone() },
            pubkey: pubkey.to_string(),
            pin: None,
            expires: now + REQUEST_TTL_MS,
            tries: 0,
        });
        false
    });
    if taken {
        return;
    }
    let shown = if name.is_empty() { name_of(state, from) } else { name };
    emit(
        "owner:requested",
        json!({ "deviceId": from, "name": shown, "fingerprint": fingerprint(pubkey) }),
    );
}

/// The machine's person said yes: show a PIN and tell the key to ask for it.
pub fn allow(state: &AppState) -> Result<String, String> {
    if !enabled(state) {
        return Err("not switched on".into());
    }
    let now = now_ms();
    let (from, pin) = state.with(|s| {
        let Some(request) = s.owner.incoming.as_mut().filter(|i| i.expires > now) else {
            return Err("nobody is asking".to_string());
        };
        let pin = six_digits();
        request.pin = Some(pin.clone());
        request.expires = now + REQUEST_TTL_MS;
        Ok((request.from.clone(), pin))
    })?;
    send(state, &from, "ownerready", json!({}));
    Ok(pin)
}

pub fn deny(state: &AppState) {
    let from = state.with(|s| s.owner.incoming.take().map(|i| i.from));
    if let Some(from) = from {
        send(state, &from, "ownerdenied", json!({}));
    }
}

fn on_confirm(state: &AppState, from: &str, payload: &Value, emit: Emit) {
    let now = now_ms();
    let pin = payload.get("pin").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let sig = payload.get("sig").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    let me = state.with(|s| s.device_id.clone());

    enum Outcome {
        Ignore,
        Wrong,
        Right(Incoming),
    }
    let outcome = state.with(|s| {
        let Some(request) = s.owner.incoming.as_mut() else {
            return Outcome::Ignore;
        };
        if request.from != from || request.expires <= now {
            return Outcome::Ignore;
        }
        let Some(expected) = request.pin.clone() else {
            return Outcome::Ignore;
        };
        request.tries += 1;
        let tries = request.tries;
        let good = !pin.is_empty()
            && expected == pin
            && verify(&request.pubkey, &enrol_message(&pin, from, &me), &sig);
        if good {
            Outcome::Right(request.clone())
        } else {
            // A wrong PIN counts; running out of tries ends the request, so
            // six digits are never enough to walk through.
            if tries >= MAX_PIN_TRIES {
                s.owner.incoming = None;
            }
            Outcome::Wrong
        }
    });

    match outcome {
        Outcome::Ignore => {}
        Outcome::Wrong => send(state, from, "ownerresult", json!({ "accepted": false })),
        Outcome::Right(request) => {
            state.with(|s| {
                if let Some(db) = s.db.as_ref() {
                    // One key to start with: enrolling replaces the last.
                    let _ = db.execute("DELETE FROM owner_keys", []);
                    let _ = db.execute(
                        "INSERT INTO owner_keys (pubkey, name, enrolled_at) VALUES (?1, ?2, ?3)",
                        rusqlite::params![request.pubkey, request.name, now as i64],
                    );
                }
                s.owner.enrolled = Some(Enrolled {
                    pubkey: request.pubkey.clone(),
                    name: request.name.clone(),
                    enrolled_at: now,
                });
                s.owner.incoming = None;
            });
            // The proof of possession was in the confirmation itself, so the
            // rights start now rather than at the next link.
            grant(state, from);
            send(state, from, "ownerresult", json!({ "accepted": true }));
            emit("owner:changed", json!({ "deviceId": from }));
        }
    }
}

/// Forgets the key and takes its rights back at once.
pub fn unenrol(state: &AppState) {
    let proven: Vec<String> = state.with(|s| {
        if let Some(db) = s.db.as_ref() {
            let _ = db.execute("DELETE FROM owner_keys", []);
        }
        s.owner.enrolled = None;
        s.owner.proven.iter().cloned().collect()
    });
    for device in proven {
        revoke(state, &device);
    }
}

/* ---------------------------------------------------- machine: every link */

/// A link has formed: ask whoever is on it to prove they hold the key.
pub fn challenge(state: &AppState, peer: &str) {
    if !enabled(state) {
        return;
    }
    let Some(pubkey) = state.with(|s| s.owner.enrolled.as_ref().map(|e| e.pubkey.clone())) else {
        return;
    };
    let nonce = token();
    state.with(|s| {
        s.owner.challenges.insert(peer.to_string(), (nonce.clone(), now_ms() + CHALLENGE_TTL_MS));
    });
    send(state, peer, "ownerchallenge", json!({ "nonce": nonce, "pubkey": pubkey }));
}

fn on_proof(state: &AppState, from: &str, payload: &Value, emit: Emit) {
    let nonce = payload.get("nonce").and_then(|v| v.as_str()).unwrap_or_default();
    let sig = payload.get("sig").and_then(|v| v.as_str()).unwrap_or_default();
    let me = state.with(|s| s.device_id.clone());
    let ok = state.with(|s| {
        // Taken out whatever happens: a nonce answers once.
        let Some((expected, lapses)) = s.owner.challenges.remove(from) else {
            return false;
        };
        let Some(key) = s.owner.enrolled.as_ref() else {
            return false;
        };
        !nonce.is_empty()
            && expected == nonce
            && lapses > now_ms()
            && verify(&key.pubkey, &proof_message(nonce, &me, from), sig)
    });
    if ok {
        grant(state, from);
        emit("owner:changed", json!({ "deviceId": from }));
    }
}

/* ------------------------------------------------------------ key (phone) */

/// Asks a machine to accept this device as its owner key.
pub fn request(state: &AppState, peer: &str) -> Result<(), String> {
    if !enabled(state) {
        return Err("not switched on".into());
    }
    let pubkey = public_hex(state, true).ok_or("could not make a key")?;
    let name = state.with(|s| s.instance.clone());
    state.with(|s| s.owner.outgoing = Some((peer.to_string(), now_ms() + REQUEST_TTL_MS)));
    send(state, peer, "ownerrequest", json!({ "pubkey": pubkey, "name": name }));
    Ok(())
}

fn on_ready(state: &AppState, from: &str, emit: Emit) {
    let waiting = state.with(|s| {
        s.owner.outgoing.as_ref().is_some_and(|(peer, until)| peer == from && *until > now_ms())
    });
    if waiting {
        emit("owner:ready", json!({ "deviceId": from, "name": name_of(state, from) }));
    }
}

fn on_denied(state: &AppState, from: &str, emit: Emit) {
    let had = state.with(|s| {
        if s.owner.outgoing.as_ref().is_some_and(|(peer, _)| peer == from) {
            s.owner.outgoing = None;
            true
        } else {
            false
        }
    });
    if had {
        emit("owner:result", json!({ "deviceId": from, "accepted": false, "denied": true }));
    }
}

/// Types the PIN the machine is showing.
pub fn confirm(state: &AppState, pin: &str) -> Result<(), String> {
    if !enabled(state) {
        return Err("not switched on".into());
    }
    let (peer, me) = state.with(|s| {
        (
            s.owner.outgoing.as_ref().filter(|(_, until)| *until > now_ms()).map(|(p, _)| p.clone()),
            s.device_id.clone(),
        )
    });
    let peer = peer.ok_or("no request is waiting for a PIN")?;
    let sig = sign(state, &enrol_message(pin, &me, &peer)).ok_or("this device has no key")?;
    send(state, &peer, "ownerconfirm", json!({ "pin": pin, "sig": sig }));
    Ok(())
}

fn on_result(state: &AppState, from: &str, payload: &Value, emit: Emit) {
    let accepted = payload.get("accepted").and_then(|v| v.as_bool()).unwrap_or(false);
    let ours = state.with(|s| s.owner.outgoing.as_ref().is_some_and(|(peer, _)| peer == from));
    if !ours {
        return;
    }
    let name = name_of(state, from);
    if accepted {
        remember_machine(state, from, &name);
        state.with(|s| s.owner.outgoing = None);
    }
    emit("owner:result", json!({ "deviceId": from, "accepted": accepted, "name": name }));
}

fn remember_machine(state: &AppState, device: &str, name: &str) {
    state.with(|s| {
        if let Some(db) = s.db.as_ref() {
            let _ = db.execute(
                "INSERT INTO owner_machines (device_id, name, seen_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(device_id) DO UPDATE SET name = ?2, seen_at = ?3",
                rusqlite::params![device, name, now_ms() as i64],
            );
        }
    });
}

/// A machine asks this device to prove it is the key. Answered only for this
/// device's own public key, so asking about any other key gets nothing.
fn on_challenge(state: &AppState, from: &str, payload: &Value, emit: Emit) {
    let nonce = payload.get("nonce").and_then(|v| v.as_str()).unwrap_or_default();
    let asked = payload.get("pubkey").and_then(|v| v.as_str()).unwrap_or_default();
    if nonce.is_empty() || public_hex(state, false).as_deref() != Some(asked) {
        return;
    }
    let me = state.with(|s| s.device_id.clone());
    let Some(sig) = sign(state, &proof_message(nonce, from, &me)) else {
        return;
    };
    send(state, from, "ownerproof", json!({ "nonce": nonce, "sig": sig }));
    remember_machine(state, from, &name_of(state, from));
    emit("owner:changed", json!({ "deviceId": from }));
}

/* --------------------------------------------------------------- dispatch */

/// Handles the owner-key envelope kinds. Returns whether it took the envelope.
pub(crate) fn on_envelope(state: &AppState, envelope: &Envelope, emit: Emit) -> bool {
    // Taken and dropped when switched off: the same silence as a kind nobody
    // handles, so a device that asks cannot tell this one from any other.
    if !enabled(state) {
        return envelope.kind.starts_with("owner");
    }
    let from = envelope.from.as_str();
    match envelope.kind.as_str() {
        "ownerrequest" => on_request(state, from, &envelope.payload, emit),
        "ownerconfirm" => on_confirm(state, from, &envelope.payload, emit),
        "ownerproof" => on_proof(state, from, &envelope.payload, emit),
        "ownerready" => on_ready(state, from, emit),
        "ownerdenied" => on_denied(state, from, emit),
        "ownerresult" => on_result(state, from, &envelope.payload, emit),
        "ownerchallenge" => on_challenge(state, from, &envelope.payload, emit),
        _ => return false,
    }
    true
}

/* -------------------------------------------------------------- commands */

type Res<T> = Result<T, String>;

/// Everything the Settings section shows, in one read.
#[tauri::command]
pub fn owner_status(state: tauri::State<'_, AppState>) -> Value {
    if !enabled(&state) {
        return json!({ "available": false });
    }
    let now = now_ms();
    let identity = public_hex(&state, false);
    let machines: Vec<Value> = state.with(|s| {
        let Some(db) = s.db.as_ref() else {
            return Vec::new();
        };
        let Ok(mut stmt) = db
            .prepare("SELECT device_id, name, seen_at FROM owner_machines ORDER BY seen_at DESC")
        else {
            return Vec::new();
        };
        let rows = stmt.query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?))
        });
        rows.map(|rows| {
            rows.flatten()
                .map(|(id, stored, seen)| {
                    let live = s.peers.values().find(|p| p.device_id == id).map(|p| p.name.clone());
                    json!({
                        "deviceId": id,
                        "name": live.filter(|n| !n.is_empty()).unwrap_or(stored),
                        "seenAt": seen,
                        "online": s.links.has(&id),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
    });
    state.with(|s| {
        json!({
            "available": true,
            "identity": identity.as_ref().map(|k| json!({ "fingerprint": fingerprint(k) })),
            "enrolled": s.owner.enrolled.as_ref().map(|e| json!({
                "name": e.name,
                "fingerprint": fingerprint(&e.pubkey),
                "enrolledAt": e.enrolled_at,
            })),
            "incoming": s.owner.incoming.as_ref().filter(|i| i.expires > now).map(|i| json!({
                "deviceId": i.from,
                "name": i.name,
                "fingerprint": fingerprint(&i.pubkey),
                "pin": i.pin,
            })),
            "outgoing": s.owner.outgoing.as_ref().filter(|(_, u)| *u > now).map(|(p, _)| p.clone()),
            "proven": s.owner.proven.iter().cloned().collect::<Vec<_>>(),
            "machines": machines,
        })
    })
}

/// This device's key, made if it has none. The fingerprint is for comparing.
#[tauri::command]
pub fn owner_identity(state: tauri::State<'_, AppState>) -> Res<Value> {
    if !enabled(&state) {
        return Err("not switched on".into());
    }
    let key = public_hex(&state, true).ok_or("could not make a key")?;
    Ok(json!({ "fingerprint": fingerprint(&key) }))
}

#[tauri::command]
pub fn owner_request(state: tauri::State<'_, AppState>, peer_id: String) -> Res<()> {
    let device = state.with(|s| {
        s.peers
            .values()
            .find(|p| p.device_id == peer_id || p.id == peer_id)
            .map(|p| p.device_id.clone())
            .unwrap_or(peer_id.clone())
    });
    request(&state, &device)
}

/// The person at this machine allows the request; returns the PIN to show.
#[tauri::command]
pub fn owner_allow(state: tauri::State<'_, AppState>) -> Res<String> {
    allow(&state)
}

#[tauri::command]
pub fn owner_deny(state: tauri::State<'_, AppState>) {
    deny(&state);
}

#[tauri::command]
pub fn owner_confirm(state: tauri::State<'_, AppState>, pin: String) -> Res<()> {
    confirm(&state, pin.trim())
}

#[tauri::command]
pub fn owner_unenrol(app: tauri::AppHandle, state: tauri::State<'_, AppState>) {
    use tauri::Emitter;
    unenrol(&state);
    let peers: Vec<_> = state.with(|s| s.peers.values().cloned().collect());
    let _ = app.emit("peers:changed", &peers);
    let _ = app.emit("owner:changed", json!({}));
}

/// A machine drops a key it agreed to from the key's side of the list.
#[tauri::command]
pub fn owner_forget_machine(state: tauri::State<'_, AppState>, device_id: String) {
    state.with(|s| {
        if let Some(db) = s.db.as_ref() {
            let _ = db.execute(
                "DELETE FROM owner_machines WHERE device_id = ?1",
                rusqlite::params![device_id],
            );
        }
    });
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use tokio::sync::mpsc;

    /// A data folder with the marker in it, which is what switching it on is.
    pub(crate) fn switch_on(st: &AppState) {
        let dir = std::env::temp_dir().join(format!("lantern-owner-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join(MARKER), b"").unwrap();
        set_dir(st, &dir);
    }

    fn node(id: &str) -> (AppState, mpsc::UnboundedReceiver<String>) {
        let st = AppState::default();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        st.with(|s| {
            s.db = Some(conn);
            s.device_id = id.to_string();
        });
        switch_on(&st);
        // A link to nobody in particular, so `send` has somewhere to put things.
        let _ = &tx;
        (st, rx)
    }

    /// Two states wired by hand: what one sends is handed to the other.
    struct Pair {
        key: AppState,
        machine: AppState,
        key_rx: mpsc::UnboundedReceiver<String>,
        machine_rx: mpsc::UnboundedReceiver<String>,
    }

    fn pair() -> Pair {
        let (key, _) = node("phone");
        let (machine, _) = node("pc");
        let (to_machine, machine_rx) = mpsc::unbounded_channel();
        let (to_key, key_rx) = mpsc::unbounded_channel();
        key.with(|s| s.links.insert("pc".into(), to_machine));
        machine.with(|s| s.links.insert("phone".into(), to_key));
        Pair { key, machine, key_rx, machine_rx }
    }

    fn deliver(rx: &mut mpsc::UnboundedReceiver<String>, to: &AppState) -> Option<Envelope> {
        let line = rx.try_recv().ok()?;
        let envelope: Envelope = serde_json::from_str(&line).unwrap();
        on_envelope(to, &envelope, &|_, _| {});
        Some(envelope)
    }

    fn enrol(p: &mut Pair) {
        request(&p.key, "pc").unwrap();
        deliver(&mut p.machine_rx, &p.machine).unwrap();
        let pin = allow(&p.machine).unwrap();
        deliver(&mut p.key_rx, &p.key).unwrap(); // ownerready
        confirm(&p.key, &pin).unwrap();
        deliver(&mut p.machine_rx, &p.machine).unwrap(); // ownerconfirm
        deliver(&mut p.key_rx, &p.key).unwrap(); // ownerresult
    }

    fn rights(st: &AppState, device: &str) -> (bool, bool) {
        st.with(|s| (s.trusted.contains(device), s.companions.contains(device)))
    }

    #[test]
    fn a_device_asking_for_owner_access_gets_nothing_until_the_pin_is_typed() {
        let mut p = pair();
        request(&p.key, "pc").unwrap();
        deliver(&mut p.machine_rx, &p.machine).unwrap();
        assert_eq!(rights(&p.machine, "phone"), (false, false));
        let _pin = allow(&p.machine).unwrap();
        assert_eq!(rights(&p.machine, "phone"), (false, false), "showing a PIN grants nothing");
    }

    #[test]
    fn typing_the_pin_enrols_and_grants_in_memory_only() {
        let mut p = pair();
        enrol(&mut p);
        assert_eq!(rights(&p.machine, "phone"), (true, true));
        assert!(!persisted(&p.machine, "trusted", "phone"));
        assert!(!persisted(&p.machine, "companions", "phone"));
        assert!(p.machine.with(|s| s.owner.enrolled.is_some()));
    }

    #[test]
    fn a_wrong_pin_enrols_nothing_and_five_wrong_ones_end_the_request() {
        let mut p = pair();
        request(&p.key, "pc").unwrap();
        deliver(&mut p.machine_rx, &p.machine).unwrap();
        let pin = allow(&p.machine).unwrap();
        deliver(&mut p.key_rx, &p.key).unwrap();
        let wrong = if pin == "000000" { "000001" } else { "000000" };
        for _ in 0..MAX_PIN_TRIES {
            confirm(&p.key, wrong).unwrap();
            deliver(&mut p.machine_rx, &p.machine).unwrap();
            deliver(&mut p.key_rx, &p.key).unwrap();
        }
        assert!(p.machine.with(|s| s.owner.enrolled.is_none()));
        // And the right one, afterwards, is too late.
        confirm(&p.key, &pin).unwrap();
        deliver(&mut p.machine_rx, &p.machine);
        assert!(p.machine.with(|s| s.owner.enrolled.is_none()));
        assert_eq!(rights(&p.machine, "phone"), (false, false));
    }

    #[test]
    fn a_pin_signed_by_a_different_key_is_refused() {
        let mut p = pair();
        request(&p.key, "pc").unwrap();
        deliver(&mut p.machine_rx, &p.machine).unwrap();
        let pin = allow(&p.machine).unwrap();
        deliver(&mut p.key_rx, &p.key).unwrap();
        // Someone who saw the PIN, and claims the phone's id, but has no key.
        let (thief, _) = node("phone");
        let sig = {
            thief.with(|s| s.device_id = "phone".into());
            keypair(&thief, true).map(|k| hex(k.sign(&enrol_message(&pin, "phone", "pc")).as_ref()))
        };
        let forged = Envelope {
            v: 1,
            from: "phone".into(),
            kind: "ownerconfirm".into(),
            payload: json!({ "pin": pin, "sig": sig }),
        };
        on_envelope(&p.machine, &forged, &|_, _| {});
        assert!(p.machine.with(|s| s.owner.enrolled.is_none()), "the signature is of another key");
    }

    #[test]
    fn a_claimed_device_id_without_the_proof_is_an_ordinary_peer() {
        let mut p = pair();
        enrol(&mut p);
        revoke(&p.machine, "phone");
        assert_eq!(rights(&p.machine, "phone"), (false, false));
        // A new link: the machine challenges. A stranger answers with a made-up proof.
        challenge(&p.machine, "phone");
        let sent = p.key_rx.try_recv().unwrap();
        let sent: Envelope = serde_json::from_str(&sent).unwrap();
        let nonce = sent.payload["nonce"].as_str().unwrap().to_string();
        let bad = Envelope {
            v: 1,
            from: "phone".into(),
            kind: "ownerproof".into(),
            payload: json!({ "nonce": nonce, "sig": "00".repeat(64) }),
        };
        on_envelope(&p.machine, &bad, &|_, _| {});
        assert_eq!(rights(&p.machine, "phone"), (false, false));
    }

    #[test]
    fn the_real_key_proves_itself_on_a_new_link_and_loses_it_when_the_link_closes() {
        let mut p = pair();
        enrol(&mut p);
        revoke(&p.machine, "phone");
        challenge(&p.machine, "phone");
        deliver(&mut p.key_rx, &p.key).unwrap(); // ownerchallenge -> phone signs
        deliver(&mut p.machine_rx, &p.machine).unwrap(); // ownerproof
        assert_eq!(rights(&p.machine, "phone"), (true, true));

        p.machine.with(|s| s.links.drop_link("phone"));
        link_closed(&p.machine, "phone");
        assert_eq!(rights(&p.machine, "phone"), (false, false));
    }

    #[test]
    fn a_proof_answers_one_challenge_once() {
        let mut p = pair();
        enrol(&mut p);
        revoke(&p.machine, "phone");
        challenge(&p.machine, "phone");
        let line = p.key_rx.try_recv().unwrap();
        let challenge_env: Envelope = serde_json::from_str(&line).unwrap();
        on_envelope(&p.key, &challenge_env, &|_, _| {});
        let line = p.machine_rx.try_recv().unwrap();
        let proof: Envelope = serde_json::from_str(&line).unwrap();
        on_envelope(&p.machine, &proof, &|_, _| {});
        assert_eq!(rights(&p.machine, "phone"), (true, true));
        revoke(&p.machine, "phone");
        // Replayed on the next link, the same answer is for a nonce that is gone.
        on_envelope(&p.machine, &proof, &|_, _| {});
        assert_eq!(rights(&p.machine, "phone"), (false, false));
    }

    #[test]
    fn an_answer_made_for_one_machine_is_no_use_to_another() {
        let mut p = pair();
        enrol(&mut p);
        let key = public_hex(&p.key, false).unwrap();
        let me_phone = "phone";
        // The key answers a challenge from "pc"; the same signature is offered to "tv".
        let sig = sign(&p.key, &proof_message("n1", "pc", me_phone)).unwrap();
        assert!(verify(&key, &proof_message("n1", "pc", me_phone), &sig));
        assert!(!verify(&key, &proof_message("n1", "tv", me_phone), &sig));
    }

    #[test]
    fn rights_do_not_strip_a_trust_the_household_set_deliberately() {
        let mut p = pair();
        crate::commands::set_trusted(&p.machine, "phone", true);
        enrol(&mut p);
        p.machine.with(|s| s.links.drop_link("phone"));
        link_closed(&p.machine, "phone");
        assert_eq!(rights(&p.machine, "phone"), (true, false), "trusted stays; companion goes");
    }

    #[test]
    fn unenrolling_takes_the_rights_back_at_once() {
        let mut p = pair();
        enrol(&mut p);
        unenrol(&p.machine);
        assert_eq!(rights(&p.machine, "phone"), (false, false));
        assert!(p.machine.with(|s| s.owner.enrolled.is_none()));
        // And it stays unenrolled after a reload.
        load(&p.machine);
        assert!(p.machine.with(|s| s.owner.enrolled.is_none()));
    }

    #[test]
    fn the_key_survives_a_restart_on_the_machine() {
        let mut p = pair();
        enrol(&mut p);
        p.machine.with(|s| s.owner.enrolled = None);
        load(&p.machine);
        assert!(p.machine.with(|s| s.owner.enrolled.is_some()));
    }

    #[test]
    fn the_key_only_answers_for_its_own_public_key() {
        let mut p = pair();
        enrol(&mut p);
        let env = Envelope {
            v: 1,
            from: "pc".into(),
            kind: "ownerchallenge".into(),
            payload: json!({ "nonce": "abc", "pubkey": "00".repeat(32) }),
        };
        on_envelope(&p.key, &env, &|_, _| {});
        assert!(p.machine_rx.try_recv().is_err(), "no signature for somebody else's key");
    }

    #[test]
    fn switched_off_it_answers_nothing_and_grants_nothing() {
        let mut p = pair();
        enrol(&mut p);
        let dir = p.machine.with(|s| s.owner.dir.clone().unwrap());
        std::fs::remove_file(dir.join(MARKER)).unwrap();
        assert!(!enabled(&p.machine));
        // Rights the key held are gone the moment it is looked at.
        assert_eq!(rights(&p.machine, "phone"), (false, false));
        // A request now is taken and dropped, with nothing sent back and no prompt.
        let fresh = Envelope {
            v: 1,
            from: "tv".into(),
            kind: "ownerrequest".into(),
            payload: json!({ "pubkey": "11".repeat(32), "name": "X" }),
        };
        assert!(on_envelope(&p.machine, &fresh, &|_, _| panic!("emitted")));
        assert!(p.machine.with(|s| s.owner.incoming.is_none()));
        assert!(allow(&p.machine).is_err());
        assert!(request(&p.machine, "tv").is_err());
        // And a new link is not even challenged.
        challenge(&p.machine, "phone");
        assert!(p.key_rx.try_recv().is_err());
    }

    #[test]
    fn with_no_data_folder_it_is_off() {
        let st = AppState::default();
        assert!(!enabled(&st));
    }

    #[test]
    fn fingerprints_are_six_words_and_differ_by_key() {
        let a = fingerprint(&"11".repeat(32));
        let b = fingerprint(&"22".repeat(32));
        assert_eq!(a.split(' ').count(), 6);
        assert_ne!(a, b);
    }
}
