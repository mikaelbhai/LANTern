/**
 * The television's native video player, as the page sees it.
 *
 * On LANTV the Android shell registers a `LanternTv` object (TvNativePlayer.kt)
 * that plays a film with the system's own decoder and reports back through
 * `window.__lantvEvent`. Anywhere else - a phone, a desktop, a browser - there is
 * no such object, `nativeAvailable()` is false and the player keeps using <video>.
 *
 * Positions cross the boundary in milliseconds, which is what the other side
 * counts in; everything this file hands back to the page is in seconds.
 */

export type NativeEvent =
  | { type: 'time'; positionMs: number; bufferedMs: number; durationMs: number }
  | { type: 'ready'; durationMs: number }
  | { type: 'buffering'; buffering: boolean }
  | { type: 'playing'; playing: boolean }
  | { type: 'firstFrame' }
  | { type: 'ended' }
  | { type: 'size'; width: number; height: number }
  | { type: 'tracks'; audio: NativeAudioTrack[] }
  | { type: 'error'; message: string; firstFrame: boolean };

export interface NativeAudioTrack {
  /** Position among the file's audio tracks, in the order it lists them. */
  index: number;
  lang: string;
  label: string;
  mime: string;
  channels: number;
  /** Whether this device can decode it at all. */
  supported: boolean;
  selected: boolean;
}

interface Bridge {
  open(url: string, startMs: number, autoplay: boolean): void;
  play(): void;
  pause(): void;
  seek(ms: number): void;
  selectAudio(index: number): void;
  close(): void;
}

declare global {
  interface Window {
    LanternTv?: Bridge;
    __lantvEvent?: (event: NativeEvent) => void;
  }
}

export const nativeAvailable = (): boolean =>
  typeof window !== 'undefined' && typeof window.LanternTv?.open === 'function';

const listeners = new Set<(event: NativeEvent) => void>();

/** Hears what the native player reports. Returns the way to stop. */
export function onNativeEvent(listener: (event: NativeEvent) => void): () => void {
  listeners.add(listener);
  window.__lantvEvent = (event) => listeners.forEach((l) => l(event));
  return () => {
    listeners.delete(listener);
  };
}

const bridge = (): Bridge | undefined => (nativeAvailable() ? window.LanternTv : undefined);

export const native = {
  open: (url: string, startSec: number, autoplay = true) =>
    bridge()?.open(url, Math.round(Math.max(0, startSec) * 1000), autoplay),
  play: () => bridge()?.play(),
  pause: () => bridge()?.pause(),
  seek: (sec: number) => bridge()?.seek(Math.round(Math.max(0, sec) * 1000)),
  selectAudio: (index: number) => bridge()?.selectAudio(index),
  close: () => bridge()?.close(),
};
