/**
 * What "seen it" means, in one place.
 *
 * It used to be decided separately by every screen that needed it - a tick at
 * "the last 3%", a hero that stopped counting at 95%, a resume that did not
 * stop counting at all - so a film left in its credits was "Resume" on one
 * shelf, "Watched" on another, and started again from the credits when it was
 * played. Credits are not worth resuming into: past this point a title is done,
 * and playing it again means watching it again, from the beginning.
 */

import type { MediaItem } from './types';

/** Seconds from the end of a film that are its credits. */
export const FILM_CREDITS_SEC = 10 * 60;
/** Seconds from the end of an episode that are its credits. */
export const EPISODE_CREDITS_SEC = 2 * 60;
/** Under this a position is "the start" and not worth resuming into. */
export const MIN_RESUME_SEC = 30;

type Watchable = Pick<MediaItem, 'progressSec' | 'durationSec'> &
  Partial<Pick<MediaItem, 'kind' | 'series' | 'episode'>>;

const isShow = (i: Watchable) => i.kind === 'episode' || !!i.series || i.episode != null;

/**
 * How much of the end counts as credits for this title.
 *
 * Capped at a tenth of its length, so a five-minute clip is not "finished"
 * from the first second just because films have ten minutes of credits.
 */
export function creditsWindow(item: Watchable): number {
  const window = isShow(item) ? EPISODE_CREDITS_SEC : FILM_CREDITS_SEC;
  return item.durationSec > 0 ? Math.min(window, item.durationSec * 0.1) : window;
}

/** Watched to the credits (or beyond): the next play begins at the start. */
export function isFinished(item: Watchable): boolean {
  if (!(item.durationSec > 0) || !(item.progressSec > 0)) return false;
  return item.durationSec - item.progressSec <= creditsWindow(item);
}

/** Part-way through: worth offering "Continue watching" and a resume. */
export function isContinuing(item: Watchable): boolean {
  return item.progressSec > MIN_RESUME_SEC && !isFinished(item);
}

/**
 * Where playback should begin, given the best-known position.
 *
 * The start for a title that was left in its credits, and for one that was
 * barely begun; otherwise where it was left.
 */
export function resumeAt(item: Watchable, position: number = item.progressSec): number {
  if (!(position > MIN_RESUME_SEC)) return 0;
  return isFinished({ ...item, progressSec: position }) ? 0 : position;
}
