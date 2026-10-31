import { oneEpisodePerSeries } from '../screens/Theatre';
import type { Collection, Grouping } from '../lib/collections';
import { isContinuing, isFinished } from '../lib/watched';
import type { MediaItem } from '../lib/types';

/**
 * What the television's pages are made of.
 *
 * Kept apart from the components so the same rules feed the home page, the
 * Movies and Shows grids and the hero, and so they can be checked without a
 * television: nothing here touches the DOM.
 */

export type Tile =
  | { kind: 'item'; key: string; item: MediaItem }
  | { kind: 'show'; key: string; collection: Collection };

export interface Shelf {
  label: string;
  tiles: Tile[];
}

export const itemTile = (i: MediaItem): Tile => ({ kind: 'item', key: i.id, item: i });
export const showTile = (c: Collection): Tile => ({ kind: 'show', key: c.key, collection: c });

/** Which episode of a series to offer first: the one being watched, else the first not yet finished. */
export function whereToStart(c: Collection): MediaItem {
  const watching = c.items
    .filter(isContinuing)
    .sort((a, b) => (b.watchedAt ?? 0) - (a.watchedAt ?? 0))[0];
  if (watching) return watching;
  return c.items.find((i) => !isFinished(i)) ?? c.items[0];
}

/** The rows of the home page, in the order they are shown. */
export function homeShelves(items: MediaItem[], grouping: Grouping): Shelf[] {
  const out: Shelf[] = [];

  const continued = oneEpisodePerSeries(items.filter(isContinuing)).sort(
    (a, b) => (b.watchedAt ?? 0) - (a.watchedAt ?? 0),
  );
  if (continued.length) out.push({ label: 'Continue watching', tiles: continued.map(itemTile) });

  // Films seen to the end, for watching again from the start.
  const again = items
    .filter((i) => i.kind !== 'episode' && !i.series && isFinished(i))
    .sort((a, b) => (b.watchedAt ?? 0) - (a.watchedAt ?? 0))
    .slice(0, 20);
  if (again.length) out.push({ label: 'Watch again', tiles: again.map(itemTile) });

  if (grouping.collections.length) {
    out.push({ label: 'Shows & collections', tiles: grouping.collections.map(showTile) });
  }

  const recent = [...grouping.singles].sort((a, b) => b.addedAt - a.addedAt).slice(0, 24);
  if (recent.length) out.push({ label: 'Recently added', tiles: recent.map(itemTile) });

  const films = grouping.singles
    .filter((i) => i.kind === 'film')
    .sort((a, b) => a.title.localeCompare(b.title));
  if (films.length > recent.length || films.length > 8) out.push({ label: 'All films', tiles: films.map(itemTile) });

  const clips = grouping.singles.filter((i) => i.kind === 'clip');
  if (clips.length) out.push({ label: 'Clips', tiles: clips.map(itemTile) });
  return out;
}

/** Everything that is a film or a clip, by title. The Movies tab. */
export function movieTiles(grouping: Grouping): Tile[] {
  return grouping.singles
    .filter((i) => i.kind !== 'episode')
    .sort((a, b) => a.title.localeCompare(b.title))
    .map(itemTile);
}

/** Series and collections, by title. The Shows tab. */
export function showTiles(grouping: Grouping): Tile[] {
  return [...grouping.collections].sort((a, b) => a.title.localeCompare(b.title)).map(showTile);
}

/** What the hero rotates through: what is being watched first, then the newest. At most five. */
export function featured(items: MediaItem[], grouping: Grouping): Tile[] {
  const seen = new Set<string>();
  const out: Tile[] = [];
  const add = (t: Tile) => {
    if (seen.has(t.key) || out.length >= 5) return;
    seen.add(t.key);
    out.push(t);
  };
  oneEpisodePerSeries(items.filter(isContinuing))
    .sort((a, b) => (b.watchedAt ?? 0) - (a.watchedAt ?? 0))
    .forEach((i) => add(itemTile(i)));
  [...grouping.singles]
    .filter((i) => i.kind === 'film' && !isFinished(i))
    .sort((a, b) => b.addedAt - a.addedAt)
    .forEach((i) => add(itemTile(i)));
  grouping.collections.forEach((c) => add(showTile(c)));
  return out;
}

/** The art for a tile: the item's own, or the first picture a collection has. */
export function coverOf(tile: Tile): MediaItem | undefined {
  return tile.kind === 'item' ? tile.item : (tile.collection.items.find((i) => i.posterUrl) ?? tile.collection.items[0]);
}

export const titleOf = (tile: Tile): string => (tile.kind === 'item' ? tile.item.title : tile.collection.title);

/** What a tile plays when somebody presses Play on it. */
export function playTarget(tile: Tile): MediaItem {
  return tile.kind === 'item' ? tile.item : whereToStart(tile.collection);
}
