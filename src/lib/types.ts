export type OS = 'windows' | 'linux' | 'macos' | 'android' | 'unknown';

export type ConnLayer = 'direct' | 'routed' | 'upnp' | 'relayed' | 'manual';

export type NatType = 'open' | 'moderate' | 'strict' | 'double' | 'unknown';

export type PeerStatus = 'available' | 'busy' | 'in-game' | 'dnd' | 'offline';

/**
 * Where a peer sits relative to this device's NAT.
 *
 * `local`    — same subnet, found by mDNS.
 * `upstream` — on the network our router's WAN side belongs to (the outer LAN
 *              in a double-NAT setup). We can reach out to them; they cannot
 *              reach in unless a mapping is published.
 * `downstream` — behind a NAT of their own, below us. They reached out to us.
 */
export type PeerScope = 'local' | 'upstream' | 'downstream';

/** Which side opened the session — the side that can always initiate. */
export type Initiator = 'us' | 'them';

export interface Peer {
  id: string;
  /** Stable across address changes — the thing that makes a peer one peer. */
  deviceId: string;
  name: string;
  color: string;
  emoji: string;
  os: OS;
  ip: string;
  /** Every address this device is known to answer on. */
  addresses: string[];
  port: number;
  layer: ConnLayer;
  latencyMs: number;
  lossPct: number;
  status: PeerStatus;
  statusMessage?: string;
  lastSeen: number;
  trusted: boolean;
  scope: PeerScope;
  /** Which side opened the session that carries this peer's traffic. */
  initiatedBy: Initiator;
}

export interface Profile {
  id: string;
  name: string;
  color: string;
  emoji: string;
  statusMessage: string;
  deviceNickname: string;
}

export type RoomKind = 'dm' | 'group' | 'broadcast';

export interface Room {
  id: string;
  kind: RoomKind;
  name: string;
  members: string[];
  createdAt: number;
  pinned: string[];
  unread: number;
  lastReadAt: number;
  muted?: boolean;
}

export type Attachment = {
  id: string;
  name: string;
  size: number;
  mime: string;
  kind: 'image' | 'video' | 'audio' | 'file';
  dataUrl?: string;
  localPath?: string;
};

export interface VoiceClip {
  durationMs: number;
  peaks: number[];
  dataUrl?: string;
}

export interface Message {
  id: string;
  roomId: string;
  authorId: string;
  body: string;
  ts: number;
  editedAt?: number;
  deleted?: boolean;
  replyTo?: string;
  threadRoot?: string;
  reactions: Record<string, string[]>;
  attachments: Attachment[];
  voice?: VoiceClip;
  sticker?: string;
  gif?: string;
  mentions: string[];
  deliveredTo: string[];
  seenBy: string[];
  scheduledFor?: number;
  pending?: boolean;
  system?: boolean;
}

export type TransferState =
  | 'queued'
  | 'active'
  | 'paused'
  | 'done'
  | 'failed'
  | 'cancelled';

export interface Transfer {
  id: string;
  name: string;
  size: number;
  sent: number;
  peerId: string;
  direction: 'in' | 'out';
  state: TransferState;
  speedBps: number;
  startedAt: number;
  finishedAt?: number;
  mime: string;
  localPath?: string;
  expiresAt?: number;
  bundleId?: string;
}

export type CallKind = 'voice' | 'video';

export interface CallParticipant {
  peerId: string;
  /**
   * Who this is, captured when the call started.
   *
   * Not looked up live: a peer can drop out of the discovered list during a
   * call — a missed mDNS announcement is enough — and the call screen should
   * not start calling them "Unknown peer" mid-conversation.
   */
  name?: string;
  muted: boolean;
  camOn: boolean;
  speaking: boolean;
  volume: number;
  handRaised: boolean;
  handRaisedAt?: number;
  talkMs: number;
  sharing: boolean;
}

export interface CallSession {
  id: string;
  kind: CallKind;
  roomId?: string;
  participants: CallParticipant[];
  startedAt: number;
  state: 'ringing' | 'connecting' | 'active' | 'held' | 'ended';
  incomingFrom?: string;
  layout: 'grid' | 'spotlight';
  spotlightId?: string;
  recording: boolean;
  lowBandwidth: boolean;
  pip: boolean;
  screenShare?: { byPeerId: string; source: string; audio: boolean; fps: number };
}

