import type { MediaItem } from './types';

/**
 * Groups the library into series and sagas.
 *
 * Two things get folded together: episodes that share a series name (seasons
 * within them), and films whose titles differ only by a sequel marker —
 * "Northern Lantern" and "Northern Lantern II" belong on one shelf. Grouping is
 * deliberately conservative: a single title never forms a collection on its
 * own, because a wrong merge is far more annoying than a missed one.
 *
 * Every decision here can be overridden by the user, and overrides win.
 */

export type CollectionKind = 'series' | 'saga';

export interface Collection {
  /** Stable key derived from the grouping, or the user's chosen key. */
  key: string;
  title: string;
  kind: CollectionKind;
  items: MediaItem[];
  /** Episodes bucketed by season, for series. */
  seasons: { season: number; items: MediaItem[] }[];
}

export interface Grouping {
  collections: Collection[];
  /** Titles that belong to no collection. */
  singles: MediaItem[];
}

export interface Overrides {
  /** Item id → collection key the user filed it under. */
  itemToKey: Record<string, string>;
  /** Collection key → display title the user chose. */
  titles: Record<string, string>;
  /** Item ids the user explicitly pulled out of any collection. */
  detached: string[];
}

export const emptyOverrides = (): Overrides => ({
  itemToKey: {},
  titles: {},
  detached: [],
});

const ROMAN: Record<string, number> = {
  i: 1, ii: 2, iii: 3, iv: 4, v: 5,
  vi: 6, vii: 7, viii: 8, ix: 9, x: 10,
};

/**
 * Splits a film title into the part that identifies the saga and its ordinal.
 *
 * Only trailing markers count. A leading number is part of the name ("2001"),
 * and a four-digit trailing number is a year, not a sequel.
 */
export function splitSequel(title: string): { base: string; ordinal: number | null } {
  const trimmed = title.trim();

  const patterns: RegExp[] = [
    /^(.*?)[\s:–-]+(?:part|chapter|vol\.?|volume|book)\s+([0-9]{1,2}|[ivx]{1,4})$/i,
    /^(.*?)\s+([0-9]{1,2})$/,
    /^(.*?)\s+([ivx]{1,4})$/i,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (!match) continue;

    const base = match[1].trim();
    const raw = match[2].toLowerCase();
    // A bare "2001" is a year or part of the name, not a second instalment.
    if (/^\d+$/.test(raw) && raw.length >= 3) continue;
    if (base.length < 2) continue;

    const ordinal = /^\d+$/.test(raw) ? parseInt(raw, 10) : (ROMAN[raw] ?? null);
    if (ordinal === null || ordinal < 2 || ordinal > 30) continue;

    return { base, ordinal };
  }

  return { base: trimmed, ordinal: null };
}

const normalise = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export const seriesKey = (name: string) => `series:${normalise(name)}`;
export const sagaKey = (base: string) => `saga:${normalise(base)}`;

/** Builds the shelves the Theatre displays. */
export function groupLibrary(items: MediaItem[], overrides: Overrides): Grouping {
  const buckets = new Map<string, MediaItem[]>();
  const detached = new Set(overrides.detached);
  const loose: MediaItem[] = [];

  for (const item of items) {
    const forced = overrides.itemToKey[item.id];
    if (forced) {
      buckets.set(forced, [...(buckets.get(forced) ?? []), item]);
      continue;
    }
    if (detached.has(item.id)) {
      loose.push(item);
      continue;
    }
    if (item.series) {
      const key = seriesKey(item.series);
      buckets.set(key, [...(buckets.get(key) ?? []), item]);
      continue;
    }
    loose.push(item);
  }

  // Films that share a sequel base become a saga, but only in company.
  const byBase = new Map<string, MediaItem[]>();
  for (const item of loose) {
    const { base } = splitSequel(item.title);
    const key = sagaKey(base);
    byBase.set(key, [...(byBase.get(key) ?? []), item]);
  }

  const singles: MediaItem[] = [];
  for (const [key, group] of byBase) {
    if (group.length >= 2) {
      buckets.set(key, [...(buckets.get(key) ?? []), ...group]);
    } else {
      singles.push(...group);
    }
  }

  const collections: Collection[] = [];
  for (const [key, group] of buckets) {
    if (!group.length) continue;
    const kind: CollectionKind = key.startsWith('series:') ? 'series' : 'saga';

    const sorted = [...group].sort((a, b) => {
      if (kind === 'series') {
        return (a.season ?? 0) - (b.season ?? 0) || (a.episode ?? 0) - (b.episode ?? 0);
      }
      const oa = splitSequel(a.title).ordinal ?? 1;
      const ob = splitSequel(b.title).ordinal ?? 1;
      return oa - ob || a.title.localeCompare(b.title);
    });

    const seasonMap = new Map<number, MediaItem[]>();
    for (const item of sorted) {
      const season = item.season ?? 1;
      seasonMap.set(season, [...(seasonMap.get(season) ?? []), item]);
    }

    collections.push({
      key,
      kind,
      title:
        overrides.titles[key] ??
        (kind === 'series'
          ? (sorted.find((i) => i.series)?.series ?? sorted[0].title)
          : splitSequel(sorted[0].title).base),
      items: sorted,
      seasons: [...seasonMap.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([season, list]) => ({ season, items: list })),
    });
  }

  // A collection that ended up with one title is not a collection - unless a
  // person made it. The two-title rule exists to stop the *automatic* pass
  // inventing a saga out of a lone film; applied to a deliberate choice it
  // silently deleted the category the moment you created it, because a new
  // one necessarily starts with a single title in it.
  const authored = new Set<string>([
    ...Object.values(overrides.itemToKey),
    ...Object.keys(overrides.titles),
  ]);

  const kept: Collection[] = [];
  for (const c of collections) {
    if (c.items.length >= 2 || authored.has(c.key)) kept.push(c);
    else singles.push(...c.items);
  }

  kept.sort((a, b) => a.title.localeCompare(b.title));
  singles.sort((a, b) => b.addedAt - a.addedAt);

  return { collections: kept, singles };
}

/** Summary line for a collection card. */
export function describeCollection(c: Collection): string {
  if (c.kind === 'series') {
    const seasons = c.seasons.length;
    return seasons > 1
      ? `${seasons} seasons · ${c.items.length} episodes`
      : `${c.items.length} episodes`;
  }
  return `${c.items.length} films`;
}
