/**
 * Mirroring a phone's screen to a television.
 *
 * Arranged here, carried natively. The phone offers over the peer link; the
 * television accepts with the port it opened and a one-time token (or declines);
 * the phone's ScreenMirror.kt then asks Android for the screen and streams it to
 * that port, where MirrorReceiver.kt decodes it behind the television's page.
 * Either side can stop, and the other is told.
 *
 * On a phone `window.LanternMirror` exists; on a television `window.LanternMirrorTv`
 * does. Anywhere else (a desktop, a browser) neither does, and nothing here offers
 * itself.
 */
import { create } from 'zustand';

import { api, on } from './bridge';
import { useStore } from './store';
import type { MirrorPayload, Peer } from './types';

interface Sender {
  start(host: string, port: number, token: string, label: string): void;
  stop(): void;
}
interface Receiver {
  listen(token: string): number;
  stop(): void;
}
export interface MirrorEvent {
  type: 'state';
  state: 'consent' | 'declined' | 'connected' | 'live' | 'stopped' | 'error' | 'nosound' | 'unreachable' | 'lost';
  message: string;
}

declare global {
  interface Window {
    LanternMirror?: Sender;
    LanternMirrorTv?: Receiver;
    __mirrorEvent?: (event: MirrorEvent) => void;
  }
}

/** Whether this device can mirror its own screen (a phone with the native half). */
export const canMirror = (): boolean =>
  typeof window !== 'undefined' && typeof window.LanternMirror?.start === 'function';

/** Whether this device can show a phone's screen (a television). */
export const canShowMirror = (): boolean =>
  typeof window !== 'undefined' && typeof window.LanternMirrorTv?.listen === 'function';

/** A television, by what it says it is, or - for one too old to say - by its name. */
export function isTelevision(peer: Pick<Peer, 'form' | 'name' | 'deviceName'>): boolean {
  if (peer.form === 'tv') return true;
  const name = `${peer.deviceName ?? ''} ${peer.name ?? ''}`.toLowerCase();
  return /(^|\W)(tv|television|shield|chromecast|firestick|projector)(\W|$)/.test(name);
}

const listeners = new Set<(event: MirrorEvent) => void>();
function onNative(listener: (event: MirrorEvent) => void): () => void {
  listeners.add(listener);
  window.__mirrorEvent = (event) => listeners.forEach((l) => l(event));
  return () => {
    listeners.delete(listener);
  };
}

const randomToken = (): string => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

/* ---------------------------------------------------------------- the phone */

type SendPhase = 'idle' | 'asking' | 'consent' | 'connecting' | 'live';

interface MirrorState {
  phase: SendPhase;
  /** The television being mirrored to. */
  peerId: string | null;
  name: string;
  start: (peer: Peer) => void;
  stop: () => void;
}

const toast = (title: string, body?: string, kind: 'info' | 'error' = 'info') =>
  useStore.getState().toast({ kind, title, body });

export const useMirror = create<MirrorState>((set, get) => ({
  phase: 'idle',
  peerId: null,
  name: '',
  start: (peer) => {
    if (!canMirror() || get().phase !== 'idle') return;
    const name = peer.deviceName || peer.name;
    set({ phase: 'asking', peerId: peer.deviceId, name });
    const me = useStore.getState().profile?.name || 'A phone';
    void api.mirror.signal(peer.deviceId, { op: 'offer', name: me }).then((sent) => {
      if (!sent) {
        set({ phase: 'idle', peerId: null });
        toast(`${name} is not reachable`, 'It has to be on and on this network.', 'error');
      }
    });
  },
  stop: () => {
    const { peerId } = get();
    window.LanternMirror?.stop();
    if (peerId) void api.mirror.signal(peerId, { op: 'stop' });
    set({ phase: 'idle', peerId: null });
  },
}));

/* ----------------------------------------------------------- the television */

interface ShowState {
  /** A phone asking to mirror here, waiting for an answer. */
  offer: { from: string; name: string } | null;
  /** The phone being shown, once accepted. */
  showing: { from: string; name: string; live: boolean } | null;
  accept: () => void;
  decline: () => void;
  stop: () => void;
}