export interface CallLogEntry {
  id: string;
  kind: CallKind;
  peers: string[];
  startedAt: number;
  durationMs: number;
  outcome: 'completed' | 'missed' | 'declined';
}

/**
 * The network our router's WAN interface sits on — the outer LAN when this
 * device is behind a second router. Absent when there is only one NAT.
 */
/**
 * One WAN link on the router.
 *
 * Dual-WAN setups balance or fail over between uplinks, each with its own
 * external address, so a mapping must exist on every one.
 */
export interface WanLink {
  externalIp: string;
  service: string;
  published: boolean;
}

export interface UpstreamInfo {
  /** Our router's address on the outer network. */
  routerWanIp: string;
  /**
   * False while `routerWanIp` is still the neighbouring-subnet estimate.
   *
   * The difference is worth showing: an estimated network is a guess about
   * someone's house, and presenting it as fact sends people looking for a LAN
   * that is not there.
   */
  wanConfirmed: boolean;
  /** A private WAN address is what "there is a LAN above this one" means. */
  wanIsPrivate: boolean;
  /** The outer network in CIDR form, e.g. "192.168.0.0/24". */
  subnet: string;
  /** The outer network's own gateway (usually the ISP box). */
  gateway: string;
  /** True once an outbound probe has reached something up there. */
  reachable: boolean;
  /** A mapping is open on our router, so upstream devices can initiate to us. */
  published: boolean;
  /** How the hole was opened — automatically, or by the user on the router. */
  publishedVia: 'upnp' | 'manual' | null;
  /** The address upstream devices should use to reach us, once published. */
  publishedAddress: string | null;
  lastScanAt: number | null;
  hostsScanned: number;
  /** Every uplink the router exposes. One entry on an ordinary router. */
  wans: WanLink[];
}

export interface NetInfo {
  ip: string;
  subnet: string;
  gateway: string;
  nat: NatType;
  upnpAvailable: boolean;
  /**
   * Every usable IPv4 interface, each with its own mask.
   *
   * Per interface rather than one mask for the machine: Ethernet on a /24 and
   * Wi-Fi on a /16 give different answers to "is that peer on my network",
   * and a single mask gets one of them wrong.
   */
  interfaces: {
    name: string;
    ip: string;
    kind: 'ethernet' | 'wifi' | 'other';
    mask: string;
    cidr: string;
  }[];
  port: number;
  stunPort: number;
  relayHub: boolean;
  relayBytes: number;
  bridging: boolean;
  upstream: UpstreamInfo | null;
  /** Port the built-in static HTTP server listens on for published folders. */
  hostPort: number;
}

export interface PortMapping {
  id: string;
  external: number;
  internal: number;
  proto: 'TCP' | 'UDP';
  description: string;
  expiresAt?: number;
}

export interface DiagStep {
  layer: ConnLayer;
  ok: boolean;
  detail: string;
  rttMs?: number;
}

/**
 * How a published folder is served.
 *
 * `files` — a browsable index, for handing a directory to someone.
 * `site`  — static hosting: `/` serves index.html, paths map to files.
 * `app`   — as `site`, but unknown paths fall back to index.html so a
 *           client-side router owns them.
 * `media` — a video library: files are streamed with HTTP range requests so
 *           viewers can seek, and they surface in every peer's Theatre.
 */
export type ShareMode = 'files' | 'site' | 'app' | 'media';

export interface Share {
  id: string;
  name: string;
  /** Absolute path of the folder or file being published. */
  path: string;
  /** URL path segment, e.g. "docs" in http://192.168.1.17:7981/docs */
  slug: string;
  mode: ShareMode;
  running: boolean;
  /** Serve to anyone on the LAN, or only peers who entered the phrase. */
  requirePhrase: boolean;
  phrase?: string;
  /** Let visitors upload into the folder. */
  allowUpload: boolean;
  fileCount: number;
  totalBytes: number;
  createdAt: number;
  requests: number;
  bytesServed: number;
  activeViewers: number;
  lastRequestAt: number | null;
}

