import React from 'react';
import { AnimatePresence, Reorder, motion } from 'framer-motion';
import {
  Check,
  ChevronLeft,
  ChevronRight,
  Download,
  Film,
  Info,
  Play,
  Plus,
  RefreshCw,
  Layers,
  Lock,
  Pencil,
  Search,
  ShieldCheck,
  Tv,
  Upload,
  Users,
} from 'lucide-react';
import { ScreenHeader } from '../components/ScreenHeader';
import { Avatar } from '../components/Avatar';
import { LockButton } from '../components/PinUnlock';
import { canHost } from '../lib/picker';
import { Badge, Button, Empty, IconButton, Input, Modal, Select, Spinner } from '../components/ui';
import { Audience, TITLE_AGES, ratingLabel } from '../components/Audience';
import { Artwork, Thumbnail, TitleCard } from '../lib/poster';
import { Player } from './theatre/Player';
import { PublishMediaModal } from './theatre/PublishMedia';
import { api, on } from '../lib/bridge';
import {
  type Collection,
  type Overrides,
  describeCollection,
  emptyOverrides,
  groupLibrary,
  sagaKey,
} from '../lib/collections';
import { useLocalStorage } from '../lib/hooks';
import { useStore } from '../lib/store';
import { cn, formatBytes } from '../lib/utils';
import type { MediaItem, RatingsStatus, WatchParty } from '../lib/types';
import { PullToRefresh } from '../components/PullToRefresh';

