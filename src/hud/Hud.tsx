/**
 * The popup itself.
 *
 * Runs in its own window, in its own JavaScript context, and knows nothing
 * except the last snapshot it was handed. It deliberately does not import the
 * store: that would start a second copy of the application's machinery in a
 * window with none of the permissions to run it, and give the popup opinions
 * of its own about state the application already owns.
 *
 * Everything here is either drawing, or sending back what was pressed.
 */
import React from 'react';
import {
  ArrowUpRight,
  Check,
  Download,
  FileDown,
  FolderOpen,
  FolderSearch,
  Mic,
  MicOff,
  Phone,
  PhoneOff,
  Video,
  X,
} from 'lucide-react';

import { Avatar } from '../components/Avatar';
import { api, emitNative, listenNative } from '../lib/bridge';
import { EMPTY, HUD_ACTION, HUD_READY, HUD_STATE } from '../lib/hud';
import type { HudAction, HudSnapshot } from '../lib/hud';
import { cn, formatBytes, formatDuration, formatSpeed } from '../lib/utils';

const send = (action: HudAction) => void emitNative(HUD_ACTION, action);

export function Hud() {
  const [snap, setSnap] = React.useState<HudSnapshot>(EMPTY);
  const root = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    let stop: (() => void) | null = null;
    let cancelled = false;
    void listenNative(HUD_STATE, (s: HudSnapshot) => setSnap(s ?? EMPTY)).then((off) => {
      if (cancelled) off();
      else stop = off;
    });
    // Whatever opened this window described itself before the window existed.
    void emitNative(HUD_READY);

    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  /**
   * Tell the window how tall to be.
   *
   * Measured rather than calculated: a long filename wraps, a group call adds
   * a line, and the window has to end exactly where the content does or there
   * is a band of empty panel sitting over the desktop.
   */
  React.useEffect(() => {
    const el = root.current;
    if (!el) return;
    const report = () => {
      const h = Math.ceil(el.getBoundingClientRect().height);
      if (h > 0) void api.hud.resize(h).catch(() => {});
    };
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={root}
      className="w-full bg-surface border border-edge-strong text-txt select-none overflow-hidden"
    >
      <div className="h-7 px-2.5 flex items-center gap-1.5 border-b border-edge bg-raised/50">
        <span className="text-gold text-[11px]">🏮</span>
        <span className="text-[10px] tracking-wide text-dim flex-1">LANTern</span>
        <button
          onClick={() => send({ t: 'open' })}
          title="Open LANTern"
          className="h-5 w-5 grid place-items-center rounded hover:bg-raised text-muted hover:text-txt"
        >
          <ArrowUpRight size={12} />
        </button>
      </div>

      {snap.call && <CallCard call={snap.call} />}
      {snap.offer && <OfferCard offer={snap.offer} />}
      {snap.active.length > 0 && <Progress list={snap.active} />}
      {snap.done && <DoneCard done={snap.done} />}
    </div>
  );
}

/* ------------------------------------------------------------------ calls */

function CallCard({ call }: { call: NonNullable<HudSnapshot['call']> }) {
  const [elapsed, setElapsed] = React.useState(0);

  React.useEffect(() => {
    if (call.state !== 'active') return;
    const tick = () => setElapsed(Date.now() - call.startedAt);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [call.state, call.startedAt]);

  const Kind = call.kind === 'video' ? Video : Phone;

  return (
    <div className="p-2.5">
      <div className="flex items-center gap-2.5">
        <Avatar name={call.who} color={call.color} emoji={call.emoji} size={34} />
        <button
          onClick={() => send({ t: 'open' })}
          className="min-w-0 flex-1 text-left"
          title="Open LANTern"
        >
          <div className="text-xs font-medium truncate">
            {call.who}
            {call.others > 0 && <span className="text-muted"> +{call.others}</span>}
          </div>
          <div className="text-[10px] text-muted flex items-center gap-1">
            <Kind size={9} />
            {call.incoming
              ? `Incoming ${call.kind} call`
              : call.state === 'active'
                ? formatDuration(elapsed)
                : call.state === 'ringing'
                  ? 'Ringing…'
                  : 'Connecting…'}
          </div>
        </button>
      </div>

      <div className="flex gap-1.5 mt-2.5">
        {call.incoming ? (
          <>
            <Action tone="go" icon={<Phone size={12} />} onClick={() => send({ t: 'answer' })}>
              Answer
            </Action>
            <Action tone="stop" icon={<PhoneOff size={12} />} onClick={() => send({ t: 'decline' })}>
              Decline
            </Action>
          </>
        ) : (
          <>
            <Action
              tone={call.muted ? 'stop' : 'plain'}
              icon={call.muted ? <MicOff size={12} /> : <Mic size={12} />}
              onClick={() => send({ t: 'mute', on: !call.muted })}
            >
              {call.muted ? 'Unmute' : 'Mute'}
            </Action>
            <Action tone="stop" icon={<PhoneOff size={12} />} onClick={() => send({ t: 'hangup' })}>
              Hang up
            </Action>
          </>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ files */

function OfferCard({ offer }: { offer: NonNullable<HudSnapshot['offer']> }) {
  return (
    <div className="p-2.5 border-t border-edge">
      <div className="flex items-start gap-2.5">
        <span className="h-8 w-8 shrink-0 rounded-input grid place-items-center bg-cyan/10 border border-cyan/30 text-cyan">
          <FileDown size={15} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium truncate" title={offer.name}>
            {offer.name}
          </div>
          <div className="text-[10px] text-muted truncate">
            {formatBytes(offer.size)} · from {offer.who}
          </div>
        </div>
      </div>

      <p className="text-[10px] text-muted mt-1.5 leading-relaxed truncate" title={offer.saveTo}>
        Goes to <span className="font-mono text-dim">{offer.saveTo}</span>
      </p>

      <div className="flex gap-1.5 mt-2">
        <Action tone="go" icon={<Download size={12} />} onClick={() => send({ t: 'accept', id: offer.id })}>
          Accept
        </Action>
        {/*
          Choosing a folder opens a native dialog, which belongs to the window
          that is allowed to open one. This only asks.
        */}
        <Action
          icon={<FolderSearch size={12} />}
          onClick={() => void emitNative(`${HUD_ACTION}:saveTo`, { id: offer.id })}
        >
          Save to…
        </Action>
        <Action icon={<X size={12} />} onClick={() => send({ t: 'reject', id: offer.id })}>
          Not now
        </Action>
      </div>
    </div>
  );
}

function Progress({ list }: { list: HudSnapshot['active'] }) {
  return (
    <div className="p-2.5 border-t border-edge space-y-2">
      {list.map((t) => {
        const pct = t.size > 0 ? Math.min(100, Math.round((t.sent / t.size) * 100)) : 0;
        return (
          <div key={t.id}>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] truncate flex-1" title={t.name}>
                {t.direction === 'in' ? '↓' : '↑'} {t.name}
              </span>
              <span className="text-[10px] font-mono text-muted shrink-0">{pct}%</span>
            </div>
            <div className="h-1 rounded-full bg-base mt-1 overflow-hidden">
              <div
                className={cn(
                  'h-full rounded-full transition-[width] duration-300',
                  t.state === 'paused' ? 'bg-muted' : 'bg-cyan',
                )}
                style={{ width: `${pct}%` }}
              />
            </div>
            <div className="text-[10px] text-muted mt-0.5">
              {t.state === 'paused'
                ? 'Paused'
                : `${formatBytes(t.sent)} of ${formatBytes(t.size)} · ${formatSpeed(t.speedBps)}`}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function DoneCard({ done }: { done: NonNullable<HudSnapshot['done']> }) {
  return (
    <div className="p-2.5 border-t border-edge">
      <div className="flex items-center gap-2.5">
        <span className="h-7 w-7 shrink-0 rounded-full grid place-items-center bg-gold/10 border border-gold/30 text-gold">
          <Check size={13} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs truncate" title={done.name}>
            {done.count > 1 ? `${done.count} files saved` : done.name}
          </div>
          <div className="text-[10px] text-muted">Finished</div>
        </div>
        <button
          onClick={() => send({ t: 'dismiss' })}
          title="Dismiss"
          className="h-5 w-5 grid place-items-center rounded hover:bg-raised text-muted hover:text-txt shrink-0"
        >
          <X size={11} />
        </button>
      </div>

      {done.path && (
        <div className="flex gap-1.5 mt-2">
          <Action
            tone="go"
            icon={<FolderOpen size={12} />}
            onClick={() => send({ t: 'reveal', path: done.path! })}
          >
            Open folder
          </Action>
        </div>
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- pieces */

/**
 * A button, written here rather than taken from `components/ui`.
 *
 * That one plays a sound on press and hooks the back gesture, neither of which
 * belongs in a window this size — and pulling it in would drag half the
 * application's chrome into a popup that renders four lines of text.
 */
function Action({
  children,
  icon,
  tone = 'plain',
  onClick,
}: {
  children: React.ReactNode;
  icon?: React.ReactNode;
  tone?: 'plain' | 'go' | 'stop';
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'flex-1 h-7 px-2 rounded-input border text-[11px] font-medium',
        'flex items-center justify-center gap-1 transition-colors',
        tone === 'go' && 'bg-gold/15 border-gold/40 text-gold hover:bg-gold/25',
        tone === 'stop' && 'bg-danger/15 border-danger/40 text-danger hover:bg-danger/25',
        tone === 'plain' && 'bg-raised border-edge text-dim hover:text-txt hover:border-edge-strong',
      )}
    >
      {icon}
      {children}
    </button>
  );
}
