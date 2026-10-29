/**
 * LANTern in a browser tab, as a guest of the machine that served the page.
 *
 * Opened from `http://<host>:<port>/guest/` - not under Tauri, not the
 * simulator - the same interface runs against this instead of against Rust.
 * Where the simulator invents peers, this talks to a real one: the host. It can
 * chat with that host, play what the host publishes, and hand it files and
 * receive files from it. It cannot call or share a screen, because a browser
 * will not open a microphone, a camera or a screen on a plain `http://` page,
 * and it cannot see other devices on the network, because it is not on it the
 * way an app is.
 *
 * Anything this does not support answers `null`, which is what the simulator
 * does for a command it has never heard of and what the screens already cope
 * with. The one thing it must never do is answer with the simulator's invented
 * data: a guest looking at made-up people would believe them.
 */
import { emit } from './bridge';
import type { MediaItem, NetInfo, Peer, Transfer } from './types';

export const isGuestPage = (): boolean =>
  typeof location !== 'undefined' && location.pathname.startsWith('/guest');

export type GuestPhase =
  | 'checking'
  /** The host has not switched guest mode on. */
  | 'off'
  /** Reached a host that has no window to talk to, or no host at all. */
  | 'unreachable'
  | 'need-name'
  | 'pending'
  | 'denied'
  | 'allowed'
  /** Was in, and the host sent this tab away. */
  | 'removed';

export interface GuestSnapshot {
  phase: GuestPhase;
  hostName: string;
  hostId: string;
  me: string;
  name: string;
  detail: string;
}

let snapshot: GuestSnapshot = {
  phase: 'checking',
  hostName: '',
  hostId: '',
  me: '',
  name: '',
  detail: '',
};
const watchers = new Set<() => void>();

function set(patch: Partial<GuestSnapshot>) {
  snapshot = { ...snapshot, ...patch };
  watchers.forEach((fn) => fn());
}

export const guestSnapshot = () => snapshot;
export function watchGuest(fn: () => void): () => void {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

const NAME_KEY = 'lantern.guest.name';
const PROGRESS_KEY = 'lantern.guest.progress';

function rememberedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { credentials: 'same-origin', cache: 'no-store' });
  if (!response.ok) throw new Error(`${response.status}`);
  return (await response.json()) as T;
}

interface Status {
  enabled: boolean;
  standing: 'pending' | 'allowed' | 'denied' | null;
  me?: string;
  name?: string;
  hostId: string;
  hostName: string;
}

let resolveReady: (() => void) | null = null;
let poll: number | undefined;
let source: EventSource | null = null;

/**
 * Brings the tab to "allowed", then connects.
 *
 * Resolves only once the host has said yes. The bridge's `startBridge` waits on
 * it, so the interface does not initialise - and does not show a single peer or
 * message - until there is somebody to be a guest of.
 */
export function startGuest(): Promise<void> {
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  void check();
  return ready;
}

async function check() {
  let status: Status;
  try {
    status = await getJson<Status>('/guest/api/status');
  } catch {
    set({ phase: 'unreachable', detail: 'Could not reach the machine that served this page.' });
    return;
  }
  set({ hostId: status.hostId, hostName: status.hostName });

  if (!status.enabled) {
    set({
      phase: 'off',
      detail: 'Guest mode is off on this machine, or the LANTern app is not open on it.',
    });
    return;
  }
  if (status.standing === 'allowed') {
    set({ me: status.me ?? '', name: status.name ?? '' });
    await admitted();
    return;
  }
  if (status.standing === 'pending') {
    set({ phase: 'pending', me: status.me ?? '', name: status.name ?? '' });
    watch();
    return;
  }
  if (status.standing === 'denied') {
    set({ phase: 'denied' });
    return;
  }
  const name = rememberedName();
  if (name) {
    await join(name);
  } else {
    set({ phase: 'need-name' });
  }
}

/** Asks the host to let this tab in. */
export async function join(name: string): Promise<void> {
  const clean = name.trim().slice(0, 24) || 'Guest';
  try {
    localStorage.setItem(NAME_KEY, clean);
  } catch {
    /* Private window: the name is simply asked for again next time. */
  }
  set({ name: clean, phase: 'pending', detail: '' });
  const response = await fetch('/guest/api/join', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ name: clean }),
  }).catch(() => null);
  if (!response || !response.ok) {
    const why = response ? await response.text().catch(() => '') : '';
    set({ phase: 'unreachable', detail: why || 'Could not reach the machine that served this page.' });
    return;
  }
  watch();
}

/** Waits, a couple of seconds at a time, for the host to decide. */
function watch() {
  window.clearInterval(poll);
  poll = window.setInterval(async () => {
    let status: Status;
    try {
      status = await getJson<Status>('/guest/api/status');
    } catch {
      return;
    }
    if (status.standing === 'allowed') {
      window.clearInterval(poll);
      set({ me: status.me ?? '', name: status.name ?? snapshot.name });
      await admitted();
    } else if (status.standing === 'denied') {
      window.clearInterval(poll);
      set({ phase: 'denied' });
    } else if (status.standing === null) {
      // The request timed out on the host, or was cleared. Ask again.
      window.clearInterval(poll);
      set({ phase: 'need-name' });
    }
  }, 1500);
}

