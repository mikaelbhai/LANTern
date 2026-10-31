import React from 'react';
import { Loader2, RefreshCw } from 'lucide-react';

import type { Collection, Grouping } from '../lib/collections';
import type { MediaItem } from '../lib/types';
import { cn } from '../lib/utils';
import { TvCard, CARD_GAP, CARD_STEP } from './TvCard';
import { TvHero } from './TvHero';
import { intentOf } from './remote';
import { featured, homeShelves, playTarget, type Tile } from './tvShelves';
import { u } from './units';

/**
 * The home page: a hero for one title at a time and rows of cards below it.
 *
 * Focus is the pair (row, column) held here, not whatever the browser thinks
 * is focused. Row -1 is the hero (column 0 its Play button, column 1 its
 * information button); the rest are shelves. Moving it scrolls what it landed
 * on into view and does nothing else.
 */

const TILES_BEHIND = 4;
const TILES_AHEAD = 12;
/** A shelf the viewer is not on still shows this many, so it is not empty when they arrive. */
const TILES_FIRST = 14;
/** How long the hero holds one title while the cursor rests on it. */
const HERO_MS = 8000;

export function TvHome({
  items,
  grouping,
  active,
  onPlay,
  onOpen,
  onUp,
}: {
  items: MediaItem[];
  grouping: Grouping;
  /** False while something else (a film, a detail page, the tab bar) has the remote. */
  active: boolean;
  onPlay: (i: MediaItem) => void;
  /** Open a title's own page. */
  onOpen: (t: Tile) => void;
  /** Up from the top of the page: on to the tab bar. */
  onUp: () => void;
}) {
  const shelves = React.useMemo(() => homeShelves(items, grouping), [items, grouping]);
  const heroes = React.useMemo(() => featured(items, grouping), [items, grouping]);

  const [focus, setFocus] = React.useState({ r: heroes.length ? -1 : 0, c: 0 });
  const [heroAt, setHeroAt] = React.useState(0);
  const remembered = React.useRef<number[]>([]);
  const root = React.useRef<HTMLDivElement>(null);
  const placed = React.useRef(heroes.length > 0);

  // Keep the cursor on something that exists when the page changes under it.
  React.useEffect(() => {
    // The shelf arrives after the page opens: when the first title appears the
    // cursor goes to it, rather than staying on a row that was never chosen.
    if (!placed.current && heroes.length) {
      placed.current = true;
      setFocus({ r: -1, c: 0 });
      return;
    }
    setFocus((f) => {
      if (f.r < 0) return heroes.length ? f : { r: 0, c: 0 };
      const r = Math.min(f.r, Math.max(0, shelves.length - 1));
      const c = Math.min(f.c, Math.max(0, (shelves[r]?.tiles.length ?? 1) - 1));
      return r === f.r && c === f.c ? f : { r, c };
    });
    setHeroAt((i) => Math.min(i, Math.max(0, heroes.length - 1)));
  }, [shelves, heroes]);

  // The hero turns over by itself, but only while somebody is looking at it:
  // a picture changing under a row they are choosing from is a distraction,
  // and each new one is a frame asked of another device.
  React.useEffect(() => {
    if (!active || focus.r >= 0) return;
    if (heroes.length < 2) return;
    const id = window.setInterval(() => setHeroAt((i) => (i + 1) % heroes.length), HERO_MS);
    return () => window.clearInterval(id);
  }, [active, focus.r, heroes.length]);

  const hero = heroes[Math.min(heroAt, heroes.length - 1)] ?? null;

  // Scrolling: the row to the top, the tile to the middle of its row.
  React.useEffect(() => {
    const el = root.current;
    if (!active || !el) return;
    if (focus.r < 0) {
      el.querySelector<HTMLElement>('[data-scroller]')?.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    el.querySelector<HTMLElement>(`[data-row="${focus.r}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    el.querySelector<HTMLElement>(`[data-tile="${focus.r}-${focus.c}"]`)?.scrollIntoView({
      block: 'nearest',
      inline: 'center',
      behavior: 'smooth',
    });
  }, [focus, active]);

  const state = React.useRef({ focus, shelves, hero, heroes, active });
  state.current = { focus, shelves, hero, heroes, active };
  const handlers = React.useRef({ onPlay, onOpen, onUp });
  handlers.current = { onPlay, onOpen, onUp };

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { focus: f, shelves: rows, hero: h, heroes: hs, active: on } = state.current;
      if (!on) return;
      const intent = intentOf(e);
      if (!intent || intent === 'back') return;
      e.preventDefault();
      e.stopPropagation();

      // The hero.
      if (f.r < 0) {
        if (intent === 'up') handlers.current.onUp();
        else if (intent === 'down') {
          if (rows.length) setFocus({ r: 0, c: Math.min(remembered.current[0] ?? 0, rows[0].tiles.length - 1) });
        } else if (intent === 'left') {
          if (f.c === 1) setFocus({ r: -1, c: 0 });
          else if (hs.length > 1) setHeroAt((i) => (i - 1 + hs.length) % hs.length);
        } else if (intent === 'right') {
          if (f.c === 0) setFocus({ r: -1, c: 1 });
          else if (hs.length > 1) setHeroAt((i) => (i + 1) % hs.length);
        } else if (intent === 'ok' && h) {
          if (f.c === 0) handlers.current.onPlay(playTarget(h));
          else handlers.current.onOpen(h);
        }
        return;
      }

      if (intent === 'up' && f.r === 0) {
        remembered.current[0] = f.c;
        if (hs.length) setFocus({ r: -1, c: 0 });
        else handlers.current.onUp();
        return;
      }
      if (intent === 'left') setFocus({ r: f.r, c: Math.max(0, f.c - 1) });
      else if (intent === 'right') setFocus({ r: f.r, c: Math.min(rows[f.r].tiles.length - 1, f.c + 1) });
      else if (intent === 'up' || intent === 'down') {
        const r = Math.max(0, Math.min(rows.length - 1, f.r + (intent === 'down' ? 1 : -1)));
        if (r === f.r) return;
        remembered.current[f.r] = f.c;
        setFocus({ r, c: Math.min(remembered.current[r] ?? f.c, rows[r].tiles.length - 1) });
      } else if (intent === 'ok') {
        const tile = rows[f.r]?.tiles[f.c];
        if (tile) handlers.current.onOpen(tile);
      }
      // Back is the tab bar's and the system's.
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div ref={root} className="relative h-full">
      <div data-scroller className="h-full overflow-hidden" style={{ paddingBottom: u(6) }}>
        {hero && <TvHero tile={hero} index={heroAt} count={heroes.length} focused={active && focus.r < 0 && focus.c === 0} infoFocused={active && focus.r < 0 && focus.c === 1} />}

        <div style={{ paddingTop: hero ? 0 : u(10) }}>
          {shelves.map((shelf, r) => {
            /*
             * Only the cards near where the viewer is are drawn.
             *
             * Every card of every shelf used to be, each with its picture
             * requested - a hundred and fifty at once on a television's
             * processor, all asking another device to cut a frame before the
             * first could be looked at. A short run around the cursor is
             * drawn, with empty space where the rest are so scrolling to them
             * still works.
             */
            const centre = r === focus.r ? focus.c : (remembered.current[r] ?? 0);
            const from = Math.max(0, centre - TILES_BEHIND);
            const to = Math.min(shelf.tiles.length, Math.max(centre + TILES_AHEAD, TILES_FIRST));
            return (
              <section
                key={shelf.label}
                data-row={r}
                style={{ marginTop: r === 0 ? u(1) : u(2.6), scrollMarginTop: u(9) }}
              >
                <h2 className="font-bold text-white" style={{ fontSize: u(2.4), padding: `0 ${u(5)}`, marginBottom: u(1.2) }}>
                  {shelf.label}
                </h2>
                <div className="flex overflow-hidden" style={{ padding: `${u(1.6)} ${u(5)} ${u(2.2)}`, gap: CARD_GAP }}>
                  {from > 0 && <div className="shrink-0" style={{ width: `calc(${from} * ${CARD_STEP})` }} />}
                  {shelf.tiles.slice(from, to).map((tile, i) => (
                    <TvCard key={tile.key} tile={tile} focused={active && r === focus.r && from + i === focus.c} at={`${r}-${from + i}`} />
                  ))}
                  {to < shelf.tiles.length && (
                    <div className="shrink-0" style={{ width: `calc(${shelf.tiles.length - to} * ${CARD_STEP})` }} />
                  )}
                </div>
              </section>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/**
 * What the page says while there is nothing to show: looking, or nothing
 * published. A centred message, because the bar above it is the only other
 * thing there is.
 */
export function TvEmpty({
  loading,
  busy,
  devices,
  focused,
}: {
  /** Still looking: nothing has been found yet, and it is too soon to say so. */
  loading: boolean;
  busy: boolean;
  /** Names of the devices that have been found, which is most of what a viewer wants to know while waiting. */
  devices: string[];
  /** The Refresh button has the cursor. */
  focused: boolean;
}) {
  const found = devices.length;
  const searching = loading || busy;
  return (
    <div className="h-full grid place-items-center text-center" style={{ padding: u(6) }}>
      <div className="flex flex-col items-center">
        {searching && <Loader2 className="animate-spin text-white/70" style={{ width: u(6.5), height: u(6.5), marginBottom: u(2.2) }} />}
        <div className="font-bold" style={{ fontSize: u(3.6) }}>
          {busy
            ? 'Refreshing…'
            : loading
              ? found
                ? `Reading the library on ${devices[0]}…`
                : 'Looking for films on your network…'
              : found
                ? 'Nothing to watch yet'
                : 'No devices found'}
        </div>
        <p className="text-white/60" style={{ fontSize: u(2), marginTop: u(1.2), maxWidth: u(70) }}>
          {searching
            ? found
              ? 'This can take a few seconds.'
              : 'Searching for computers and phones that are sharing films.'
            : found
              ? `${devices.slice(0, 3).join(', ')} ${found === 1 ? 'has' : 'have'} not published a media folder yet.`
              : 'Open LANTern on a computer or phone on this Wi-Fi and publish a media folder, and it appears here.'}
        </p>
        <span
          className={cn(
            'tv-lift inline-flex items-center rounded-full font-semibold',
            focused ? 'bg-white text-black' : 'bg-white/15 text-white/80',
          )}
          style={{
            marginTop: u(3.4),
            gap: u(1.1),
            height: u(5.4),
            paddingInline: u(3.2),
            fontSize: u(2.1),
            transform: focused ? 'scale(1.08)' : 'scale(1)',
          }}
        >
          <RefreshCw className={busy ? 'animate-spin' : undefined} style={{ width: u(2.3), height: u(2.3) }} />
          {busy ? 'Refreshing…' : 'Refresh'}
        </span>
      </div>
    </div>
  );
}

export type { Collection };