export function Theatre() {
  const peers = useStore((s) => s.peers);
  const profile = useStore((s) => s.profile);
  const toast = useStore((s) => s.toast);

  const [items, setItems] = React.useState<MediaItem[]>([]);

  /**
   * The watch party this device is in, if any.
   *
   * The backend owns it: starting one, or being invited into one, both arrive
   * as `party:changed`. Holding it here rather than in the player means the
   * invitation survives closing and reopening a title.
   */
  const [party, setParty] = React.useState<WatchParty | null>(null);

  React.useEffect(() => on('party:changed', (p) => setParty(p as WatchParty | null)), []);

  /**
   * Peers that are online but whose library could not be read.
   *
   * Worth saying out loud. An empty Theatre beside a peer that is plainly
   * connected - you can call them - reads as "they have shared nothing", when
   * what actually happened is that something between the two machines refused
   * the connection to their file server. A firewall that allows the app on one
   * network profile and not another produces exactly that, and gives no other
   * sign anywhere in the app.
   */
  const [unreachable, setUnreachable] = React.useState<string[]>([]);
  React.useEffect(
    () => on('library:unreachable', (names) => setUnreachable((names as string[]) ?? [])),
    [],
  );
  const [loading, setLoading] = React.useState(true);
  const [playing, setPlaying] = React.useState<MediaItem | null>(null);
  const [detail, setDetail] = React.useState<MediaItem | null>(null);
  const [query, setQuery] = React.useState('');
  const [publishOpen, setPublishOpen] = React.useState(false);
  /** Who may watch what this device publishes — the same panel as Settings. */
  const [audienceOpen, setAudienceOpen] = React.useState(false);
  const [collection, setCollection] = React.useState<Collection | null>(null);
  const [overrides, setOverrides] = useLocalStorage<Overrides>(
    'lantern.theatre.grouping',
    emptyOverrides(),
  );
  const [filmSort, setFilmSort] = useLocalStorage<FilmSort>('lantern.theatre.filmSort', 'watched');

  const load = React.useCallback(async () => {
    setItems(await api.media.list());
    setLoading(false);
  }, []);

  /**
   * Titles pulled from a peer onto this device already, and which transfer
   * is carrying one still in flight — keyed by the *original* item id, not
   * the synced copy's own (a different share entirely), which is what lets
   * a row ask "do I already have this one" about the title it is showing.
   */
  const [syncedIds, setSyncedIds] = React.useState<Set<string>>(new Set());
  const loadSynced = React.useCallback(() => {
    void api.media.syncedIds().then((ids) => setSyncedIds(new Set(ids)));
  }, []);
  const [syncTransfers, setSyncTransfers] = React.useState<Record<string, string>>({});
  const startSync = React.useCallback(async (item: MediaItem) => {
    const transferId = await api.media.sync(item);
    setSyncTransfers((prev) => ({ ...prev, [item.id]: transferId }));
  }, []);
  const removeSync = React.useCallback(async (item: MediaItem) => {
    await api.media.removeSynced(item.id);
    setSyncedIds((prev) => {
      const next = new Set(prev);
      next.delete(item.id);
      return next;
    });
  }, []);

  React.useEffect(() => {
    void load();
    loadSynced();
    // A completed sync rescans on the native side and emits the same event
    // a folder being republished does — refreshing both here is what makes
    // a title that just finished syncing show its "Synced" state without a
    // manual reload.
    return on('media:changed', (list: MediaItem[]) => {
      setItems(list);
      loadSynced();
    });
  }, [load, loadSynced]);

  const ownerName = React.useCallback(
    (item: MediaItem) =>
      item.peerId
        ? // The live peer list first, because a name can change; then the one
          // the library was fetched with, which is there even when the peer
          // momentarily is not.
          (peers[item.peerId]?.name ?? (item as any).ownerName ?? 'Peer')
        : profile.name || 'This device',
    [peers, profile.name],
  );

  const searching = query.trim().length > 0;
  const results = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return items.filter(
      (i) =>
        i.title.toLowerCase().includes(q) ||
        i.series?.toLowerCase().includes(q) ||
        i.genres.some((g) => g.toLowerCase().includes(q)),
    );
  }, [items, query]);

  const grouping = React.useMemo(
    () => groupLibrary(items, overrides),
    [items, overrides],
  );
  const rows = React.useMemo(
    () => buildRows(items, grouping, ownerName, filmSort),
    [items, grouping, ownerName, filmSort],
  );

  // Keep an open collection in step with regrouping.
  React.useEffect(() => {
    if (!collection) return;
    const fresh = grouping.collections.find((c) => c.key === collection.key);
    setCollection(fresh ?? null);
  }, [grouping]);
  const hero = React.useMemo(() => pickHero(items), [items]);

  const play = (item: MediaItem) => {
    /*
     * A locked title is listed and not served.
     *
     * It used to open the player anyway. The device holding the file refuses
     * the stream, and the player has one way of saying it got nothing:
     * "Can't reach" - which describes a network that is down, not a rating
     * that is being enforced. So the one case the person can do something
     * about looked exactly like the one they cannot.
     *
     * The door is still visible, as it is meant to be. It just says what it
     * is now, and who can open it.
     */
    if (item.locked) {
      toast({
        kind: 'info',
        title: `${item.title} is rated ${ratingLabel(item.minAge) || 'above this device'}`,
        body: `${ownerName(item)} decides what this device may watch. Ask them to let this one past.`,
      });
      return;
    }
    setDetail(null);
    setPlaying(item);
  };

  /**
   * Starts everyone on the same title at the same moment.
   *
   * Every peer that is online is invited: a watch party on a LAN is the people
   * in the house, and asking which of four devices to include is a dialog that
   * earns nothing.
   */
  const watchTogether = async (item: MediaItem) => {
    const online = Object.values(peers)
      .filter((p) => p.status !== 'offline')
      .map((p) => p.id);
    if (!online.length) return;
    try {
      setParty(await api.party.start(item.id, online));
    } catch {
      // Starting one is optional; playing the film alone is not.
    }
    play(item);
  };

  const onlinePeerCount = React.useMemo(
    () => Object.values(peers).filter((p) => p.status !== 'offline').length,
    [peers],
  );

  const partyMembers = React.useMemo(() => {
    if (!party) return [];
    return party.members
      .map((id) => peers[id])
      .filter((p): p is NonNullable<typeof p> => !!p)
      .map((p) => ({ name: p.name, color: p.color, emoji: p.emoji }));
  }, [party, peers]);

  if (playing) {
    const order = seriesOrder(items, playing);
    const at = order.findIndex((i) => i.id === playing.id);
    return (
      <Player
        item={playing}
        upNext={at >= 0 ? (order[at + 1] ?? null) : null}
        previous={at > 0 ? (order[at - 1] ?? null) : null}
        ownerName={ownerName(playing)}
        // A party only applies to the title it was started for; opening
        // something else leaves the others watching what they chose.
        party={party && party.itemId === playing.id ? party : null}
        isHost={!!party && party.hostId === profile.id}
        partyMembers={partyMembers}
        onClose={() => {
          if (party) {
            void api.party.leave(party.id).catch(() => {});
            setParty(null);
          }
          setPlaying(null);
          void load();
        }}
        onPlayNext={(next) => setPlaying(next)}
      />
    );
  }

  return (
    // The palette is redeclared by the shell while this screen is showing, so
    // `bg-base` here is the cinema's near-black and the bar above and tabs
    // below are dark with it. It used to be a hardcoded #08090C between two
    // white bars. See `.cinema` in index.css.
    <div className="h-full flex flex-col bg-base">
      <ScreenHeader
        icon={<Film size={15} />}
        title="Theatre"
        hint="Everything published on the network, streamed straight from the device holding it"
        actions={
          <>
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search titles…"
              icon={<Search size={12} />}
              className="w-44 hidden md:flex"
            />
            <IconButton
              label="Rescan the network"
              onClick={() => {
                setLoading(true);
                void api.media.scan().then((l) => {
                  setItems(l);
                  setLoading(false);
                });
              }}
            >
              <RefreshCw size={16} />
            </IconButton>
            {canHost() ? (
              <>
                {/* Publishing is deciding who it is for, so the two sit
                    together rather than one of them being three screens
                    away in Settings. */}
                <IconButton label="Who can watch" onClick={() => setAudienceOpen(true)}>
                  <ShieldCheck size={16} />
                </IconButton>
                <IconButton label="Add videos" onClick={() => setPublishOpen(true)}>
                  <Plus size={18} />
                </IconButton>
              </>
            ) : (
              /*
               * A phone or a television cannot publish here — Android's
               * picker hands back a `content://` URI, not a path the file
               * server can hold open and serve from, so the folder button
               * led to a picker that could not finish what it started.
               * What a viewer-only device gets instead is a way to see
               * further into what is already published: a phrase, tried
               * against every host on the network at once.
               */
              <LockButton />
            )}
          </>
        }
      />

      <div className="shrink-0 px-4 py-2.5 md:hidden">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search titles…"
          icon={<Search size={15} />}
          className="h-11 rounded-full bg-raised border-transparent pl-10 text-sm"
        />
      </div>

      {unreachable.length > 0 && (
        <div className="shrink-0 mx-4 mt-3 rounded-card border border-gold/30 bg-gold/10 px-3 py-2">
          <p className="text-xs text-gold/90 leading-relaxed">
            <span className="font-medium">
              Can&rsquo;t read {unreachable.join(', ')}
              {unreachable.length > 1 ? "'s libraries" : "'s library"}.
            </span>{' '}
            {unreachable.length > 1 ? 'Those devices are' : 'That device is'} online — messages
            and calls work — but the connection to{' '}
            {unreachable.length > 1 ? 'their' : 'its'} files is being refused. On Windows that
            is usually the firewall: the network it is on has to be set to Private, or LANTern
            allowed on a Public one.
          </p>
        </div>
      )}

      <PullToRefresh className="flex-1" onRefresh={() => api.media.scan().then(setItems)}>
      <div>
        {loading ? (
          <div className="p-6 space-y-6">
            <div className="h-[300px] rounded-card bg-surface animate-pulse" />
            <div className="flex gap-3">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="h-28 w-52 rounded-card bg-surface animate-pulse" />
              ))}
            </div>
          </div>
        ) : items.length === 0 ? (
          <Empty
            icon={<Tv size={20} />}
            title="Nothing to watch yet"
            hint={
              canHost()
                ? 'Publish a folder of videos and it appears here — and in the Theatre of everyone else on the network.'
                : 'Nothing is published on the network yet. A phone or a television watches — publishing is a desktop or a laptop\'s job.'
            }
            action={
              canHost() ? (
                <Button variant="primary" icon={<Upload size={13} />} onClick={() => setPublishOpen(true)}>
                  Add videos
                </Button>
              ) : undefined
            }
          />
        ) : searching ? (
          <div className="p-4">
            <h2 className="text-sm font-semibold mb-3">
              {results.length} result{results.length === 1 ? '' : 's'} for “{query.trim()}”
            </h2>
            {results.length === 0 ? (
              <p className="text-xs text-muted">Nothing matches that.</p>
            ) : (
              <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(196px,1fr))]">
                {results.map((item) => (
                  <Card
                    key={item.id}
                    item={item}
                    owner={ownerName(item)}
                    onPlay={() => play(item)}
                    onInfo={() => setDetail(item)}
                  />
                ))}
              </div>
            )}
          </div>
        ) : (
          <>
            {hero && (
              <Hero
                item={hero}
                owner={ownerName(hero)}
                onPlay={() => play(hero)}
                onInfo={() => setDetail(hero)}
              />
            )}
            <div className="pb-8 -mt-10 relative z-10">
              {rows.map((row) => (
                <Row
                  key={row.label}
                  label={row.label}
                  entries={row.entries}
                  ownerName={ownerName}
                  onPlay={play}
                  onInfo={setDetail}
                  onOpenCollection={setCollection}
                  onReorder={
                    row.label === 'Series & collections'
                      ? (keys) => setOverrides({ ...overrides, order: keys })
                      : undefined
                  }
                  sortControl={
                    row.label === 'Films' ? (
                      <Select
                        value={filmSort}
                        onChange={setFilmSort}
                        options={FILM_SORTS}
                        className="w-40 shrink-0"
                      />
                    ) : undefined
                  }
                />
              ))}
            </div>
          </>
        )}
      </div>
      </PullToRefresh>

      <DetailSheet
        onWatchTogether={(i) => void watchTogether(i)}
        peerCount={onlinePeerCount}
        item={detail}
        owner={detail ? ownerName(detail) : ''}
        collections={grouping.collections}
        overrides={overrides}
        onOverrides={setOverrides}
        onRated={() => void load()}
        onClose={() => setDetail(null)}
        onPlay={play}
        syncedIds={syncedIds}
        syncTransfers={syncTransfers}
        onSync={startSync}
        onRemoveSync={removeSync}
      />

      <CollectionSheet
        collection={collection}
        ownerName={ownerName}
        overrides={overrides}
        onOverrides={setOverrides}
        onRated={() => void load()}
        onClose={() => setCollection(null)}
        onPlay={play}
        onInfo={(i) => {
          setCollection(null);
          setDetail(i);
        }}
        syncedIds={syncedIds}
        syncTransfers={syncTransfers}
        onSync={startSync}
        onRemoveSync={removeSync}
      />

      <PublishMediaModal
        open={publishOpen}
        onClose={() => {
          setPublishOpen(false);
          void load();
        }}
      />

      {/* The same panel Settings draws, opened from where the decision is
          actually being made. */}
      <Modal
        open={audienceOpen}
        onClose={() => {
          setAudienceOpen(false);
          void load();
        }}
        title="Who can watch"
        width="max-w-xl"
      >
        <p className="text-2xs text-muted leading-relaxed mb-4">
          Everything below is decided by this device, at the moment a file would
          be sent. Nothing depends on the watching app agreeing to behave.
        </p>
        <Audience compact />
      </Modal>
    </div>
  );
}

