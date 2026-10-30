import React from 'react';

import { api, on } from './bridge';
import type { Overrides } from './collections';
import { emptyOverrides } from './collections';
import type { MediaItem } from './types';

/**
 * The collections other devices have made, as one set of overrides.
 *
 * A host's names for its collections ("Sam Raimi Spider-Man") and the ones it
 * made by hand were kept on its own screen and nowhere else, so every other
 * device grouped the same titles from their filenames and showed something
 * different. Each device now publishes how it groups its library; this reads
 * them (already translated to the ids this device's library uses - see
 * `collections_sync.rs`) and folds them together.
 *
 * What the viewer chose on this device always wins over what a host chose.
 */

type Published = Record<string, Partial<Overrides> | undefined>;

/** Folds several peers' published groupings into one set of overrides. */
export function foldPeerOverrides(published: Published | null | undefined): Overrides {
  const out = emptyOverrides();
  for (const o of Object.values(published ?? {})) {
    if (!o) continue;
    Object.assign(out.itemToKey, o.itemToKey ?? {});
    Object.assign(out.titles, o.titles ?? {});
    out.detached.push(...(o.detached ?? []));
    Object.assign(out.memberOrder!, o.memberOrder ?? {});
  }
  return out;
}

/** `base` first, then `mine` on top: this device's own choices win. */
export function mergeOverrides(base: Overrides, mine: Overrides): Overrides {
  // A title this device filed somewhere itself, or pulled out of every
  // collection, is not put back by a host's idea of it.
  const mineDetached = new Set(mine.detached);
  const hostItemToKey = Object.fromEntries(
    Object.entries(base.itemToKey).filter(([id]) => !mineDetached.has(id)),
  );
  return {
    itemToKey: { ...hostItemToKey, ...mine.itemToKey },
    titles: { ...base.titles, ...mine.titles },
    detached: [...new Set([...base.detached.filter((id) => !(id in mine.itemToKey)), ...mine.detached])],
    order: mine.order,
    memberOrder: { ...(base.memberOrder ?? {}), ...(mine.memberOrder ?? {}) },
  };
}

/** What peers have published, kept current. */
export function usePeerOverrides(): Overrides {
  const [published, setPublished] = React.useState<Published>({});

  React.useEffect(() => {
    let alive = true;
    // Null from a build without the command, or from the simulator.
    void api.media
      .peerCollections()
      .then((p) => alive && setPublished((p as Published) ?? {}))
      .catch(() => undefined);
    const off = on('library:collections', (p: Published) => setPublished(p ?? {}));
    return () => {
      alive = false;
      off();
    };
  }, []);

  return React.useMemo(() => foldPeerOverrides(published), [published]);
}

/**
 * This device's own choices, for publishing: only the ones about titles that
 * are in this device's own library. A choice about somebody else's title is
 * theirs to publish, and its id would mean nothing to a reader here.
 */
export function ownChoices(overrides: Overrides, items: MediaItem[]): Overrides {
  const own = new Set(items.filter((i) => !i.peerId).map((i) => i.id));
  return {
    ...overrides,
    itemToKey: Object.fromEntries(Object.entries(overrides.itemToKey).filter(([id]) => own.has(id))),
    detached: overrides.detached.filter((id) => own.has(id)),
    memberOrder: Object.fromEntries(
      Object.entries(overrides.memberOrder ?? {})
        .map(([key, ids]) => [key, ids.filter((id) => own.has(id))] as const)
        .filter(([, ids]) => ids.length > 0),
    ),
  };
}
