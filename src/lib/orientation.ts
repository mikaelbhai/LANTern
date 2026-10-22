import { create } from 'zustand';
import { api, isTauri } from './bridge';
import { isAndroid } from './picker';
import { isTv } from './tv';

/**
 * Which way up the screen is, and who decides.
 *
 * On Android the system's auto-rotate switch decides by default, and a web page
 * cannot override it: `screen.orientation.lock` only works in fullscreen. A
 * video player does not behave that way - it turns when the phone does,
 * whatever the switch says. So the activity is told directly (`setOrientation`
 * below, which ends in `MainActivity.setOrientationMode`), and this module
 * keeps what the web layer needs to react to the result.
 */

/**
 * Whether this device turns itself: a phone or tablet running the Android app.
 * Not the television build, which is the same application and the same user
 * agent but has no accelerometer and only ever one way up.
 *
 * Read from the user agent rather than from `isTauri`, so the rotation
 * behaviour can be exercised in a browser with a resized window; only the call
 * into native code is gated on actually being the app.
 */
export const rotatesWithDevice = (): boolean => isAndroid() && !isTv();

export type OrientationMode = 'sensor' | 'locked' | 'landscape' | 'system';

const LOCK_KEY = 'lantern.orientationLock';

const readLock = (): boolean => {
  try {
    return localStorage.getItem(LOCK_KEY) === '1';
  } catch {
    return false;
  }
};

const landscapeNow = (): boolean =>
  typeof window !== 'undefined' && !!window.matchMedia?.('(orientation: landscape)').matches;

interface OrientationState {
  /** The person's own lock: rotation is ignored and nothing switches screens. */
  locked: boolean;
  /** Whether the window is wider than it is tall right now. */
  landscape: boolean;
}

export const useOrientation = create<OrientationState>(() => ({
  locked: readLock(),
  landscape: landscapeNow(),
}));

// One listener for the life of the page. `change` fires on a rotate and on any
// resize across the square, which is the same thing on a phone and what lets a
// resized browser stand in for one.
if (typeof window !== 'undefined' && window.matchMedia) {
  window
    .matchMedia('(orientation: landscape)')
    .addEventListener('change', (e) => useOrientation.setState({ landscape: e.matches }));
}

let current: OrientationMode = 'system';

/** The mode last asked for, for tests - native code is the only other witness. */
export const currentOrientationMode = (): OrientationMode => current;

export function setOrientation(mode: OrientationMode) {
  if (mode === current) return;
  current = mode;
  if (isTauri()) void api.pip.setOrientation(mode).catch(() => {});
}

/** The mode Theatre wants when nothing else is forcing one. */
export const restingMode = (): OrientationMode => (useOrientation.getState().locked ? 'locked' : 'sensor');

/**
 * Locks or unlocks, and applies it at once when the screen is already under
 * the sensor's control.
 *
 * `locked` freezes whatever orientation the screen is in at that moment, which
 * is the point: lock while sideways to keep the player, lock upright to keep
 * the gallery.
 */
export function setOrientationLocked(locked: boolean) {
  try {
    localStorage.setItem(LOCK_KEY, locked ? '1' : '0');
  } catch {
    /* the lock still holds for this session */
  }
  useOrientation.setState({ locked });
  if (current !== 'system') setOrientation(locked ? 'locked' : 'sensor');
}

/**
 * Calls back once the phone is physically held on its side.
 *
 * Needed because forcing landscape (a film tapped while holding the phone
 * upright) leaves the screen sideways with the phone still upright - and
 * going back to the sensor straight away would swing it back to portrait and
 * throw the player out the instant it opened. The tilt sensors report the
 * device's own frame, not the screen's, so they still say what the hand is
 * doing while the screen is held in place.
 */
export function whenHeldSideways(callback: () => void): () => void {
  const onTilt = (e: DeviceOrientationEvent) => {
    // Upright in the hand is beta ~90 and gamma ~0; on its side it swaps.
    if (Math.abs(e.gamma ?? 0) > 50 && Math.abs(e.beta ?? 90) < 50) callback();
  };
  window.addEventListener('deviceorientation', onTilt);
  return () => window.removeEventListener('deviceorientation', onTilt);
}