/* -------------------------------------------------------------- shaping */

/**
 * One series in the order you would actually watch it.
 *
 * Season first, then episode. Sorting on episode alone put S2E1 before S1E2,
 * so "next episode" from the middle of season two offered the first episode of
 * season one — the whole series sorted, with position ignored.
 *
 * Anything missing a number sorts last rather than as zero, so an unnumbered
 * special does not jump to the front of the run.
 */
function seriesOrder(items: MediaItem[], of: MediaItem): MediaItem[] {
  if (!of.series) return [of];
  const rank = (n: number | undefined) => (typeof n === 'number' ? n : Number.MAX_SAFE_INTEGER);
  return items
    .filter((i) => i.series === of.series)
    .sort(
      (a, b) =>
        rank(a.season) - rank(b.season) ||
        rank(a.episode) - rank(b.episode) ||
        a.title.localeCompare(b.title),
    );
}

/**
 * One row per series in Continue watching, rather than one per episode.
 *
 * A show watched over a week put every part-finished episode on the shelf side
 * by side - "S1 E1", "S1 E2", the same artwork twice over - which is a list of
 * everything except the one thing being asked for, which is where to carry on.
 *
 * The furthest in is the one kept: episode three half-watched means one and
 * two are behind you, whatever their own progress bars say. Films are
 * untouched; each is its own thing and belongs on the shelf in its own right.
 */
function oneEpisodePerSeries(items: MediaItem[]): MediaItem[] {
  const furthest = new Map<string, MediaItem>();
  const out: MediaItem[] = [];

  for (const item of items) {
    if (!item.series) {
      out.push(item);
      continue;
    }
    const held = furthest.get(item.series);
    if (!held || isLater(item, held)) furthest.set(item.series, item);
  }

  return [...out, ...furthest.values()];
}

/** Later in a series: by season, then by episode. */
function isLater(a: MediaItem, b: MediaItem): boolean {
  const season = (i: MediaItem) => i.season ?? 0;
  const episode = (i: MediaItem) => i.episode ?? 0;
  if (season(a) !== season(b)) return season(a) > season(b);
  return episode(a) > episode(b);
}

function pickHero(items: MediaItem[]): MediaItem | null {
  if (!items.length) return null;
  // Prefer something part-watched, then the newest full-length title.
  const resumable = items.find((i) => i.progressSec > 60 && i.progressSec < i.durationSec * 0.95);
  if (resumable) return resumable;
  const films = items.filter((i) => i.kind === 'film');
  return (films.length ? films : items).reduce((a, b) => (b.addedAt > a.addedAt ? b : a));
}

export type RowEntry =
  | { type: 'item'; item: MediaItem }
  | { type: 'collection'; collection: Collection };

/**
 * Shelves for the browse view.
 *
 * Collections stand in for their members everywhere except Continue watching,
 * where the specific episode someone is partway through is the useful thing to
 * show.
 */
export type FilmSort = 'watched' | 'added' | 'title' | 'year';

export const FILM_SORTS: { value: FilmSort; label: string }[] = [
  { value: 'watched', label: 'Latest watched' },
  { value: 'added', label: 'Recently added' },
  { value: 'title', label: 'Title A–Z' },
  { value: 'year', label: 'Newest release' },
];

function sortFilms(films: MediaItem[], sort: FilmSort): MediaItem[] {
  const sorted = [...films];
  switch (sort) {
    case 'watched':
      // Never-watched titles have nothing to sort by here and fall back to
      // recently-added, after every title that has actually been watched -
      // "latest watched" putting untouched titles first would be backwards.
      return sorted.sort((a, b) => {
        if (a.watchedAt && b.watchedAt) return b.watchedAt - a.watchedAt;
        if (a.watchedAt) return -1;
        if (b.watchedAt) return 1;
        return b.addedAt - a.addedAt;
      });
    case 'added':
      return sorted.sort((a, b) => b.addedAt - a.addedAt);
    case 'title':
      return sorted.sort((a, b) => a.title.localeCompare(b.title));
    case 'year':
      return sorted.sort((a, b) => (b.year ?? 0) - (a.year ?? 0));
  }
}

