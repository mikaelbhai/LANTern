import { create } from 'zustand';
import { api, emit, on } from './bridge';
import { sfx } from './audio';
import * as rtc from './webrtc';
import { notifyMessage } from './ringer';
import { gameName } from './games';
import { emptyScores, record } from './scores';
import type { Result, Scores } from './scores';
import type {
  ActivityItem,
  Attachment,
  CallKind,
  CallLogEntry,
  CallSession,
  GameKind,
  Message,
  NetInfo,
  Peer,
  Profile,
  Room,
  Share,
  Transfer,
  VoiceClip,
  GameSession,
} from './types';
import { uid } from './utils';

/**
 * Call offers waiting for the user to answer, keyed by call id.
 *
 * Kept out of the store deliberately: this holds an SDP description, which is
 * neither serialisable nor something any component should re-render on.
 */
const pendingOffers = new Map<string, rtc.SignalMessage>();

/** What `deliver` on the Rust side stamps onto an inbound chat envelope. */
interface InboundChat {
  from: string;
  roomId?: string;
  message?: Message;
  reaction?: { messageId: string; emoji: string };
}

const LS_KEY = 'lantern.state.v1';

export type Density = 'compact' | 'cozy' | 'spacious';
export type ThemeMode = 'dark' | 'light' | 'system';

export interface Settings {
  theme: ThemeMode;
  accent: string;
  fontSize: 'small' | 'medium' | 'large';
  density: Density;
  sidebarCollapsed: boolean;
  notifications: {
    message: boolean;
    mention: boolean;
    call: boolean;
    file: boolean;
    sound: boolean;
    dnd: boolean;
    dndFrom: string;
    dndTo: string;
    dndSchedule: boolean;
  };
  calls: {
    camera: string;
    mic: string;
    speaker: string;
    lowBandwidth: boolean;
    noiseSuppression: boolean;
    pushToTalk: boolean;
    pushToTalkKey: string;
    recordingPath: string;
  };
  files: {
    downloadDir: string;
    autoAcceptTrusted: boolean;
    defaultExpiry: 'never' | '1h' | '6h' | '24h' | '7d';
    zipFolders: boolean;
  };
  network: {
    port: number;
    stunPort: number;
    mdnsName: string;
    relayHub: boolean;
    relayCapMbps: number;
    upnp: boolean;
  };
  privacy: { appLock: boolean; pin: string };
}

const defaultSettings: Settings = {
  theme: 'dark',
  accent: '#F5A623',
  fontSize: 'medium',
  density: 'cozy',
  sidebarCollapsed: false,
  notifications: {
    message: true,
    mention: true,
    call: true,
    file: true,
    sound: true,
    dnd: false,
    dndFrom: '22:00',
    dndTo: '08:00',
    dndSchedule: false,
  },
  calls: {
    camera: 'default',
    mic: 'default',
    speaker: 'default',
    lowBandwidth: false,
    noiseSuppression: true,
    pushToTalk: false,
    pushToTalkKey: 'Space',
    recordingPath: '',
  },
  files: {
    downloadDir: '',
    autoAcceptTrusted: true,
    defaultExpiry: 'never',
    zipFolders: true,
  },
  network: {
    port: 7979,
    stunPort: 7980,
    mdnsName: '',
    relayHub: false,
    relayCapMbps: 0,
    upnp: true,
  },
  privacy: { appLock: false, pin: '' },
};

export interface Toast {
  id: string;
  title: string;
  body?: string;
  kind: 'info' | 'success' | 'error';
  peerId?: string;
  action?: { label: string; run: () => void };
  /** How many times this same message has arrived while it was on screen. */
  count?: number;
}

/** Beyond this many, the oldest goes to make room. */
const TOASTS_AT_ONCE = 4;

interface State {
  ready: boolean;
  onboarded: boolean;
  profile: Profile;
  settings: Settings;

  peers: Record<string, Peer>;
  net: NetInfo | null;

  rooms: Record<string, Room>;
  messages: Record<string, Message[]>;
  drafts: Record<string, string>;
  typing: Record<string, Record<string, number>>;
  saved: string[];
  activeRoomId: string | null;
  threadRootId: string | null;

  transfers: Record<string, Transfer>;
  shares: Share[];
  call: CallSession | null;
  callLog: CallLogEntry[];

  activity: ActivityItem[];
  toasts: Toast[];

  activeGame: { kind: GameKind; opponentId?: string } | null;
  /**
   * The game everyone is playing together, if there is one.
   *
   * Held here rather than in the Games screen because it arrives while you are
   * somewhere else entirely — usually mid-call — and has to be able to pull
   * you in from wherever you are.
   */
  gameSession: GameSession | null;
  setGameSession: (s: GameSession | null) => void;
  /**
   * A game you walked out of, kept for a minute in case you meant to come
   * back.
   *
   * Leaving is usually an accident — a stray back press, a tab closed, a call
   * that had to be answered — and the others are still sitting there. The seat
   * is held rather than collapsed the instant somebody steps away.
   */
  heldGame: { session: GameSession; until: number } | null;
  holdGame: (session: GameSession) => void;
  rejoinGame: () => void;
  dropHeldGame: () => void;
  /**
   * A match running on the network that you are not in.
   *
   * Kept so the Games screen can offer the next one. Without it a late
   * arrival sees an ordinary menu and no sign that four people are already
   * playing.
   */
  nearbyGame: GameSession | null;
  /** Wins and points, kept between sessions. */
  scores: Scores;
  /** Writes down a finished match. Safe to call more than once for the same one. */
  recordResult: (r: Result) => void;
  /** Ask the host of `nearbyGame` to deal you in next time. */
  joinNextMatch: () => void;
  leaveNextMatch: () => void;
  /** Ask for the next match to be a different game. */
  proposeNextGame: (game: GameKind) => void;
  /**
   * Swap somebody waiting into somebody else's seat, mid-match.
   *
   * The two change places: whoever comes out joins the queue. Host only —
   * everybody else asks, through `askToSubOut`.
   */
  substitute: (out: string, incoming: string) => void;
  /** Ask to be replaced by whoever is first in the queue. */
  askToSubOut: () => void;
  /**
   * Start the match everyone has been waiting for. Host only.
   *
   * Takes the players still here plus whoever queued, and whatever game was
   * asked for.
   */
  startNextMatch: () => Promise<void>;

