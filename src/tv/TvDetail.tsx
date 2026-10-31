import React from 'react';
import { Check, Play, RotateCcw } from 'lucide-react';

import { Thumbnail } from '../lib/poster';
import type { Collection } from '../lib/collections';
import { runtime } from '../screens/Theatre';
import { isContinuing, isFinished } from '../lib/watched';
import type { MediaItem } from '../lib/types';
import { cn } from '../lib/utils';
import { metaOf, playLabel } from './TvHero';
import { intentOf } from './remote';
import { coverOf, itemTile, playTarget, showTile, titleOf, type Tile } from './tvShelves';
import { u } from './units';

type Zone = 'buttons' | 'seasons' | 'episodes';

const EP_W = `calc((100vw - ${u(10)}) / 4.4 - ${u(1.8)})`;

/**
 * A title's own page.
 *
 * A film gets Play (Resume, Watch again) and, part-way through, a way to start
 * over. A series gets the same for the episode to carry on with, then its
 * seasons and a row of its episodes. It replaces the list that used to open
 * over the shelf: that was only for series, said nothing about what it was
 * looking at, and offered no way to play a film from the beginning.
 */
export function TvDetail({
  tile,
  active,
  onPlay,
}: {
  tile: Tile;
  active: boolean;
  onPlay: (i: MediaItem) => void;
}) {
  const collection: Collection | null = tile.kind === 'show' ? tile.collection : null;
  const series = collection && collection.kind === 'series' ? collection : null;
  const start = playTarget(tile);
  const cover = coverOf(tile);
  const title = titleOf(tile);
  const it = tile.kind === 'item' ? tile.item : null;

  const seasons = collection?.seasons ?? [];
  const multi = seasons.length > 1;
  const [season, setSeason] = React.useState(start.season ?? seasons[0]?.season ?? 1);
  const episodes = React.useMemo(
    () => (collection ? (seasons.find((s) => s.season === season)?.items ?? collection.items) : []),
    [collection, seasons, season],
  );
  const [epAt, setEpAt] = React.useState(() =>
    Math.max(0, episodes.findIndex((e) => e.id === start.id)),
  );

  const [zone, setZone] = React.useState<Zone>('buttons');
  const [button, setButton] = React.useState(0);

  const buttons = React.useMemo(() => {
    const out: { id: string; label: string; run: () => void }[] = [
      { id: 'play', label: playLabel(tile), run: () => onPlay(start) },
    ];
    if (isContinuing(start)) {
      out.push({
        id: 'restart',
        label: 'Start from the beginning',
        // The player also consults a copy of the position kept in the page's own
        // storage and takes the further of the two, unless the shelf's is newer.
        // A watched time in the future is newer than anything, so this is the
        // one way to say "from the top" without a second code path in the player.
        run: () => onPlay({ ...start, progressSec: 0, watchedAt: Date.now() + 365 * 24 * 3600 * 1000 }),
      });
    }
    return out;
  }, [tile, start, onPlay]);

  const root = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    if (!active || zone !== 'episodes') return;
    root.current
      ?.querySelector<HTMLElement>(`[data-ep="${epAt}"]`)
      ?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [epAt, zone, active]);

  const state = React.useRef({ zone, button, buttons, season, seasons, epAt, episodes, multi, active, series });
  state.current = { zone, button, buttons, season, seasons, epAt, episodes, multi, active, series };
  const play = React.useRef(onPlay);
  play.current = onPlay;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = state.current;
      if (!s.active) return;
      const intent = intentOf(e);
      if (!intent || intent === 'back') return;
      e.preventDefault();
      e.stopPropagation();

      if (s.zone === 'buttons') {
        if (intent === 'left') setButton(Math.max(0, s.button - 1));
        else if (intent === 'right') setButton(Math.min(s.buttons.length - 1, s.button + 1));
        else if (intent === 'down' && s.series) setZone(s.multi ? 'seasons' : 'episodes');
        else if (intent === 'ok') s.buttons[s.button]?.run();
        return;
      }
      if (s.zone === 'seasons') {
        const i = s.seasons.findIndex((x) => x.season === s.season);
        if (intent === 'left' && i > 0) {
          setSeason(s.seasons[i - 1].season);
          setEpAt(0);
        } else if (intent === 'right' && i < s.seasons.length - 1) {
          setSeason(s.seasons[i + 1].season);
          setEpAt(0);
        } else if (intent === 'down' || intent === 'ok') setZone('episodes');
        else if (intent === 'up') setZone('buttons');
        return;
      }
      // Episodes.
      if (intent === 'left') setEpAt(Math.max(0, s.epAt - 1));
      else if (intent === 'right') setEpAt(Math.min(s.episodes.length - 1, s.epAt + 1));
      else if (intent === 'up') setZone(s.multi ? 'seasons' : 'buttons');
      else if (intent === 'ok') {
        const chosen = s.episodes[s.epAt];
        if (chosen) play.current(chosen);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const left = isContinuing(start) ? runtime(Math.max(0, start.durationSec - start.progressSec)) : null;

  return (
    <div ref={root} className="absolute inset-0 z-30 bg-black overflow-hidden">
      {cover && (
        <Thumbnail
          title={title}
          seed={cover.id}
          posterUrl={cover.posterUrl}
          streamUrl={cover.streamUrl}
          className="absolute inset-0 h-full w-full"
        />
      )}
      <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, #000 0%, rgba(0,0,0,0.82) 34%, rgba(0,0,0,0.25) 72%, rgba(0,0,0,0.5) 100%)' }} />
      <div className="absolute inset-x-0 bottom-0" style={{ height: series ? '62%' : '40%', background: 'linear-gradient(to top, #000 22%, rgba(0,0,0,0))' }} />

      <div className="tv-fade-in absolute inset-0 flex flex-col" style={{ padding: `${u(5)} ${u(5)} ${u(3)}` }}>
        <div className="flex-1 min-h-0 flex flex-col justify-end">
          <div
            className="font-bold leading-[1.02] line-clamp-2"
            style={{ fontSize: u(6.4), maxWidth: '60%', letterSpacing: '-0.025em', textShadow: '0 0.2rem 1.6rem rgba(0,0,0,0.7)' }}
          >
            {title}
          </div>
          <div className="text-white/75 font-medium" style={{ fontSize: u(1.9), marginTop: u(1.3) }}>
            {metaOf(tile).join('   ·   ')}
          </div>
          {(it?.synopsis || start.synopsis) && (
            <p className="text-white/65 line-clamp-3" style={{ fontSize: u(1.85), marginTop: u(1), maxWidth: '48%', lineHeight: 1.45 }}>
              {it?.synopsis ?? start.synopsis}
            </p>
          )}

          <div className="flex items-center" style={{ gap: u(1.4), marginTop: u(2.4) }}>
            {buttons.map((b, i) => {
              const focused = active && zone === 'buttons' && i === button;
              return (
                <span
                  key={b.id}
                  className={cn(
                    'tv-lift inline-flex items-center rounded-full font-semibold',
                    focused ? 'bg-white text-black' : 'bg-white/25 text-white',
                  )}
                  style={{
                    height: u(5.4),
                    paddingInline: u(3),
                    gap: u(1),
                    fontSize: u(2.1),
                    transform: focused ? 'scale(1.08)' : 'scale(1)',
                    boxShadow: focused ? '0 0.8rem 2rem rgba(0,0,0,0.55)' : undefined,
                  }}
                >
                  {b.id === 'play' ? (
                    <Play style={{ width: u(2.1), height: u(2.1) }} fill="currentColor" />
                  ) : (
                    <RotateCcw style={{ width: u(2.1), height: u(2.1) }} />
                  )}
                  {b.label}
                </span>
              );
            })}
            {left && <span className="text-white/65" style={{ fontSize: u(1.7), marginLeft: u(0.6) }}>{left} left</span>}
          </div>
        </div>

        {series && (
          <div style={{ marginTop: u(3) }}>
            {multi && (
              <div className="flex" style={{ gap: u(1), marginBottom: u(1.6) }}>
                {seasons.map((s) => {
                  const here = s.season === season;
                  const cursor = active && zone === 'seasons' && here;
                  return (
                    <span
                      key={s.season}
                      className={cn(
                        'tv-lift rounded-full font-semibold',
                        cursor ? 'bg-white text-black' : here ? 'bg-white/25 text-white' : 'text-white/55',
                      )}
                      style={{
                        fontSize: u(1.9),
                        paddingInline: u(2.4),
                        height: u(4.4),
                        display: 'inline-flex',
                        alignItems: 'center',
                        transform: cursor ? 'scale(1.08)' : 'scale(1)',
                      }}
                    >
                      Season {s.season}
                    </span>
                  );
                })}
              </div>
            )}
            <div className="flex overflow-hidden" style={{ gap: u(1.8), padding: `${u(1.2)} 0 ${u(1)}` }}>
              {episodes.map((ep, i) => (
                <EpisodeCard key={ep.id} ep={ep} n={i} fallbackTitle={collection?.title ?? ''} focused={active && zone === 'episodes' && i === epAt} />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function EpisodeCard({
  ep,
  n,
  fallbackTitle,
  focused,
}: {
  ep: MediaItem;
  n: number;
  fallbackTitle: string;
  focused: boolean;
}) {
  const pct = ep.durationSec > 0 ? (ep.progressSec / ep.durationSec) * 100 : 0;
  const done = isFinished(ep);
  const name = ep.title === fallbackTitle ? `Episode ${ep.episode ?? n + 1}` : ep.title;
  return (
    <div data-ep={n} className="shrink-0" style={{ width: EP_W }}>
      <div
        className="tv-lift relative overflow-hidden bg-white/10"
        style={{
          aspectRatio: '16 / 9',
          borderRadius: u(1.4),
          transform: focused ? `translateY(calc(${u(0.5)} * -1)) scale(1.06)` : 'scale(1)',
          boxShadow: focused ? '0 1.4rem 2.6rem rgba(0,0,0,0.65)' : '0 0.3rem 0.8rem rgba(0,0,0,0.35)',
          opacity: focused ? 1 : 0.9,
        }}
      >
        <Thumbnail title={ep.title} seed={ep.id} posterUrl={ep.posterUrl} streamUrl={ep.streamUrl} className="absolute inset-0 h-full w-full" />
        <div className="tv-lift tv-sheen absolute inset-0" style={{ opacity: focused ? 1 : 0 }} />
        {done && (
          <span className="absolute grid place-items-center rounded-full bg-white text-black" style={{ top: u(0.8), right: u(0.8), width: u(2.4), height: u(2.4) }}>
            <Check style={{ width: u(1.5), height: u(1.5) }} strokeWidth={3} />
          </span>
        )}
        {pct > 1 && !done && (
          <div className="absolute inset-x-0 bottom-0 bg-black/55" style={{ height: u(0.5) }}>
            <div className="h-full bg-white" style={{ width: `${pct}%` }} />
          </div>
        )}
      </div>
      <div className={cn('tv-lift', focused ? 'opacity-100' : 'opacity-70')} style={{ marginTop: u(1), paddingInline: u(0.3) }}>
        <div className="font-semibold leading-tight truncate" style={{ fontSize: u(1.75) }}>
          {ep.episode ? `${ep.episode}. ` : ''}
          {name}
        </div>
        <div className="text-white/60 truncate" style={{ fontSize: u(1.4), marginTop: u(0.2) }}>
          {ep.durationSec > 0 ? runtime(ep.durationSec) : ''}
          {ep.progressSec > 30 && !done ? ` · ${runtime(ep.durationSec - ep.progressSec)} left` : ''}
        </div>
      </div>
    </div>
  );
}

/** A tile for a title opened from somewhere that only has the item or the collection. */
export const tileFor = (t: MediaItem | Collection): Tile => ('items' in t ? showTile(t) : itemTile(t));
