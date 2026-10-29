import React from 'react';
import { Check, Layers, Play } from 'lucide-react';

import { Thumbnail } from '../lib/poster';
import { emptyOverrides, groupLibrary, type Collection } from '../lib/collections';
import { oneEpisodePerSeries, runtime } from '../screens/Theatre';
import { useBackDismiss } from '../lib/hooks';
import type { MediaItem } from '../lib/types';
import { cn } from '../lib/utils';
import { intentOf } from './remote';
import { u } from './units';

/**
 * The television's shelf.
 *
 * One page, no menus. Whatever has the focus is described in the panel above
 * the rows, so there is no "more info" to press and no detail screen to come
 * back from: OK plays it (or, for a series, opens the episodes), and the
 * remote's four arrows are the only other thing there is to learn.
 *
 * Focus is the pair (row, column) held here, not whatever the browser thinks
 * is focused; moving it scrolls the tile into view and nothing else.
 */

type Tile =
  | { kind: 'item'; key: string; item: MediaItem }
  | { kind: 'show'; key: string; collection: Collection };

interface Shelf {
  label: string;
  tiles: Tile[];
}

const item = (i: MediaItem): Tile => ({ kind: 'item', key: i.id, item: i });
const show = (c: Collection): Tile => ({ kind: 'show', key: c.key, collection: c });

const finishedWatching = (i: MediaItem) =>
  i.durationSec > 0 && i.progressSec > 0 && i.durationSec - i.progressSec < Math.max(40, i.durationSec * 0.03);

/** Which episode of a series to offer first: the one being watched, else the first. */
function whereToStart(c: Collection): MediaItem {
  const watching = c.items
    .filter((i) => i.progressSec > 30 && !finishedWatching(i))
    .sort((a, b) => (b.watchedAt ?? 0) - (a.watchedAt ?? 0))[0];
  if (watching) return watching;
  // Otherwise the first one not yet seen to the end.
  return c.items.find((i) => !finishedWatching(i)) ?? c.items[0];
}

