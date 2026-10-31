import { Check, Layers } from 'lucide-react';

import { Thumbnail } from '../lib/poster';
import { runtime } from '../screens/Theatre';
import { isFinished } from '../lib/watched';
import { cn } from '../lib/utils';
import { coverOf, titleOf, type Tile } from './tvShelves';
import { u } from './units';

/**
 * How wide a card is, and how far one card and the gap after it advance.
 *
 * Cards per screen is fractional on purpose: the next one is always partly in
 * view, which is what tells somebody a row goes on.
 */
export const CARD_GAP = u(1.8);
export const CARD_STEP = `calc((100vw - ${u(10)}) / 5.4)`;
export const CARD_W = `calc(${CARD_STEP} - ${CARD_GAP})`;

/** The line under a card's title. */
export function subtitleOf(tile: Tile): string {
  if (tile.kind === 'show') {
    const n = tile.collection.items.length;
    return `${n} ${tile.collection.kind === 'series' ? (n === 1 ? 'episode' : 'episodes') : n === 1 ? 'film' : 'films'}`;
  }
  const it = tile.item;
  if (it.kind === 'episode') {
    const left = it.durationSec - it.progressSec;
    return `S${it.season ?? 1} E${it.episode ?? 1}${
      it.progressSec > 30 && !isFinished(it) && left > 0 ? ` · ${runtime(left)} left` : ''
    }`;
  }
  const left = it.durationSec - it.progressSec;
  if (it.progressSec > 30 && !isFinished(it) && left > 0) return `${runtime(left)} left`;
  return runtime(it.durationSec);
}

/**
 * The one card: a 16:9 picture with its name underneath.
 *
 * Focus is a lift, a light across the picture and a deep shadow - transform
 * and opacity only, because a television's processor has no frames to spare
 * for anything that makes it re-blur or re-flow what is behind.
 */
export function TvCard({
  tile,
  focused,
  at,
  width = CARD_W,
}: {
  tile: Tile;
  focused: boolean;
  /** Where it is on the page, for scrolling it into view. */
  at: string;
  width?: string;
}) {
  const cover = coverOf(tile);
  const title = titleOf(tile);
  const progress =
    tile.kind === 'item' && tile.item.durationSec > 0 ? (tile.item.progressSec / tile.item.durationSec) * 100 : 0;
  const done = tile.kind === 'item' && isFinished(tile.item);

  return (
    <div data-tile={at} className="shrink-0" style={{ width }}>
      <div
        className="tv-lift relative overflow-hidden bg-white/10"
        style={{
          aspectRatio: '16 / 9',
          borderRadius: u(1.4),
          transform: focused ? `translateY(calc(${u(0.5)} * -1)) scale(1.08)` : 'scale(1)',
          zIndex: focused ? 2 : 1,
          boxShadow: focused ? '0 1.6rem 3rem rgba(0,0,0,0.65)' : '0 0.3rem 0.8rem rgba(0,0,0,0.35)',
          opacity: focused ? 1 : 0.92,
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
        <div className="tv-lift tv-sheen absolute inset-0" style={{ opacity: focused ? 1 : 0 }} />
        {tile.kind === 'show' && (
          <span
            className="absolute grid place-items-center rounded-full bg-black/60"
            style={{ top: u(0.8), right: u(0.8), width: u(2.6), height: u(2.6) }}
          >
            <Layers style={{ width: u(1.5), height: u(1.5) }} />
          </span>
        )}
        {done && (
          <span
            className="absolute grid place-items-center rounded-full bg-white text-black"
            style={{ top: u(0.8), right: u(0.8), width: u(2.4), height: u(2.4) }}
          >
            <Check style={{ width: u(1.5), height: u(1.5) }} strokeWidth={3} />
          </span>
        )}
        {progress > 1 && !done && (
          <div className="absolute inset-x-0 bottom-0 bg-black/55" style={{ height: u(0.5) }}>
            <div className="h-full bg-white" style={{ width: `${progress}%` }} />
          </div>
        )}
      </div>

      <div
        className={cn('tv-lift', focused ? 'opacity-100' : 'opacity-70')}
        style={{ marginTop: u(1.1), paddingInline: u(0.3), transform: focused ? `translateY(${u(0.4)})` : undefined }}
      >
        <div className="font-semibold leading-tight truncate" style={{ fontSize: u(1.8) }}>
          {title}
        </div>
        <div className="text-white/60 truncate" style={{ fontSize: u(1.45), marginTop: u(0.2) }}>
          {subtitleOf(tile)}
        </div>
      </div>
    </div>
  );
}