  // actions
  init: () => Promise<void>;
  completeOnboarding: (p: Partial<Profile>) => void;
  setProfile: (p: Partial<Profile>) => void;
  setSettings: (fn: (s: Settings) => Settings) => void;

  ensureDm: (peerId: string) => string;
  createRoom: (name: string, members: string[], kind: Room['kind']) => string;
  deleteRoom: (roomId: string) => void;
  openRoom: (roomId: string | null) => void;
  setDraft: (roomId: string, text: string) => void;
  openThread: (messageId: string | null) => void;

  sendMessage: (roomId: string, input: Partial<Message>) => void;
  editMessage: (id: string, body: string) => void;
  deleteMessage: (id: string) => void;
  toggleReaction: (id: string, emoji: string) => void;
  togglePin: (roomId: string, messageId: string) => void;
  toggleSaved: (messageId: string) => void;
  markRoomRead: (roomId: string) => void;

  startCall: (kind: CallKind, peerIds: string[], roomId?: string) => void;
  answerCall: () => void;
  endCall: () => void;
  /**
   * Whether this microphone is muted.
   *
   * Held here rather than in the call overlay because the corner popup can
   * mute too, and two copies of a flag that decides whether people can hear
   * you is exactly the arrangement that gets somebody overheard.
   */
  micMuted: boolean;
  setMicMuted: (muted: boolean) => void;
  updateCall: (fn: (c: CallSession) => CallSession) => void;

  addTransfers: (t: Transfer[]) => void;
  updateTransfer: (t: Transfer) => void;
  setShares: (s: Share[]) => void;

  pushActivity: (a: Omit<ActivityItem, 'id' | 'ts'>) => void;
  toast: (t: Omit<Toast, 'id'>) => void;
  /**
   * A file someone is offering, waiting on a yes or no.
   *
   * Held in the store rather than in the Files screen so the question follows
   * you — a transfer offered while you are in a call or watching something
   * should not sit unseen behind them.
   */
  pendingOffer: Transfer | null;
  clearPendingOffer: () => void;
  dismissToast: (id: string) => void;

  setActiveGame: (g: State['activeGame']) => void;
}

function loadPersisted(): Partial<State> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const p = JSON.parse(raw);
    return {
      onboarded: p.onboarded,
      profile: p.profile,
      settings: { ...defaultSettings, ...p.settings },
      rooms: p.rooms ?? {},
      messages: p.messages ?? {},
      saved: p.saved ?? [],
      callLog: p.callLog ?? [],
      activity: p.activity ?? [],
      // Whitelisted like the rest: anything not named here is written on save
      // and silently dropped on load, which is a record that resets every
      // time the application starts.
      scores: p.scores ?? emptyScores(),
    };
  } catch {
    return {};
  }
}

let saveTimer: number | undefined;
function persist(s: State) {
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      // Attachment data URLs are large and re-derivable; keep them out of storage.
      const messages: Record<string, Message[]> = {};
      for (const [rid, list] of Object.entries(s.messages)) {
        messages[rid] = list.slice(-500).map((m) => ({
          ...m,
          // A message without attachments has none rather than an empty list,
          // depending on where it came from, and this ran on every save — so a
          // single such message threw on a timer, forever.
          attachments: (m.attachments ?? []).map(({ dataUrl, ...a }) => a),
        }));
      }
      localStorage.setItem(
        LS_KEY,
        JSON.stringify({
          onboarded: s.onboarded,
          profile: s.profile,
          settings: s.settings,
          rooms: s.rooms,
          messages,
          saved: s.saved,
          callLog: s.callLog.slice(-200),
          activity: s.activity.slice(0, 100),
          scores: s.scores,
        }),
      );
    } catch {
      /* quota exceeded — state stays in memory for this session */
    }
  }, 400);
}

const AVATAR_COLORS = [
  '#F5A623', '#39D9C8', '#9B8CFF', '#E05C5C',
  '#7BD88F', '#FF8FC7', '#5BA9F5', '#FFD17A',
];

/**
 * Spells out who "me" is in a session.
 *
 * The native side writes the host into its own session as the literal string
 * "me" and broadcasts that verbatim, so every device receives a list in which
 * one entry means "whoever sent this". Left alone, a peer reading its own id
 * into that entry merges the host's seat with its own: a three-handed game
 * shows three seats on the host's screen and two on everybody else's.
 *
 * Resolving it once, here, means the rest of the application can treat a
 * session's players as ordinary peer ids — which is also what lets a seat keep
 * its place when somebody is substituted into it.
 */
