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
    /// What the person at this device calls themselves.
    ///
    /// Separate from `instance`, which is the machine's own name. Until this
    /// existed only the machine name went out, so everybody on the network saw
    /// each other as a list of hostnames.
    pub display_name: String,
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
    /// Peers that are linked but whose library could not be read.
    pub library_unreachable: Vec<String>,
    /// Where a given transfer should be saved, when the receiver chose.
    pub download_into: std::collections::HashMap<String, Option<String>>,
    /// Why the published-folders server is not answering, when it is not.
    ///
    /// A share is marked live in the database, which is a record of intent and
    /// not of a bound socket. The two came apart badly: a detached host held
    /// the port, the app's own bind failed, and the window went on showing two
    /// green dots at a port nothing was listening on. Keeping the reason means
    /// the window can say what happened instead of looking like a firewall.
    pub host_error: Option<String>,
    /// Devices refused outright: no link, no calls, no files, not listed.
    ///
    /// Keyed by device id rather than address, because an address is not an
    /// identity — a blocked device that reconnects on a new IP is the same
    /// device and stays blocked.
    pub blocked: std::collections::HashSet<String>,
    /// Devices the host has vouched for. The other half of `blocked`, and
    /// what "auto-accept from trusted peers" actually reads.
    pub trusted: std::collections::HashSet<String>,
    /// This person's *own* other devices - a phone and a desktop belonging
    /// to whoever sits at this one, not another person's machine merely
    /// vouched for.
    ///
    /// Kept apart from `trusted` on purpose: trusting a peer is "I vouch for
    /// this other person's device" and grants nothing beyond calls and
    /// file auto-accept. A companion is "this is also me," which is why it
    /// is the one thing in this application allowed to browse a device's
    /// whole filesystem rather than only what has been explicitly
    /// published - a grant trust was never meant to carry, and reusing it
    /// would have quietly widened every trust decision anyone had already
    /// made. Set only through pairing (see commands::peers_pair_confirm),
    /// never as a side effect of trusting someone.
    pub companions: std::collections::HashSet<String>,
    /// The PIN this device is currently showing for someone to pair with,
    /// and when it stops being valid.
    ///
    /// One at a time, cleared on the first match: pairing is meant to be
    /// looked at and typed by a person standing at both screens, not a
    /// standing offer anyone on the network can try against indefinitely.
    pub pending_pair: Option<(String, u64)>,
    /// One-off permission to watch past a rating: (device, path) -> when it
    /// lapses, where 0 never does and a path of `*` covers everything.
    pub approvals: std::collections::HashMap<(String, String), u64>,
    /// Whether a request from this machine is treated as the publisher's own.
    ///
    /// True in the application, where it is what stops the host being caught
    /// by the restrictions it set: an age limit meant for a child's tablet
    /// refusing the person who set it, or an unlisted folder vanishing from
    /// the Theatre of the device publishing it.
    ///
    /// Off in the gate tests, which reach the server over loopback and would
    /// otherwise all look like the host - leaving nothing asserting that a
    /// guest is refused, which is the thing those tests exist for.
    pub trust_local_requests: bool,
    /// Who may drive this machine's pointer and keyboard, and who does now.
    pub control: crate::input::Control,
    /// Held open while a device is driving this one, so a finger dragging at
    /// sixty events a second does not reopen the platform's input device
    /// sixty times.
    #[cfg(target_os = "windows")]
    pub injector: Option<crate::input::Injector>,
    /// A folder of installers this machine offers to anyone on the network.
    ///
    /// Empty means the offer is off. The landing page is how somebody who has
    /// not got LANTern yet finds out it exists - they are looking at a folder
    /// it is serving them - and telling them to go and find a download
    /// elsewhere is the one instruction this application cannot give, because
    /// there is no elsewhere on a network with no way out.
    pub installers: String,

    /// Hardware addresses seen for peers, kept so a sleeping one can be woken.
    ///
    /// Only knowable while a device is awake, which is exactly when nobody
    /// needs it — so it is written down every time a peer is seen.
    pub macs: std::collections::HashMap<String, String>,
    /// Files picked on a phone and waiting to be sent.
    ///
    /// Held open rather than copied. Android names a file with a `content://`
    /// URI that cannot be opened by path, but it will hand over a descriptor -
    /// and on Linux a descriptor is addressable as `/proc/self/fd/N`, which
    /// the transfer server can open like anything else. Closing the file would
    /// make that path point at nothing, so it lives here until the send
    /// dialog is done with it.
    pub staged: std::collections::HashMap<std::path::PathBuf, crate::transfers::Staged>,
    /// Keys this device has issued to peers, so it can tell who is asking.
    ///
    /// An HTTP request between peers carries no identity: anyone on the
    /// network can fetch a stream URL. That is fine for a library everyone may
    /// watch and useless the moment some of it is restricted, because
    /// "enforced by the device holding the file" then means nothing.
    ///
    /// So each link hands the far side a secret over the signalling channel,
    /// which is authenticated, and requests carry it back. Keyed by their
    /// device id; the value is what they must present.
    pub issued_keys: std::collections::HashMap<String, String>,
    /// Keys peers have issued to this device, to present when asking them.
    pub held_keys: std::collections::HashMap<String, String>,
    /// The oldest content each device may watch, set here by the person at
    /// this machine. Absent means the household default applies.
    pub device_ages: std::collections::HashMap<String, u8>,
    /// Ratings the host has set by hand, which always beat the guess.
    ///
    /// Keyed by the stream path the manifest advertises, so a title keeps its
    /// rating however the library is rescanned.
    pub title_ages: std::collections::HashMap<String, u8>,
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
            same_subnet: Vec::new(),
            upstream: None,
            host_port: DEFAULT_HOST_PORT,
        };

        AppState(Arc::new(Mutex::new(Inner {
            net,
            display_name: String::new(),
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
            library_unreachable: Vec::new(),
            download_into: std::collections::HashMap::new(),
            host_error: None,
            blocked: std::collections::HashSet::new(),
            control: crate::input::Control::default(),
            #[cfg(target_os = "windows")]
            injector: None,
            installers: String::new(),
            macs: std::collections::HashMap::new(),
            staged: std::collections::HashMap::new(),
            issued_keys: std::collections::HashMap::new(),
            held_keys: std::collections::HashMap::new(),
            trusted: std::collections::HashSet::new(),
            companions: std::collections::HashSet::new(),
            pending_pair: None,
            approvals: std::collections::HashMap::new(),
            trust_local_requests: true,
            device_ages: std::collections::HashMap::new(),
            title_ages: std::collections::HashMap::new(),
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
