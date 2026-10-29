import React from 'react';
import { Download, FolderOpen, Film, Info, LogOut, MessageSquare, Upload, X } from 'lucide-react';
import { Wordmark } from '../components/Logo';
import { Button } from '../components/ui';
import { Toasts } from '../components/Toasts';
import { IncomingFile } from '../components/IncomingFile';
import { Chats } from './Chats';
import { Theatre } from './Theatre';
import { api } from '../lib/bridge';
import { guestSnapshot, join, leave, watchGuest, type GuestSnapshot } from '../lib/guest';
import { pickFilesToSend } from '../lib/picker';
import { useStore } from '../lib/store';
import type { Screen } from '../lib/nav';
import { cn, formatBytes } from '../lib/utils';

/**
 * What somebody sees when they open a host's address in a browser and choose
 * "Use LANTern in this browser".
 *
 * Not the application's shell. A guest has three things - the library, a
 * conversation with the host, and a way to hand files over - and a sidebar with
 * seven screens, four of which could not work here, would only be a list of
 * things to tap and be disappointed by.
 */
export function GuestApp() {
  const g = React.useSyncExternalStore(watchGuest, guestSnapshot);
  if (g.phase !== 'allowed') return <Gate g={g} />;
  return <Shell g={g} />;
}

/* ------------------------------------------------------------------ gate */

function Gate({ g }: { g: GuestSnapshot }) {
  const [name, setName] = React.useState(g.name);
  const host = g.hostName || 'this machine';

  return (
    <div className="h-full w-full bg-base text-txt flex items-center justify-center p-6 overflow-auto">
      <div className="w-full max-w-sm">
        <Wordmark size="md" />

        {g.phase === 'checking' && (
          <p className="mt-6 text-sm text-muted" role="status">
            Looking for {host}…
          </p>
        )}

        {g.phase === 'need-name' && (
          <form
            className="mt-6"
            onSubmit={(e) => {
              e.preventDefault();
              void join(name);
            }}
          >
            <h1 className="text-xl font-semibold tracking-tight">Join {host} as a guest</h1>
            <p className="mt-2 text-sm text-muted leading-relaxed">
              Chat, watch what {host} is sharing, and send files — nothing to install. The host
              will be asked to let you in.
            </p>
            <label className="mt-5 block text-2xs uppercase tracking-wider text-dim" htmlFor="guest-name">
              Your name
            </label>
            <input
              id="guest-name"
              autoFocus
              value={name}
              maxLength={24}
              onChange={(e) => setName(e.target.value)}
              placeholder="Guest"
              className="mt-1.5 w-full h-11 px-3 rounded-input bg-surface border border-edge text-sm outline-none focus:border-gold/60"
            />
            <Button type="submit" variant="primary" size="lg" full className="mt-4">
              Ask to join
            </Button>
          </form>
        )}

        {g.phase === 'pending' && (
          <div className="mt-6" role="status">
            <h1 className="text-xl font-semibold tracking-tight">Waiting for {host}</h1>
            <p className="mt-2 text-sm text-muted leading-relaxed">
              Whoever is at {host} has been asked to let you in. This page carries on by itself
              once they do.
            </p>
            <div className="mt-5 h-1 rounded-full bg-raised overflow-hidden">
              <div className="h-full w-1/3 rounded-full bg-gold animate-[guest-wait_1.6s_ease-in-out_infinite]" />
            </div>
          </div>
        )}

        {g.phase === 'denied' && (
          <Notice
            title="Not this time"
            body={`${host} did not let this device in. If that is a mistake, ask them to allow it and try again.`}
            action={
              <Button variant="outline" onClick={() => location.reload()}>
                Try again
              </Button>
            }
          />
        )}

        {g.phase === 'removed' && (
          <Notice
            title="You have been signed out"
            body={`${host} ended this session. You can ask to join again.`}
            action={
              <Button variant="outline" onClick={() => location.reload()}>
                Ask again
              </Button>
            }
          />
        )}

        {g.phase === 'off' && (
          <Notice title="Guest mode is off" body={g.detail} action={<GetTheApp />} />
        )}

        {g.phase === 'unreachable' && (
          <Notice title="Cannot reach the host" body={g.detail} action={<GetTheApp />} />
        )}
      </div>
    </div>
  );
}