function buildRows(
  items: MediaItem[],
  grouping: { collections: Collection[]; singles: MediaItem[] },
  ownerName: (i: MediaItem) => string,
  filmSort: FilmSort,
): { label: string; entries: RowEntry[] }[] {
  if (!items.length) return [];
  const rows: { label: string; entries: RowEntry[] }[] = [];

  const asItem = (item: MediaItem): RowEntry => ({ type: 'item', item });
  const asCollection = (collection: Collection): RowEntry => ({
    type: 'collection',
    collection,
  });

  // Most recently watched first. `watchedAt` is the actual answer; a title
  // saved before this field existed falls back to how far into it someone
  // got, which is a guess but a better one than the order it happened to be
  // added in.
  const continued = oneEpisodePerSeries(
    items.filter((i) => i.progressSec > 30 && i.progressSec < i.durationSec * 0.95),
  ).sort(
    (a, b) => (b.watchedAt ?? b.progressSec / b.durationSec) - (a.watchedAt ?? a.progressSec / a.durationSec),
  );
  if (continued.length) {
    rows.push({ label: 'Continue watching', entries: continued.map(asItem) });
  }

  if (grouping.collections.length) {
    rows.push({
      label: 'Series & collections',
      entries: grouping.collections.map(asCollection),
    });
  }

  // Newest first, with a collection dated by its most recent member.
  const recent: RowEntry[] = [
    ...grouping.collections.map((c) => ({
      entry: asCollection(c),
      at: Math.max(...c.items.map((i) => i.addedAt)),
    })),
    ...grouping.singles.map((i) => ({ entry: asItem(i), at: i.addedAt })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 12)
    .map((x) => x.entry);
  if (recent.length) rows.push({ label: 'Recently added', entries: recent });

  const films = grouping.singles.filter((i) => i.kind === 'film');
  if (films.length) {
    rows.push({ label: 'Films', entries: sortFilms(films, filmSort).map(asItem) });
  }

  // One row per device, so it is obvious where a title is coming from.
  const byOwner = new Map<string, MediaItem[]>();
  for (const item of grouping.singles) {
    const key = ownerName(item);
    byOwner.set(key, [...(byOwner.get(key) ?? []), item]);
  }
  for (const [owner, list] of byOwner) {
    if (list.length >= 2) {
      rows.push({ label: `From ${owner}`, entries: list.map(asItem) });
    }
  }

  const clips = grouping.singles.filter((i) => i.kind === 'clip');
  if (clips.length) rows.push({ label: 'Clips', entries: clips.map(asItem) });

  return rows;
}

/* ----------------------------------------------------------------- hero */

function Hero({
  item,
  owner,
  onPlay,
  onInfo,
}: {
  item: MediaItem;
  owner: string;
  onPlay: () => void;
  onInfo: () => void;
}) {
  const resume = item.progressSec > 30;
  return (
    <div className="relative h-[320px] md:h-[400px]">
      <Artwork
        title={item.title}
        seed={item.id}
        variant="backdrop"
        rounded={false}
        className="absolute inset-0 h-full w-full"
      />
      <div className="absolute inset-0 bg-gradient-to-r from-[#08090C] via-[#08090C]/70 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-[#08090C] to-transparent" />

      <div className="relative h-full flex flex-col justify-end p-6 md:p-10 max-w-2xl">
        {item.series && (
          <Badge tone="gold" className="w-fit mb-2">
            {item.series} · S{item.season} E{item.episode}
          </Badge>
        )}
        <h1 className="text-2xl md:text-[40px] font-bold leading-[1.05] text-white drop-shadow-lg">
          {item.title}
        </h1>
        <div className="flex items-center gap-2 mt-2.5 text-xs text-white/70 flex-wrap">
          {item.year && <span>{item.year}</span>}
          <span>·</span>
          <span>{runtime(item.durationSec)}</span>
          {item.quality && (
            <>
              <span>·</span>
              <span className="px-1.5 h-[18px] inline-flex items-center rounded border border-white/25 text-[10px] font-semibold tracking-wide">
                {item.quality}
              </span>
            </>
          )}
          <span>·</span>
          <span>{item.genres.join(' · ')}</span>
          <span>·</span>
          <span className="text-cyan">{owner}</span>
        </div>
        {item.synopsis && (
          <p className="text-sm text-white/80 mt-3 leading-relaxed max-w-lg line-clamp-3">
            {item.synopsis}
          </p>
        )}

        {resume && (
          <div className="mt-3 max-w-xs">
            <div className="h-1 bg-white/20 rounded-full overflow-hidden">
              <div
                className="h-full bg-gold"
                style={{ width: `${(item.progressSec / item.durationSec) * 100}%` }}
              />
            </div>
            <div className="text-[10px] text-white/60 mt-1">
              {runtime(item.durationSec - item.progressSec)} left
            </div>
          </div>
        )}

        <div className="flex gap-2 mt-5">
          <button
            onClick={onPlay}
            className="h-10 px-6 rounded-input bg-white text-black font-semibold text-sm flex items-center gap-2 hover:bg-white/85 transition-colors active:scale-[0.98]"
          >
            <Play size={16} fill="currentColor" />
            {resume ? 'Resume' : 'Play'}
          </button>
          <button
            onClick={onInfo}
            className="h-10 px-5 rounded-input bg-white/15 text-white font-medium text-sm flex items-center gap-2 hover:bg-white/25 transition-colors backdrop-blur active:scale-[0.98]"
          >
            <Info size={16} />
            More info
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------- rows */

function Row({
  label,
  entries,
  ownerName,
  onPlay,
  onInfo,
  onOpenCollection,
  onReorder,
  sortControl,
}: {
  label: string;
  entries: RowEntry[];
  ownerName: (i: MediaItem) => string;
  onPlay: (i: MediaItem) => void;
  onInfo: (i: MediaItem) => void;
  onOpenCollection: (c: Collection) => void;
  /**
   * Present only on the collections shelf. Drag order is meaningful there —
   * it is how you put the show you actually watch above forty others
   * fetched once and never opened again — and meaningless everywhere else,
   * where the row is already ordered by something with its own logic
   * (progress, recency, the device it came from).
   */
  onReorder?: (keys: string[]) => void;
  /** Present only on the Films row, the one shelf with no order of its own. */
  sortControl?: React.ReactNode;
}) {
  const scroller = React.useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = React.useState(false);
  const [canRight, setCanRight] = React.useState(false);

  const measure = React.useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 8);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 8);
  }, []);

  React.useEffect(() => {
    measure();
    const el = scroller.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [measure, entries.length]);

  const nudge = (dir: 1 | -1) => {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };

  return (
    <section className="mt-6 group/row">
      <div className="flex items-center justify-between px-6 mb-2">
        <h2 className="text-sm font-semibold text-white/90">{label}</h2>
        {sortControl}
      </div>
      <div className="relative">
        {canLeft && (
          <button
            onClick={() => nudge(-1)}
            aria-label="Scroll left"
            className="absolute left-0 top-0 bottom-0 z-20 w-10 grid place-items-center bg-gradient-to-r from-[#08090C] to-transparent opacity-0 group-hover/row:opacity-100 transition-opacity"
          >
            <ChevronLeft size={22} className="text-white" />
          </button>
        )}
        {canRight && (
          <button
            onClick={() => nudge(1)}
            aria-label="Scroll right"
            className="absolute right-0 top-0 bottom-0 z-20 w-10 grid place-items-center bg-gradient-to-l from-[#08090C] to-transparent opacity-0 group-hover/row:opacity-100 transition-opacity"
          >
            <ChevronRight size={22} className="text-white" />
          </button>
        )}

        {onReorder ? (
          <Reorder.Group
            as="div"
            axis="x"
            ref={scroller}
            onScroll={measure}
            values={entries.map((e) => (e.type === 'collection' ? e.collection.key : ''))}
            onReorder={onReorder}
            className="flex gap-3 overflow-x-auto no-scrollbar px-6 pb-2"
          >
            {entries.map((entry) =>
              entry.type === 'collection' ? (
                <Reorder.Item
                  key={entry.collection.key}
                  value={entry.collection.key}
                  className="w-52 shrink-0 cursor-grab active:cursor-grabbing"
                  whileDrag={{ scale: 1.04, zIndex: 10 }}
                >
                  <CollectionCard
                    collection={entry.collection}
                    onOpen={() => onOpenCollection(entry.collection)}
                  />
                </Reorder.Item>
              ) : null,
            )}
          </Reorder.Group>
        ) : (
          <div
            ref={scroller}
            onScroll={measure}
            className="flex gap-3 overflow-x-auto no-scrollbar px-6 pb-2"
          >
            {entries.map((entry) =>
              entry.type === 'item' ? (
                <div key={entry.item.id} className="w-52 shrink-0">
                  <Card
                    item={entry.item}
                    owner={ownerName(entry.item)}
                    onPlay={() => onPlay(entry.item)}
                    onInfo={() => onInfo(entry.item)}
                  />
                </div>
              ) : (
                <div key={entry.collection.key} className="w-52 shrink-0">
                  <CollectionCard
                    collection={entry.collection}
                    onOpen={() => onOpenCollection(entry.collection)}
                  />
                </div>
              ),
            )}
          </div>
        )}
      </div>
    </section>
  );
}

