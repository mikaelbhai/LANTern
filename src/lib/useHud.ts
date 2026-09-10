/**
 * Driving the corner popup from the application.
 *
 * This runs in the main window, which stays alive while it is hidden — a Tauri
 * window that is hidden or minimised is still running its JavaScript. So the
 * application remains the one place that knows what is happening and the one
 * place allowed to act on it, and the popup is only ever a view of that.
 *
 * It appears when two things are true at once: the main window is out of sight,
 * and there is something that wants an answer. Either alone is not enough. A
 * popup over the application it belongs to is clutter, and a popup with nothing
 * on it is a window that exists to say nothing.
 */
import React from 'react';

import { api, emitNative, listenNative, on } from './bridge';
import { EMPTY, HUD_ACTION, HUD_READY, HUD_STATE, hasContent } from './hud';
import type { HudAction, HudSnapshot } from './hud';
import { pickFolder } from './picker';
import { useStore } from './store';
import * as rtc from './webrtc';

/** Roughly how tall the popup starts out; it measures itself once it is up. */
const GUESS = 120;

export function useHud() {
  const call = useStore((s) => s.call);
  const peers = useStore((s) => s.peers);
  const offer = useStore((s) => s.pendingOffer);
  const transfers = useStore((s) => s.transfers);
  const micMuted = useStore((s) => s.micMuted);
  const downloadDir = useStore((s) => s.settings.files.downloadDir);

  const [away, setAway] = React.useState(false);

  React.useEffect(() => {
    const off = on('main:away', (v: boolean) => setAway(!!v));
    // Window events describe every change but not the state we started in:
    // launched at login the window is already hidden and nothing happened.
    void api.hud.sync().catch(() => {});
    return off;
  }, []);

  /**
   * The most recent finished download, until something else happens.
   *
   * Kept in a ref rather than derived: the point of it is to survive the
   * transfer list settling down afterwards, so that "Open folder" is still
   * there a moment later when you look up and notice.
   */
  /**
   * A clock that only runs when something is counting down.
   *
   * The "saved" card expires, and an expiry derived from `Date.now()` inside a
   * memo would sit there indefinitely because nothing re-runs it.
   */
  const [tick, setTick] = React.useState(0);

  const done = React.useMemo(() => {
    void tick;
    const all = Object.values(transfers);
    const finished = all
      .filter((t) => t.direction === 'in' && t.state === 'done' && t.finishedAt)
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0));
    const latest = finished[0];
    if (!latest) return null;
    // Anything older than a couple of minutes is not news any more.
    if (Date.now() - (latest.finishedAt ?? 0) > 120_000) return null;
    // A folder arrives as many transfers; one line about the folder is more
    // use than twenty about its contents.
    const together = latest.bundleId
      ? finished.filter((t) => t.bundleId === latest.bundleId).length
      : 1;
    return {
      id: latest.id,
      name: latest.name,
      path: latest.localPath,
      direction: 'in' as const,
      count: together,
    };
  }, [transfers, tick]);

  React.useEffect(() => {
    if (!done) return;
    const id = setInterval(() => setTick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, [done]);

  const [dismissed, setDismissed] = React.useState<string | null>(null);

  // Coming back to the application is as good as reading the card: the file
  // is right there in Files, and the popup should not be waiting with old
  // news the next time the window goes away.
  React.useEffect(() => {
    if (!away && done) setDismissed(done.id);
  }, [away, done]);

  const snapshot: HudSnapshot = React.useMemo(() => {
    const other = call?.participants.find((p) => p.peerId !== useStore.getState().profile.id);
    const who = call
      ? (peers[call.incomingFrom ?? other?.peerId ?? '']?.name ?? other?.name ?? 'Someone')
      : '';
    const peer = call ? peers[call.incomingFrom ?? other?.peerId ?? ''] : undefined;

    return {
      call: call
        ? {
            kind: call.kind,
            state: call.state,
            incoming: call.state === 'ringing' && !!call.incomingFrom,
            who,
            color: peer?.color,
            emoji: peer?.emoji,
            startedAt: call.startedAt,
            muted: micMuted,
            others: Math.max(0, call.participants.length - 2),
          }
        : null,
      offer: offer
        ? {
            id: offer.id,
            name: offer.name,
            size: offer.size,
            who: peers[offer.peerId]?.name ?? 'an unknown device',
            saveTo: downloadDir || 'your downloads folder',
          }
        : null,
      active: Object.values(transfers)
        .filter((t) => t.state === 'active' || t.state === 'paused')
        .slice(0, 3)
        .map((t) => ({
          id: t.id,
          name: t.name,
          size: t.size,
          sent: t.sent,
          direction: t.direction,
          state: t.state,
          speedBps: t.speedBps,
        })),
      done: done && done.id !== dismissed ? done : null,
    };
  }, [call, peers, offer, transfers, micMuted, downloadDir, done, dismissed]);

  /** Push the snapshot, and show or hide the window to match. */
  const latest = React.useRef(EMPTY);
  React.useEffect(() => {
    const wanted = away && hasContent(snapshot);
    latest.current = wanted ? snapshot : EMPTY;
    void emitNative(HUD_STATE, latest.current);
    void api.hud.set(wanted, GUESS).catch(() => {});
  }, [away, snapshot]);

  /** The popup finished loading and wants to know what it missed. */
  React.useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void listenNative(HUD_READY, () => {
      void emitNative(HUD_STATE, latest.current);
    }).then((off) => {
      if (cancelled) off();
      else stop = off;
    });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  /** Do what was clicked over there. */
  React.useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;

    void listenNative(HUD_ACTION, (action: HudAction) => {
      const s = useStore.getState();
      switch (action.t) {
        case 'answer':
          s.answerCall();
          break;
        case 'decline':
        case 'hangup':
          s.endCall();
          break;
        case 'mute':
          s.setMicMuted(action.on);
          // The overlay's effect does this when it is mounted; with the window
          // hidden it may not be, and a mute that only changes a label is the
          // failure this control must never have.
          rtc.setMicrophoneEnabled(!action.on);
          break;
        case 'accept':
          void api.files.accept(action.id, s.settings.files.downloadDir || undefined);
          s.clearPendingOffer();
          break;
        case 'reject':
          // The same as "Not now" in the window: nothing was ever written, and
          // the transfer stays queued for a decision later.
          s.clearPendingOffer();
          break;
        case 'reveal':
          void api.files.reveal(action.path);
          break;
        case 'dismiss':
          setDismissed(done?.id ?? null);
          break;
        case 'open':
          void api.hud.openApp().catch(() => {});
          break;
        default:
          break;
      }
    }).then((off) => {
      if (cancelled) off();
      else stop = off;
    });

    return () => {
      cancelled = true;
      stop?.();
    };
  }, [done?.id]);

  // "Save to…" needs a folder picker, which is a main-window job: the popup
  // has no dialog permission and should not have one.
  React.useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;

    void listenNative(`${HUD_ACTION}:saveTo`, async (payload: { id: string }) => {
      const picked = await pickFolder();
      // A cancelled picker means "I have not decided", not "put it anywhere".
      if (!picked?.path) return;
      await api.files.accept(payload.id, picked.path);
      useStore.getState().clearPendingOffer();
    }).then((off) => {
      if (cancelled) off();
      else stop = off;
    });

    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);
}
