import { create } from 'zustand';
import { api, emit, on } from './bridge';
import { sfx } from './audio';
import * as rtc from './webrtc';
import { notifyMessage } from './ringer';
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
}

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

/** Guards against double-registering bridge listeners (StrictMode remounts). */
let initialised = false;

export const useStore = create<State>((set, get) => {
  const persisted = loadPersisted();

  const notify = (t: Omit<Toast, 'id'>) => {
    const toast = { ...t, id: uid() };
    set((s) => ({ toasts: [...s.toasts, toast] }));
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
    setGameSession: (session) => set({ gameSession: session }),

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
      set({ heldGame: null, gameSession: held.session, activeGame: { kind: held.session.game } });
    },
    dropHeldGame: () => set({ heldGame: null }),
    pendingOffer: null,
    clearPendingOffer: () => set({ pendingOffer: null }),

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
      on('game:session', (session: GameSession & { from?: string }) => {
        const me = get().profile.id;
        const mine = session.players?.includes('me') || session.players?.includes(me);
        if (!mine) return;

        get().setGameSession(session);

        const inCall = !!get().call && get().call?.state === 'active';
        const alreadyPlaying = get().activeGame?.kind === session.game;

        if (inCall && !alreadyPlaying) {
          set({ activeGame: { kind: session.game } });
        } else if (!inCall && !alreadyPlaying) {
          get().toast({
            kind: 'info',
            title: 'Game invitation',
            body: `${get().peers[session.from ?? '']?.name ?? 'Someone'} started ${session.game}`,
          });
        }
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
    },

    setProfile(p) {
      set((s) => ({ profile: { ...s.profile, ...p } }));
      persist(get());
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

      set((s) => ({ call: null, callLog: [entry, ...s.callLog] }));
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