function Card({
  item,
  owner,
  onPlay,
  onInfo,
}: {
  item: MediaItem;
  owner: string;
  onPlay: () => void;
  onInfo: () => void;
}) {
  const pct = item.durationSec ? (item.progressSec / item.durationSec) * 100 : 0;

  return (
    <motion.div
      whileHover={{ scale: 1.05, y: -4 }}
      transition={{ type: 'spring', stiffness: 300, damping: 24 }}
      className="relative rounded-card overflow-hidden border border-white/10 bg-surface cursor-pointer group/card"
      onClick={onPlay}
      // Selectable by keyboard and by a remote control. A div with an onClick
      // is invisible to both: on a television the pad could never land on a
      // film, which made the whole screen unusable from a sofa.
      role="button"
      tabIndex={0}
      aria-label={item.title}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPlay();
        }
        // The pad's own "details" gesture, and a keyboard equivalent.
        if (e.key === 'ContextMenu' || e.key === 'i') onInfo();
      }}
    >
      <TitleCard
        title={item.title}
        subtitle={
          item.kind === 'episode'
            ? `S${item.season} E${item.episode} · ${owner}`
            : `${runtime(item.durationSec)} · ${owner}`
        }
        badge={item.quality}
        seed={item.id}
        streamUrl={item.streamUrl}
        posterUrl={item.posterUrl}
        className="aspect-video"
      />

      {/* What it is rated, where a rating exists. On the card rather than
          only in the details, because the question "can the children see
          this" is asked while looking at the shelf, not after opening one. */}
      {item.minAge !== undefined && (
        <span
          className="absolute top-1.5 left-1.5 px-1.5 h-[18px] rounded-[4px] bg-black/70 border border-white/20 text-[10px] font-medium text-white/90 grid place-items-center"
          title={item.ratedByHost ? 'Rated by you' : 'Guessed from the filename'}
        >
          {ratingLabel(item.minAge)}
        </span>
      )}

      {/* Restricted above the watching device's allowance: it is listed, and
          the bytes do not move. A door somebody can see. */}
      {item.locked && (
        <span className="absolute top-1.5 right-1.5 h-[18px] w-[18px] rounded-full bg-black/70 border border-white/20 grid place-items-center">
          <Lock size={9} className="text-white/80" />
        </span>
      )}

      {pct > 1 && (
        <div className="absolute bottom-0 inset-x-0 h-[3px] bg-black/50">
          <div className="h-full bg-gold" style={{ width: `${pct}%` }} />
        </div>
      )}

      <div className="absolute inset-0 bg-black/45 opacity-0 group-hover/card:opacity-100 transition-opacity grid place-items-center gap-2">
        <span className="h-11 w-11 rounded-full bg-white/95 grid place-items-center">
          <Play size={18} className="text-black ml-0.5" fill="currentColor" />
        </span>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onInfo();
          }}
          className="text-[10px] text-white/90 underline underline-offset-2"
        >
          More info
        </button>
      </div>
    </motion.div>
  );
}

/* --------------------------------------------------------------- detail */