async function admitted() {
  set({ phase: 'allowed' });

  // The store holds who this person is. A guest has no onboarding to go
  // through: the name was asked for at the door.
  const { useStore } = await import('./store');
  const store = useStore.getState();
  if (!store.onboarded) store.completeOnboarding({ name: snapshot.name, emoji: '🌐' });

  connect(0);
  void measure();
  window.setInterval(() => void measure(), 10_000);
  resolveReady?.();
  resolveReady = null;
}

/** The stream of what the host sends this tab. Reconnects on its own. */
function connect(since: number) {
  source?.close();
  source = new EventSource(`/guest/api/events?since=${since}`, { withCredentials: true });
  source.onmessage = (event) => {
    try {
      deliver(JSON.parse(event.data));
    } catch {
      /* A line that is not an envelope is not for the interface. */
    }
  };
  source.onerror = async () => {
    // EventSource retries by itself. What it cannot tell is whether the host
    // has since sent this tab away, which would otherwise look like a link that
    // never comes back.
    try {
      const status = await getJson<Status>('/guest/api/status');
      if (status.standing !== 'allowed') {
        source?.close();
        set({ phase: status.enabled ? 'removed' : 'off' });
      }
    } catch {
      /* Still offline; EventSource is already trying again. */
    }
  };
}

interface WireEnvelope {
  from: string;
  kind: string;
  payload: any;
}

/** The same mapping `deliver()` makes natively: an envelope kind to an event. */
function deliver(envelope: WireEnvelope) {
  const payload = { ...(envelope.payload ?? {}), from: envelope.from };
  switch (envelope.kind) {
    case 'chat':
      emit('message:received', payload);
      break;
    case 'typing':
      emit('typing', payload);
      break;
    case 'file': {
      const offer = envelope.payload?.offer;
      if (!offer) break;
      const transfer: Transfer = {
        id: offer.transferId,
        name: offer.name,
        size: offer.size,
        sent: 0,
        peerId: envelope.from,
        direction: 'in',
        state: 'queued',
        speedBps: 0,
        startedAt: Date.now(),
        mime: offer.mime,
        bundleId: offer.bundleId ?? undefined,
        viaChat: !!offer.viaChat,
      };
      offers.set(transfer.id, { transfer, url: sameOrigin(offer.url) });
      transfers.set(transfer.id, transfer);
      emit('transfer:offer', transfer);
      break;
    }
  }
}

/**
 * The host puts its own address in an offer, which is not always the one this
 * tab reached it by - a name, or the other of two interfaces. The same path on
 * the address that is demonstrably working is what the browser can fetch.
 */
function sameOrigin(raw: string): string {
  try {
    const url = new URL(raw);
    return `${location.origin}${url.pathname}${url.search}`;
  } catch {
    return raw;
  }
}

/* ------------------------------------------------------------- commands */

const offers = new Map<string, { transfer: Transfer; url: string }>();
const transfers = new Map<string, Transfer>();
const staged = new Map<string, File>();

/** Remembers a file the person picked, and gives back what stands in for a path. */
export function stageGuestFile(file: File): string {
  const key = `guestfile:${crypto.randomUUID?.() ?? Math.random().toString(36).slice(2)}`;
  staged.set(key, file);
  return key;
}

let latency = -1;

/** Round trip to the host, which is the one number a guest can honestly show. */
async function measure() {
  const started = performance.now();
  const ok = await fetch('/guest/api/status', { cache: 'no-store', credentials: 'same-origin' })
    .then((r) => r.ok)
    .catch(() => false);
  if (!ok) return;
  latency = Math.round((performance.now() - started) * 10) / 10;
  emit('peer:updated', hostPeer());
}

function hostPeer(): Peer {
  return {
    id: snapshot.hostId,
    deviceId: snapshot.hostId,
    name: snapshot.hostName || 'Host',
    deviceName: snapshot.hostName || 'Host',
    color: '#F5A623',
    emoji: '🏮',
    os: 'unknown',
    ip: location.hostname,
    addresses: [location.hostname],
    localAddress: '',
    port: Number(location.port) || 80,
    layer: 'direct',
    latencyMs: latency,
    lossPct: 0,
    status: 'available',
    lastSeen: Date.now(),
    trusted: false,
    scope: 'local',
    initiatedBy: 'them',
  } as Peer;
}

function netInfo(): NetInfo {
  return {
    ip: location.hostname,
    subnet: '',
    gateway: '',
    nat: 'unknown',
    upnpAvailable: false,
    interfaces: [],
    port: Number(location.port) || 80,
    stunPort: 0,
    relayHub: false,
    relayBytes: 0,
    sameSubnet: [],
    upstream: null,
    hostPort: Number(location.port) || 80,
  } as unknown as NetInfo;
}

