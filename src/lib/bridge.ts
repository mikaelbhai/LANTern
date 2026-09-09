/**
 * Single entry point to the native layer.
 *
 * Under Tauri every call goes to a Rust command. Opened in a plain browser
 * (`npm run dev` without the shell) the same API is served by `sim.ts`, so the
 * whole UI is exercisable without the Rust toolchain.
 */
import type {
  DiagStep,
  NetInfo,
  Peer,
  GameKind,
  GameSession,
  MediaItem,
  PortMapping,
  WatchParty,
  Share,
  ShareMode,
  Transfer,
  UpstreamInfo,
} from './types';

type Handler = (payload: any) => void;

const listeners = new Map<string, Set<Handler>>();

export function on(event: string, fn: Handler): () => void {
  let set = listeners.get(event);
  if (!set) {
    set = new Set();
    listeners.set(event, set);
  }
  set.add(fn);
  return () => set!.delete(fn);
}

export function emit(event: string, payload?: any) {
  listeners.get(event)?.forEach((fn) => fn(payload));
}

export const isTauri = (): boolean =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

let invokeFn: ((cmd: string, args?: any) => Promise<any>) | null = null;

async function nativeInvoke(cmd: string, args?: any): Promise<any> {
  if (!invokeFn) {
    const mod = await import('@tauri-apps/api/core');
    invokeFn = mod.invoke;
  }
  return invokeFn(cmd, args);
}

let sim: typeof import('./sim') | null = null;
async function simulator() {
  if (!sim) sim = await import('./sim');
  return sim;
}

async function call<T>(cmd: string, args?: any): Promise<T> {
  if (isTauri()) return nativeInvoke(cmd, args) as Promise<T>;
  const s = await simulator();
  return s.handle(cmd, args) as Promise<T>;
}

/** Wire Rust-side events into the local bus. Idempotent. */
let wired = false;
export async function startBridge() {
  if (wired) return;
  wired = true;
  if (isTauri()) {
    const { listen } = await import('@tauri-apps/api/event');
    // Each subscription is isolated: a single rejected `listen` must not stop
    // the rest from binding, and must never prevent the services below from
    // starting — that failure mode looks like the app launching fine while
    // nothing at all is listening on the network.
    const events = [
      'peer:joined',
      'peer:left',
      'peer:updated',
      'message:received',
      'message:updated',
      'typing',
      'transfer:progress',
      'transfer:offer',
      'call:incoming',
      'call:state',
      'game:invite',
      'game:move',
      'net:changed',
      'service:failed',
      'host:changed',
      'media:changed',
      'library:unreachable',
      'party:changed',
      'game:session',
    ];

    await Promise.all(
      events.map((ev) =>
        listen(ev, (e) => emit(ev, e.payload)).catch((err) =>
          console.error(`LANTern: could not subscribe to "${ev}"`, err),
        ),
      ),
    );

    try {
      await call('start_services');
    } catch (err) {
      console.error('LANTern: services failed to start', err);
      throw err;
    }
  } else {
    const s = await simulator();
    s.start();
  }
}