export function TvLibrary({
  items,
  loading,
  active,
  onPlay,
}: {
  items: MediaItem[];
  loading: boolean;
  /** False while a film is playing over this: the keys are the player's then. */
  active: boolean;
  onPlay: (i: MediaItem) => void;
}) {
  const grouping = React.useMemo(() => groupLibrary(items, emptyOverrides()), [items]);

  const shelves = React.useMemo<Shelf[]>(() => {
    const out: Shelf[] = [];
    const continued = oneEpisodePerSeries(
      items.filter((i) => i.progressSec > 30 && !finishedWatching(i)),
    ).sort((a, b) => (b.watchedAt ?? 0) - (a.watchedAt ?? 0));
    if (continued.length) out.push({ label: 'Continue watching', tiles: continued.map(item) });

    if (grouping.collections.length) {
      out.push({ label: 'Shows & collections', tiles: grouping.collections.map(show) });
    }

    const recent = [...grouping.singles].sort((a, b) => b.addedAt - a.addedAt).slice(0, 24);
    if (recent.length) out.push({ label: 'Recently added', tiles: recent.map(item) });

    const films = grouping.singles
      .filter((i) => i.kind === 'film')
      .sort((a, b) => a.title.localeCompare(b.title));
    if (films.length > recent.length || films.length > 8) out.push({ label: 'All films', tiles: films.map(item) });

    const clips = grouping.singles.filter((i) => i.kind === 'clip');
    if (clips.length) out.push({ label: 'Clips', tiles: clips.map(item) });
    return out;
  }, [items, grouping]);

  const [focus, setFocus] = React.useState({ r: 0, c: 0 });
  const remembered = React.useRef<number[]>([]);
  const [picker, setPicker] = React.useState<Picker | null>(null);

  // Keep the focus on something that exists when the shelves change under it.
  React.useEffect(() => {
    setFocus((f) => {
      const r = Math.min(f.r, Math.max(0, shelves.length - 1));
      const c = Math.min(f.c, Math.max(0, (shelves[r]?.tiles.length ?? 1) - 1));
      return r === f.r && c === f.c ? f : { r, c };
    });
  }, [shelves]);

  // The system's Back closes the episode list rather than leaving the app.
  useBackDismiss(!!picker, () => setPicker(null));

  const current = shelves[focus.r]?.tiles[focus.c] ?? null;
  const root = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!active) return;
    root.current
      ?.querySelector<HTMLElement>(`[data-tile="${focus.r}-${focus.c}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [focus, active, shelves.length]);

  const activate = (tile: Tile | null) => {
    if (!tile) return;
    if (tile.kind === 'item') onPlay(tile.item);
    else openShow(tile.collection);
  };

  const openShow = (c: Collection) => {
    const start = whereToStart(c);
    const seasons = c.seasons.map((s) => s.season);
    const season = start?.season ?? seasons[0] ?? 1;
    const list = c.seasons.find((s) => s.season === season)?.items ?? c.items;
    setPicker({
      collection: c,
      season,
      zone: 'list',
      at: Math.max(0, list.findIndex((i) => i.id === start?.id)),
    });
  };

  const state = React.useRef({ focus, shelves, picker, active });
  state.current = { focus, shelves, picker, active };
  const act = React.useRef(activate);
  act.current = activate;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { focus: f, shelves: rows, picker: p, active: on } = state.current;
      if (!on) return;
      const intent = intentOf(e);
      if (!intent) return;
      e.preventDefault();
      e.stopPropagation();

      if (p) {
        setPicker(stepPicker(p, intent, onPlay));
        return;
      }
      if (!rows.length) return;

      if (intent === 'left') setFocus({ r: f.r, c: Math.max(0, f.c - 1) });
      else if (intent === 'right') setFocus({ r: f.r, c: Math.min(rows[f.r].tiles.length - 1, f.c + 1) });
      else if (intent === 'up' || intent === 'down') {
        const r = Math.max(0, Math.min(rows.length - 1, f.r + (intent === 'down' ? 1 : -1)));
        if (r === f.r) return;
        remembered.current[f.r] = f.c;
        setFocus({ r, c: Math.min(remembered.current[r] ?? f.c, rows[r].tiles.length - 1) });
      } else if (intent === 'ok') act.current(rows[f.r].tiles[f.c]);
      // Back is left to the system: on the shelf it leaves the app.
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onPlay]);

  // The picker's own scroll, so the focused episode is always on screen.
  React.useEffect(() => {
    if (!picker) return;
    root.current
      ?.querySelector<HTMLElement>('[data-episode="true"]')
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [picker]);

  if (!items.length) {
    return (
      <div className="h-full grid place-items-center text-center" style={{ padding: u(6) }}>
        <div>
          <div className="font-semibold" style={{ fontSize: u(3.4) }}>
            {loading ? 'Looking for films on your network…' : 'Nothing to watch yet'}
          </div>
          {!loading && (
            <p className="text-white/60" style={{ fontSize: u(2), marginTop: u(1.2), maxWidth: u(70) }}>
              Publish a media folder from LANTern on a computer or phone on this network and it appears here.
            </p>
          )}
        </div>
      </div>
    );
  }

  return (
    <div ref={root} className="h-full flex flex-col">
      <Spotlight tile={current} />

      <div className="flex-1 min-h-0 overflow-hidden" style={{ paddingBottom: u(3) }}>
        {shelves.map((shelf, r) => (
          <section key={shelf.label} style={{ marginTop: r === 0 ? 0 : u(1.8) }}>
            <h2
              className="font-semibold text-white/85"
              style={{ fontSize: u(1.9), padding: `0 ${u(5)}`, marginBottom: u(0.9) }}
            >
              {shelf.label}
            </h2>
            <div className="flex overflow-hidden" style={{ padding: `${u(0.9)} ${u(5)}`, gap: u(1.4) }}>
              {shelf.tiles.map((tile, c) => (
                <TileView key={tile.key} tile={tile} focused={active && r === focus.r && c === focus.c} at={`${r}-${c}`} />
              ))}
            </div>
          </section>
        ))}
      </div>

      {picker && <EpisodePicker picker={picker} />}
    </div>
  );
}

/* ------------------------------------------------------------- the tiles */

const TILE_W = `calc((100vw - ${u(10)}) / 7.3 - ${u(1.4)})`;

function TileView({ tile, focused, at }: { tile: Tile; focused: boolean; at: string }) {
  const cover =
    tile.kind === 'item'
      ? tile.item
      : (tile.collection.items.find((i) => i.posterUrl) ?? tile.collection.items[0]);
  const title = tile.kind === 'item' ? tile.item.title : tile.collection.title;
  const sub =
    tile.kind === 'item'
      ? tile.item.kind === 'episode'
        ? `S${tile.item.season ?? 1} E${tile.item.episode ?? 1}`
        : runtime(tile.item.durationSec)
      : `${tile.collection.items.length} ${tile.collection.kind === 'series' ? 'episodes' : 'films'}`;
  const progress =
    tile.kind === 'item' && tile.item.durationSec > 0 ? (tile.item.progressSec / tile.item.durationSec) * 100 : 0;
  const done = tile.kind === 'item' && finishedWatching(tile.item);

  return (
    <div
      data-tile={at}
      className="relative shrink-0 rounded-xl overflow-hidden bg-white/5 transition-transform duration-150"
      style={{
        width: TILE_W,
        aspectRatio: '16 / 9',
        transform: focused ? 'scale(1.07)' : 'scale(1)',
        zIndex: focused ? 2 : 1,
        outline: focused ? `${u(0.32)} solid #fff` : `${u(0.12)} solid rgba(255,255,255,0.08)`,
        outlineOffset: focused ? u(0.2) : 0,
        boxShadow: focused ? '0 1.2rem 2.4rem rgba(0,0,0,0.55)' : undefined,
      }}
    >
      {cover && (
        <Thumbnail
          title={title}
          seed={cover.id}
          posterUrl={cover.posterUrl}
          streamUrl={cover.streamUrl}
          className="absolute inset-0 h-full w-full"
        />
      )}
      <div
        className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/45 to-transparent"
        style={{ padding: `${u(2.4)} ${u(1)} ${u(0.8)}` }}
      >
        <div className="font-semibold leading-tight truncate" style={{ fontSize: u(1.55) }}>
          {title}
        </div>
        <div className="text-white/65 truncate" style={{ fontSize: u(1.2) }}>
          {sub}
        </div>
      </div>
      {tile.kind === 'show' && (
        <span
          className="absolute right-0 top-0 m-1.5 grid place-items-center rounded-md bg-black/65"
          style={{ width: u(2.4), height: u(2.4) }}
        >
          <Layers style={{ width: u(1.4), height: u(1.4) }} />
        </span>
      )}
      {done && (
        <span
          className="absolute right-0 top-0 m-1.5 grid place-items-center rounded-full bg-gold text-on-gold"
          style={{ width: u(2.2), height: u(2.2) }}
        >
          <Check style={{ width: u(1.4), height: u(1.4) }} strokeWidth={3} />
        </span>
      )}
      {progress > 1 && !done && (
        <div className="absolute inset-x-0 bottom-0 bg-black/50" style={{ height: u(0.35) }}>
          <div className="h-full bg-gold" style={{ width: `${progress}%` }} />
        </div>
      )}
    </div>
  );
}

