/**
 * Fitting a picture to a screen that is not its shape.
 *
 * Almost nothing matches. A 2.35:1 film on a 16:9 monitor spends a fifth of
 * the panel on black bars; the same film on a phone held sideways spends less
 * but still spends some. There is no arrangement that shows all of the
 * picture and none of the bars, so the only honest thing to offer is the
 * choice between them:
 *
 * Fit shows the whole picture and accepts the bars. Crop fills the screen and
 * loses what hangs over the edges.
 *
 * What is deliberately not offered is stretching. A picture squeezed to the
 * shape of the screen is wrong in a way that is hard to name and impossible to
 * unsee — faces go wide, wheels go oval — and people leave it on without
 * realising. Both modes here keep the picture exactly the shape it was shot.
 *
 * Kept out of React because it is arithmetic, and arithmetic that is a few
 * pixels wrong at the edges is the kind of thing nobody notices until a
 * subtitle is cut in half.
 */

/** How the picture meets the frame. Both preserve its own shape. */
export type Fit = 'fit' | 'crop';

export const DEFAULT_FIT: Fit = 'fit';

export interface Size {
  w: number;
  h: number;
}

/** The box the picture should occupy, centred in the frame. */
export interface Box {
  width: number;
  height: number;
}

export const FITS: { id: Fit; label: string; hint: string }[] = [
  { id: 'fit', label: 'Fit', hint: 'The whole picture, with bars where it does not reach' },
  { id: 'crop', label: 'Crop', hint: 'Fills the screen, losing the edges' },
];

/**
 * The box the picture should occupy, centred in the frame.
 *
 * Always the picture's own aspect ratio. Fit picks the largest such box that
 * sits inside the frame; Crop picks the smallest that covers it, and the frame
 * clips the rest.
 */
export function boxFor(fit: Fit, frame: Size, video: Size): Box {
  const aspect = video.w > 0 && video.h > 0 ? video.w / video.h : 0;

  // Nothing has loaded yet, so there is no shape to work from. Filling the
  // frame is what a video element does anyway, and it is replaced the moment
  // the first frame arrives.
  if (!aspect || !Number.isFinite(aspect) || frame.w <= 0 || frame.h <= 0) {
    return { width: frame.w, height: frame.h };
  }

  const wide = { w: frame.w, h: frame.w / aspect };
  const tall = { w: frame.h * aspect, h: frame.h };

  // At an exact match the two are the same box, which is why a 16:9 film on a
  // 16:9 screen looks identical either way rather than jumping when toggled.
  const box = fit === 'fit' ? (wide.h <= frame.h ? wide : tall) : wide.h >= frame.h ? wide : tall;
  return { width: box.w, height: box.h };
}

/**
 * The fraction of the picture Crop would cut away, from 0 to 1.
 *
 * Worth showing before the choice is made. "Crop" says what it does but not
 * what it costs, and the cost is the whole question: a hair off the sides of
 * a nearly-matching film is free, and a third of a 4:3 programme is not.
 */
export function croppedAway(frame: Size, video: Size): number {
  const aspect = video.w > 0 && video.h > 0 ? video.w / video.h : 0;
  const screen = frame.w > 0 && frame.h > 0 ? frame.w / frame.h : 0;
  if (!aspect || !screen || !Number.isFinite(aspect) || !Number.isFinite(screen)) return 0;

  // Cropping scales the picture until the short side matches, so what is lost
  // is the ratio of the two aspects, whichever way round they are.
  const ratio = aspect > screen ? screen / aspect : aspect / screen;
  return 1 - ratio;
}

/** The fraction of the frame Fit would leave as bars, from 0 to 1. */
export function barsLeft(frame: Size, video: Size): number {
  // The same number seen from the other side: what crop loses off the picture
  // is what fit leaves as bars on the screen.
  return croppedAway(frame, video);
}

export const fitLabel = (fit: Fit): string => (fit === 'crop' ? 'Crop' : 'Fit');

/** The other one, for a control that is a toggle rather than a menu. */
export const otherFit = (fit: Fit): Fit => (fit === 'fit' ? 'crop' : 'fit');

const STORE_KEY = 'lantern.player.fit';

/**
 * The choice carries across titles, the way it does in every other player.
 *
 * Somebody who chose Crop because their monitor is 16:9 and their films are
 * 2.35:1 means it for the next film too, and having to set it again each time
 * is what makes a feature not worth using.
 */
export function loadFit(): Fit {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return FITS.some((f) => f.id === raw) ? (raw as Fit) : DEFAULT_FIT;
  } catch {
    // Unreadable storage. A film shown in the wrong mode is a nuisance; one
    // that does not play because a preference would not parse is a fault.
    return DEFAULT_FIT;
  }
}

export function saveFit(fit: Fit): void {
  try {
    localStorage.setItem(STORE_KEY, fit);
  } catch {
    /* it will be the default next time, which is survivable */
  }
}