async function post(kind: string, payload: unknown): Promise<boolean> {
  const response = await fetch('/guest/api/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ kind, payload }),
  }).catch(() => null);
  return !!response && response.ok;
}

function progressMap(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? '{}');
  } catch {
    return {};
  }
}

async function library(): Promise<MediaItem[]> {
  const shares = await getJson<{ slug: string; mode: string }[]>('/shares.json').catch(() => []);
  const saved = progressMap();
  const lists = await Promise.all(
    shares
      .filter((s) => s.mode === 'media')
      .map((s) => getJson<MediaItem[]>(`/${encodeURIComponent(s.slug)}/index.json`).catch(() => [])),
  );
  return lists.flat().map((item) => ({
    ...item,
    peerId: snapshot.hostId,
    progressSec: saved[item.id] ?? 0,
  }));
}

function upload(file: File, onProgress: (sent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', `/guest/api/upload?name=${encodeURIComponent(file.name)}`);
    request.withCredentials = true;
    request.upload.onprogress = (e) => onProgress(e.loaded);
    request.onload = () =>
      request.status < 300
        ? resolve()
        : reject(new Error(request.responseText || `Upload refused (${request.status}).`));
    request.onerror = () => reject(new Error('The upload was interrupted.'));
    request.send(file);
  });
}

function offerFiles(paths: string[]): Transfer[] {
  const created: Transfer[] = [];
  for (const path of paths) {
    const file = staged.get(path);
    if (!file) continue;
    const transfer: Transfer = {
      id: crypto.randomUUID?.() ?? Math.random().toString(36).slice(2),
      name: file.name,
      size: file.size,
      sent: 0,
      peerId: snapshot.hostId,
      direction: 'out',
      state: 'active',
      speedBps: 0,
      startedAt: Date.now(),
      mime: file.type || 'application/octet-stream',
    };
    transfers.set(transfer.id, transfer);
    created.push(transfer);

    const started = Date.now();
    const update = (patch: Partial<Transfer>) => {
      const next = { ...transfers.get(transfer.id)!, ...patch };
      transfers.set(transfer.id, next);
      emit('transfer:progress', next);
    };
    upload(file, (sent) =>
      update({ sent, speedBps: Math.round(sent / Math.max(1, (Date.now() - started) / 1000)) }),
    )
      .then(() => update({ sent: file.size, state: 'done', finishedAt: Date.now() }))
      .catch(() => update({ state: 'failed' }));
    staged.delete(path);
  }
  return created;
}

/** Starts the browser's own download for an offered file. */
function acceptOffer(id: string) {
  const held = offers.get(id);
  if (!held) return;
  const link = document.createElement('a');
  link.href = held.url;
  link.download = held.transfer.name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // The browser's download manager owns it from here; there is nothing to
  // report progress on.
  const done = {
    ...held.transfer,
    sent: held.transfer.size,
    state: 'done' as const,
    finishedAt: Date.now(),
  };
  transfers.set(id, done);
  emit('transfer:progress', done);
}

export async function handle(cmd: string, args: any): Promise<any> {
  switch (cmd) {
    case 'start_services':
      return null;
    case 'host_os':
      return 'browser';
    case 'net_info':
      return netInfo();
    case 'identity_device_id':
      return snapshot.me;
    case 'peers_list':
      return snapshot.hostId ? [hostPeer()] : [];
    case 'peers_linked':
      return snapshot.hostId ? [snapshot.hostId] : [];

    case 'chat_send': {
      const ok = await post('chat', { roomId: args.roomId, message: args.payload });
      return ok ? 1 : 0;
    }
    case 'chat_typing':
      await post('typing', { roomId: args.roomId, peerId: snapshot.me });
      return null;
    case 'chat_react':
      await post('chat', { reaction: { messageId: args.messageId, emoji: args.emoji } });
      return null;

    case 'files_list':
      return [...transfers.values()];
    case 'files_stat':
      return (args.paths as string[]).flatMap((path) => {
        const file = staged.get(path);
        return file ? [{ path, name: file.name, size: file.size }] : [];
      });
    case 'files_offer':
      return offerFiles(args.paths as string[]);
    case 'files_accept':
      acceptOffer(args.id);
      return null;
    case 'files_cancel':
    case 'files_pause':
    case 'files_resume':
      return null;
    case 'files_exists':
      return false;

    case 'media_list':
    case 'media_scan':
      return library();
    case 'media_set_progress': {
      const saved = progressMap();
      saved[args.id] = args.progressSec;
      try {
        localStorage.setItem(PROGRESS_KEY, JSON.stringify(saved));
      } catch {
        /* Not remembered; the film still plays. */
      }
      return null;
    }
    case 'media_can_switch_audio':
      return false;
    case 'media_synced_ids':
      return [];

    default:
      return null;
  }
}

export async function leave(): Promise<void> {
  source?.close();
  await fetch('/guest/api/leave', { method: 'POST', credentials: 'same-origin' }).catch(() => null);
  set({ phase: 'need-name' });
}