/** Describes whatever has the focus, in place of a details screen. */
function Spotlight({ tile }: { tile: Tile | null }) {
  const cover =
    tile?.kind === 'item'
      ? tile.item
      : tile
        ? (tile.collection.items.find((i) => i.posterUrl) ?? tile.collection.items[0])
        : null;
  const it = tile?.kind === 'item' ? tile.item : null;
  const col = tile?.kind === 'show' ? tile.collection : null;
  const title = it?.title ?? col?.title ?? '';

  const bits: string[] = [];
  if (it) {
    if (it.series) bits.push(`${it.series} · S${it.season ?? 1} E${it.episode ?? 1}`);
    if (it.year) bits.push(String(it.year));
    if (it.durationSec > 0) bits.push(runtime(it.durationSec));
    if (it.quality) bits.push(it.quality);
    if (it.genres.length) bits.push(it.genres.slice(0, 3).join(' · '));
  } else if (col) {
    const seasons = col.seasons.length;
    bits.push(col.kind === 'series' ? (seasons > 1 ? `${seasons} seasons` : 'Series') : 'Collection');
    bits.push(`${col.items.length} ${col.kind === 'series' ? 'episodes' : 'films'}`);
  }
  const resume = it && it.progressSec > 30 && !finishedWatching(it);

  return (
    <div className="relative shrink-0 overflow-hidden" style={{ height: '36vh' }}>
      {cover && (
        <Thumbnail
          title={title}
          seed={cover.id}
          posterUrl={cover.posterUrl}
          streamUrl={cover.streamUrl}
          className="absolute inset-0 h-full w-full opacity-70"
        />
      )}
      <div className="absolute inset-0 bg-gradient-to-r from-black via-black/70 to-transparent" />
      <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black to-transparent" style={{ height: '45%' }} />
      <div className="absolute inset-0 flex flex-col justify-end" style={{ padding: `${u(3)} ${u(5)} ${u(1.4)}` }}>
        <div className="font-bold leading-[1.05] drop-shadow-lg line-clamp-2" style={{ fontSize: u(4.4), maxWidth: '62%' }}>
          {title}
        </div>
        <div className="text-white/75" style={{ fontSize: u(1.8), marginTop: u(0.9) }}>
          {bits.join('   ·   ')}
        </div>
        {it?.synopsis && (
          <p className="text-white/60 line-clamp-2" style={{ fontSize: u(1.7), marginTop: u(0.7), maxWidth: '52%' }}>
            {it.synopsis}
          </p>
        )}
        <div className="flex items-center text-white/80" style={{ gap: u(1), fontSize: u(1.6), marginTop: u(1.1) }}>
          <span
            className="inline-flex items-center rounded-full bg-white text-black font-semibold"
            style={{ height: u(3.6), paddingInline: u(2), gap: u(0.8) }}
          >
            <Play style={{ width: u(1.7), height: u(1.7) }} fill="currentColor" />
            {col ? 'Open' : resume ? 'Resume' : 'Play'}
          </span>
          {resume && it && (
            <span className="text-white/60">{runtime(Math.max(0, it.durationSec - it.progressSec))} left</span>
          )}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------- the episodes */

interface Picker {
  collection: Collection;
  season: number;
  zone: 'tabs' | 'list';
  at: number;
}

function stepPicker(p: Picker, intent: ReturnType<typeof intentOf>, play: (i: MediaItem) => void): Picker | null {
  const seasons = p.collection.seasons;
  const multi = p.collection.kind === 'series' && seasons.length > 1;
  const list = seasons.find((s) => s.season === p.season)?.items ?? p.collection.items;

  if (intent === 'back') return null;

  if (p.zone === 'tabs') {
    const i = seasons.findIndex((s) => s.season === p.season);
    if (intent === 'left') return { ...p, season: seasons[Math.max(0, i - 1)].season, at: 0 };
    if (intent === 'right') return { ...p, season: seasons[Math.min(seasons.length - 1, i + 1)].season, at: 0 };
    if (intent === 'down' || intent === 'ok') return { ...p, zone: 'list' };
    return p;
  }

  if (intent === 'up') return p.at === 0 && multi ? { ...p, zone: 'tabs' } : { ...p, at: Math.max(0, p.at - 1) };
  if (intent === 'down') return { ...p, at: Math.min(list.length - 1, p.at + 1) };
  if (intent === 'left' && multi) return { ...p, zone: 'tabs' };
  if (intent === 'ok') {
    const chosen = list[p.at];
    if (chosen) play(chosen);
    return null;
  }
  return p;
}

function EpisodePicker({ picker }: { picker: Picker }) {
  const { collection, season, zone, at } = picker;
  const multi = collection.kind === 'series' && collection.seasons.length > 1;
  const list = collection.seasons.find((s) => s.season === season)?.items ?? collection.items;
  const cover = collection.items.find((i) => i.posterUrl) ?? collection.items[0];

  return (
    <div className="absolute inset-0 z-30 flex bg-black" style={{ padding: `${u(4)} ${u(5)}`, gap: u(5) }}>
      <div className="shrink-0" style={{ width: u(34) }}>
        <div className="relative rounded-2xl overflow-hidden bg-white/5" style={{ aspectRatio: '16 / 9' }}>
          {cover && (
            <Thumbnail
              title={collection.title}
              seed={cover.id}
              posterUrl={cover.posterUrl}
              streamUrl={cover.streamUrl}
              className="absolute inset-0 h-full w-full"
            />
          )}
        </div>
        <div className="font-bold leading-tight" style={{ fontSize: u(3.6), marginTop: u(1.6) }}>
          {collection.title}
        </div>
        <div className="text-white/60" style={{ fontSize: u(1.8), marginTop: u(0.6) }}>
          {collection.items.length} {collection.kind === 'series' ? 'episodes' : 'films'}
        </div>
        <div className="text-white/40" style={{ fontSize: u(1.4), marginTop: u(3) }}>
          OK plays · Back returns
        </div>
      </div>

      <div className="flex-1 min-w-0 flex flex-col">
        {multi && (
          <div className="flex shrink-0" style={{ gap: u(1.2), marginBottom: u(2) }}>
            {collection.seasons.map((s) => {
              const focused = zone === 'tabs' && s.season === season;
              const here = s.season === season;
              return (
                <span
                  key={s.season}
                  className={cn(
                    'rounded-full font-semibold transition-all',
                    focused
                      ? 'bg-gold text-on-gold scale-105'
                      : here
                        ? 'bg-white/20 text-white'
                        : 'bg-white/8 text-white/60',
                  )}
                  style={{ height: u(4.6), paddingInline: u(2.4), display: 'inline-flex', alignItems: 'center', fontSize: u(1.9) }}
                >
                  Season {s.season}
                </span>
              );
            })}
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-hidden" style={{ display: 'flex', flexDirection: 'column', gap: u(0.9) }}>
          {list.map((ep, i) => {
            const focused = zone === 'list' && i === at;
            const pct = ep.durationSec > 0 ? (ep.progressSec / ep.durationSec) * 100 : 0;
            return (
              <div
                key={ep.id}
                data-episode={focused ? 'true' : undefined}
                className={cn(
                  'flex items-center rounded-xl shrink-0 transition-all',
                  focused ? 'bg-white text-black scale-[1.015]' : 'bg-white/8 text-white/90',
                )}
                style={{ padding: u(1), gap: u(1.6) }}
              >
                <div className="relative shrink-0 rounded-lg overflow-hidden bg-black/30" style={{ width: u(14), aspectRatio: '16 / 9' }}>
                  <Thumbnail
                    title={ep.title}
                    seed={ep.id}
                    posterUrl={ep.posterUrl}
                    streamUrl={ep.streamUrl}
                    className="absolute inset-0 h-full w-full"
                  />
                  {pct > 1 && !finishedWatching(ep) && (
                    <div className="absolute inset-x-0 bottom-0 bg-black/50" style={{ height: u(0.35) }}>
                      <div className="h-full bg-gold" style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-semibold truncate" style={{ fontSize: u(2.1) }}>
                    {ep.episode ? `${ep.episode}. ` : ''}
                    {ep.title === collection.title ? `Episode ${ep.episode ?? i + 1}` : ep.title}
                  </div>
                  <div className={focused ? 'text-black/60' : 'text-white/55'} style={{ fontSize: u(1.5) }}>
                    {ep.durationSec > 0 ? runtime(ep.durationSec) : ''}
                    {ep.progressSec > 30 && !finishedWatching(ep) ? ` · ${runtime(ep.durationSec - ep.progressSec)} left` : ''}
                  </div>
                </div>
                {finishedWatching(ep) && (
                  <Check style={{ width: u(2.6), height: u(2.6) }} className={focused ? 'text-black/60' : 'text-gold'} strokeWidth={3} />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
