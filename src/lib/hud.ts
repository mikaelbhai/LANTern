/**
 * What the corner popup shows, and what it can ask for.
 *
 * The popup runs in its own window with its own JavaScript context, so it
 * shares nothing with the application — not the store, not the peer list, not
 * a single import. Everything it knows arrives as one snapshot over an event,
 * and everything it wants goes back the same way for the main window to carry
 * out. The two sides only ever agree on the shapes in this file.
 *
 * That is deliberate. The popup is a window that sits above everything else on
 * the screen and can be clicked while the application is nowhere in sight; the
 * fewer things it is allowed to do, the smaller the consequences of getting it
 * wrong. It cannot write a file or place a call. It can ask.
 */
import type { CallKind, TransferState } from './types';

export interface HudCall {
  kind: CallKind;
  state: 'ringing' | 'connecting' | 'active' | 'held' | 'ended';
  /** Ringing at us, rather than us ringing them. */
  incoming: boolean;
  who: string;
  color?: string;
  emoji?: string;
  startedAt: number;
  muted: boolean;
  /** How many people besides `who`, for a group call. */
  others: number;
}

export interface HudOffer {
  id: string;
  name: string;
  size: number;
  who: string;
  /** Where it would go if accepted as-is. */
  saveTo: string;
}

export interface HudTransfer {
  id: string;
  name: string;
  size: number;
  sent: number;
  direction: 'in' | 'out';
  state: TransferState;
  speedBps: number;
}

/** The last thing that finished, kept until it is dismissed or superseded. */
export interface HudDone {
  id: string;
  name: string;
  path?: string;
  direction: 'in' | 'out';
  count: number;
}

export interface HudSnapshot {
  call: HudCall | null;
  offer: HudOffer | null;
  active: HudTransfer[];
  done: HudDone | null;
}

export type HudAction =
  | { t: 'answer' }
  | { t: 'decline' }
  | { t: 'hangup' }
  | { t: 'mute'; on: boolean }
  /** Bring the application back to the front. */
  | { t: 'open' }
  | { t: 'accept'; id: string }
  | { t: 'reject'; id: string }
  | { t: 'reveal'; path: string }
  | { t: 'dismiss' };

export const HUD_STATE = 'hud:state';
export const HUD_ACTION = 'hud:action';
/**
 * The popup announcing that it exists and is listening.
 *
 * The window is created the moment there is something to show, which is after
 * the snapshot describing that something has already been sent. Without a way
 * to ask again, the first thing the popup is ever opened for is the one thing
 * it never sees.
 */
export const HUD_READY = 'hud:ready';

export const EMPTY: HudSnapshot = { call: null, offer: null, active: [], done: null };

/** Whether a snapshot is worth putting on the screen at all. */
export const hasContent = (s: HudSnapshot): boolean =>
  !!s.call || !!s.offer || s.active.length > 0 || !!s.done;