function Notice({
  title,
  body,
  action,
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mt-6" role="status">
      <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
      <p className="mt-2 text-sm text-muted leading-relaxed">{body}</p>
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

function GetTheApp() {
  return (
    <a
      href="../"
      className="inline-flex items-center h-9 px-4 rounded-input border border-edge text-sm text-txt hover:bg-raised"
    >
      Back to the start page
    </a>
  );
}

/* ----------------------------------------------------------------- shell */

const TABS: { id: Screen; label: string; icon: React.ElementType }[] = [
  { id: 'theatre', label: 'Theatre', icon: Film },
  { id: 'chats', label: 'Chat', icon: MessageSquare },
  { id: 'files', label: 'Files', icon: FolderOpen },
];

const NOTE_KEY = 'lantern.guest.note';

function Shell({ g }: { g: GuestSnapshot }) {
  const screen = useStore((s) => s.screen);
  const navigate = useStore((s) => s.navigate);
  const active: Screen = TABS.some((t) => t.id === screen) ? screen : 'theatre';

  const [note, setNote] = React.useState(() => {
    try {
      return localStorage.getItem(NOTE_KEY) !== '1';
    } catch {
      return true;
    }
  });
  const dismissNote = () => {
    setNote(false);
    try {
      localStorage.setItem(NOTE_KEY, '1');
    } catch {
      /* Shown again next visit; harmless. */
    }
  };

  // The store starts on Home, which a guest does not have.
  React.useEffect(() => {
    if (screen !== active) navigate(active);
  }, [screen, active, navigate]);

  // A guest has exactly one conversation, and no Home to start it from, so it
  // is opened for them: the room list would only ever hold the host.
  const ensureDm = useStore((s) => s.ensureDm);
  const openRoom = useStore((s) => s.openRoom);
  const activeRoomId = useStore((s) => s.activeRoomId);
  const playerActive = useStore((s) => s.playerActive);
  React.useEffect(() => {
    if (active === 'chats' && !activeRoomId && g.hostId) openRoom(ensureDm(g.hostId));
  }, [active, activeRoomId, g.hostId, ensureDm, openRoom]);

  return (
    <div
      className={cn(
        'h-full w-full flex flex-col bg-base text-txt overflow-hidden',
        active === 'theatre' && 'cinema',
      )}
    >
      <header className="safe-t shrink-0 bg-surface border-b border-edge">
        <div className="h-14 flex items-center gap-3 px-4">
          <Wordmark size="sm" />
          <span className="px-2 h-5 inline-flex items-center rounded-full bg-gold/15 text-gold text-2xs font-semibold tracking-wide">
            Guest
          </span>
          <span className="flex-1 min-w-0 truncate text-xs text-muted">
            {g.hostName ? `on ${g.hostName}` : ''}
          </span>
          <a
            href="../"
            className="hidden sm:inline text-xs text-dim hover:text-txt"
            title="Install LANTern for everything else"
          >
            Get the app
          </a>
          <button
            onClick={() => void leave().then(() => location.reload())}
            aria-label="Leave"
            title="Leave"
            className="h-9 w-9 grid place-items-center rounded-input text-dim hover:bg-raised hover:text-txt"
          >
            <LogOut size={16} />
          </button>
        </div>

        <nav className="flex px-2" aria-label="Guest sections">
          {TABS.map((t) => {
            const Icon = t.icon;
            const on = active === t.id;
            return (
              <button
                key={t.id}
                onClick={() => navigate(t.id)}
                aria-current={on ? 'page' : undefined}
                className={cn(
                  'flex-1 h-11 flex items-center justify-center gap-2 text-sm font-medium border-b-2 transition-colors',
                  on
                    ? 'border-gold text-gold'
                    : 'border-transparent text-dim hover:text-txt',
                )}
              >
                <Icon size={16} />
                {t.label}
              </button>
            );
          })}
        </nav>
      </header>

      {note && (
        <div className="shrink-0 flex items-start gap-2 px-4 py-2 bg-raised border-b border-edge text-2xs text-muted leading-relaxed">
          <Info size={13} className="mt-0.5 shrink-0 text-dim" />
          <p className="flex-1">
            Calls and screen sharing need the app: a browser will not open the microphone, camera
            or screen on a page that is not https, and a home network has no certificate to give
            it.
          </p>
          <button onClick={dismissNote} aria-label="Dismiss" className="text-dim hover:text-txt">
            <X size={13} />
          </button>
        </div>
      )}

      <main className="flex-1 min-h-0 relative">
        {/* Kept, unseen, while a film is loaded: unmounting it on the way to
            Chat is how a film kept playing with nothing on screen to stop it.
            The player pauses itself while it is away and resumes on return. */}
        {(active === 'theatre' || playerActive) && (
          <div
            className={cn(
              'absolute inset-0',
              active !== 'theatre' && 'invisible pointer-events-none',
            )}
          >
            <Theatre />
          </div>
        )}
        {active === 'chats' && (
          <div className="absolute inset-0">
            <Chats />
          </div>
        )}
        {active === 'files' && (
          <div className="absolute inset-0">
            <GuestFiles hostId={g.hostId} hostName={g.hostName} />
          </div>
        )}
      </main>

      <IncomingFile />
      <Toasts />
    </div>
  );
}

/* ----------------------------------------------------------------- files */

function GuestFiles({ hostId, hostName }: { hostId: string; hostName: string }) {
  const transfers = useStore((s) => s.transfers);
  const addTransfers = useStore((s) => s.addTransfers);
  const toast = useStore((s) => s.toast);
  const host = hostName || 'the host';

  const list = Object.values(transfers).sort((a, b) => b.startedAt - a.startedAt);

  const send = async () => {
    const picked = await pickFilesToSend();
    const paths = picked.flatMap((p) => (p.path ? [p.path] : []));
    if (!paths.length) return;
    try {
      addTransfers(await api.files.offer(hostId, paths));
    } catch (err) {
      toast({ kind: 'error', title: 'Could not send that', body: String(err) });
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="mx-auto max-w-xl p-4">
        <button
          onClick={() => void send()}
          className="w-full rounded-card border border-dashed border-edge hover:border-gold/50 hover:bg-raised transition-colors px-4 py-8 flex flex-col items-center gap-2 text-center"
        >
          <Upload size={22} className="text-gold" />
          <span className="text-sm font-medium">Send files to {host}</span>
          <span className="text-2xs text-muted">
            They are asked before anything is saved on their machine.
          </span>
        </button>

        <h2 className="mt-6 mb-2 text-2xs uppercase tracking-wider text-dim">Transfers</h2>
        {list.length === 0 ? (
          <p className="text-sm text-muted">
            Nothing yet. Files {host} sends you show up here to download.
          </p>
        ) : (
          <ul className="divide-y divide-edge rounded-card border border-edge bg-surface">
            {list.map((t) => (
              <li key={t.id} className="flex items-center gap-3 px-3 py-2.5">
                {t.direction === 'in' ? (
                  <Download size={15} className="shrink-0 text-dim" />
                ) : (
                  <Upload size={15} className="shrink-0 text-dim" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm truncate">{t.name}</p>
                  <p className="text-2xs text-muted tabular-nums">
                    {formatBytes(t.size)} · {describe(t)}
                  </p>
                  {t.state === 'active' && t.size > 0 && (
                    <div className="mt-1.5 h-1 rounded-full bg-raised overflow-hidden">
                      <div
                        className="h-full bg-gold"
                        style={{ width: `${Math.min(100, (t.sent / t.size) * 100)}%` }}
                      />
                    </div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function describe(t: { direction: string; state: string }): string {
  if (t.state === 'done') return t.direction === 'in' ? 'downloaded' : 'sent';
  if (t.state === 'failed') return 'did not go through';
  if (t.state === 'cancelled') return 'cancelled';
  if (t.state === 'active') return t.direction === 'in' ? 'downloading' : 'sending';
  return t.direction === 'in' ? 'waiting for you' : 'waiting for the host';
}
