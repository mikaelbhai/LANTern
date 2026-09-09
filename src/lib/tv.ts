/**
 * Running on a television.
 *
 * A TV is not a big phone. There is no pointer, the only input is a four-way
 * pad and a select button, and the viewer is three metres away. Two things
 * follow, and LANTern does both:
 *
 * 1. Only Theatre makes sense. Chats, Files and Settings all want a keyboard
 *    that a remote control is not, and nobody types a message on a TV.
 * 2. Focus has to be visible and movable with arrow keys. A WebView does
 *    spatial navigation for `Tab` only — arrows scroll the page instead — so
 *    without the code below a D-pad cannot reach anything.
 */

/**
 * Whether this device is a television.
 *
 * Android TV's WebView reports a user agent containing `TV`, and leanback
 * devices have no touchscreen. Either signal alone produces false positives —
 * a phone named "TV-something", a desktop with no touch — so both the platform
 * and the absence of a pointer are required.
 */
export function isTv(): boolean {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') return false;

  const ua = navigator.userAgent;
  const android = /Android/i.test(ua);
  const saysTv = /\bTV\b|GoogleTV|AndroidTV|BRAVIA|AFT[A-Z]/i.test(ua);

  // `pointer: coarse` is a touchscreen; a TV reports `pointer: none` because
  // the remote cannot address a position on screen.
  const noPointer = window.matchMedia?.('(pointer: none)').matches ?? false;

  return saysTv || (android && noPointer);
}

/** Elements a D-pad should be able to land on. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
  'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function visible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  // Off the bottom of a long list is still reachable; off-screen entirely,
  // because a parent is hidden, is not.
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

type Direction = 'up' | 'down' | 'left' | 'right';

/**
 * Picks the element a press should move to.
 *
 * Exported for its own sake: the geometry is the part worth reasoning about,
 * and it can be checked without a television.
 *
 * Candidates must lie in the direction travelled. The winner is the nearest,
 * with sideways drift counted several times over — pressing right should reach
 * the next card in the row, never a distant one on another line that happens
 * to be marginally closer as the crow flies.
 */
export function nextInDirection(
  from: DOMRect,
  candidates: { rect: DOMRect; el: HTMLElement }[],
  direction: Direction,
): HTMLElement | null {
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;

  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const { rect, el } of candidates) {
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;

    // How far along the axis of travel, and how far off it.
    let along: number;
    let across: number;
    switch (direction) {
      case 'right':
        along = rect.left - from.right;
        across = Math.abs(y - cy);
        break;
      case 'left':
        along = from.left - rect.right;
        across = Math.abs(y - cy);
        break;
      case 'down':
        along = rect.top - from.bottom;
        across = Math.abs(x - cx);
        break;
      case 'up':
        along = from.top - rect.bottom;
        across = Math.abs(x - cx);
        break;
    }

    // Must actually be in that direction. A small negative allows for
    // neighbours that overlap by a pixel or two.
    if (along < -8) continue;

    const score = Math.max(along, 0) + across * 3;
    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }

  return best;
}

/**
 * Makes the arrow keys move focus.
 *
 * Returns a function that removes the handler again. Only active on a TV: on a
 * desktop the arrow keys belong to whatever has focus, and stealing them would
 * break scrolling, text fields and the player's own seek shortcuts.
 */
export function enableDpadNavigation(): () => void {
  const onKey = (event: KeyboardEvent) => {
    const direction = (
      {
        ArrowUp: 'up',
        ArrowDown: 'down',
        ArrowLeft: 'left',
        ArrowRight: 'right',
      } as const
    )[event.key];
    if (!direction) return;

    const active = document.activeElement as HTMLElement | null;

    // Inside a text field or a slider the arrows mean what they normally mean.
    if (active) {
      const tag = active.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || active.isContentEditable) return;
    }

    const all = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      (el) => el !== active && visible(el),
    );
    if (!all.length) return;

    // With nothing focused yet — the state a screen starts in — the first
    // press lands on whatever is nearest the top left rather than doing
    // nothing, which would leave the remote apparently dead.
    const from =
      active && active !== document.body
        ? active.getBoundingClientRect()
        : new DOMRect(0, 0, 0, 0);

    const target = nextInDirection(
      from,
      all.map((el) => ({ el, rect: el.getBoundingClientRect() })),
      direction,
    );
    if (!target) return;

    event.preventDefault();
    target.focus();
    target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };

  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