function DetailSheet({
  item,
  owner,
  collections,
  overrides,
  onOverrides,
  onRated,
  onClose,
  onPlay,
  onWatchTogether,
  peerCount,
  syncedIds,
  syncTransfers,
  onSync,
  onRemoveSync,
}: {
  item: MediaItem | null;
  owner: string;
  collections: Collection[];
  overrides: Overrides;
  /** Starts everyone online on this title at once. */
  onWatchTogether?: (i: MediaItem) => void;
  /** How many peers are online, which decides whether that is worth offering. */
  peerCount: number;
  onOverrides: (o: Overrides) => void;
  /** Re-reads the library, so a rating just set is the one shown. */
  onRated: () => void;
  onClose: () => void;
  onPlay: (i: MediaItem) => void;
  syncedIds: Set<string>;
  syncTransfers: Record<string, string>;
  onSync: (i: MediaItem) => void;
  onRemoveSync: (i: MediaItem) => void;
}) {
  const peers = useStore((s) => s.peers);

  return (
    <AnimatePresence>
      {item && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[100] glass grid place-items-center p-4"
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            initial={{ scale: 0.95, y: 12 }}
            animate={{ scale: 1, y: 0 }}
            exit={{ scale: 0.97, opacity: 0 }}
            className="w-full max-w-2xl bg-surface border border-edge-strong rounded-modal overflow-hidden shadow-2xl"
          >
            <div className="relative h-52">
              <Artwork
                title={item.title}
                seed={item.id}
                variant="backdrop"
                rounded={false}
                className="h-full w-full"
              />
              <div className="absolute inset-0 bg-gradient-to-t from-surface to-transparent" />
              <div className="absolute bottom-4 left-5 right-5">
                <h2 className="text-xl font-bold text-white">{item.title}</h2>
                {item.series && (
                  <div className="text-xs text-white/70 mt-0.5">
                    {item.series} · Season {item.season}, Episode {item.episode}
                  </div>
                )}
              </div>
            </div>

            <div className="p-5 space-y-4">
              <div className="flex items-center gap-2 flex-wrap text-xs text-dim">
                {item.year && <span>{item.year}</span>}
                <span>·</span>
                <span>{runtime(item.durationSec)}</span>
                <span>·</span>
                <span>{formatBytes(item.sizeBytes)}</span>
                {item.quality && <Badge tone="cyan">{item.quality}</Badge>}
                {item.genres.map((g) => (
                  <Badge key={g} tone="neutral">
                    {g}
                  </Badge>
                ))}
              </div>

              {item.synopsis && (
                <p className="text-sm text-dim leading-relaxed">{item.synopsis}</p>
              )}

              <div className="flex items-center gap-2.5 p-2.5 rounded-card bg-raised border border-edge">
                {item.peerId ? (
                  <Avatar
                    name={peers[item.peerId]?.name ?? 'Peer'}
                    color={peers[item.peerId]?.color}
                    emoji={peers[item.peerId]?.emoji}
                    src={peers[item.peerId]?.avatar}
                    size={26}
                  />
                ) : (
                  <span className="h-[26px] w-[26px] rounded-full bg-gold/15 border border-gold/40 grid place-items-center text-gold">
                    <Film size={12} />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <div className="text-xs">Streaming from {owner}</div>
                  <div className="text-[10px] font-mono text-muted truncate">
                    {item.streamUrl}
                  </div>
                </div>
              </div>

              {/* Ours to rate; a peer's is set on the device holding it. */}
              {!item.peerId && item.streamPath && (
                <RatingControl
                  paths={[item.streamPath]}
                  minAge={item.minAge}
                  byHost={item.ratedByHost}
                  onChanged={onRated}
                />
              )}

              {!item.peerId && <ApproveControl item={item} onChanged={onRated} />}

              <GroupingEditor
                item={item}
                collections={collections}
                overrides={overrides}
                onOverrides={onOverrides}
              />

              <div className="flex gap-2 flex-wrap">
                {/* Listed, not served. Saying so here beats a Play button
                    that opens a player which cannot be filled. */}
                {item.locked ? (
                  <div className="h-9 px-4 rounded-input bg-raised border border-edge flex items-center gap-2 text-sm text-muted">
                    <Lock size={14} className="text-gold shrink-0" />
                    <span>
                      Rated {ratingLabel(item.minAge) || 'above this device'} — {owner} decides
                    </span>
                  </div>
                ) : (
                  <button
                    onClick={() => onPlay(item)}
                    className="h-9 px-5 rounded-input bg-white text-black font-semibold text-sm flex items-center gap-2 hover:bg-white/85"
                  >
                    <Play size={15} fill="currentColor" />
                    {item.progressSec > 30 ? 'Resume' : 'Play'}
                  </button>
                )}
                {/* Only offered when there is somebody to watch with; a button
                    that starts a party of one is a button that does nothing. */}
                {onWatchTogether && peerCount > 0 && (
                  <Button icon={<Users size={13} />} onClick={() => onWatchTogether(item)}>
                    Watch together
                  </Button>
                )}
                <SyncControl
                  item={item}
                  synced={syncedIds.has(item.id)}
                  transferId={syncTransfers[item.id]}
                  onSync={onSync}
                  onRemove={onRemoveSync}
                />
                <Button onClick={onClose}>Close</Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/**
 * Sync to this device, for offline viewing — or the state that button is in.
 *
 * A peer's own title only: this device's own files are already here, and
 * "sync" would just be a second copy of a file already local.
 */
function SyncControl({
  item,
  synced,
  transferId,
  onSync,
  onRemove,
  compact,
}: {
  item: MediaItem;
  synced: boolean;
  transferId: string | undefined;
  onSync: (i: MediaItem) => void;
  onRemove: (i: MediaItem) => void;
  compact?: boolean;
}) {
  const transfer = useStore((s) => (transferId ? s.transfers[transferId] : undefined));
  const active = !!transfer && !['done', 'failed', 'cancelled'].includes(transfer.state);
  const size = compact ? 'xs' : 'sm';

  if (!item.peerId) return null;

  if (active && transfer) {
    const pct = transfer.size ? Math.round((transfer.sent / transfer.size) * 100) : 0;
    return (
      <Button size={size} variant="ghost" disabled icon={<Download size={compact ? 11 : 13} />}>
        {pct}%
      </Button>
    );
  }

  if (synced) {
    return (
      <Button
        size={size}
        variant="ghost"
        icon={<Check size={compact ? 11 : 13} className="text-cyan" />}
        onClick={() => onRemove(item)}
        title="Synced to this device — click to remove the local copy"
      >
        {compact ? '' : 'Synced'}
      </Button>
    );
  }

  return (
    <Button
      size={size}
      variant="ghost"
      icon={<Download size={compact ? 11 : 13} />}
      onClick={() => onSync(item)}
      title="Sync to this device for offline viewing"
    >
      {compact ? '' : 'Sync'}
    </Button>
  );
}

/**
 * What a title is rated, and the host's chance to say otherwise.
 *
 * Only for our own titles. A peer's rating is set on the device holding the
 * file, which is the only device that can enforce it — offering a control here
 * would be offering a label with nothing behind it.
 *
 * `paths` is a whole selection so a series can be rated in one go. Rating a
 * show one episode at a time is thirty-four decisions to express one, and the
 * thirty-fourth is the one that gets forgotten.
 */
function RatingControl({
  paths,
  minAge,
  byHost,
  count,
  onChanged,
}: {
  paths: string[];
  minAge?: number;
  byHost?: boolean;
  /** How many titles this covers, when it is more than one. */
  count?: number;
  onChanged: () => void;
}) {
  const toast = useStore((s) => s.toast);
  const [saving, setSaving] = React.useState(false);

  if (paths.length === 0) return null;

  const save = async (v: string) => {
    setSaving(true);
    try {
      const age = v === '' ? null : Number(v);
      await api.ratings.setTitles(paths, age);
      toast({
        kind: 'success',
        title:
          age === null
            ? 'Rating cleared'
            : `Rated ${TITLE_AGES.find((o) => o.value === v)?.label ?? v}`,
        body: count && count > 1 ? `${count} titles` : undefined,
      });
      onChanged();
    } catch {
      toast({ kind: 'error', title: 'Could not save that rating' });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="flex items-center gap-2.5 p-2.5 rounded-card bg-raised border border-edge">
      <span className="h-[26px] w-[26px] rounded-full bg-gold/15 border border-gold/40 grid place-items-center text-gold shrink-0">
        <ShieldCheck size={12} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-xs">
          {count && count > 1 ? `Rating for all ${count}` : 'Rating'}
        </div>
        <div className="text-[10px] text-muted">
          {byHost
            ? 'Set by you'
            : minAge !== undefined
              ? 'Guessed from the filename — set it to be sure'
              : 'Nobody has said'}
        </div>
      </div>
      {saving ? (
        <Spinner size={12} />
      ) : (
        <Select
          value={minAge === undefined ? '' : String(minAge)}
          onChange={save}
          options={TITLE_AGES}
          className="w-36 shrink-0"
        />
      )}
    </div>
  );
}

/**
 * Letting one device past the rating on one title.
 *
 * The obvious alternative — raise that device's limit — is a standing change
 * made to answer a question about a single evening, and nobody ever puts it
 * back. Six months later the tablet is allowed everything and the reason was
 * one film. So this records the exception and leaves the limit alone.
 *
 * Only devices the rating would actually stop are offered. Approving somebody
 * who was already allowed is a control that does nothing, and a list of them
 * would bury the one name that matters.
 */
function ApproveControl({
  item,
  onChanged,
}: {
  item: MediaItem;
  onChanged: () => void;
}) {
  const peers = useStore((s) => s.peers);
  const toast = useStore((s) => s.toast);

  const [ratings, setRatings] = React.useState<RatingsStatus | null>(null);
  const [live, setLive] = React.useState<{ deviceId: string; streamPath: string }[]>([]);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    void api.ratings.status().then(setRatings).catch(() => setRatings(null));
    void api.ratings.approvals().then(setLive).catch(() => setLive([]));
  }, []);
  React.useEffect(load, [load]);

  const path = item.streamPath;
  const needs = item.minAge;
  if (!path || needs === undefined) return null;

  const allowanceOf = (deviceId: string) =>
    ratings?.devices.find((d) => d.deviceId === deviceId)?.maxAge ?? ratings?.defaultAge ?? 12;

  const approvedFor = (deviceId: string) =>
    live.some(
      (a) => a.deviceId === deviceId && (a.streamPath === path || a.streamPath === '*'),
    );

  // Everyone this title is currently out of reach for.
  const stopped = Object.values(peers).filter((p) => allowanceOf(p.deviceId) < needs);
  if (stopped.length === 0) return null;

  const grant = async (deviceId: string, name: string, minutes: number | null) => {
    setBusy(true);
    try {
      await api.ratings.approve(deviceId, path, minutes);
      toast({
        kind: 'success',
        title: `${name} can watch this`,
        body: minutes ? `For the next ${minutes} minutes` : 'Just this title',
      });
      load();
      onChanged();
    } catch {
      toast({ kind: 'error', title: 'Could not approve that' });
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async (deviceId: string, name: string) => {
    setBusy(true);
    try {
      await api.ratings.revoke(deviceId, path);
      toast({ kind: 'success', title: `${name} can no longer watch this` });
      load();
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="p-2.5 rounded-card bg-raised border border-edge space-y-2">
      <div className="flex items-center gap-2.5">
        <span className="h-[26px] w-[26px] rounded-full bg-gold/15 border border-gold/40 grid place-items-center text-gold shrink-0">
          <Lock size={12} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs">Rated {ratingLabel(needs)}</div>
          <div className="text-[10px] text-muted">
            Out of reach for {stopped.length} device{stopped.length === 1 ? '' : 's'} — let one
            past without changing what it is allowed
          </div>
        </div>
        {busy && <Spinner size={12} />}
      </div>

      {stopped.map((p) => (
        <div key={p.deviceId} className="flex items-center gap-2 pl-[34px]">
          <span className="text-[11px] truncate flex-1">{p.name}</span>
          {approvedFor(p.deviceId) ? (
            <Button size="xs" onClick={() => void withdraw(p.deviceId, p.name)}>
              Withdraw
            </Button>
          ) : (
            <>
              <Button size="xs" onClick={() => void grant(p.deviceId, p.name, null)}>
                Just this video
              </Button>
              <Button size="xs" onClick={() => void grant(p.deviceId, p.name, 180)}>
                Just for now
              </Button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------- collections */

function CollectionCard({
  collection,
  onOpen,
}: {
  collection: Collection;
  onOpen: () => void;
}) {
  // The first member that has a picture, rather than simply the first.
  //
  // A collection card was passing only a seed, so it drew the generated
  // gradient while every episode inside it showed a real frame — the one card
  // standing for fifteen things was the only one with nothing to look at.
  //
  // Episode one is the natural choice and is often the one with artwork beside
  // it; when it is not, anything in the set is a better cover than a gradient,
  // and a frame from episode two still says what the programme is.
  const cover =
    collection.items.find((i) => i.posterUrl) ??
    collection.items.find((i) => i.streamUrl) ??
    collection.items[0];
  return (
    <motion.div
      whileHover={{ scale: 1.05, y: -4 }}
      transition={{ type: 'spring', stiffness: 300, damping: 24 }}
      onClick={onOpen}
      className="relative rounded-card overflow-hidden border border-white/10 bg-surface cursor-pointer group/card"
    >
      {/* A stacked edge reads as "more than one thing" at a glance. */}
      <span className="absolute -top-1 left-2 right-2 h-2 rounded-t bg-white/10" />
      <TitleCard
        title={collection.title}
        subtitle={describeCollection(collection)}
        seed={cover?.id ?? collection.key}
        posterUrl={cover?.posterUrl}
        streamUrl={cover?.streamUrl}
        className="aspect-video"
      />
      <span className="absolute top-1.5 right-1.5">
        <Badge tone="cyan">
          <Layers size={9} />
          {collection.items.length}
        </Badge>
      </span>
      <div className="absolute inset-0 bg-black/45 opacity-0 group-hover/card:opacity-100 transition-opacity grid place-items-center">
        <span className="text-[11px] text-white font-medium">
          {collection.kind === 'series' ? 'Browse episodes' : 'Browse films'}
        </span>
      </div>
    </motion.div>
  );
}

/** Full view of one series or saga, split by season or instalment. */
function CollectionSheet({
  collection,
  ownerName,
  overrides,
  onOverrides,
  onRated,
  onClose,
  onPlay,
  onInfo,
  syncedIds,
  syncTransfers,
  onSync,
  onRemoveSync,
}: {
  collection: Collection | null;
  ownerName: (i: MediaItem) => string;
  overrides: Overrides;
  onOverrides: (o: Overrides) => void;
  /** Re-reads the library after a rating covering the whole collection. */
  onRated: () => void;
  onClose: () => void;
  onPlay: (i: MediaItem) => void;
  onInfo: (i: MediaItem) => void;
  syncedIds: Set<string>;
  syncTransfers: Record<string, string>;
  onSync: (i: MediaItem) => void;
  onRemoveSync: (i: MediaItem) => void;
}) {
  const [renaming, setRenaming] = React.useState(false);
  const [draft, setDraft] = React.useState('');

  React.useEffect(() => {
    if (collection) {
      setDraft(collection.title);
      setRenaming(false);
    }
  }, [collection?.key]);

  // How many of these were put here by hand rather than by the filename.
  // Nothing to undo when the answer is none, and a button offering to undo
  // nothing is worse than no button.
  const handMade = collection
    ? collection.items.filter(
        (item) => overrides.itemToKey[item.id] || overrides.detached.includes(item.id),
      ).length
    : 0;

  if (!collection) return null;

  // Peers' episodes not already synced or mid-sync — what a "Sync" button
  // for a whole season or the whole collection actually has left to do.
  const syncTargets = (items: MediaItem[]) =>
    items.filter((i) => i.peerId && !syncedIds.has(i.id) && !syncTransfers[i.id]);
  const syncMany = (items: MediaItem[]) => {
    for (const item of syncTargets(items)) onSync(item);
  };

  // Only our own titles can be rated here, and only a rating every one of them
  // already shares can be shown as the collection's — a season where one
  // episode differs has no single answer, and inventing one would overwrite
  // the odd one out the moment the control was touched by accident.
  const ours = collection.items
    .filter((i) => !i.peerId && i.streamPath)
    .map((i) => i.streamPath as string);
  const ages = new Set(collection.items.filter((i) => !i.peerId).map((i) => i.minAge));
  const sharedAge = ages.size === 1 ? [...ages][0] : undefined;

  const saveTitle = () => {
    const next = draft.trim();
    onOverrides({
      ...overrides,
      titles: next
        ? { ...overrides.titles, [collection.key]: next }
        : Object.fromEntries(
            Object.entries(overrides.titles).filter(([k]) => k !== collection.key),
          ),
    });
    setRenaming(false);
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-[100] glass grid place-items-center p-4"
        onMouseDown={(e) => e.target === e.currentTarget && onClose()}
      >
        <motion.div
          initial={{ scale: 0.96, y: 12 }}
          animate={{ scale: 1, y: 0 }}
          className="w-full max-w-3xl max-h-[86vh] bg-surface border border-edge-strong rounded-modal overflow-hidden shadow-2xl flex flex-col"
        >
          <div className="relative h-40 shrink-0">
            <Thumbnail
              title={collection.title}
              seed={collection.items[0]?.id ?? collection.key}
              posterUrl={collection.items[0]?.posterUrl}
              streamUrl={collection.items[0]?.streamUrl}
              className="h-full w-full"
            />
            <div className="absolute inset-0 bg-gradient-to-t from-surface to-transparent" />
            <div className="absolute bottom-4 left-5 right-5 flex items-end gap-3">
              <div className="min-w-0 flex-1">
                {renaming ? (
                  <div className="flex gap-2">
                    <Input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && saveTitle()}
                      className="h-8"
                    />
                    <Button size="sm" variant="primary" onClick={saveTitle}>
                      Save
                    </Button>
                  </div>
                ) : (
                  <>
                    <h2 className="text-xl font-bold text-white truncate">
                      {collection.title}
                    </h2>
                    <div className="text-xs text-white/70 mt-0.5">
                      {describeCollection(collection)}
                    </div>
                  </>
                )}
              </div>
              {!renaming && (
                <Button size="xs" icon={<Pencil size={11} />} onClick={() => setRenaming(true)}>
                  Rename
                </Button>
              )}
            </div>
          </div>

          <div className="flex-1 scroll-y p-5 space-y-5">
            {/* One rating for the whole series. Ours only: a peer's is set on
                the device holding the files, which is the only one that can
                enforce it. */}
            {ours.length > 0 && (
              <RatingControl
                paths={ours}
                minAge={sharedAge}
                byHost={collection.items.every((i) => i.ratedByHost)}
                count={ours.length}
                onChanged={onRated}
              />
            )}

            {collection.seasons.map(({ season, items }) => (
              <section key={season}>
                {collection.kind === 'series' && collection.seasons.length > 1 && (
                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="label !mb-0">Season {season}</h3>
                    {syncTargets(items).length > 0 && (
                      <button
                        onClick={() => syncMany(items)}
                        className="text-2xs text-dim hover:text-gold flex items-center gap-1"
                      >
                        <Download size={10} />
                        Sync season
                      </button>
                    )}
                  </div>
                )}
                <div className="space-y-1.5">
                  {items.map((item) => (
                    <div
                      key={item.id}
                      className="flex items-center gap-3 p-2 rounded-card bg-raised border border-edge hover:border-gold/40 transition-colors"
                    >
                      <button
                        onClick={() => onPlay(item)}
                        className="relative w-28 shrink-0 rounded-input overflow-hidden group/thumb"
                      >
                        <Thumbnail
                          title={item.title}
                          seed={item.id}
                          posterUrl={item.posterUrl}
                          streamUrl={item.streamUrl}
                          className="aspect-video w-full"
                        />
                        <span className="absolute inset-0 grid place-items-center bg-black/40 opacity-0 group-hover/thumb:opacity-100 transition-opacity">
                          <Play size={16} className="text-white" fill="currentColor" />
                        </span>
                        {item.progressSec > 30 && (
                          <span className="absolute bottom-0 inset-x-0 h-[3px] bg-black/50">
                            <span
                              className="block h-full bg-gold"
                              style={{
                                width: `${(item.progressSec / (item.durationSec || 1)) * 100}%`,
                              }}
                            />
                          </span>
                        )}
                      </button>

                      <div className="min-w-0 flex-1">
                        <div className="text-xs font-medium truncate">
                          {/* An episode with no name of its own carried the
                              series name, so every row in a collection read
                              "1. Lanterns", "2. Lanterns" — the one thing
                              every row already had in common. */}
                          {item.episode
                            ? item.title === collection.title
                              ? `Episode ${item.episode}`
                              : `${item.episode}. ${item.title}`
                            : item.title}
                        </div>
                        <div className="text-2xs text-muted mt-0.5">
                          {item.durationSec > 0 ? `${runtime(item.durationSec)} · ` : ''}
                          {ownerName(item)}
                        </div>
                      </div>

                      <SyncControl
                        item={item}
                        synced={syncedIds.has(item.id)}
                        transferId={syncTransfers[item.id]}
                        onSync={onSync}
                        onRemove={onRemoveSync}
                        compact
                      />
                      <Button size="xs" variant="ghost" onClick={() => onInfo(item)}>
                        Info
                      </Button>
                      <Button
                        size="xs"
                        variant="ghost"
                        onClick={() =>
                          onOverrides({
                            ...overrides,
                            detached: [...overrides.detached, item.id],
                            itemToKey: Object.fromEntries(
                              Object.entries(overrides.itemToKey).filter(
                                ([id]) => id !== item.id,
                              ),
                            ),
                          })
                        }
                      >
                        Remove
                      </Button>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>

          <div className="px-5 py-3 border-t border-edge flex items-center gap-2 shrink-0">
            <p className="text-2xs text-muted flex-1">
              Grouped automatically from filenames. Rename it, or remove a title that does
              not belong.
            </p>
            {/* Every episode not already local, all at once — the point of
                grouping episodes into a collection in the first place is not
                having to open each one to ask the same question. */}
            {syncTargets(collection.items).length > 0 && (
              <Button
                size="sm"
                icon={<Download size={13} />}
                onClick={() => syncMany(collection.items)}
              >
                Sync all ({syncTargets(collection.items).length})
              </Button>
            )}
            {/*
              Undoing the whole collection, not one title at a time.

              Every item already has this in its own panel, which is fine for
              correcting one mistake and useless for the case it is actually
              needed: a hand-made grouping that has been overtaken by the
              automatic one, leaving two collections with the same name and no
              way to merge them except opening a dozen titles in turn.
            */}
            {handMade > 0 && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const mine = new Set(collection.items.map((i) => i.id));
                  onOverrides({
                    ...overrides,
                    itemToKey: Object.fromEntries(
                      Object.entries(overrides.itemToKey).filter(([id]) => !mine.has(id)),
                    ),
                    detached: overrides.detached.filter((id) => !mine.has(id)),
                    // The chosen name goes with the filing it belonged to. A
                    // title left behind would rename whatever the automatic
                    // grouping puts under that key next.
                    titles: Object.fromEntries(
                      Object.entries(overrides.titles).filter(([key]) => key !== collection.key),
                    ),
                  });
                  onClose();
                }}
              >
                Reset {handMade} to automatic
              </Button>
            )}
            <Button onClick={onClose}>Close</Button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}

/** Lets the user file a title into a collection, or pull it out of one. */
function GroupingEditor({
  item,
  collections,
  overrides,
  onOverrides,
}: {
  item: MediaItem;
  collections: Collection[];
  overrides: Overrides;
  onOverrides: (o: Overrides) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [newName, setNewName] = React.useState('');

  const current = collections.find((c) => c.items.some((i) => i.id === item.id));
  const detached = overrides.detached.includes(item.id);

  const fileInto = (key: string) => {
    onOverrides({
      ...overrides,
      itemToKey: { ...overrides.itemToKey, [item.id]: key },
      detached: overrides.detached.filter((id) => id !== item.id),
    });
    setOpen(false);
  };

  const createAndFile = () => {
    const name = newName.trim();
    if (!name) return;
    const key = sagaKey(name);
    onOverrides({
      ...overrides,
      itemToKey: { ...overrides.itemToKey, [item.id]: key },
      titles: { ...overrides.titles, [key]: name },
      detached: overrides.detached.filter((id) => id !== item.id),
    });
    setNewName('');
    setOpen(false);
  };

  const reset = () => {
    onOverrides({
      ...overrides,
      itemToKey: Object.fromEntries(
        Object.entries(overrides.itemToKey).filter(([id]) => id !== item.id),
      ),
      detached: overrides.detached.filter((id) => id !== item.id),
    });
    setOpen(false);
  };

  return (
    <div className="rounded-card border border-edge bg-raised/50 p-2.5">
      <div className="flex items-center gap-2">
        <Layers size={12} className="text-muted shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="text-2xs text-muted">Part of</div>
          <div className="text-xs truncate">
            {current ? current.title : detached ? 'Nothing — kept separate' : 'Nothing yet'}
          </div>
        </div>
        <Button size="xs" onClick={() => setOpen((o) => !o)}>
          {open ? 'Done' : 'Change'}
        </Button>
      </div>

      {open && (
        <div className="mt-2.5 pt-2.5 border-t border-edge space-y-2">
          {collections.length > 0 && (
            <div className="space-y-1">
              <div className="label">Move into</div>
              <div className="flex flex-wrap gap-1.5">
                {collections.map((c) => (
                  <button
                    key={c.key}
                    onClick={() => fileInto(c.key)}
                    className={cn(
                      'px-2 h-7 rounded-input border text-2xs transition-colors',
                      c.key === current?.key
                        ? 'border-gold/50 bg-gold/10 text-gold'
                        : 'border-edge bg-base hover:border-edge-strong',
                    )}
                  >
                    {c.title}
                  </button>
                ))}
              </div>
            </div>
          )}

          <div className="space-y-1">
            <div className="label">Or start a new one</div>
            <div className="flex gap-1.5">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createAndFile()}
                placeholder="Collection name"
              />
              <Button size="sm" variant="primary" disabled={!newName.trim()} onClick={createAndFile}>
                Create
              </Button>
            </div>
          </div>

          {(current || detached) && (
            <Button size="xs" variant="ghost" full onClick={reset}>
              Reset to automatic grouping
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

export function runtime(sec: number): string {
  // Durations are read from the file by the player, so a freshly scanned
  // library legitimately has none yet.
  if (!Number.isFinite(sec) || sec <= 0) return 'Unknown length';
  // Rounded once, into minutes, and only then split. Rounding the remainder
  // separately is how a two hour film came out as "1h 60m": anything from
  // 1:59:30 rounds its leftover seconds up to a full sixty minutes, which is
  // an hour the hours column never hears about.
  const minutes = Math.round(sec / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
