/**
 * A phone driving the machine across the room.
 *
 * Two things people mean by this, and they are the same mechanism underneath:
 * a trackpad and keyboard for working at a desktop you are not sitting at, and
 * a controller for playing something on a television. Both are a stream of
 * small input events travelling over the peer link that already carries chat
 * and calls, and both are applied by the same code at the far end.
 *
 * The events are deliberately terse. A finger dragging across glass produces
 * sixty of these a second, and a readable field name costs more on the wire
 * than the number it labels.
 *
 * Three properties matter more than anything else here, and each is a way the
 * far machine could be left worse than before:
 *
 * A key that goes down must come up. A stuck Ctrl or a stuck arrow makes the
 * controlled desktop unusable, and the person holding the phone cannot see it
 * happen. So the sender tracks what it is holding and can always let go of
 * everything.
 *
 * Fractional movement must not be lost. Rounding each delta to whole pixels
 * throws away everything below one, so a slow careful drag — placing a cursor
 * precisely, which is exactly when precision matters — moves nothing at all.
 *
 * And a tap is not a drag. Getting that wrong means either a pointer that
 * jumps whenever you click, or clicks that never register.
 */

/** Which button. Named rather than numbered so the far end cannot misread it. */
export type Button = 'left' | 'right' | 'middle';

/**
 * One input event, as it travels.
 *
 * `t` is the tag: m)ove, b)utton, s)croll, k)ey, te(x)t.
 */
export type RemoteEvent =
  | { t: 'm'; dx: number; dy: number }
  | { t: 'b'; b: Button; d: boolean }
  | { t: 's'; dx: number; dy: number }
  | { t: 'k'; k: string; d: boolean }
  | { t: 'x'; s: string };

/* ------------------------------------------------------------- the pointer */

/**
 * Turns finger movement into pointer movement.
 *
 * Keeps the fraction left over by rounding. Without it a slow drag produces a
 * run of deltas below a pixel, every one of which rounds to zero, and the
 * pointer sits still however long you push at it.
 */
export class Pointer {
  private carryX = 0;
  private carryY = 0;

  constructor(private speed = 1.6) {}

  /**
   * Movement since the last call, in whole pixels, or null when the leftover
   * has not yet added up to one.
   */
  move(dx: number, dy: number): RemoteEvent | null {
    // A wild delta is a lost touch or a second finger landing, not a gesture.
    // Sending it would fling the pointer to a corner.
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return null;

    const gain = accelerate(Math.hypot(dx, dy)) * this.speed;
    this.carryX += dx * gain;
    this.carryY += dy * gain;

    const x = Math.trunc(this.carryX);
    const y = Math.trunc(this.carryY);
    if (x === 0 && y === 0) return null;

    this.carryX -= x;
    this.carryY -= y;
    return { t: 'm', dx: x, dy: y };
  }

  /** Forgets the leftover, so a new touch does not inherit the last one's. */
  reset(): void {
    this.carryX = 0;
    this.carryY = 0;
  }
}

/**
 * How much faster the pointer moves when the finger moves faster.
 *
 * A flat multiplier forces a choice between crossing a 4K screen in one swipe
 * and being able to land on a button. The curve gives both: slow movement is
 * close to one-to-one, fast movement is amplified.
 */
export function accelerate(speed: number): number {
  if (speed <= 2) return 1;
  // Grows with the square root rather than linearly, which is fast enough to
  // cross a screen and slow enough to stay predictable.
  return Math.min(3.5, 1 + Math.sqrt(speed - 2) / 2.2);
}

/* --------------------------------------------------------- tap versus drag */

export interface Touch {
  x: number;
  y: number;
  at: number;
}

/** Under this far and this quick, a touch was somebody tapping. */
export const TAP_SLOP_PX = 12;
export const TAP_TIME_MS = 260;

export function isTap(start: Touch, end: Touch): boolean {
  const moved = Math.hypot(end.x - start.x, end.y - start.y);
  return moved <= TAP_SLOP_PX && end.at - start.at <= TAP_TIME_MS;
}

