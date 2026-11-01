import React from 'react';
import { Download, Monitor, RefreshCw, Smartphone } from 'lucide-react';

import { cn } from '../lib/utils';
import type { MediaItem, Peer } from '../lib/types';
import { intentOf } from './remote';
import { install, look, type Chosen, type Found } from './tvUpdate';
import { u } from './units';

type Phase =
  | { k: 'idle' }
  | { k: 'checking' }
  | { k: 'current'; found: Found }
  | { k: 'ready'; found: Found; chosen: Chosen }
  | { k: 'working'; fraction: number }
  | { k: 'error'; message: string };

/** What the update button says, for where it has got to. */
function updateLabel(p: Phase): string {
  switch (p.k) {
    case 'checking':
      return 'Looking for a newer version…';
    case 'current':
      return `LANTV ${p.found.current} is the newest`;
    case 'ready':
      return `Install ${p.chosen.version}`;
    case 'working':
      return p.fraction > 0 && p.fraction < 1 ? `Downloading ${Math.round(p.fraction * 100)}%` : 'Installing…';
    case 'error':
      return 'Try again';
    default:
      return 'Check for update';
  }
}

/** The line under it: where the new version would come from, or why there is none. */
function updateNote(p: Phase): string {
  switch (p.k) {
    case 'ready':
      return p.chosen.source === 'network'
        ? `From ${p.chosen.peer ?? 'a device on your network'} - no internet needed.`
        : 'From the internet.';
    case 'current': {
      const { askedNetwork, askedOnline } = p.found;
      if (!askedNetwork && !askedOnline) return 'Could not reach your network or the internet.';
      return askedOnline ? 'Checked your network and the internet.' : 'Checked your network. The internet could not be reached.';
    }
    case 'working':
      return p.fraction >= 1 ? 'Confirm on the screen that follows.' : 'Keep this open until it finishes.';
    case 'error':
      return p.message;
    case 'checking':
      return 'Asking the other devices, then GitHub.';
    default:
      return 'Looks on your network first, then online, and installs the newest.';
  }
}

/**
 * Who is sharing what, and the way to update LANTV.
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

  // 0 is Refresh, 1 is the update button.
  const [at, setAt] = React.useState<0 | 1>(0);
  const [phase, setPhase] = React.useState<Phase>({ k: 'idle' });

  const check = React.useCallback(async () => {
    setPhase({ k: 'checking' });
    try {
      const found = await look();
      setPhase(found.chosen ? { k: 'ready', found, chosen: found.chosen } : { k: 'current', found });
    } catch (e) {
      setPhase({ k: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const go = React.useCallback(async (found: Found, chosen: Chosen) => {
    setPhase({ k: 'working', fraction: 0 });
    try {
      await install(chosen, found.online ? { asset: found.online.asset } : null, (fraction) =>
        setPhase({ k: 'working', fraction }),
      );
      // The system's installer has the screen now; if it comes back unfinished
      // the button is as it was.
      setPhase({ k: 'ready', found, chosen });
    } catch (e) {
      setPhase({ k: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  const press = () => {
    if (at === 0) return onRefresh();
    if (phase.k === 'ready') void go(phase.found, phase.chosen);
    else if (phase.k !== 'checking' && phase.k !== 'working') void check();
  };

  const live = React.useRef({ at, press, onUp, active });
  live.current = { at, press, onUp, active };

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = live.current;
      if (!s.active) return;
      const intent = intentOf(e);
      if (!intent || intent === 'back') return;
      e.preventDefault();
      e.stopPropagation();
      if (intent === 'up') {
        if (s.at === 0) s.onUp();
        else setAt(0);
      } else if (intent === 'down') setAt(1);
      else if (intent === 'ok') s.press();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const button = (focused: boolean, children: React.ReactNode, which: 0 | 1) => (
    <span
      onMouseEnter={() => active && setAt(which)}
      onClick={() => {
        if (!active) return;
        setAt(which);
        if (which === 0) onRefresh();
        else if (phase.k === 'ready') void go(phase.found, phase.chosen);
        else if (phase.k !== 'checking' && phase.k !== 'working') void check();
      }}
      className={cn(
        'tv-lift inline-flex items-center rounded-full font-semibold cursor-pointer',
        focused ? 'bg-white text-black' : 'bg-white/15 text-white/80',
      )}
      style={{
        gap: u(1.1),
        height: u(5.4),
        paddingInline: u(3.2),
        fontSize: u(2.1),
        transform: focused ? 'scale(1.08)' : 'scale(1)',
        boxShadow: focused ? '0 0.8rem 2rem rgba(0,0,0,0.55)' : undefined,
      }}
    >
      {children}
    </span>
  );

  return (
    <div className="h-full overflow-hidden" style={{ padding: `${u(10)} ${u(5)} ${u(4)}` }}>
      <h1 className="font-bold" style={{ fontSize: u(4.4), marginBottom: u(0.6), letterSpacing: '-0.01em' }}>
        Devices
      </h1>
      <p className="text-white/60" style={{ fontSize: u(1.8), marginBottom: u(2) }}>
        Sharing a library right now
      </p>

      {!peers.length ? (
        <p className="text-white/60" style={{ fontSize: u(2.2), maxWidth: u(80) }}>
          No device is sharing a library right now. Open LANTern on a computer or phone on this Wi-Fi and publish a media folder.
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
                  <div className="text-white/60 truncate" style={{ fontSize: u(1.7), marginTop: u(0.2) }}>
                    {p.hostOnly ? 'Sharing with nobody signed in' : (p.deviceName ?? p.name)}
                    {n > 0 ? ` · ${n} ${n === 1 ? 'title' : 'titles'}` : ''}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex items-start" style={{ marginTop: u(3), gap: u(2.4) }}>
        {button(
          active && at === 0,
          <>
            <RefreshCw className={busy ? 'animate-spin' : undefined} style={{ width: u(2.3), height: u(2.3) }} />
            {busy ? 'Refreshing…' : 'Refresh'}
          </>,
          0,
        )}
        <div>
          {button(
            active && at === 1,
            <>
              <Download style={{ width: u(2.3), height: u(2.3) }} />
              {updateLabel(phase)}
            </>,
            1,
          )}
          <div className="text-white/60" style={{ fontSize: u(1.7), marginTop: u(1), maxWidth: u(60) }}>
            {updateNote(phase)}
          </div>
          {phase.k === 'working' && (
            <div className="rounded-full bg-white/20 overflow-hidden" style={{ height: u(0.8), marginTop: u(1.2), width: u(40) }}>
              <div className="h-full bg-white" style={{ width: `${Math.round(phase.fraction * 100)}%` }} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
