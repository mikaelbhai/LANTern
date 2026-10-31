import React from 'react';

import { TvCard, CARD_GAP } from './TvCard';
import { intentOf } from './remote';
import type { Tile } from './tvShelves';
import { u } from './units';

const COLUMNS = 4;
const COL_W = `calc((100vw - ${u(10)}) / ${COLUMNS} - ${CARD_GAP})`;
/** A row's height: a 16:9 card of that width, its caption, and the space between rows. */
const ROW_H = `calc(${COL_W} * 9 / 16 + ${u(9.5)})`;
/** Rows kept drawn around the one with the cursor. */
const ROWS_BEHIND = 1;
const ROWS_AHEAD = 3;

/**
 * Every film, or every series, as a grid of cards.
 *
 * Only a few rows around the cursor are drawn, with blank rows of the same
 * height standing in for the rest, for the reason the home page does the same:
 * a card is a picture asked of another device.
 */
export function TvGrid({
  heading,
  tiles,
  empty,
  active,
  onOpen,
  onUp,
}: {
  heading: string;
  tiles: Tile[];
  empty: string;
  active: boolean;
  onOpen: (t: Tile) => void;
  onUp: () => void;
}) {
  const [at, setAt] = React.useState(0);
  const root = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    setAt((i) => Math.min(i, Math.max(0, tiles.length - 1)));
  }, [tiles.length]);

  const rowCount = Math.ceil(tiles.length / COLUMNS);
  const row = Math.floor(at / COLUMNS);

  React.useEffect(() => {
    if (!active) return;
    root.current?.querySelector<HTMLElement>(`[data-grid-row="${row}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [row, active]);

  const state = React.useRef({ at, tiles, active });
  state.current = { at, tiles, active };
  const handlers = React.useRef({ onOpen, onUp });
  handlers.current = { onOpen, onUp };

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const { at: i, tiles: list, active: on } = state.current;
      if (!on) return;
      const intent = intentOf(e);
      if (!intent || intent === 'back') return;
      e.preventDefault();
      e.stopPropagation();
      if (!list.length) {
        if (intent === 'up') handlers.current.onUp();
        return;
      }
      if (intent === 'left') setAt(Math.max(0, i - 1));
      else if (intent === 'right') setAt(Math.min(list.length - 1, i + 1));
      else if (intent === 'down') setAt(Math.min(list.length - 1, i + COLUMNS));
      else if (intent === 'up') {
        if (i < COLUMNS) handlers.current.onUp();
        else setAt(i - COLUMNS);
      } else if (intent === 'ok') handlers.current.onOpen(list[i]);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div ref={root} className="h-full overflow-hidden" style={{ paddingTop: u(10) }}>
      <h1 className="font-bold" style={{ fontSize: u(4.4), padding: `0 ${u(5)}`, marginBottom: u(1.6), letterSpacing: '-0.02em' }}>
        {heading}
      </h1>
      {!tiles.length ? (
        <p className="text-white/60" style={{ fontSize: u(2.2), padding: `0 ${u(5)}` }}>
          {empty}
        </p>
      ) : (
        <div className="h-[calc(100%-var(--grid-top))] overflow-hidden" style={{ ['--grid-top' as string]: u(8) }}>
          {Array.from({ length: rowCount }, (_, r) => {
            const near = r >= row - ROWS_BEHIND && r <= row + ROWS_AHEAD;
            return (
              <div key={r} data-grid-row={r} style={{ height: ROW_H }}>
                {near && (
                  <div className="flex" style={{ padding: `${u(1.4)} ${u(5)} 0`, gap: CARD_GAP }}>
                    {tiles.slice(r * COLUMNS, r * COLUMNS + COLUMNS).map((tile, c) => (
                      <TvCard
                        key={tile.key}
                        tile={tile}
                        focused={active && r * COLUMNS + c === at}
                        at={`${r}-${c}`}
                        width={COL_W}
                      />
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