export const useMirrorShow = create<ShowState>((set, get) => ({
  offer: null,
  showing: null,
  accept: () => {
    const offer = get().offer;
    const tv = window.LanternMirrorTv;
    if (!offer || !tv) return;
    const token = randomToken();
    const port = tv.listen(token);
    if (port <= 0) {
      set({ offer: null });
      void api.mirror.signal(offer.from, { op: 'decline', reason: 'could not listen' });
      return;
    }
    set({ offer: null, showing: { from: offer.from, name: offer.name, live: false } });
    void api.mirror.signal(offer.from, { op: 'accept', port, token });
  },
  decline: () => {
    const offer = get().offer;
    if (offer) void api.mirror.signal(offer.from, { op: 'decline' });
    set({ offer: null });
  },
  stop: () => {
    const showing = get().showing;
    window.LanternMirrorTv?.stop();
    if (showing) void api.mirror.signal(showing.from, { op: 'stop' });
    set({ showing: null });
  },
}));

let started = false;

/** Listens for mirroring on whichever end this device is. Called once at start. */
export function initMirror(): void {
  if (started || (!canMirror() && !canShowMirror())) return;
  started = true;

  on('mirror:signal', (raw: MirrorPayload & { from: string }) => {
    const from = raw.from;
    if (canShowMirror()) {
      const show = useMirrorShow.getState();
      if (raw.op === 'offer') {
        // Somebody already showing keeps the screen; a second phone is told no.
        if (show.showing && show.showing.from !== from) {
          void api.mirror.signal(from, { op: 'decline', reason: 'busy' });
          return;
        }
        useMirrorShow.setState({ offer: { from, name: raw.name || 'A phone' } });
        // A phone that is this person's own, or one they vouched for, needs no question.
        const peer = Object.values(useStore.getState().peers).find((p) => p.deviceId === from);
        if (peer?.trusted) useMirrorShow.getState().accept();
      } else if (raw.op === 'stop' && show.showing?.from === from) {
        window.LanternMirrorTv?.stop();
        useMirrorShow.setState({ showing: null });
      }
      return;
    }

    // The phone's side.
    const mirror = useMirror.getState();
    if (mirror.peerId !== from) return;
    if (raw.op === 'accept') {
      const peer = Object.values(useStore.getState().peers).find((p) => p.deviceId === from);
      if (!peer?.ip) {
        mirror.stop();
        toast(`Could not find ${mirror.name} on the network`, undefined, 'error');
        return;
      }
      useMirror.setState({ phase: 'consent' });
      window.LanternMirror?.start(peer.ip, raw.port, raw.token, mirror.name);
    } else if (raw.op === 'decline') {
      useMirror.setState({ phase: 'idle', peerId: null });
      toast(raw.reason === 'busy' ? `${mirror.name} is already showing another screen` : `${mirror.name} said no`);
    } else if (raw.op === 'stop') {
      window.LanternMirror?.stop();
      useMirror.setState({ phase: 'idle', peerId: null });
    }
  });

  onNative((event) => {
    if (canShowMirror()) {
      const showing = useMirrorShow.getState().showing;
      if (event.state === 'live' && showing) {
        useMirrorShow.setState({ showing: { ...showing, live: true } });
      } else if (event.state === 'stopped' || event.state === 'error') {
        if (showing) void api.mirror.signal(showing.from, { op: 'stop' });
        useMirrorShow.setState({ showing: null });
      }
      return;
    }

    const mirror = useMirror.getState();
    switch (event.state) {
      case 'consent':
        useMirror.setState({ phase: 'consent' });
        break;
      case 'live':
        useMirror.setState({ phase: 'live' });
        break;
      case 'nosound':
        toast('Mirroring without sound', event.message);
        break;
      case 'declined':
      case 'stopped':
      case 'error':
      case 'unreachable':
      case 'lost':
        if (mirror.peerId) void api.mirror.signal(mirror.peerId, { op: 'stop' });
        useMirror.setState({ phase: 'idle', peerId: null });
        if (event.state === 'unreachable') toast(`Could not reach ${mirror.name}`, 'Is it still on this network?', 'error');
        else if (event.state === 'lost') toast(`Lost the connection to ${mirror.name}`, undefined, 'error');
        else if (event.state === 'error') toast('Mirroring stopped', event.message || undefined, 'error');
        break;
      default:
        break;
    }
  });
}