export const api = {
  net: {
    info: () => call<NetInfo>('net_info'),
    setRelayHub: (on: boolean) => call<void>('net_set_relay_hub', { on }),
    setBridging: (on: boolean) => call<void>('net_set_bridging', { on }),
    setPort: (port: number) => call<void>('net_set_port', { port }),
    addManualPeer: (ip: string, port: number) =>
      call<Peer>('net_add_manual_peer', { ip, port }),
    addByPhrase: (phrase: string) => call<Peer>('net_add_by_phrase', { phrase }),
    /** The networks this device is on, and whether one of them blocks peers. */
    connectionProfiles: () =>
      call<{ alias: string; category: string; blocksPeers: boolean }[]>(
        'net_connection_profiles',
      ),
    /** Asks Windows to trust a network. Elevation is prompted for by Windows. */
    setPrivate: (alias: string) => call<void>('net_set_private', { alias }),
    diagnose: (peerId: string) => call<DiagStep[]>('net_diagnose', { peerId }),
    /** Re-announce over mDNS and re-dial known peers. Returns peers known. */
    refresh: () => call<number>('net_refresh'),
    scanUpstream: () => call<Peer[]>('net_scan_upstream'),
    publishUpstream: (on: boolean) =>
      call<UpstreamInfo | null>('net_publish_upstream', { on }),
    /** Record a port forward the user set up on the router themselves. */
    publishUpstreamManual: (on: boolean) =>
      call<UpstreamInfo | null>('net_publish_upstream_manual', { on }),
    invite: () => call<{ phrase: string; payload: string }>('net_invite'),
    upnpList: () => call<PortMapping[]>('net_upnp_list'),
    upnpOpen: (internal: number, proto: 'TCP' | 'UDP') =>
      call<PortMapping>('net_upnp_open', { internal, proto }),
    upnpClose: (id: string) => call<void>('net_upnp_close', { id }),
  },
  peers: {
    list: () => call<Peer[]>('peers_list'),
    ping: (peerId: string) => call<number>('peers_ping', { peerId }),
    /** Everything a peer is publishing — media libraries and plain folders. */
    shares: (peerId: string) =>
      call<{ slug: string; name: string; mode: string; url: string }[]>('peers_shares', {
        peerId,
      }),
    /** One directory inside a peer's published folder. */
    browse: (peerId: string, slug: string, path: string) =>
      call<{ entries: { name: string; isDir: boolean; size: number; path: string; url: string }[] }>(
        'peers_browse',
        { peerId, slug, path },
      ),
    /** Refuses a device outright: no link, no calls, no files, not listed. */
    block: (peerId: string, blocked: boolean) =>
      call<void>('peers_block', { peerId, blocked }),
    /** Everything currently blocked, for the list in Settings. */
    blocked: () =>
      call<{ deviceId: string; name: string; blockedAt: number }[]>('peers_blocked'),
    trust: (peerId: string, trusted: boolean) =>
      call<void>('peers_trust', { peerId, trusted }),
  },
  chat: {
    /** `memberIds` are peer device ids; empty means broadcast to the network. */
    send: (roomId: string, payload: any, memberIds: string[] = []) =>
      call<number>('chat_send', { roomId, payload, memberIds }),
    typing: (roomId: string) => call<void>('chat_typing', { roomId }),
    react: (messageId: string, emoji: string) =>
      call<void>('chat_react', { messageId, emoji }),
  },
  files: {
    /**
     * Offers files by absolute path. The sender publishes each one on its own
     * HTTP server and tells the peer where to fetch it, so the bytes never go
     * through the signalling link.
     */
    offer: (peerId: string, paths: string[]) => call<Transfer[]>('files_offer', { peerId, paths }),
    /**
     * Starts pulling an offered file, resuming from whatever is on disk.
     *
     * `dir` is where it should land. Omitted means the usual folder.
     */
    accept: (id: string, dir?: string) => call<void>('files_accept', { id, dir: dir ?? null }),
    list: () => call<Transfer[]>('files_list'),
    /** Names and sizes for paths the native dialog returned. */
    stat: (paths: string[]) =>
      call<{ path: string; name: string; size: number }[]>('files_stat', { paths }),
    pause: (id: string) => call<void>('files_pause', { id }),
    resume: (id: string) => call<void>('files_resume', { id }),
    cancel: (id: string) => call<void>('files_cancel', { id }),
    reveal: (path: string) => call<void>('files_reveal', { path }),
    open: (path: string) => call<void>('files_open', { path }),
  },
  /** The built-in static server that publishes folders to the LAN. */
  host: {
    list: () => call<Share[]>('host_list'),
    create: (input: {
      name: string;
      path: string;
      slug: string;
      mode: ShareMode;
      requirePhrase: boolean;
      allowUpload: boolean;
      fileCount: number;
      totalBytes: number;
    }) => call<Share>('host_create', input),
    setRunning: (id: string, running: boolean) =>
      call<Share>('host_set_running', { id, running }),
    update: (id: string, patch: Partial<Share>) =>
      call<Share>('host_update', { id, patch }),
    remove: (id: string) => call<void>('host_remove', { id }),
    rescan: (id: string) => call<void>('host_rescan', { id }),
    /** Inspects a folder before publishing so the UI can pick a mode. */
    probe: (path: string) =>
      call<{
        exists: boolean;
        fileCount: number;
        totalBytes: number;
        hasIndexHtml: boolean;
        videoCount: number;
      }>('host_probe', { path }),
    openInBrowser: (url: string) => call<void>('host_open', { url }),
  },
  /** The shared video library assembled from every peer's media shares. */
  media: {
    list: () => call<MediaItem[]>('media_list'),
    setProgress: (id: string, progressSec: number) =>
      call<void>('media_set_progress', { id, progressSec }),
    scan: () => call<MediaItem[]>('media_scan'),
    /** Whether this device can re-serve a file with a chosen audio track. */
    canSwitchAudio: () => call<boolean>('media_can_switch_audio'),
    /**
     * Remembers how a title is being watched. Empty strings are meaningful:
     * subtitles deliberately off, audio left on the file's default.
     */
    setTracks: (id: string, audioLang: string, subtitleLang: string) =>
      call<void>('media_set_tracks', { id, audioLang, subtitleLang }),
  },
  /**
   * Installing a newer version.
   *
   * The bytes are fetched and checked in `lib/update.ts` — this only stores
   * them and hands the file to the system installer.
   */
  update: {
    /** Names the file that the next `stage` call will write. */
    begin: (name: string) => call<void>('update_begin', { name }),
    /** Writes the installer to disk and returns where it landed. */
    stage: async (bytes: ArrayBuffer): Promise<string> => {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<string>('update_stage', bytes);
    },
    /** Opens it with the system installer. */
    launch: (path: string) => call<void>('update_launch', { path }),
  },
  /** WebRTC negotiation. The media itself never comes through here. */
  call: {
    /** Returns false when there is no live link to that peer. */
    signal: (peerId: string, payload: unknown) =>
      call<boolean>('call_signal', { peerId, payload }),
  },
  /** Shared games across devices. */
  game: {
    start: (game: GameKind, peerIds: string[], seed: number) =>
      call<GameSession>('game_start', { game, peerIds, seed }),
    report: (
      sessionId: string,
      completion: number,
      moves: number,
      elapsedMs: number,
      finished: boolean,
    ) =>
      call<GameSession | null>('game_report', {
        sessionId,
        completion,
        moves,
        elapsedMs,
        finished,
      }),

    /**
     * Sends one move to the other players.
     *
     * Only the move travels; every client replays the same sequence and
     * arrives at the same board.
     */
    move: (sessionId: string, payload: unknown) =>
      call<boolean>('game_move', { sessionId, payload }),
    leave: (sessionId: string) => call<void>('game_leave', { sessionId }),
  },
  /** Synchronised viewing across devices. */
  party: {
    start: (itemId: string, memberIds: string[]) =>
      call<WatchParty>('party_start', { itemId, memberIds }),
    sync: (partyId: string, playing: boolean, positionSec: number) =>
      call<void>('party_sync', { partyId, playing, positionSec }),
    leave: (partyId: string) => call<void>('party_leave', { partyId }),
  },
  /**
   * Serving files without the app open.
   *
   * A separate, tiny process keeps the published folders reachable after the
   * window closes — including while the app itself is being rebuilt.
   */
  service: {
    get: () => call<boolean>('service_get'),
    set: (enabled: boolean) => call<void>('service_set', { enabled }),
    running: () => call<boolean>('service_running'),
  },
  /** Tray and launch behaviour. No-ops in a plain browser. */
  system: {
    traySupported: () => call<boolean>('tray_supported'),
    hideToTray: () => call<void>('window_hide_to_tray'),
    showWindow: () => call<void>('window_show'),
    getAutostart: () => call<boolean>('autostart_get'),
    setAutostart: (enabled: boolean) => call<boolean>('autostart_set', { enabled }),
  },
  profile: {
    os: () => call<string>('host_os'),
    /** Stores a 500x500 PNG. An empty array clears it. */
    setAvatar: (png: number[]) => call<void>('profile_set_avatar', { png }),
    hasAvatar: () => call<boolean>('profile_has_avatar'),
  },
};
