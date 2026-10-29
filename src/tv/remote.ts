/**
 * What a television remote's buttons mean.
 *
 * A remote is nine buttons, and every one of them reaches a web page by a
 * different road: the pad's centre is `Enter` on Android TV and `Select` on
 * some boxes, Back is `Escape`, `GoBack` or `BrowserBack` depending on the
 * system, and the media keys are named in the standard way but only on devices
 * that have them. The rest of the interface asks what a press *means*; this is
 * the one place that knows what it was called.
 */

export type Intent =
  | 'ok'
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'back'
  | 'playpause'
  | 'ff'
  | 'rw'
  | 'next'
  | 'prev';

const BY_KEY: Record<string, Intent> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  Enter: 'ok',
  Select: 'ok',
  // A keyboard on the sofa, for the people who have one.
  ' ': 'playpause',
  Escape: 'back',
  Backspace: 'back',
  GoBack: 'back',
  BrowserBack: 'back',
  MediaPlayPause: 'playpause',
  MediaPlay: 'playpause',
  MediaPause: 'playpause',
  MediaFastForward: 'ff',
  MediaRewind: 'rw',
  MediaTrackNext: 'next',
  MediaTrackPrevious: 'prev',
};

/** Android key codes, for a WebView that reports a code and no useful name. */
const BY_CODE: Record<number, Intent> = {
  19: 'up',
  20: 'down',
  21: 'left',
  22: 'right',
  23: 'ok',
  66: 'ok',
  4: 'back',
  8: 'back',
  85: 'playpause',
  126: 'playpause',
  127: 'playpause',
  90: 'ff',
  89: 'rw',
  87: 'next',
  88: 'prev',
};

export function intentOf(e: Pick<KeyboardEvent, 'key' | 'keyCode'>): Intent | null {
  return BY_KEY[e.key] ?? BY_CODE[e.keyCode] ?? null;
}

/**
 * How far one press of Left or Right moves the playhead, given how many
 * presses of the same key there have been in a row.
 *
 * Ten seconds for a tap; holding the button speeds up, because a film is two
 * hours long and nobody will press a button six hundred times to get to the
 * end of it.
 */
export function scrubStep(repeats: number): number {
  if (repeats < 3) return 10;
  if (repeats < 10) return 30;
  return 60;
}

/** Moves a position by a step, kept inside the film. */
export function scrubbed(from: number, direction: 1 | -1, repeats: number, duration: number): number {
  const next = from + direction * scrubStep(repeats);
  return Math.max(0, duration > 0 ? Math.min(next, Math.max(0, duration - 1)) : next);
}
