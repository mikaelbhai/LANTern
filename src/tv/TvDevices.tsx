import React from 'react';
import { Monitor, RefreshCw, Smartphone } from 'lucide-react';

import { cn } from '../lib/utils';
import type { MediaItem, Peer } from '../lib/types';
import { intentOf } from './remote';
import { u } from './units';

/**
 * Who is sharing what.
 *
 * A television cannot tell anybody why its shelf is empty, and "nothing is
 * published" is not an answer when the real one is that the computer is off.
 * This lists the devices that have been found, how many titles each is
 * offering, and says so plainly when one is serving with nobody signed in.
 */
export function TvDevices({
  peers,
  items,
  active,
  busy,
  onRefresh,
  onUp,
}: {
  peers: Peer[];
  items: MediaItem[];
  active: boolean;
  busy: boolean;
  onRefresh: () => void;
  onUp: () => void;
}) {
  const counts = React.useMemo(() => {
    const out = new Map<string, number>();
    for (const i of items) if (i.peerId) out.set(i.peerId, (out.get(i.peerId) ?? 0) + 1);
    return out;
  }, [items]);

  const handlers = React.useRef({ onRefresh, onUp });
  handlers.current = { onRefresh, onUp };
  const on = React.useRef(active);
  on.current = active;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!on.current) return;
      const intent = intentOf(e);
      if (!intent || intent === 'back') return;
      e.preventDefault();
      e.stopPropagation();
      if (intent === 'up') handlers.current.onUp();
      else if (intent === 'ok') handlers.current.onRefresh();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  return (
    <div className="h-full overflow-hidden" style={{ padding: `${u(10)} ${u(5)} ${u(4)}` }}>
      <h1 className="font-bold" style={{ fontSize: u(4.4), marginBottom: u(2), letterSpacing: '-0.02em' }}>
        Devices
      </h1>

      {!peers.length ? (
        <p className="text-white/60" style={{ fontSize: u(2.2), maxWidth: u(80) }}>
          No other device has been found yet. Open LANTern on a computer or phone on this Wi-Fi.
        </p>
      ) : (
        <div className="grid" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: u(1.6), maxWidth: u(130) }}>
          {peers.map((p) => {
            const n = counts.get(p.id) ?? counts.get(p.deviceId) ?? 0;
            const Icon = (p.os as string) === 'android' || (p.os as string) === 'ios' ? Smartphone : Monitor;
            return (
              <div key={p.id} className="flex items-center bg-white/10" style={{ padding: u(1.8), gap: u(1.6), borderRadius: u(1.6) }}>
                <span className="grid place-items-center rounded-full bg-white/15 shrink-0" style={{ width: u(5.6), height: u(5.6) }}>
                  <Icon style={{ width: u(2.8), height: u(2.8) }} />
                </span>
                <div className="min-w-0">
                  <div className="font-semibold truncate" style={{ fontSize: u(2.2) }}>
                    {p.name}
                  </div>
                  <div className="text-white/60 truncate" style={{ fontSize: u(1.55), marginTop: u(0.2) }}>
                    {p.hostOnly ? 'Sharing with nobody signed in' : (p.deviceName ?? p.name)}
                    {n > 0 ? ` · ${n} ${n === 1 ? 'title' : 'titles'}` : ''}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <span
        className={cn(
          'tv-lift inline-flex items-center rounded-full font-semibold',
          active ? 'bg-white text-black' : 'bg-white/15 text-white/80',
        )}
        style={{
          marginTop: u(3),
          gap: u(1.1),
          height: u(5.4),
          paddingInline: u(3.2),
          fontSize: u(2.1),
          transform: active ? 'scale(1.08)' : 'scale(1)',
        }}
      >
        <RefreshCw className={busy ? 'animate-spin' : undefined} style={{ width: u(2.3), height: u(2.3) }} />
        {busy ? 'Refreshing…' : 'Refresh'}
      </span>
    </div>
  );
}
