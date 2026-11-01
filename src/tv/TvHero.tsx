import { Info, Play } from 'lucide-react';

import { Thumbnail } from '../lib/poster';
import { runtime } from '../screens/Theatre';
import { isContinuing, isFinished } from '../lib/watched';
import { cn } from '../lib/utils';
import { coverOf, playTarget, titleOf, type Tile } from './tvShelves';
import { u } from './units';

/** What the Play button says for a tile. */
export function playLabel(tile: Tile): string {
  const t = playTarget(tile);
  if (isContinuing(t)) return 'Resume';
  if (isFinished(t)) return 'Watch again';
  if (tile.kind === 'show') return t.series ? `Play S${t.season ?? 1} E${t.episode ?? 1}` : 'Play';
  return 'Play';
}

/** The facts about a title, on one line. */
export function metaOf(tile: Tile): string[] {
  const bits: string[] = [];
  if (tile.kind === 'item') {
    const it = tile.item;
    if (it.series) bits.push(`${it.series} · S${it.season ?? 1} E${it.episode ?? 1}`);
    if (it.genres.length) bits.push(it.genres.slice(0, 2).join(' · '));
    if (it.year) bits.push(String(it.year));
    if (it.durationSec > 0) bits.push(runtime(it.durationSec));
    if (it.quality) bits.push(it.quality);
  } else {
    const c = tile.collection;
    const seasons = c.seasons.length;
    bits.push(c.kind === 'series' ? (seasons > 1 ? `${seasons} seasons` : 'Series') : 'Collection');
    bits.push(`${c.items.length} ${c.kind === 'series' ? 'episodes' : 'films'}`);
  }
  return bits;
}

/**
 * The top of the home page: one title at a time, large, with its picture
 * across the whole width and fading to black on the left and at the bottom
 * so the writing is always on something dark.
 *
 * Plain gradients, no blur: this is the biggest thing on the screen, and the
 * place where a television's processor would first show it was being asked
 * too much.
 */
export function TvHero({
  tile,
  index,
  count,
  focused,
  infoFocused,
}: {
  tile: Tile;
  index: number;
  count: number;
  /** The cursor is on the Play button. */
  focused: boolean;
  /** ...or on the information button beside it. */
  infoFocused: boolean;
}) {
  const cover = coverOf(tile);
  const title = titleOf(tile);
  const it = tile.kind === 'item' ? tile.item : null;
  const target = playTarget(tile);
  const left = isContinuing(target) ? runtime(Math.max(0, target.durationSec - target.progressSec)) : null;

  return (
    <div className="relative shrink-0 overflow-hidden" style={{ height: '58vh' }}>
      {cover && (
        <div key={tile.key} className="tv-fade-in absolute inset-0">
          <Thumbnail
            title={title}
            seed={cover.id}
            posterUrl={cover.posterUrl}
            streamUrl={cover.streamUrl}
            className="absolute inset-0 h-full w-full"
          />
        </div>
      )}
      <div className="absolute inset-0" style={{ background: 'linear-gradient(to right, #000 0%, rgba(0,0,0,0.78) 32%, rgba(0,0,0,0) 68%)' }} />
      <div className="absolute inset-x-0 bottom-0" style={{ height: '48%', background: 'linear-gradient(to top, #000 4%, rgba(0,0,0,0))' }} />

      <div
        key={`t-${tile.key}`}
        className="tv-fade-in absolute inset-0 flex flex-col justify-end"
        style={{ padding: `0 ${u(5)} ${u(3.2)}` }}
      >
        <div
          className="font-bold leading-[1.02] line-clamp-2"
          style={{ fontSize: u(6.2), maxWidth: '58%', letterSpacing: '-0.01em', textShadow: '0 0.2rem 1.6rem rgba(0,0,0,0.7)' }}
        >
          {title}
        </div>
        <div className="text-white/75 font-medium" style={{ fontSize: u(2.2), marginTop: u(1.3) }}>
          {metaOf(tile).join('   ·   ')}
        </div>
        {it?.synopsis && (
          <p className="text-white/65 line-clamp-2" style={{ fontSize: u(2.05), marginTop: u(1), maxWidth: '46%', lineHeight: 1.4 }}>
            {it.synopsis}
          </p>
        )}

        <div className="flex items-center" style={{ gap: u(1.4), marginTop: u(2.2) }}>
          <span
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
            <Play style={{ width: u(2.1), height: u(2.1) }} fill="currentColor" />
            {playLabel(tile)}
          </span>
          <span
            className={cn(
              'tv-lift grid place-items-center rounded-full',
              infoFocused ? 'bg-white text-black' : 'bg-white/25 text-white',
            )}
            style={{
              width: u(5.4),
              height: u(5.4),
              transform: infoFocused ? 'scale(1.08)' : 'scale(1)',
              boxShadow: infoFocused ? '0 0.8rem 2rem rgba(0,0,0,0.55)' : undefined,
            }}
          >
            <Info style={{ width: u(2.4), height: u(2.4) }} />
          </span>
          {left && <span className="text-white/65" style={{ fontSize: u(1.9), marginLeft: u(0.6) }}>{left} left</span>}
        </div>

        {count > 1 && (
          <div className="absolute flex" style={{ right: u(5), bottom: u(3.6), gap: u(0.8) }}>
            {Array.from({ length: count }, (_, i) => (
              <span
                key={i}
                className="rounded-full bg-white transition-all duration-300"
                style={{
                  height: u(0.9),
                  width: i === index ? u(2.8) : u(0.9),
                  opacity: i === index ? 0.95 : 0.35,
                }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
