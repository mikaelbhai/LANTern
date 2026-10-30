import type { MediaItem } from './types';
import { resumeAt } from './watched';

/**
 * A second, independent copy of where each title was left.
 *
 * The saved position lives in the native database and is carried between
 * devices by a title key. That has failed in ways that were hard to see - a
 * write that arrived while the host was away and blanked what was known, a
 * rebuilt shelf that preferred a stale copy - and each time the result was a
 * film an hour in starting from the beginning. This is the net under all of
 * that: written alongside every accepted position, in the page's own storage,
 * and consulted only when the shelf's answer is both older and further back.
 *
 * Nothing here is trusted over the database when the database is the newer
 * word; see `recoveredPosition`.
 */

const KEY = 'lantern.resume.v1';
const CAP = 300;
/** Under this a position is "the start", and is not worth remembering. */
const MIN_SEC = 5;

interface Entry {
  sec: number;
  at: number;
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The same title on any device: its name, which episode, and its length to the
 * nearest minute. Not an id - an id says where a file is kept, and the point is
 * to survive that changing.
 */
export function mirrorKey(item: MediaItem): string {
  return `${normalise(item.series ?? item.title)}|${item.season ?? ''}x${item.episode ?? ''}|${Math.round(
    (item.durationSec || 0) / 60,
  )}`;
}

function read(): Record<string, Entry> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}

/** Notes a position that was really reached. */
export function rememberPosition(item: MediaItem, sec: number, at = Date.now()): void {
  if (!(sec > MIN_SEC)) return;
  try {
    const all = read();
    all[mirrorKey(item)] = { sec: Math.floor(sec), at };
    const keys = Object.keys(all);
    if (keys.length > CAP) {
      keys
        .sort((a, b) => all[a].at - all[b].at)
        .slice(0, keys.length - CAP)
        .forEach((k) => delete all[k]);
    }
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* Private window or full storage: this is a net, not the record. */
  }
}

/**
 * A position the shelf has lost, if this copy knows better.
 *
 * Only when it is both newer than the shelf's own last write and more than half
 * a minute further on: a shelf that is current, or that is simply a little
 * behind, is left alone, and a film that was finished and started again is not
 * pulled back to where the last viewing ended.
 */
export function recoveredPosition(item: MediaItem): number | null {
  const entry = read()[mirrorKey(item)];
  if (!entry) return null;
  const shelfAt = item.watchedAt ?? 0;
  return entry.at > shelfAt && entry.sec > item.progressSec + 30 ? entry.sec : null;
}

/**
 * Where to begin: the shelf's position, or the better one this remembers - and
 * the start, for a title that was left in its credits (see `watched.ts`).
 */
export function startPosition(item: MediaItem): number {
  return resumeAt(item, Math.max(item.progressSec, recoveredPosition(item) ?? 0));
}
