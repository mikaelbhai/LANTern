//! Wire types shared with the frontend.
//!
//! Field names are serialised in camelCase so these structs deserialise
//! directly into the interfaces declared in `src/lib/types.ts`.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConnLayer {
    Direct,
    Routed,
    Upnp,
    Relayed,
    Manual,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NatType {
    Open,
    Moderate,
    Strict,
    Double,
    Unknown,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PeerScope {
    Local,
    Upstream,
    Downstream,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Initiator {
    Us,
    Them,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PeerStatus {
    Available,
    Busy,
    InGame,
    Dnd,
    Offline,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Peer {
    pub id: String,
    /// Stable across address changes — the thing that makes a peer one peer.
    pub device_id: String,
    /// What to call them: their own name where they have set one.
    pub name: String,
    /// The machine's name, which is a different thing and worth showing too —
    /// one person can be at three devices.
    #[serde(default)]
    pub device_name: String,
    pub color: String,
    pub emoji: String,
    pub os: String,
    pub ip: String,
    /// Every address this device is known to answer on.
    pub addresses: Vec<String>,
    pub port: u16,
    pub layer: ConnLayer,
    pub latency_ms: f64,
    pub loss_pct: f64,
    pub status: PeerStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status_message: Option<String>,
    pub last_seen: u64,
    pub trusted: bool,
    pub scope: PeerScope,
    pub initiated_by: Initiator,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Interface {
    pub name: String,
    pub ip: String,
    pub kind: String,
    /// This interface's own netmask.
    ///
    /// Carried per interface rather than taken from the primary one: a machine
    /// with Ethernet on a /24 and Wi-Fi on a /16 has two different answers to
    /// "is that peer on my network", and using one mask for both gets one of
    /// them wrong.
    pub mask: String,
    /// The network this interface sits on, e.g. "192.168.100.0/24".
    pub cidr: String,
}

/// One WAN link on the router.
///
/// Dual-WAN setups load-balance or fail over between several uplinks, each
/// with its own external address. A mapping has to exist on every one, or
/// inbound traffic works only while the router happens to be using that link.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WanLink {
    /// Address peers on the outer network would use to reach us over this link.
    pub external_ip: String,
    /// Which connection service this link is served by.
    pub service: String,
    pub published: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpstreamInfo {
    pub router_wan_ip: String,
    /// Whether `router_wan_ip` came from the router or is still an estimate.
    ///
    /// The difference matters enough to show: an estimated network is a guess
    /// about someone's house, and presenting it as fact sends people looking
    /// for a LAN that is not there.
    pub wan_confirmed: bool,
    /// True when the router's WAN address is itself private — which is what
    /// "there is another LAN above this one" actually means.
    pub wan_is_private: bool,
    pub subnet: String,
    pub gateway: String,
    pub reachable: bool,
    pub published: bool,
    /// "upnp" when opened automatically, "manual" when the user forwarded it.
    pub published_via: Option<String>,
    pub published_address: Option<String>,
    pub last_scan_at: Option<u64>,
    pub hosts_scanned: u32,
    /// Every uplink the router exposes. One entry on an ordinary router.
    pub wans: Vec<WanLink>,
}

/// One file moving between two devices.
///
/// `state` and `direction` are plain strings rather than enums because they
/// are mirrored verbatim by the TypeScript `Transfer` type; a mismatch would
/// be a silent deserialisation failure on the far side rather than a compile
/// error here.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transfer {
    pub id: String,
    pub name: String,
    pub size: u64,
    pub sent: u64,
    pub peer_id: String,
    /// "in" or "out".
    pub direction: String,
    /// "queued" | "active" | "paused" | "done" | "failed" | "cancelled".
    pub state: String,
    pub speed_bps: u64,
    pub started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<u64>,
    pub mime: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub local_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
    /// Where an incoming file is fetched from. Held here so resuming needs
    /// nothing but the transfer id — the UI never has to carry the URL.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NetInfo {
    pub ip: String,
    pub subnet: String,
    pub gateway: String,
    pub nat: NatType,
    pub upnp_available: bool,
    pub interfaces: Vec<Interface>,
    pub port: u16,
    pub stun_port: u16,
    pub relay_hub: bool,
    pub relay_bytes: u64,
    pub bridging: bool,
    pub upstream: Option<UpstreamInfo>,
    pub host_port: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortMapping {
    pub id: String,
    pub external: u16,
    pub internal: u16,
    pub proto: String,
    pub description: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagStep {
    pub layer: ConnLayer,
    pub ok: bool,
    pub detail: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rtt_ms: Option<f64>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ShareMode {
    Files,
    Site,
    App,
    /// A video library, streamed with range requests so viewers can seek.
    Media,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Share {
    pub id: String,
    pub name: String,
    pub path: String,
    pub slug: String,
    pub mode: ShareMode,
    pub running: bool,
    pub require_phrase: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub phrase: Option<String>,
    pub allow_upload: bool,
    pub file_count: u64,
    pub total_bytes: u64,
    pub created_at: u64,
    pub requests: u64,
    pub bytes_served: u64,
    pub active_viewers: u32,
    pub last_request_at: Option<u64>,
}

/// How far one player has got, in a race.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameProgress {
    pub peer_id: String,
    pub completion: f64,
    pub moves: u32,
    pub elapsed_ms: u64,
    pub finished: bool,
    pub finished_at: Option<u64>,
}

/// A shared game. Solitaire becomes multiplayer by dealing everyone the same
/// hand, so the seed belongs to the session rather than to each client.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GameSession {
    pub id: String,
    pub game: String,
    pub seed: u64,
    pub host_id: String,
    pub players: Vec<String>,
    pub started_at: u64,
    pub progress: std::collections::HashMap<String, GameProgress>,
    pub winner_id: Option<String>,
    /// Who has asked to be dealt into the next match.
    ///
    /// A match already running cannot take anybody new - hands are dealt and
    /// turns are in order - so somebody who arrives late queues instead of
    /// being turned away.
    #[serde(default)]
    pub waiting: Vec<String>,
    /// What the next match will be, if anyone has changed it. The same game
    /// again otherwise.
    #[serde(default)]
    pub next_game: Option<String>,
}

/// A synchronised viewing session. The host owns the clock.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchParty {
    pub id: String,
    pub item_id: String,
    pub host_id: String,
    pub members: Vec<String>,
    pub playing: bool,
    pub position_sec: f64,
    pub updated_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Invite {
    pub phrase: String,
    pub payload: String,
}

/// Milliseconds since the Unix epoch, matching `Date.now()` on the JS side.
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}