/** A tap, as the pair of events it stands for. */
export const clickEvents = (button: Button = 'left'): RemoteEvent[] => [
  { t: 'b', b: button, d: true },
  { t: 'b', b: button, d: false },
];

/* --------------------------------------------------------------- the pad */

/** The buttons a controller has, named by what they do rather than by letter. */
export type PadButton =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'a'
  | 'b'
  | 'x'
  | 'y'
  | 'start'
  | 'select';

/**
 * What each pad button presses.
 *
 * Keys rather than a gamepad device, because a key is what everything
 * understands: LANTern's own games read the arrows, and so does almost
 * anything else likely to be on screen. Presenting a virtual gamepad would
 * mean a driver on Windows and nothing at all on macOS.
 */
export const PAD_KEYS: Record<PadButton, string> = {
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  a: 'Space',
  b: 'Escape',
  x: 'Return',
  y: 'Shift',
  start: 'Return',
  select: 'Tab',
};

/** The same pad over WASD, for anything that wants the left hand. */
export const PAD_KEYS_WASD: Record<PadButton, string> = {
  ...PAD_KEYS,
  up: 'w',
  down: 's',
  left: 'a',
  right: 'd',
};

/* ------------------------------------------------- what is currently held */

/**
 * Everything this phone is holding down at the far end.
 *
 * The point of the class is `releaseAll`. A phone can lose its link, be locked,
 * or have the app swiped away mid-press, and any of those leaves a key held on
 * a machine in another room with nobody able to see why it is behaving oddly.
 * Whatever tears the session down asks this what is still down and sends the
 * matching ups.
 */
export class Held {
  private keys = new Set<string>();
  private buttons = new Set<Button>();

  key(k: string, down: boolean): RemoteEvent | null {
    // Repeats arrive while a finger stays on a button, and the far end does
    // its own auto-repeat. Sending ours as well doubles the rate.
    if (down && this.keys.has(k)) return null;
    if (!down && !this.keys.has(k)) return null;
    if (down) this.keys.add(k);
    else this.keys.delete(k);
    return { t: 'k', k, d: down };
  }

  button(b: Button, down: boolean): RemoteEvent | null {
    if (down === this.buttons.has(b)) return null;
    if (down) this.buttons.add(b);
    else this.buttons.delete(b);
    return { t: 'b', b, d: down };
  }

  /** Lets go of everything, and says what it let go of. */
  releaseAll(): RemoteEvent[] {
    const out: RemoteEvent[] = [];
    for (const k of this.keys) out.push({ t: 'k', k, d: false });
    for (const b of this.buttons) out.push({ t: 'b', b, d: false });
    this.keys.clear();
    this.buttons.clear();
    return out;
  }

  get count(): number {
    return this.keys.size + this.buttons.size;
  }
}

/* ------------------------------------------------------------- the stream */

/**
 * Squashes a burst of events into the fewest that mean the same thing.
 *
 * A finger produces a move event per frame and the link does not need sixty
 * separate messages to say the pointer went one way. Consecutive moves add up;
 * so do consecutive scrolls. Anything else is a discrete act and is left
 * exactly where it is, because a click that arrives before the move that
 * positioned it lands in the wrong place.
 */
export function coalesce(events: RemoteEvent[]): RemoteEvent[] {
  const out: RemoteEvent[] = [];
  for (const event of events) {
    const last = out[out.length - 1];
    if (last && (event.t === 'm' || event.t === 's') && last.t === event.t) {
      last.dx += event.dx;
      last.dy += event.dy;
      continue;
    }
    // Copied, so merging into it cannot reach back into the caller's array.
    out.push({ ...event });
  }
  // A run that cancels itself out — a finger wobbling in place — is nothing.
  return out.filter((e) => !((e.t === 'm' || e.t === 's') && e.dx === 0 && e.dy === 0));
}
