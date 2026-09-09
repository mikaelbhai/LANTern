import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ChevronLeft,
  ChevronRight,
  Film,
  Info,
  Play,
  Plus,
  RefreshCw,
  Layers,
  Pencil,
  Search,
  Tv,
  Upload,
  Users,
} from 'lucide-react';
import { Avatar } from '../components/Avatar';
import { Badge, Button, Empty, IconButton, Input } from '../components/ui';
import { Artwork, TitleCard } from '../lib/poster';
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
import type { MediaItem, WatchParty } from '../lib/types';

export function Theatre() {
  const peers = useStore((s) => s.peers);
  const profile = useStore((s) => s.profile);

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
  const [collection, setCollection] = React.useState<Collection | null>(null);
  const [overrides, setOverrides] = useLocalStorage<Overrides>(
    'lantern.theatre.grouping',
    emptyOverrides(),
  );

  const load = React.useCallback(async () => {
    setItems(await api.media.list());
    setLoading(false);
  }, []);

  React.useEffect(() => {
    void load();
    return on('media:changed', (list: MediaItem[]) => setItems(list));
  }, [load]);

  const ownerName = React.useCallback(
    (item: MediaItem) =>
      item.peerId ? (peers[item.peerId]?.name ?? 'Peer') : (profile.name || 'This device'),
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
    () => buildRows(items, grouping, ownerName),
    [items, grouping, ownerName],
  );

  // Keep an open collection in step with regrouping.
  React.useEffect(() => {
    if (!collection) return;
    const fresh = grouping.collections.find((c) => c.key === collection.key);
    setCollection(fresh ?? null);
  }, [grouping]);
  const hero = React.useMemo(() => pickHero(items), [items]);

  const play = (item: MediaItem) => {
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
    <div className="h-full flex flex-col bg-[#08090C]">
      <header className="h-11 shrink-0 border-b border-edge bg-surface flex items-center px-4 gap-3">
        <Film size={15} className="text-gold" />
        <span className="text-sm font-semibold">Theatre</span>
        <span className="text-2xs text-muted hidden md:block">
          Everything published on the network, streamed straight from the device holding it
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search titles…"
            icon={<Search size={12} />}
            className="w-44"
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
            <RefreshCw size={14} />
          </IconButton>
          <Button
            size="xs"
            variant="primary"
            icon={<Plus size={12} />}
            onClick={() => setPublishOpen(true)}
          >
            Add videos
          </Button>
        </div>
      </header>

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

      <div className="flex-1 scroll-y">
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
            hint="Publish a folder of videos and it appears here — and in the Theatre of everyone else on the network."
            action={
              <Button variant="primary" icon={<Upload size={13} />} onClick={() => setPublishOpen(true)}>
                Add videos
              </Button>
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
                />
              ))}
            </div>
          </>
        )}
      </div>

      <DetailSheet
        onWatchTogether={(i) => void watchTogether(i)}
        peerCount={onlinePeerCount}
        item={detail}
        owner={detail ? ownerName(detail) : ''}
        collections={grouping.collections}
        overrides={overrides}
        onOverrides={setOverrides}
        onClose={() => setDetail(null)}
        onPlay={play}
      />

      <CollectionSheet
        collection={collection}
        ownerName={ownerName}
        overrides={overrides}
        onOverrides={setOverrides}
        onClose={() => setCollection(null)}
        onPlay={play}
        onInfo={(i) => {
          setCollection(null);
          setDetail(i);
        }}
      />

      <PublishMediaModal
        open={publishOpen}
        onClose={() => {
          setPublishOpen(false);
          void load();
        }}
      />
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
function buildRows(
  items: MediaItem[],
  grouping: { collections: Collection[]; singles: MediaItem[] },
  ownerName: (i: MediaItem) => string,
): { label: string; entries: RowEntry[] }[] {
  if (!items.length) return [];
  const rows: { label: string; entries: RowEntry[] }[] = [];

  const asItem = (item: MediaItem): RowEntry => ({ type: 'item', item });
  const asCollection = (collection: Collection): RowEntry => ({
    type: 'collection',
    collection,
  });

  const continued = items
    .filter((i) => i.progressSec > 30 && i.progressSec < i.durationSec * 0.95)
    .sort((a, b) => b.progressSec / b.durationSec - a.progressSec / a.durationSec);
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
  if (films.length) rows.push({ label: 'Films', entries: films.map(asItem) });

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
}: {
  label: string;
  entries: RowEntry[];
  ownerName: (i: MediaItem) => string;
  onPlay: (i: MediaItem) => void;
  onInfo: (i: MediaItem) => void;
  onOpenCollection: (c: Collection) => void;
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
      <h2 className="text-sm font-semibold px-6 mb-2 text-white/90">{label}</h2>
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
  onClose,
  onPlay,
  onWatchTogether,
  peerCount,
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
  onClose: () => void;
  onPlay: (i: MediaItem) => void;
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

              <GroupingEditor
                item={item}
                collections={collections}
                overrides={overrides}
                onOverrides={onOverrides}
              />

              <div className="flex gap-2 flex-wrap">
                <button
                  onClick={() => onPlay(item)}
                  className="h-9 px-5 rounded-input bg-white text-black font-semibold text-sm flex items-center gap-2 hover:bg-white/85"
                >
                  <Play size={15} fill="currentColor" />
                  {item.progressSec > 30 ? 'Resume' : 'Play'}
                </button>
                {/* Only offered when there is somebody to watch with; a button
                    that starts a party of one is a button that does nothing. */}
                {onWatchTogether && peerCount > 0 && (
                  <Button icon={<Users size={13} />} onClick={() => onWatchTogether(item)}>
                    Watch together
                  </Button>
                )}
                <Button onClick={onClose}>Close</Button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
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
  const cover = collection.items[0];
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
  onClose,
  onPlay,
  onInfo,
}: {
  collection: Collection | null;
  ownerName: (i: MediaItem) => string;
  overrides: Overrides;
  onOverrides: (o: Overrides) => void;
  onClose: () => void;
  onPlay: (i: MediaItem) => void;
  onInfo: (i: MediaItem) => void;
}) {
  const [renaming, setRenaming] = React.useState(false);
  const [draft, setDraft] = React.useState('');

  React.useEffect(() => {
    if (collection) {
      setDraft(collection.title);
      setRenaming(false);
    }
  }, [collection?.key]);

  if (!collection) return null;

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
            <Artwork
              title={collection.title}
              seed={collection.items[0]?.id ?? collection.key}
              variant="backdrop"
              rounded={false}
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
            {collection.seasons.map(({ season, items }) => (
              <section key={season}>
                {collection.kind === 'series' && collection.seasons.length > 1 && (
                  <h3 className="label mb-2">Season {season}</h3>
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
                        <Artwork
                          title={item.title}
                          seed={item.id}
                          variant="backdrop"
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
                          {item.episode
                            ? `${item.episode}. ${item.title}`
                            : item.title}
                        </div>
                        <div className="text-2xs text-muted mt-0.5">
                          {item.durationSec > 0 ? `${runtime(item.durationSec)} · ` : ''}
                          {ownerName(item)}
                        </div>
                      </div>

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
  const h = Math.floor(sec / 3600);
  const m = Math.round((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}