function qualify(session: GameSession, hostId: string): GameSession {
  const name = (p: string) => (p === 'me' ? hostId : p);
  return {
    ...session,
    hostId: name(session.hostId),
    players: session.players.map(name),
    waiting: session.waiting?.map(name),
  };
}

/**
 * Puts this device's chosen name on the network.
 *
 * Quietly ignored where there is no native layer — in a plain browser there is
 * nothing to announce to.
 */
function announceName(name: string): void {
  void api.profile.announce(name ?? '').catch(() => {});
}

/** Guards against double-registering bridge listeners (StrictMode remounts). */
let initialised = false;

export const useStore = create<State>((set, get) => {
  const persisted = loadPersisted();

  /**
   * Puts a message on screen, briefly.
   *
   * Two things stop the corner filling up. The same message arriving again
   * while it is still showing counts up rather than stacking - five identical
   * "someone started a game" cards say nothing that one saying "x5" does not.
   * And whatever survives that is capped, because a column of toasts taller
   * than the window hides the thing they are about.
   */
  const notify = (t: Omit<Toast, 'id'>) => {
    const same = (a: Omit<Toast, 'id'>, b: Toast) =>
      a.kind === b.kind && a.title === b.title && a.body === b.body && !a.action && !b.action;

    const existing = get().toasts.find((x) => same(t, x));
    if (existing) {
      set((s) => ({
        toasts: s.toasts.map((x) =>
          x.id === existing.id ? { ...x, count: (x.count ?? 1) + 1 } : x,
        ),
      }));
      // Its life starts again, so a repeating message stays up while it repeats.
      setTimeout(() => get().dismissToast(existing.id), 5200);
      return;
    }

    const toast = { ...t, id: uid() };
    set((s) => ({ toasts: [...s.toasts, toast].slice(-TOASTS_AT_ONCE) }));
    setTimeout(() => get().dismissToast(toast.id), 5200);
  };

  return {
    ready: false,
    onboarded: persisted.onboarded ?? false,
    profile:
      persisted.profile ??
      {
        id: uid(),
        name: '',
        color: AVATAR_COLORS[0],
        emoji: '🏮',
        statusMessage: '',
        deviceNickname: '',
      },
    settings: persisted.settings ?? defaultSettings,

    peers: {},
    net: null,

    rooms: persisted.rooms ?? {},
    messages: persisted.messages ?? {},
    drafts: {},
    typing: {},
    saved: persisted.saved ?? [],
    activeRoomId: null,
    threadRootId: null,

    transfers: {},
    shares: [],
    call: null,
    callLog: persisted.callLog ?? [],

    activity: persisted.activity ?? [],
    toasts: [],
    activeGame: null,
    gameSession: null,
    setGameSession: (session) =>
      // A session minted here has this device as its host.
      set({ gameSession: session ? qualify(session, get().profile.id) : null }),

    heldGame: null,
    /** A minute is long enough to answer a door and short enough not to strand anyone. */
    holdGame: (session) =>
      set({ gameSession: null, activeGame: null, heldGame: { session, until: Date.now() + 60_000 } }),
    rejoinGame: () => {
      const held = get().heldGame;
      if (!held || Date.now() > held.until) {
        set({ heldGame: null });
        return;
      }
      // The minute you were away is long enough for the host to have gone,
      // and the seat you are going back to only exists on their device.
      const me = get().profile.id;
      const host = held.session.hostId;
      if (host !== 'me' && host !== me && !get().peers[host]) {
        set({ heldGame: null });
        get().toast({
          kind: 'info',
          title: 'That game has ended',
          body: 'The device running it left the network.',
        });
        return;
      }
      set({ heldGame: null, gameSession: held.session, activeGame: { kind: held.session.game } });
    },
    dropHeldGame: () => set({ heldGame: null }),
    pendingOffer: null,
    clearPendingOffer: () => set({ pendingOffer: null }),
    nearbyGame: null,
    scores: persisted.scores ?? emptyScores(),

    recordResult(result) {
      const me = get().profile.id;
      const peers = get().peers;
      // Names are captured now so a record still reads properly after the
      // person it belongs to has gone home.
      const names: Record<string, string> = { ...(result.names ?? {}) };
      for (const id of result.players) {
        if (names[id]) continue;
        names[id] = id === me ? get().profile.name || 'You' : (peers[id]?.name ?? 'Someone');
      }

      const next = record(get().scores, { ...result, names }, me);
      if (next === get().scores) return;
      set({ scores: next });
      persist(get());
    },

    joinNextMatch() {
      const session = get().nearbyGame;
      if (!session) return;
      void api.game.send(session.hostId, 'lobby', { t: 'wait' }).catch(() => {});
    },
    leaveNextMatch() {
      const session = get().nearbyGame;
      if (!session) return;
      void api.game.send(session.hostId, 'lobby', { t: 'unwait' }).catch(() => {});
    },
    proposeNextGame(game) {
      const session = get().nearbyGame ?? get().gameSession;
      if (!session) return;
      const me = get().profile.id;
      // The host changes it directly; everybody else has to ask.
      if (session.hostId === 'me' || session.hostId === me) {
        void api.game
          .lobby(session.id, session.waiting ?? [], game)
          .then((s) => s && set({ gameSession: s }))
          .catch(() => {});
        return;
      }
      void api.game.send(session.hostId, 'lobby', { t: 'next', game }).catch(() => {});
    },

    substitute(out, incoming) {
      const session = get().gameSession;
      const me = get().profile.id;
      if (!session || session.hostId !== me) return;

      const waiting = session.waiting ?? [];
      if (!session.players.includes(out) || !waiting.includes(incoming)) return;

      // They change places. The seat keeps its position in the list, which is
      // what keeps the turn order and everything hanging off it intact.
      const players = session.players.map((p) => (p === out ? incoming : p));
      const queue = waiting.map((p) => (p === incoming ? out : p));

      void api.game
        .lobby(session.id, queue, session.nextGame ?? null, players)
        .then((s) => {
          if (!s) return;
          set({ gameSession: { ...s, hostId: me, players, waiting: queue } });
          get().toast({
            kind: 'info',
            title: `${get().peers[incoming]?.name ?? 'Someone'} is in`,
            body: `They took ${out === me ? 'your' : `${get().peers[out]?.name ?? 'a'}’s`} seat.`,
          });
        })
        .catch(() => {});
    },

    askToSubOut() {
      const session = get().gameSession;
      const me = get().profile.id;
      if (!session) return;
      if (session.hostId === me) {
        // The host does not have to ask anybody.
        const first = (session.waiting ?? [])[0];
        if (first) get().substitute(me, first);
        return;
      }
      void api.game.send(session.hostId, 'lobby', { t: 'subout' }).catch(() => {});
    },

    async startNextMatch() {
      const session = get().gameSession;
      const me = get().profile.id;
      if (!session) return;
      if (session.hostId !== 'me' && session.hostId !== me) return;

      const online = get().peers;
      // Anybody who has gone offline in the meantime is not dealt in again.
      const here = session.players
        .map((p) => (p === 'me' ? me : p))
        .filter((id) => id === me || !!online[id]);
      const queued = (session.waiting ?? []).filter((id) => !!online[id]);
      const players = Array.from(new Set([...here, ...queued])).filter((id) => id !== me);

      const game = session.nextGame ?? session.game;
      try {
        const next = await api.game.start(game, players, Math.floor(Math.random() * 1_000_000));
        set({ gameSession: next, activeGame: { kind: game } });
      } catch {
        get().toast({ kind: 'error', title: 'Could not start the next match' });
      }
    },
    micMuted: false,
    setMicMuted: (micMuted) => set({ micMuted }),

    async init() {
      if (initialised) return;
      initialised = true;

      on('peer:joined', (p: Peer) => {
        set((s) => ({ peers: { ...s.peers, [p.id]: p } }));
        get().pushActivity({ kind: 'peer', text: `${p.name} joined the network`, peerId: p.id });
        if (get().settings.notifications.sound) sfx.peerJoin();
      });
      on('peer:updated', (p: Peer) =>
        set((s) => (s.peers[p.id] ? { peers: { ...s.peers, [p.id]: { ...s.peers[p.id], ...p } } } : {})),
      );
      on('peer:left', (id: string) => {
        const p = get().peers[id];
        set((s) => {
          const peers = { ...s.peers };
          delete peers[id];
          return { peers };
        });
        if (p) get().pushActivity({ kind: 'peer', text: `${p.name} left the network`, peerId: id });

        // One device runs each game and tells the others what is happening.
        // When that device goes, nothing is coming: the board freezes on
        // whatever it last said and every click does nothing. Saying so and
        // clearing it beats leaving people staring at a turn that will never
        // arrive.
        const session = get().gameSession;
        if (session && session.hostId === id) {
          set({ gameSession: null, activeGame: null, heldGame: null });
          get().toast({
            kind: 'info',
            title: 'The game ended',
            body: `${p?.name ?? 'The host'} left, and the match was running on their device.`,
          });
        }
        if (get().nearbyGame?.hostId === id) set({ nearbyGame: null });
      });
      on('net:changed', (n: NetInfo) => set({ net: n }));

      // A service that could not bind its port. Silently, this looks exactly
      // like a quiet network: no peers, no calls, no transfers. Said out loud,
      // it points straight at the cause - usually a second copy of LANTern
      // already holding the port.
      on('service:failed', (f: { service: string; port: number; detail: string }) => {
        get().toast({
          kind: 'error',
          title: `${f.service} could not start on port ${f.port}`,
          body: `${f.detail}. Another copy of LANTern may already be running.`,
        });
        get().pushActivity({
          kind: 'peer',
          text: `${f.service} failed to bind port ${f.port}`,
        });
      });
      on('host:changed', (list: Share[]) => set({ shares: list }));
      on('transfer:progress', (t: Transfer) => get().updateTransfer(t));

      // A peer has offered a file. The Rust side has already recorded it and
      // knows where to fetch it from; all that is decided here is whether to
      // start, which for a trusted peer is immediate.
      /**
       * Somebody started a game that includes this device.
       *
       * People in a call are pulled straight in rather than asked. That is the
       * point of playing together: you are already talking, and a dialog in
       * the middle of it asking whether you would like to join the thing your
       * friend just announced out loud is a step nobody wants. Outside a call
       * it is an invitation, because being yanked into a game by someone you
       * are not talking to is another matter entirely.
       */
      on('game:session', (session: (GameSession & { from?: string }) | null) => {
        // The host clearing the session out.
        if (!session) {
          set({ gameSession: null, nearbyGame: null });
          return;
        }

        const me = get().profile.id;
        const host = session.hostId === 'me' ? (session.from ?? me) : session.hostId;
        // Everything below reads a session whose "me" has been spelled out,
        // so a seat means the same person on every device.
        const full = qualify(session, host);

        /*
         * A match nobody is running is not a match.
         *
         * One device holds the game and tells the others what is happening.
         * If that device is not on the network - it has gone, or this
         * announcement outlived it - then joining puts you on a board that
         * never moves, with no way to tell that from a slow turn.
         */
        const hostHere = host === me || !!get().peers[host];
        if (!hostHere) return;

        // And a match with a result is over. The winner is announced to the
        // table; it is not an invitation.
        if (session.winnerId) {
          if (get().gameSession?.id === session.id) set({ gameSession: full });
          else if (get().nearbyGame?.id === session.id) set({ nearbyGame: null });
          return;
        }

        if (!full.players.includes(me)) {
          // Not dealt in, but worth knowing about: the Games screen offers
          // the next one rather than pretending nothing is happening.
          set({ nearbyGame: full });
          return;
        }

        set({ nearbyGame: null, gameSession: full });

        const inCall = !!get().call && get().call?.state === 'active';
        const alreadyPlaying = get().activeGame?.kind === session.game;

        if (inCall && !alreadyPlaying) {
          set({ activeGame: { kind: session.game } });
        } else if (!inCall && !alreadyPlaying) {
          get().toast({
            kind: 'info',
            title: 'Game invitation',
            body: `${get().peers[session.from ?? '']?.name ?? 'Someone'} started ${gameName(session.game)}`,
          });
        }
      }),

      /*
       * Somebody asking to be in the next match, or for it to be something
       * else. Only the host acts on this; everybody else has no session to
       * change and ignores it.
       */
      on('game:lobby', (msg: { from?: string; t?: string; game?: GameKind }) => {
        const session = get().gameSession;
        const me = get().profile.id;
        if (!session || !msg?.from) return;
        if (session.hostId !== 'me' && session.hostId !== me) return;

        const waiting = session.waiting ?? [];
        let next = waiting;
        let nextGame = session.nextGame ?? null;

        if (msg.t === 'wait' && !waiting.includes(msg.from)) {
          // Somebody already playing does not also need a place in the queue.
          if (session.players.includes(msg.from)) return;
          next = [...waiting, msg.from];
          get().toast({
            kind: 'info',
            title: `${get().peers[msg.from]?.name ?? 'Someone'} is waiting to play`,
            body: 'They will be dealt into the next match.',
          });
        } else if (msg.t === 'unwait') {
          next = waiting.filter((id) => id !== msg.from);
        } else if (msg.t === 'subout') {
          // Somebody in the game asking to be let out, and there is a queue.
          const first = waiting[0];
          if (first && session.players.includes(msg.from)) {
            get().substitute(msg.from, first);
          }
          return;
        } else if (msg.t === 'next' && msg.game) {
          nextGame = msg.game;
          get().toast({
            kind: 'info',
            title: 'Next match changed',
            body: `${get().peers[msg.from]?.name ?? 'Someone'} suggested ${gameName(msg.game)}.`,
          });
        } else {
          return;
        }

        void api.game
          .lobby(session.id, next, nextGame)
          .then((s) => s && set({ gameSession: s }))
          .catch(() => {});
      }),

      on('transfer:offer', (t: Transfer) => {
        get().addTransfers([t]);
        const peer = get().peers[t.peerId];
        // Ask, unless this peer is trusted and set to come straight through.
        if (!(peer?.trusted && get().settings.files.autoAcceptTrusted)) {
          set({ pendingOffer: t });
        }
        // Anything else waits as "queued" for the user to accept, so a device
        // on the network cannot push files at you unasked.
        if (peer?.trusted && get().settings.files.autoAcceptTrusted) {
          void api.files.accept(t.id);
        }
        if (get().settings.notifications.file && !get().settings.notifications.dnd) {
          get().toast({
            kind: 'info',
            title: `${peer?.name ?? 'A peer'} is sending a file`,
            body: t.name,
          });
        }
      });
      // Inbound chat.
      //
      // Room ids are minted per device, so the id the sender used means
      // nothing here unless we happen to share it — a direct message belongs
      // in our conversation with whoever sent it. Until this existed the Rust
      // side received messages correctly and emitted them to nobody, which
      // made chat look send-only from both ends.
      on('message:received', (p: InboundChat) => {
        if (!p?.from) return;

        if (p.reaction) {
          const { messageId, emoji } = p.reaction;
          set((s) => {
            const messages = { ...s.messages };
            for (const rid of Object.keys(messages)) {
              messages[rid] = messages[rid].map((m) => {
                if (m.id !== messageId) return m;
                const current = m.reactions[emoji] ?? [];
                if (current.includes(p.from)) return m;
                return { ...m, reactions: { ...m.reactions, [emoji]: [...current, p.from] } };
              });
            }
            return { messages };
          });
          persist(get());
          return;
        }

        const incoming = p.message;
        if (!incoming?.id) return;

        const roomId = p.roomId && get().rooms[p.roomId] ? p.roomId : get().ensureDm(p.from);
        const msg: Message = {
          ...incoming,
          roomId,
          // Trust the transport over the payload: the envelope's sender is
          // authenticated by the link, the body is only what it claimed to be.
          authorId: p.from,
          // An older or hand-rolled sender may omit the collection fields;
          // the rest of the app assumes they are always present.
          reactions: incoming.reactions ?? {},
          attachments: incoming.attachments ?? [],
          mentions: incoming.mentions ?? [],
          deliveredTo: incoming.deliveredTo ?? [],
          seenBy: incoming.seenBy ?? [],
        };

        let accepted = false;
        set((s) => {
          const list = s.messages[roomId] ?? [];
          // A re-established link can replay the tail of a conversation.
          if (list.some((m) => m.id === msg.id)) return {};
          accepted = true;
          const room = s.rooms[roomId];
          const isOpen = s.activeRoomId === roomId;
          return {
            messages: { ...s.messages, [roomId]: [...list, msg] },
            rooms: room
              ? { ...s.rooms, [roomId]: { ...room, unread: isOpen ? 0 : room.unread + 1 } }
              : s.rooms,
          };
        });

        if (!accepted) return;
        const settings = get().settings.notifications;
        if (settings.sound && !settings.dnd) sfx.messageIn();

        // The window may be in the tray, or the phone in a pocket. Without
        // this a message arriving was completely silent unless you happened
        // to be looking at the conversation.
        if (settings.message && !settings.dnd) {
          notifyMessage(get().peers[p.from]?.name ?? 'A peer', msg.body || 'Sent an attachment');
        }
        persist(get());
      });

      // Someone is calling this device. The overlay rings on `state: ringing`,
      // and the ringer raises an OS notification alongside it.
      rtc.startCallSignalling();
      rtc.onIncomingCall((msg) => {
        // Already busy: decline rather than leaving the caller ringing out.
        if (get().call) {
          rtc.declineCall(msg.from, msg.callId, msg.kind);
          return;
        }
        pendingOffers.set(msg.callId, msg);
        set({
          call: {
            id: msg.callId,
            kind: msg.kind,
            participants: [
              {
                peerId: msg.from,
                name: get().peers[msg.from]?.name,
                muted: false,
                camOn: msg.kind === 'video',
                speaking: false,
                volume: 1,
                handRaised: false,
                talkMs: 0,
                sharing: false,
              },
            ],
            startedAt: Date.now(),
            state: 'ringing',
            // What marks this as a call coming in rather than one going out.
            incomingFrom: msg.from,
            layout: 'grid',
            recording: false,
            lowBandwidth: get().settings.calls.lowBandwidth,
            pip: false,
          },
        });
      });

      // Media is flowing. For the caller this is the only signal that the
      // other side picked up, and without it the call sat on "Calling…" for
      // its whole duration.
      rtc.onCallConnected((peerId) => {
        const call = get().call;
        if (!call || !call.participants.some((p) => p.peerId === peerId)) return;
        if (call.state === 'active') return;
        set({ call: { ...call, state: 'active', startedAt: Date.now() } });
        sfx.callConnect();
      });

      rtc.onCallEnded((peerId, reason) => {
        const call = get().call;
        if (!call || !call.participants.some((p) => p.peerId === peerId)) return;
        pendingOffers.delete(call.id);
        get().toast({
          kind: reason === 'failed' ? 'error' : 'info',
          title:
            reason === 'declined'
              ? `${get().peers[peerId]?.name ?? 'They'} declined`
              : reason === 'failed'
                ? 'Call connection failed'
                : 'Call ended',
        });
        get().endCall();
      });

      on('typing', ({ peerId }: { peerId: string }) => {
        const rid = Object.values(get().rooms).find(
          (r) => r.kind === 'dm' && r.members.includes(peerId),
        )?.id;
        if (!rid) return;
        set((s) => ({
          typing: { ...s.typing, [rid]: { ...(s.typing[rid] ?? {}), [peerId]: Date.now() } },
        }));
      });

      const net = await api.net.info();

      // Load the peers that already exist.
      //
      // Rust starts discovery in setup(), before the webview loads, so every
      // peer found in that window fired a `peer:joined` nobody was listening
      // to. The store then sat empty for the whole session — showing
      // "0 peers online" for devices it could nonetheless call, because the
      // Rust side had them all along.
      // `?? []` as well as `.catch`: a call can *resolve* with null rather than
      // reject, and then the catch never runs. That threw here on every start
      // in the browser, inside init and before `ready` was ever set — so the
      // app came up half-initialised with no error anyone would see.
      const known = (await api.peers.list().catch(() => [] as Peer[])) ?? [];
      const seeded = Object.fromEntries(known.map((p) => [p.id, p]));

      // Transfers survive a reload the same way, for the same reason.
      const transfers = (await api.files.list().catch(() => [] as Transfer[])) ?? [];

      set({
        net,
        peers: seeded,
        transfers: Object.fromEntries(transfers.map((t) => [t.id, t])),
        ready: true,
      });

      // The name lives here and the announcement lives natively, so the two
      // have to be introduced on every start.
      announceName(get().profile.name);

      // Expire stale typing indicators.
      setInterval(() => {
        const now = Date.now();
        set((s) => {
          const next: State['typing'] = {};
          let changed = false;
          for (const [rid, byPeer] of Object.entries(s.typing)) {
            const kept: Record<string, number> = {};
            for (const [pid, ts] of Object.entries(byPeer)) {
              if (now - ts < 4000) kept[pid] = ts;
              else changed = true;
            }
            if (Object.keys(kept).length) next[rid] = kept;
          }
          return changed ? { typing: next } : {};
        });
      }, 1500);

      // Fire scheduled messages once their time arrives.
      setInterval(() => {
        const now = Date.now();
        const due: Message[] = [];
        for (const list of Object.values(get().messages)) {
          for (const m of list) if (m.scheduledFor && m.scheduledFor <= now) due.push(m);
        }
        if (!due.length) return;
        set((s) => {
          const messages = { ...s.messages };
          for (const m of due) {
            messages[m.roomId] = messages[m.roomId].map((x) =>
              x.id === m.id ? { ...x, scheduledFor: undefined, ts: now, pending: false } : x,
            );
          }
          return { messages };
        });
      }, 5000);
    },

    completeOnboarding(p) {
      set((s) => ({ onboarded: true, profile: { ...s.profile, ...p } }));
      persist(get());
      announceName(get().profile.name);
    },

    setProfile(p) {
      set((s) => ({ profile: { ...s.profile, ...p } }));
      persist(get());
      // A rename should show up on everybody else's screen without anybody
      // restarting anything, so the network is told each time.
      announceName(get().profile.name);
    },

    setSettings(fn) {
      set((s) => ({ settings: fn(s.settings) }));
      persist(get());
    },

    ensureDm(peerId) {
      const existing = Object.values(get().rooms).find(
        (r) => r.kind === 'dm' && r.members.length === 1 && r.members[0] === peerId,
      );
      if (existing) return existing.id;
      const id = uid();
      const room: Room = {
        id,
        kind: 'dm',
        name: get().peers[peerId]?.name ?? 'Direct message',
        members: [peerId],
        createdAt: Date.now(),
        pinned: [],
        unread: 0,
        lastReadAt: Date.now(),
      };
      set((s) => ({ rooms: { ...s.rooms, [id]: room }, messages: { ...s.messages, [id]: [] } }));
      persist(get());
      return id;
    },

    createRoom(name, members, kind) {
      const id = uid();
      const room: Room = {
        id,
        kind,
        name,
        members,
        createdAt: Date.now(),
        pinned: [],
        unread: 0,
        lastReadAt: Date.now(),
      };
      set((s) => ({ rooms: { ...s.rooms, [id]: room }, messages: { ...s.messages, [id]: [] } }));
      persist(get());
      return id;
    },

    deleteRoom(roomId) {
      set((s) => {
        const rooms = { ...s.rooms };
        const messages = { ...s.messages };
        delete rooms[roomId];
        delete messages[roomId];
        return {
          rooms,
          messages,
          activeRoomId: s.activeRoomId === roomId ? null : s.activeRoomId,
        };
      });
      persist(get());
    },

    openRoom(roomId) {
      set({ activeRoomId: roomId, threadRootId: null });
      if (roomId) get().markRoomRead(roomId);
    },

    setDraft(roomId, text) {
      set((s) => ({ drafts: { ...s.drafts, [roomId]: text } }));
    },

    openThread(messageId) {
      set({ threadRootId: messageId });
    },

    sendMessage(roomId, input) {
      const me = get().profile.id;
      const msg: Message = {
        id: uid(),
        roomId,
        authorId: me,
        body: '',
        ts: Date.now(),
        reactions: {},
        attachments: [],
        mentions: [],
        deliveredTo: [],
        seenBy: [],
        ...input,
      };
      set((s) => ({
        messages: { ...s.messages, [roomId]: [...(s.messages[roomId] ?? []), msg] },
      }));
      void api.chat.send(roomId, msg, get().rooms[roomId]?.members ?? []);
      if (get().settings.notifications.sound && !msg.scheduledFor) sfx.messageOut();
      persist(get());

      // Delivery/seen receipts arrive asynchronously from the far side.
      const memberCount = get().rooms[roomId]?.members.length ?? 0;
      if (memberCount && !msg.scheduledFor) {
        const members = get().rooms[roomId].members;
        setTimeout(() => {
          set((s) => ({
            messages: {
              ...s.messages,
              [roomId]: (s.messages[roomId] ?? []).map((m) =>
                m.id === msg.id ? { ...m, deliveredTo: members } : m,
              ),
            },
          }));
        }, 420);
        setTimeout(() => {
          set((s) => ({
            messages: {
              ...s.messages,
              [roomId]: (s.messages[roomId] ?? []).map((m) =>
                m.id === msg.id ? { ...m, seenBy: members } : m,
              ),
            },
          }));
        }, 2100);
      }
    },

    editMessage(id, body) {
      set((s) => {
        const messages = { ...s.messages };
        for (const rid of Object.keys(messages)) {
          messages[rid] = messages[rid].map((m) =>
            m.id === id ? { ...m, body, editedAt: Date.now() } : m,
          );
        }
        return { messages };
      });
      persist(get());
    },

    deleteMessage(id) {
      set((s) => {
        const messages = { ...s.messages };
        for (const rid of Object.keys(messages)) {
          messages[rid] = messages[rid].map((m) =>
            m.id === id
              ? { ...m, deleted: true, body: '', attachments: [], voice: undefined, sticker: undefined, gif: undefined }
              : m,
          );
        }
        return { messages };
      });
      persist(get());
    },

    toggleReaction(id, emoji) {
      const me = get().profile.id;
      set((s) => {
        const messages = { ...s.messages };
        for (const rid of Object.keys(messages)) {
          messages[rid] = messages[rid].map((m) => {
            if (m.id !== id) return m;
            const current = m.reactions[emoji] ?? [];
            const next = current.includes(me)
              ? current.filter((x) => x !== me)
              : [...current, me];
            const reactions = { ...m.reactions };
            if (next.length) reactions[emoji] = next;
            else delete reactions[emoji];
            return { ...m, reactions };
          });
        }
        return { messages };
      });
      void api.chat.react(id, emoji);
      persist(get());
    },

    togglePin(roomId, messageId) {
      set((s) => {
        const room = s.rooms[roomId];
        if (!room) return {};
        const has = room.pinned.includes(messageId);
        const pinned = has
          ? room.pinned.filter((x) => x !== messageId)
          : [messageId, ...room.pinned].slice(0, 10);
        return { rooms: { ...s.rooms, [roomId]: { ...room, pinned } } };
      });
      persist(get());
    },

    toggleSaved(messageId) {
      set((s) => ({
        saved: s.saved.includes(messageId)
          ? s.saved.filter((x) => x !== messageId)
          : [messageId, ...s.saved],
      }));
      persist(get());
    },

    markRoomRead(roomId) {
      set((s) => {
        const room = s.rooms[roomId];
        if (!room || (room.unread === 0 && room.lastReadAt > Date.now() - 1000)) return {};
        return {
          rooms: { ...s.rooms, [roomId]: { ...room, unread: 0, lastReadAt: Date.now() } },
        };
      });
    },

    startCall(kind, peerIds, roomId) {
      const call: CallSession = {
        id: uid(),
        kind,
        roomId,
        participants: peerIds.map((peerId) => ({
          peerId,
          name: get().peers[peerId]?.name,
          muted: false,
          camOn: kind === 'video',
          speaking: false,
          volume: 1,
          handRaised: false,
          talkMs: 0,
          sharing: false,
        })),
        startedAt: Date.now(),
        state: 'connecting',
        layout: 'grid',
        recording: false,
        lowBandwidth: get().settings.calls.lowBandwidth,
        pip: false,
      };
      set({ call });

      // Negotiate for real. The session stays "connecting" until the far side
      // answers — there is no timer pretending it succeeded.
      void Promise.all(peerIds.map((peerId) => rtc.placeCall(peerId, call.id, kind)))
        .then(() => {
          set((s) => (s.call?.id === call.id ? { call: { ...s.call, state: 'ringing' } } : {}));
        })
        .catch((err: Error) => {
          set((s) => (s.call?.id === call.id ? { call: null } : {}));
          get().toast({
            kind: 'error',
            title: 'Could not start the call',
            body: err?.message ?? 'That device is not reachable.',
          });
        });
    },

    answerCall() {
      const call = get().call;
      const pending = call && pendingOffers.get(call.id);
      if (!call || !pending) return;

      void rtc
        .answerCall(pending.from, pending)
        .then(() => {
          pendingOffers.delete(call.id);
          set((s) =>
            s.call?.id === call.id
              ? { call: { ...s.call, state: 'active', startedAt: Date.now() } }
              : {},
          );
          sfx.callConnect();
        })
        .catch((err: Error) => {
          get().toast({
            kind: 'error',
            title: 'Could not answer',
            body: err?.message ?? 'The microphone or camera was unavailable.',
          });
          get().endCall();
        });
    },

    endCall() {
      const call = get().call;
      if (!call) return;
      const entry: CallLogEntry = {
        id: call.id,
        kind: call.kind,
        peers: call.participants.map((p) => p.peerId),
        startedAt: call.startedAt,
        durationMs: Date.now() - call.startedAt,
        outcome: call.state === 'ringing' ? 'missed' : 'completed',
      };
      // Declining a call that never started is a different message on the
      // wire from hanging one up, and the caller's log should say so.
      const pending = pendingOffers.get(call.id);
      if (call.state === 'ringing' && pending) {
        rtc.declineCall(pending.from, call.id, call.kind);
        pendingOffers.delete(call.id);
      } else {
        rtc.hangUp();
      }

      // Mute does not carry into the next call. Someone who muted themselves
      // an hour ago should not join the next one silent and unaware of it.
      set((s) => ({ call: null, callLog: [entry, ...s.callLog], micMuted: false }));
      sfx.callEnd();
      persist(get());
    },

    updateCall(fn) {
      set((s) => (s.call ? { call: fn(s.call) } : {}));
    },

    setShares(list) {
      set({ shares: list });
    },

    addTransfers(list) {
      set((s) => {
        const transfers = { ...s.transfers };
        for (const t of list) transfers[t.id] = t;
        return { transfers };
      });
    },

    updateTransfer(t) {
      const prev = get().transfers[t.id];
      set((s) => ({ transfers: { ...s.transfers, [t.id]: t } }));
      if (prev && prev.state !== 'done' && t.state === 'done') {
        if (get().settings.notifications.sound) sfx.transferDone();
        get().pushActivity({
          kind: 'transfer',
          text: `${t.direction === 'in' ? 'Received' : 'Sent'} ${t.name}`,
          peerId: t.peerId,
        });
      }
    },

    pushActivity(a) {
      set((s) => ({
        activity: [{ ...a, id: uid(), ts: Date.now() }, ...s.activity].slice(0, 200),
      }));
      persist(get());
    },

    toast: notify,

    dismissToast(id) {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    },

    setActiveGame(g) {
      set({ activeGame: g });
    },
  };
});

export { AVATAR_COLORS, defaultSettings };

/** Convenience selector — peers plus self, keyed by id. */
export function useDirectory() {
  const peers = useStore((s) => s.peers);
  const profile = useStore((s) => s.profile);
  return { peers, profile };
}

export function displayName(id: string): string {
  const s = useStore.getState();
  if (id === s.profile.id) return s.profile.name || 'You';
  return s.peers[id]?.name ?? 'Unknown';
}
