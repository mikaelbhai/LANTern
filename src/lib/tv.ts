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

  // `?tv=1` forces it on. Television layout is otherwise impossible to look at
  // without a television, and "it looked fine on my monitor" is how a ten-foot
  // interface ends up unreadable from a sofa.
  const forced = window.location?.search?.includes('tv=1');
  if (forced) return true;

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
 * The rule that matters is *alignment*, not raw distance. Scoring purely on
 * how far away something is produces a remote that behaves erratically —
 * pressing right from a film would jump to a button in the header because it
 * happened to be nearer than the next card in the row, and pressing left would
 * land in the search box from halfway down the page.
 *
 * So a candidate must first overlap the current element on the perpendicular
 * axis: moving right means something on this row, moving down means something
 * in this column. Only when nothing overlaps at all does it fall back to the
 * nearest thing in that direction, which is what carries focus from the last
 * card of one row to the first of the next.
 */
export function nextInDirection(
  from: DOMRect,
  candidates: { rect: DOMRect; el: HTMLElement }[],
  direction: Direction,
): HTMLElement | null {
  const horizontal = direction === 'left' || direction === 'right';

  let best: HTMLElement | null = null;
  let bestScore = Infinity;

  for (const { rect, el } of candidates) {
    // How far along the axis of travel the candidate begins.
    let along: number;
    switch (direction) {
      case 'right':
        along = rect.left - from.right;
        break;
      case 'left':
        along = from.left - rect.right;
        break;
      case 'down':
        along = rect.top - from.bottom;
        break;
      case 'up':
        along = from.top - rect.bottom;
        break;
    }

    // Must lie in the direction travelled. The small tolerance allows for
    // neighbours that overlap by a pixel or two.
    if (along < -8) continue;

    // How much the two share on the other axis, and how far apart their
    // centres are on it.
    const overlap = horizontal
      ? Math.min(from.bottom, rect.bottom) - Math.max(from.top, rect.top)
      : Math.min(from.right, rect.right) - Math.max(from.left, rect.left);

    const across = horizontal
      ? Math.abs(rect.top + rect.height / 2 - (from.top + from.height / 2))
      : Math.abs(rect.left + rect.width / 2 - (from.left + from.width / 2));

    // A quarter of the smaller extent is enough to count as the same row or
    // column; less than that is a different one that happens to graze it.
    const extent = horizontal
      ? Math.min(from.height, rect.height)
      : Math.min(from.width, rect.width);
    const aligned = overlap > extent * 0.25;

    // Left and right traverse a row and stop at its ends. Without this, the
    // last card in a row sends focus flying into the header, because the only
    // things to its right are up there - which is how a remote ends up feeling
    // possessed. Up and down are the axis that crosses sections, so they keep
    // the fallback and can leave a row.
    if (!aligned && horizontal) continue;

    // Aligned candidates always beat unaligned ones, whatever the distance:
    // the penalty is larger than any plausible screen. Among the aligned, the
    // nearest wins; among the rest, the least sideways drift.
    const score = aligned
      ? Math.max(along, 0) + across * 0.2
      : 100_000 + across * 2 + Math.max(along, 0);

    if (score < bestScore) {
      bestScore = score;
      best = el;
    }
  }

  return best;
}

/**
 * Puts focus on the first thing worth selecting.
 *
 * A television has no pointer, so nothing is focused when a screen appears and
 * the first press of the pad has nothing to move *from*. Landing on the first
 * item makes the remote work immediately instead of appearing dead.
 */
export function focusFirst(): void {
  const candidates = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(visible);

  // Never a text field. The first focusable thing on Theatre is the search
  // box, and landing there on a television throws an on-screen keyboard over
  // the library before anyone has asked for one.
  const typing = (el: HTMLElement) =>
    el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable;

  const first = candidates.find((el) => !typing(el)) ?? null;
  first?.focus();
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
