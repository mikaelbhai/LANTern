/**
 * Single entry point to the native layer.
 *
 * Under Tauri every call goes to a Rust command. Opened in a plain browser
 * (`npm run dev` without the shell) the same API is served by `sim.ts`, so the
 * whole UI is exercisable without the Rust toolchain.
 */
import type {
  ControlStatus,
  DiagStep,
  GameKind,
  GameSession,
  MediaItem,
  NetInfo,
  Peer,
  PortMapping,
  Share,
  ShareMode,
  Transfer,
  UpstreamInfo,
  RatingsStatus,
  Wakeable,
  WifiStatus,
  WatchParty,
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

/**
 * Sends an event to the other windows of this application.
 *
 * `emit` above is the in-page bus and never leaves this webview. The corner
 * popup is a different webview, so reaching it means going through Tauri.
 */
export async function emitNative(event: string, payload?: unknown): Promise<void> {
  if (!isTauri()) return;
  const { emit: send } = await import('@tauri-apps/api/event');
  await send(event, payload);
}

/** Listens for one of those, from whichever window sent it. */
export async function listenNative(
  event: string,
  fn: (payload: any) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen(event, (e) => fn(e.payload));
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
      'game:state',
      'game:intent',
      'game:lobby',
      'net:changed',
      'service:failed',
      'host:changed',
      'media:changed',
      'library:unreachable',
      'party:changed',
      'game:session',
      'main:away',
      'update:progress',
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
    /** Vouches for a device, or withdraws it. Persisted, unlike before. */
    trust: (peerId: string, trusted: boolean) =>
      call<void>('peers_trust', { peerId, trusted }),
    /** Everyone vouched for, whether or not they are on the network now. */
    trusted: () =>
      call<{ deviceId: string; name: string; trustedAt: number }[]>('peers_trusted'),
    /**
     * Pairing: a PIN confirmation in place of a single unconfirmed tap.
     *
     * `pairStart` shows a PIN on this device for someone to read and type
     * elsewhere; `pairConfirm` is the other half, broadcasting a PIN someone
     * just typed to every linked peer at once — mirrors `ratings.unlockPeers`
     * for the same reason, since the PIN itself does not say which device is
     * showing it. Trust, on both ends, is applied natively the moment they
     * match; see `pair:accepted` (the showing side) and `pair:result` (the
     * entering side) for how each finds out.
     */
    pairStart: () => call<string>('peers_pair_start'),
    pairCancel: () => call<void>('peers_pair_cancel'),
    pairConfirm: (pin: string) => call<number>('peers_pair_confirm', { pin }),
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
    offer: (peerId: string, paths: string[], viaChat = false) =>
      call<Transfer[]>('files_offer', { peerId, paths, viaChat }),
    /**
     * Turns whatever a picker returned into a file this device can send.
     *
     * A no-op for a desktop path. On Android it copies the content URI into
     * the app's own storage, because that is the only way to get a path.
     */
    stage: (source: string) =>
      call<{ path: string; name: string; size: number; copied: boolean }>('files_stage', {
        source,
      }),
    clearOutbox: () => call<void>('files_clear_outbox'),
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
    /**
     * Copies a file this device already has to a folder somebody just chose.
     *
     * Not a download — the file is already here, sent or received. This is
     * the "put a copy over there too" action from the media/save modal.
     */
    saveCopy: (path: string, destDir: string) =>
      call<string>('files_save_copy', { path, destDir }),
    /** Whether a saved copy is still where it was put — moved, renamed, or
     * deleted outside this app, or by its own expiry, are all real. */
    exists: (path: string) => call<boolean>('files_exists', { path }),
  },
  /** The popup in the corner of the screen. Desktop only; a no-op elsewhere. */
  hud: {
    set: (visible: boolean, height: number) => call<void>('hud_set', { visible, height }),
    resize: (height: number) => call<void>('hud_resize', { height }),
    openApp: () => call<void>('hud_open_app'),
    sync: () => call<void>('hud_sync'),
  },
  /** The built-in static server that publishes folders to the LAN. */
  /**
   * What this device is called by everything that names devices.
   *
   * Not the profile id, which is minted in the browser and means nothing to
   * anyone else. Peers are seated by this.
   */
  identity: {
    deviceId: () => call<string>('identity_device_id'),
  },
  /**
   * Whether a film is on screen.
   *
   * Only Android acts on it, where leaving the app mid-film puts the whole
   * application into a floating window because the WebView cannot pop out the
   * video alone. Everywhere else the player has a button and this does
   * nothing. A call answers for itself, from the audio mode.
   */
  pip: {
    setPlaying: (playing: boolean) => call<void>('pip_set_playing', { playing }),
  },
  host: {
    /**
     * Narrows a published folder to named devices, or (with an empty list)
     * puts it back to everyone.
     *
     * Unlisted rather than refused: the folder stops being mentioned at all,
     * because a folder that announces itself and then says no has told
     * everyone it exists.
     */
    setAudience: (shareId: string, unlisted: boolean, deviceIds: string[]) =>
      call<void>('host_set_audience', { shareId, unlisted, deviceIds }),
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
    /**
     * Pulls one title into this device's own synced library, for offline
     * viewing. Returns a transfer id straight away — the download itself
     * shows up wherever a transfer's progress already does.
     *
     * The video comes across whole, embedded audio tracks and all: no
     * `?audio=` remux, so a multi-language release keeps every track it
     * already had rather than syncing only the one the player happened to
     * be on.
     */
    sync: (item: MediaItem) =>
      call<string>('media_sync_start', {
        itemId: item.id,
        videoUrl: item.streamUrl,
        videoRelPath: item.relPath,
        size: item.sizeBytes,
        subtitleUrls: (item.subtitles ?? []).map((s) => s.url),
      }),
    /** Original item ids that already have a local, synced copy. */
    syncedIds: () => call<string[]>('media_synced_ids'),
    /** Deletes a synced copy and drops it off Theatre's shelf. */
    removeSynced: (itemId: string) => call<boolean>('media_sync_remove', { id: itemId }),
  },
  /**
   * Installing a newer version.
   *
   * The bytes are fetched and checked in `lib/update.ts` — this only stores
   * them and hands the file to the system installer.
   */
  update: {
    /**
     * Fetches the installer straight to disk and returns where it landed.
     *
     * The bytes do not pass through here. They used to: the interface fetched
     * the file, held it in memory, hashed it, and handed all forty megabytes
     * back down to be written — which is a phone's javascript heap doing work
     * it has no business doing, and which stopped working on Android.
     */
    download: (url: string, name: string, expected?: string) =>
      call<string>('update_download', { url, name, expected: expected ?? null }),
    /** Opens it with the system installer. */
    launch: (path: string) => call<void>('update_launch', { path }),
  },
  /** WebRTC negotiation. The media itself never comes through here. */
  call: {
    /** Returns false when there is no live link to that peer. */
    signal: (peerId: string, payload: unknown) =>
      call<boolean>('call_signal', { peerId, payload }),
    /**
     * Sends call audio to the earpiece, or back out to the loudspeaker.
     *
     * Only a phone has anywhere else to send it; a desktop returns false and
     * carries on. False also means the device has no earpiece at all — a
     * tablet or a television — which is left alone rather than silenced.
     */
    earpiece: (earpiece: boolean) => call<boolean>('call_audio_earpiece', { earpiece }),
    /** Hands the audio stack back when the call ends. */
    resetAudio: () => call<void>('call_audio_reset'),
  },
  /** Android's battery optimizer, a second gate on top of the foreground service. */
  battery: {
    /** Always true on desktop, which has no optimizer to be exempt from. */
    unrestricted: () => call<boolean>('battery_unrestricted'),
    /** Opens the system dialogue that grants the exemption. */
    requestUnrestricted: () => call<void>('battery_request_unrestricted'),
  },
  /** Shared games across devices. */
  game: {
    start: (game: GameKind, peerIds: string[], seed: number) =>
      call<GameSession>('game_start', { game, peerIds, seed }),
    /** Says yes to an invitation, so the host knows somebody is there. */
    join: (sessionId: string) => call<boolean>('game_join', { sessionId }),
    /**
     * Starts the match for everybody at once. Host only.
     *
     * Seats are fixed here rather than when the invitations went out: people
     * are still arriving until somebody says go, and anyone who never
     * answered is dropped rather than left holding a seat the game waits on.
     */
    begin: (sessionId: string) => call<boolean>('game_begin', { sessionId }),
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

    /**
     * The host writing down who is waiting for the next match, and what it
     * will be, then telling everybody.
     *
     * Host only - the native side ignores it from anyone else, so a peer
     * cannot deal itself in by saying it is playing.
     */
    lobby: (
      sessionId: string,
      waiting: string[],
      nextGame: GameKind | null,
      /** A rewritten seat list, when somebody has been substituted in. */
      players?: string[],
    ) =>
      call<GameSession | null>('game_lobby', {
        sessionId,
        waiting,
        nextGame,
        players: players ?? null,
      }),

    /**
     * Sends to one player rather than the table.
     *
     * `state` is the host describing the game to somebody; `intent` is a
     * player asking the host to do something. Card games need this because a
     * hand nobody else can see cannot be broadcast.
     */
    send: (peerId: string, channel: 'state' | 'intent' | 'lobby', payload: unknown) =>
      call<boolean>('game_send', { peerId, channel, payload }),
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
    /**
     * The folder of installers offered on the landing page, or '' for off.
     *
     * The page is what somebody on this network sees when they have not got
     * LANTern, so it is the only place they can be told where to get it -
     * there is no download site on a network with no way out.
     */
    installers: () => call<string>('installers_dir'),
    setInstallers: (dir: string) => call<string>('set_installers', { dir }),
    /** Turns the offer on using LANTern's own folder, and says where it is. */
    manageInstallers: () => call<string>('installers_manage'),
    /** What is in that folder now, so the screen can say what is on offer. */
    heldInstallers: () => call<{ name: string; size: number }[]>('installers_held'),
    /**
     * Fetches one release asset into it.
     *
     * One per call, so a failure names the file that failed rather than
     * abandoning the others halfway.
     */
    fetchInstaller: (url: string, name: string, expected?: string) =>
      call<void>('installers_fetch', { url, name, expected }),
    removeInstaller: (name: string) => call<void>('installers_remove', { name }),
    set: (enabled: boolean) => call<void>('service_set', { enabled }),
    running: () => call<boolean>('service_running'),
    /**
     * Why published folders are not being served, or null when they are.
     *
     * The failure happens while the window is still loading, so the event
     * announcing it has nobody to reach. This is the same answer, asked for.
     */
    status: () => call<string | null>('host_status'),
    /** Tries the port again. False when it was not down to begin with. */
    retry: () => call<boolean>('host_retry'),
  },
  /**
   * Driving another device, and being driven.
   *
   * The asking is deliberately asymmetric: this side can only ever request,
   * and only the machine being controlled can answer.
   */
  control: {
    request: (peerId: string) => call<void>('control_request', { peerId }),
    answer: (peerId: string, allow: boolean, remember: boolean) =>
      call<void>('control_answer', { peerId, allow, remember }),
    end: () => call<void>('control_end'),
    send: (peerId: string, events: unknown[]) => call<void>('control_send', { peerId, events }),
    /** Where to fetch that peer's screen, once it has granted control. */
    screenUrl: (peerId: string, token: string) =>
      call<string>('control_screen_url', { peerId, token }),
    /** Asks them to send their screen as video rather than as still frames. */
    askScreen: (peerId: string) => call<void>('control_ask_screen', { peerId }),
    /**
     * Whether this machine hands over its screen with no picker.
     *
     * Takes effect at the next launch: a browser's switches are fixed when
     * the browser starts.
     */
    autoShareGet: () => call<boolean>('autoshare_get'),
    autoShareSet: (on: boolean) => call<void>('autoshare_set', { on }),
    status: () => call<ControlStatus>('control_status'),
    forget: (peerId: string) => call<void>('control_forget', { peerId }),
  },
  /** Waking a device that has gone to sleep. */
  wake: {
    /** Returns how many packets went out. Nothing acknowledges them. */
    send: (mac: string) => call<number>('wake_device', { mac }),
    list: () => call<Wakeable[]>('wakeable'),
  },
  /**
   * Age limits, set by the device holding the files.
   *
   * Only ever meaningful on the host: a viewer cannot raise its own
   * allowance, because it never asks — it presents a key and the machine
   * with the bytes decides what that key may see.
   */
  ratings: {
    status: () => call<RatingsStatus>('ratings_status'),
    setDevice: (deviceId: string, maxAge: number) =>
      call<void>('ratings_set_device', { deviceId, maxAge }),
    setDefault: (maxAge: number) => call<void>('ratings_set_default', { maxAge }),
    /** Null clears the host's rating and returns the title to the guess. */
    setTitle: (streamPath: string, minAge: number | null) =>
      call<void>('ratings_set_title', { streamPath, minAge }),
    /**
     * The same for a whole selection — a season, a series, a folder.
     *
     * One call rather than one per episode: thirty-four requests to express a
     * single decision is thirty-four chances for one of them to be the one
     * that did not land.
     */
    setTitles: (streamPaths: string[], minAge: number | null) =>
      call<number>('ratings_set_titles', { streamPaths, minAge }),
    /**
     * Lets one device past the rating without changing what it is allowed.
     *
     * `streamPath` of `*` covers everything; `minutes` of null never lapses,
     * which is what approving a single title means — a film does not stop
     * being approved halfway through.
     */
    approve: (deviceId: string, streamPath: string, minutes: number | null) =>
      call<void>('ratings_approve', { deviceId, streamPath, minutes }),
    revoke: (deviceId: string, streamPath: string) =>
      call<void>('ratings_revoke', { deviceId, streamPath }),
    /** Every approval still standing. Lapsed ones are not listed. */
    approvals: () =>
      call<
        {
          deviceId: string;
          name: string;
          streamPath: string;
          title: string;
          expiresAt: number;
        }[]
      >('ratings_approvals'),

    /*
     * Pass phrases, the other way past the rating gate.
     *
     * An approval needs the host present, looking at a specific device and
     * a specific title, saying yes. A phrase needs neither: whoever knows
     * the number unlocks the tier on whatever they are holding, and the
     * number is the whole of the secret — never read back by anything,
     * including this application's own screens.
     */
    pinSet: (age: number, phrase: string) => call<void>('rating_pin_set', { age, phrase }),
    /** Which tiers have a phrase set. Never the phrases themselves. */
    pins: () => call<number[]>('rating_pins'),
    /** Tries a phrase against this device's own rating store. */
    unlock: (phrase: string) => call<number | null>('rating_unlock', { phrase }),
    /** What this device has already typed its way into, if anything. */
    unlocked: () => call<number | null>('rating_unlocked'),
    /** Puts this device's own lock back, so the next title asks again. */
    relock: () => call<void>('rating_relock'),
    /**
     * Tries one phrase against every host this device is linked to right
     * now, all at once — a phrase does not say which host it belongs to,
     * or whether it belongs to more than one. Each host answers for itself,
     * arriving as its own `rating:unlocked` event; there is no single
     * combined reply to await.
     */
    unlockPeers: (phrase: string) => call<void>('rating_unlock_peers', { phrase }),
  },
  /**
   * Rejoining a known network at startup.
   *
   * Only ever a network this machine has already saved: LANTern has no
   * password to offer and does not ask for one, so the credentials stay with
   * the operating system that already holds them.
   */
  wifi: {
    status: () => call<WifiStatus>('wifi_status'),
    /** Null turns it off. */
    setStartup: (ssid: string | null) => call<void>('wifi_set_startup', { ssid }),
    connect: (ssid: string) => call<void>('wifi_connect', { ssid }),
  },
  /** Tray and launch behaviour. No-ops in a plain browser. */
  system: {
    traySupported: () => call<boolean>('tray_supported'),
    hideToTray: () => call<void>('window_hide_to_tray'),
    showWindow: () => call<void>('window_show'),
    getAutostart: () => call<boolean>('autostart_get'),
    setAutostart: (enabled: boolean) => call<boolean>('autostart_set', { enabled }),
    /**
     * Opens the operating system's own microphone or camera privacy page.
     *
     * The addresses are fixed natively rather than passed from here: a command
     * that opens whatever URL it is handed is a command that opens anything.
     */
    openPrivacySettings: (kind: 'microphone' | 'camera') =>
      call<boolean>('open_privacy_settings', { kind }),
    /**
     * Opens a web address in the system browser.
     *
     * Not `files.open`: a path and a URL are different things to the operating
     * system, and asking it to open an https address as a file did nothing at
     * all on Android.
     */
    openExternal: (url: string) => call<void>('open_external', { url }),
    /**
     * What a panic hook wrote down on the way out last time, if it wrote
     * anything. `panic = "abort"` on every platform means the process is
     * gone before any UI could show this live — this is the one chance,
     * read once at the next launch and cleared the moment it is.
     */
    lastCrash: () => call<string | null>('debug_last_crash'),
    /**
     * Writes one line to a rolling on-disk log, kept across reloads and
     * restarts — the backhaul for whatever a live debugging session would
     * otherwise need to be attached at the exact moment to catch. Fire and
     * forget: a diagnostic write that itself needed handling would defeat
     * the point.
     */
    logError: (level: 'error' | 'warn' | 'info', message: string) =>
      call<void>('debug_log', { level, message }),
    /** The log as it stands, for exporting or reading back. */
    errorLog: () => call<string>('debug_client_log'),
  },
  profile: {
    os: () => call<string>('host_os'),
    /**
     * Tells one peer what this device looks like.
     *
     * Per peer rather than broadcast because it goes down the signalling
     * link, and there is one of those per peer. Discovery cannot carry it:
     * an mDNS TXT record is a few hundred bytes.
     */
    send: (peerId: string, payload: { name: string; color: string; emoji: string; avatar?: string }) =>
      call<boolean>('profile_send', { peerId, payload }),
    /**
     * Tells the network what to call you.
     *
     * The name is typed and stored in the frontend; the announcement happens
     * natively. Until these were connected every device advertised only its
     * hostname, so the network was a list of machines rather than of people.
     */
    announce: (name: string) => call<void>('profile_announce', { name }),
    /** Stores a 500x500 PNG. An empty array clears it. */
    setAvatar: (png: number[]) => call<void>('profile_set_avatar', { png }),
    hasAvatar: () => call<boolean>('profile_has_avatar'),
  },
};
