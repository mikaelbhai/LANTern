//! Process-wide shared state.
//!
//! A single mutex guards the whole struct: contention is negligible at LAN
//! scale (a handful of peers, a few shares) and it keeps every command's view
//! of the world consistent without a web of finer-grained locks.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::model::{GameSession, NatType, NetInfo, Peer, PortMapping, Share, WatchParty};

pub const DEFAULT_PORT: u16 = 7979;
pub const DEFAULT_STUN_PORT: u16 = 7980;
pub const DEFAULT_HOST_PORT: u16 = 7981;

pub struct Inner {
    pub net: NetInfo,
    pub peers: HashMap<String, Peer>,
    pub mappings: Vec<PortMapping>,
    pub shares: Vec<Share>,
    /// Library entries, kept as JSON so the scanner can evolve the shape
    /// without a schema change on both sides of the bridge.
    pub media: Vec<serde_json::Value>,
    /// Opened once services start; absent if the store could not be created.
    pub db: Option<rusqlite::Connection>,
    /// Every UPnP control endpoint found — one per WAN link on a dual-WAN router.
    pub gateways: Vec<crate::upnp::Gateway>,
    /// The viewing session this device is part of, if any.
    pub party: Option<WatchParty>,
    /// The shared game this device is part of, if any.
    pub session: Option<GameSession>,
    /// Stable identity for this device, advertised over mDNS.
    pub device_id: String,
    /// Name this device announces itself under.
    pub instance: String,
    /// Live mDNS handle, kept so the service can be re-announced on a network change.
    pub daemon: Option<mdns_sd::ServiceDaemon>,
    /// Open peer links, keyed by device id.
    pub links: crate::signaling::Links,
    pub services_started: bool,
    /// Files this device has offered, addressable by their one-time token.
    pub offers: crate::transfers::Offers,
    /// Every transfer this session knows about, in either direction.
    pub transfers: Vec<crate::model::Transfer>,
    /// This device's profile picture as PNG bytes, served to peers on request.
    pub avatar: Option<Vec<u8>>,
    /// Where generated still frames are kept between runs.
    pub thumb_dir: Option<std::path::PathBuf>,
}

#[derive(Clone)]
pub struct AppState(pub Arc<Mutex<Inner>>);

impl AppState {
    pub fn new() -> Self {
        let net = NetInfo {
            ip: String::from("0.0.0.0"),
            subnet: String::from("255.255.255.0"),
            gateway: String::new(),
            nat: NatType::Unknown,
            upnp_available: false,
            interfaces: Vec::new(),
            port: DEFAULT_PORT,
            stun_port: DEFAULT_STUN_PORT,
            relay_hub: false,
            relay_bytes: 0,
            bridging: false,
            upstream: None,
            host_port: DEFAULT_HOST_PORT,
        };

        AppState(Arc::new(Mutex::new(Inner {
            net,
            peers: HashMap::new(),
            mappings: Vec::new(),
            shares: Vec::new(),
            media: Vec::new(),
            db: None,
            gateways: Vec::new(),
            party: None,
            session: None,
            device_id: String::new(),
            instance: String::new(),
            daemon: None,
            links: crate::signaling::Links::default(),
            services_started: false,
            offers: crate::transfers::Offers::default(),
            transfers: Vec::new(),
            avatar: None,
            thumb_dir: None,
        })))
    }

    /// Runs `f` against the locked state. Panicking while holding the lock
    /// would poison it for the rest of the session, so callers keep the closure
    /// short and infallible.
    pub fn with<R>(&self, f: impl FnOnce(&mut Inner) -> R) -> R {
        let mut guard = self.0.lock().expect("state mutex poisoned");
        f(&mut guard)
    }
}

impl Default for AppState {
    fn default() -> Self {
        Self::new()
    }
}
