import { RefreshCw } from 'lucide-react';

import { cn } from '../lib/utils';
import { u } from './units';

export type Tab = 'home' | 'movies' | 'shows' | 'devices';

export const TABS: { id: Tab; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'movies', label: 'Movies' },
  { id: 'shows', label: 'Shows' },
  { id: 'devices', label: 'Devices' },
];

/** The bar's stops: the four tabs, then Refresh. */
export const TAB_STOPS = TABS.length + 1;

/**
 * The bar along the top.
 *
 * Moving across it changes the page underneath at once, the way a tab bar on
 * a television does - there is no "open" on a tab - and Refresh is the last
 * stop. Drawn only; the keys are handled where the rest of the app's focus is.
 */
export function TvTabs({
  current,
  stop,
  focused,
  busy,
  deviceCount,
}: {
  current: Tab;
  /** Which stop has the cursor: 0-3 a tab, 4 Refresh. */
  stop: number;
  /** The cursor is on the bar, rather than on the page below. */
  focused: boolean;
  busy: boolean;
  deviceCount: number;
}) {
  return (
    <div
      className="absolute inset-x-0 top-0 z-20 flex items-center"
      style={{
        height: u(8),
        padding: `0 ${u(5)}`,
        background: 'linear-gradient(to bottom, rgba(0,0,0,0.82), rgba(0,0,0,0))',
      }}
    >
      <div className="font-bold tracking-tight text-white/90" style={{ fontSize: u(2.2), width: u(14) }}>
        LANTV
      </div>

      <div className="flex-1 flex justify-center" style={{ gap: u(0.6) }}>
        {TABS.map((t, i) => {
          const here = t.id === current;
          const cursor = focused && stop === i;
          return (
            <span
              key={t.id}
              className={cn(
                'tv-lift rounded-full font-semibold',
                cursor ? 'bg-white text-black' : here ? 'bg-white/20 text-white' : 'text-white/60',
              )}
              style={{
                fontSize: u(2),
                paddingInline: u(2.6),
                height: u(4.6),
                display: 'inline-flex',
                alignItems: 'center',
                transform: cursor ? 'scale(1.08)' : 'scale(1)',
                boxShadow: cursor ? '0 0.6rem 1.6rem rgba(0,0,0,0.5)' : undefined,
              }}
            >
              {t.label}
            </span>
          );
        })}
      </div>

      <div className="flex items-center justify-end text-white/60" style={{ width: u(14), gap: u(1.2), fontSize: u(1.5) }}>
        {deviceCount > 0 && <span>{deviceCount === 1 ? '1 device' : `${deviceCount} devices`}</span>}
        <span
          className={cn(
            'tv-lift grid place-items-center rounded-full',
            focused && stop === TABS.length ? 'bg-white text-black' : 'bg-white/10 text-white/80',
          )}
          style={{
            width: u(4.6),
            height: u(4.6),
            transform: focused && stop === TABS.length ? 'scale(1.1)' : 'scale(1)',
          }}
        >
          <RefreshCw className={busy ? 'animate-spin' : undefined} style={{ width: u(2.2), height: u(2.2) }} />
        </span>
      </div>
    </div>
  );
}