/** A single playable title in the shared video library. */
export interface MediaItem {
  id: string;
  title: string;
  /** The share publishing this file, and the path within it. */
  shareId: string;
  relPath: string;
  /** Peer publishing it; absent when it is our own. */
  peerId?: string;
  durationSec: number;
  sizeBytes: number;
  /** Poster art is derived from the title when no artwork file sits alongside. */
  posterUrl?: string;
  year?: number;
  kind: 'film' | 'episode' | 'clip';
  /** Series grouping for episodes. */
  series?: string;
  season?: number;
  episode?: number;
  synopsis?: string;
  genres: string[];
  addedAt: number;
  /** Playback position in seconds; drives Continue watching. */
  progressSec: number;
  /** Direct URL on the publishing device's host server. */
  streamUrl: string;
  /**
   * Resolution and dynamic range read from the filename, e.g. "4K DV".
   * Absent when the name advertises nothing — there is no way to know without
   * decoding the file.
   */
  quality?: string;
  /** Subtitle files found beside the video. SubRip is converted on serve. */
  subtitles?: { label: string; lang: string; url: string }[];
  /**
   * The language this title was last watched in, or the viewer's usual choice
   * when it has not been opened before. Empty means subtitles were off.
   */
  subtitleLang?: string;
  /** As above, for audio. Empty means the file's own default track. */
  audioLang?: string;
  /**
   * Audio tracks inside the file, when there is more than one.
   *
   * Selecting one re-serves the file with that track chosen: a webview cannot
   * switch between muxed tracks itself, so the switch happens on the device
   * holding the file.
   */
  audioTracks?: { label: string; lang: string; codec: string; default: boolean }[];
}

/**
 * A synchronised viewing session.
 *
 * One device is the host and owns the clock; everyone else follows it. Only
 * the host's transport controls move the party, which avoids the tug-of-war
 * that happens when every viewer can seek.
 */
export interface WatchParty {
  id: string;
  itemId: string;
  hostId: string;
  members: string[];
  playing: boolean;
  positionSec: number;
  /** When the host last broadcast, so followers can allow for latency. */
  updatedAt: number;
}

/** One entry in a directory being staged for sending. */
export interface StagedEntry {
  /** Path relative to the chosen folder root, e.g. "img/logo.png". */
  relPath: string;
  name: string;
  size: number;
  mime: string;
}

/**
 * The games on offer.
 *
 * The solitaires are on their way out: a LAN application is a strange place to
 * put a game you play alone while everyone else watches. They stay until the
 * multiplayer ones that replace them are finished.
 */
export type GameKind =
  | 'chess'
  | 'connect4'
  | 'sequence'
  | 'crossy'
  | 'dots'
  | 'klondike'
  | 'freecell'
  | 'spider'
  | 'pyramid';

/** How far one player has got, in a race. */
export interface GameProgress {
  peerId: string;
  /** 0–1. What that means is the game's business: foundations, runs, pairs. */
  completion: number;
  moves: number;
  elapsedMs: number;
  finished: boolean;
  finishedAt?: number;
}

/**
 * A shared game across devices.
 *
 * Solitaire becomes multiplayer by dealing every player the identical hand and
 * racing — which is why the seed is part of the session rather than each
 * client's own choice.
 */
export interface GameSession {
  id: string;
  game: GameKind;
  /** Shared deal, so everyone plays the same hand. */
  seed: number;
  hostId: string;
  players: string[];
  startedAt: number;
  progress: Record<string, GameProgress>;
  /** Set once someone finishes. */
  winnerId?: string;
}

export interface GameInvite {
  id: string;
  from: string;
  to: string;
  game: GameKind;
  createdAt: number;
  state: 'pending' | 'accepted' | 'declined';
}

export interface ActiveGame {
  id: string;
  game: GameKind;
  players: string[];
  startedAt: number;
  spectators: string[];
}

export interface ActivityItem {
  id: string;
  kind: 'transfer' | 'call' | 'message' | 'peer' | 'game';
  text: string;
  ts: number;
  peerId?: string;
}
