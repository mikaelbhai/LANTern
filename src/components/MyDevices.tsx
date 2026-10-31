/**
 * Devices that are this person's own: a phone, a second PC.
 *
 * Not the same list as "trusted", and deliberately kept apart. Trust is
 * somebody vouched for and only ever unlocks auto-accepted transfers and the
 * Theatre rating bypass. A companion is linked by pairing with both ends
 * saying "this one is mine", and is what opens a device's whole storage and
 * lets it be driven without a prompt each time.
 */
import React from 'react';
import {
  ArrowUp,
  Download,
  File as FileIcon,
  Folder,
  HardDrive,
  KeyRound,
  Link2Off,
  RefreshCw,
  Monitor,
  Smartphone,
} from 'lucide-react';

import { api, on } from '../lib/bridge';
import { useStore } from '../lib/store';
import { cn, formatBytes, relativeTime, uid } from '../lib/utils';
import { Badge, Button, IconButton, Modal, SectionTitle, Spinner } from './ui';
import { RemoteControl } from './RemoteControl';
import { PairEnterModal, PairShowModal } from './Audience';

interface Companion {
  deviceId: string;
  name: string;
  companionAt: number;
}

/** One row of a remote folder, as `companion::Entry` writes it. */
interface RemoteEntry {
  name: string;
  path: string;
  isDir: boolean;
  size: number;
  modified: number;
}

export function MyDevices() {
  const peers = useStore((s) => s.peers);
  const toast = useStore((s) => s.toast);
  const [list, setList] = React.useState<Companion[]>([]);
  const [browsing, setBrowsing] = React.useState<{ peerId: string; name: string } | null>(null);
  const [controlling, setControlling] = React.useState<string | null>(null);
  // Pairing, from here: this card is only ever about your own devices, so the
  // switch that says so starts on.
  const [showFor, setShowFor] = React.useState<{ deviceId: string; name: string } | null>(null);
  const [entering, setEntering] = React.useState(false);

  // What has been shared of what you have watched, and when.
  type History = { devices: { deviceId: string; syncedAt: number; rows: number; linked: boolean }[]; held: number };
  const [history, setHistory] = React.useState<History | null>(null);
  const [syncing, setSyncing] = React.useState(false);
  const loadHistory = React.useCallback(() => {
    void api.media
      .historyStatus()
      // A build without the command, or the simulator, answers with nothing.
      .then((h) => setHistory(h && Array.isArray(h.devices) ? h : null))
      .catch(() => setHistory(null));
  }, []);
  React.useEffect(loadHistory, [loadHistory, peers]);
  React.useEffect(() => on('history:changed', () => loadHistory()), [loadHistory]);
  const syncNow = async () => {
    setSyncing(true);
    try {
      const taken = await api.media.historySyncNow();
      toast({
        kind: 'success',
        title: taken ? `${taken} place${taken === 1 ? '' : 's'} brought in` : 'Already up to date',
        body: taken ? 'Continue watching now reflects what you watched on your other devices.' : 'Your other devices have nothing newer.',
      });
    } catch (err) {
      toast({ kind: 'error', title: 'Could not sync', body: String(err) });
    } finally {
      setSyncing(false);
      loadHistory();
    }
  };
  // Whether THIS device lets itself be seen in full. It is this device's
  // storage that others would browse, so it is this device that has to be
  // allowed to read it all - only ever false on Android, which hides files.
  const [allFiles, setAllFiles] = React.useState(true);
  const checkAllFiles = React.useCallback(() => {
    void api.storage
      .allFiles()
      // The simulator has no such command and answers with nothing at all.
      .then((ok) => setAllFiles(ok !== false))
      .catch(() => setAllFiles(true));
  }, []);
  React.useEffect(checkAllFiles, [checkAllFiles]);
  // Coming back from the Settings page the permission lives on.
  React.useEffect(() => {
    window.addEventListener('focus', checkAllFiles);
    return () => window.removeEventListener('focus', checkAllFiles);
  }, [checkAllFiles]);

  const load = React.useCallback(() => {
    void api.peers
      .companions()
      // The simulator has no such table and answers with nothing at all.
      .then((rows) => setList(Array.isArray(rows) ? rows : []))
      .catch(() => setList([]));
  }, []);

  // Refreshed when anybody joins or leaves (a name can change), and when a
  // pairing finishes - which is the moment a new one appears.
  React.useEffect(load, [load, peers]);
  React.useEffect(() => {
    const offs = [on('pair:accepted', () => setTimeout(load, 300)), on('pair:result', () => setTimeout(load, 300))];
    return () => offs.forEach((off) => off());
  }, [load]);

  const live = (deviceId: string) => Object.values(peers).find((p) => p.deviceId === deviceId);

  const unlink = async (device: Companion) => {
    await api.peers.setCompanion(device.deviceId, false);
    toast({
      kind: 'info',
      title: `${device.name || 'That device'} is no longer one of yours`,
      body: 'It can no longer browse this device or control it without asking.',
    });
    load();
  };

  return (
    <section className="panel p-4">
      <SectionTitle>My devices</SectionTitle>
      <p className="text-xs text-dim leading-relaxed mb-3">
        Your own phone or second PC, linked by pairing. They can browse each other's whole storage
        and be used as a screen and controller without asking every time.
      </p>

      <div className="mb-3">
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="outline" icon={<KeyRound size={13} />} onClick={() => setEntering(true)}>
            Enter a code from another device
          </Button>
          {Object.values(peers)
            .filter((p) => !list.some((c) => c.deviceId === p.deviceId))
            .map((p) => (
              <Button
                key={p.deviceId}
                size="sm"
                variant="ghost"
                onClick={() => setShowFor({ deviceId: p.deviceId, name: p.name })}
              >
                Show a code for {p.name || 'a device'}
              </Button>
            ))}
        </div>
        <p className="text-2xs text-muted leading-relaxed mt-1.5">
          Show a code on one screen and enter it on the other. Both screens need "This is one of my own
          devices" switched on - it starts on here.
        </p>
      </div>

      {list.length > 0 && !allFiles && (
        <div className="mb-3 rounded-card border border-gold/40 bg-gold/[0.06] p-3">
          <p className="text-xs text-dim leading-relaxed mb-2">
            Your other devices can only see part of this phone's storage until you allow access to
            all files. Android hides documents, PDFs and other apps' downloads from any app that
            has not been given it.
          </p>
          <Button size="sm" variant="primary" onClick={() => void api.storage.requestAllFiles()}>
            Allow access to all files
          </Button>
        </div>
      )}

      {list.length === 0 ? (
        <p className="text-2xs text-muted leading-relaxed">
          Nothing linked yet. Use the buttons above: show a code on one device and enter it on the
          other.
        </p>
      ) : (
        <>
        <div className="flex items-center justify-between gap-2 mb-1">
          <span className="text-2xs text-muted">
            What you watch follows you between these.
            {history && history.held > 0 ? ` ${history.held} title${history.held === 1 ? '' : 's'} from them.` : ''}
          </span>
          <Button size="xs" variant="ghost" icon={<RefreshCw size={11} className={syncing ? 'animate-spin' : undefined} />} disabled={syncing} onClick={() => void syncNow()}>
            Sync history now
          </Button>
        </div>
        <ul className="divide-y divide-edge/70">
          {list.map((device) => {
            const peer = live(device.deviceId);
            const here = !!peer && peer.status !== 'offline';
            const Icon = peer?.os === 'android' ? Smartphone : Monitor;
            return (
              <li key={device.deviceId} className="flex items-center gap-3 py-2.5">
                <span className={cn('shrink-0', here ? 'text-gold' : 'text-muted')}>
                  <Icon size={18} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm truncate">{peer?.name || device.name || 'A device'}</div>
                  <div className="text-2xs text-muted">
                    {here ? 'Here now' : 'Not here right now'} · linked {relativeTime(device.companionAt)}
                  </div>
                  {(() => {
                    const h = history?.devices.find((d) => d.deviceId === device.deviceId);
                    if (!history) return null;
                    return (
                      <div className="text-2xs text-muted">
                        {h && h.syncedAt > 0
                          ? `Watch history synced ${relativeTime(h.syncedAt)}`
                          : 'Watch history not synced yet'}
                      </div>
                    );
                  })()}
                </div>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<HardDrive size={12} />}
                  disabled={!here}
                  onClick={() => peer && setBrowsing({ peerId: peer.id, name: peer.name })}
                >
                  Storage
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Monitor size={12} />}
                  disabled={!here}
                  onClick={() => peer && setControlling(peer.id)}
                >
                  Control
                </Button>
                <IconButton label={`Unlink ${device.name || 'this device'}`} onClick={() => void unlink(device)}>
                  <Link2Off size={14} />
                </IconButton>
              </li>
            );
          })}
        </ul>
        </>
      )}

      {browsing && (
        <StorageBrowser
          peerId={browsing.peerId}
          name={browsing.name}
          onClose={() => setBrowsing(null)}
        />
      )}

      {/* Over everything, as in Calls: somebody using a pad is not looking at
          the rest of this screen. */}
      {controlling && (
        <div className="fixed inset-0 z-[150] bg-base">
          <RemoteControl peerId={controlling} onClose={() => setControlling(null)} />
        </div>
      )}
      {showFor && (
        <PairShowModal
          defaultOwn
          device={showFor}
          onClose={() => setShowFor(null)}
          onPaired={() => {
            setShowFor(null);
            load();
          }}
        />
      )}
      {entering && (
        <PairEnterModal
          defaultOwn
          onClose={() => setEntering(false)}
          onPaired={() => {
            setEntering(false);
            load();
          }}
        />
      )}
    </section>
  );
}

/* ------------------------------------------------------------ the browser */

/** The far end answers nothing to a device it has not linked, so silence is the failure signal. */
const BROWSE_TIMEOUT_MS = 8000;

function StorageBrowser({
  peerId,
  name,
  onClose,
}: {
  peerId: string;
  name: string;
  onClose: () => void;
}) {
  const toast = useStore((s) => s.toast);
  // null is the starting points - drives on Windows, the root elsewhere.
  const [path, setPath] = React.useState<string | null>(null);
  const [entries, setEntries] = React.useState<RemoteEntry[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const request = React.useRef('');

  React.useEffect(() => {
    const id = uid();
    request.current = id;
    setLoading(true);
    setError(null);

    const off = on('companion:browsed', (p: { requestId?: string; entries?: RemoteEntry[]; error?: string | null }) => {
      if (p.requestId !== request.current) return;
      clearTimeout(timer);
      setEntries(Array.isArray(p.entries) ? p.entries : []);
      setError(p.error ?? null);
      setLoading(false);
    });
    const timer = setTimeout(() => {
      if (request.current !== id) return;
      setError('No answer. The device may be asleep, or may no longer have this one linked.');
      setLoading(false);
    }, BROWSE_TIMEOUT_MS);

    void api.companion.browse(peerId, path, id).catch(() => {});
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [peerId, path]);

  // The parent of a path, written the way that path is: a drive root has none
  // but the list of drives, so this has to understand both separators.
  const parent = (p: string): string | null => {
    const trimmed = p.replace(/[\\/]+$/, '');
    const cut = Math.max(trimmed.lastIndexOf('\\'), trimmed.lastIndexOf('/'));
    if (cut <= 0 || /^[A-Za-z]:$/.test(trimmed)) return null;
    const up = trimmed.slice(0, cut);
    return /^[A-Za-z]:$/.test(up) ? `${up}\\` : up;
  };

  // The far end says so when it cannot read what was asked for; without this
  // the toast below promised a file that then never arrived.
  React.useEffect(
    () =>
      on('companion:fetched', (p: { error?: string | null; path?: string }) => {
        if (!p.error) return;
        toast({
          kind: 'error',
          title: `${name} could not send ${p.path?.split(/[\\/]/).pop() ?? 'that file'}`,
          body: p.error,
        });
      }),
    [name, toast],
  );

  const open = (entry: RemoteEntry) => {
    if (entry.isDir) {
      setPath(entry.path);
      return;
    }
    void api.companion.fetch(peerId, entry.path);
    toast({
      kind: 'info',
      title: `Asked ${name} to send ${entry.name}`,
      body: 'It arrives as an incoming transfer.',
    });
  };

  return (
    <Modal open onClose={onClose} title={`${name} · storage`} width="max-w-lg">
      <div className="flex items-center gap-2 mb-2">
        <IconButton label="Up one folder" disabled={path === null} onClick={() => setPath(path ? parent(path) : null)}>
          <ArrowUp size={14} />
        </IconButton>
        <div className="text-2xs text-muted truncate flex-1">{path ?? 'Drives'}</div>
      </div>

      {loading ? (
        <div className="py-10 grid place-items-center">
          <Spinner size={18} />
        </div>
      ) : error ? (
        <p className="text-xs text-danger py-6 text-center">{error}</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-muted py-6 text-center">Nothing in here.</p>
      ) : (
        <ul className="max-h-[55vh] overflow-y-auto divide-y divide-edge/60">
          {entries.map((entry) => (
            <li key={entry.path}>
              <button
                onClick={() => open(entry)}
                className="w-full flex items-center gap-2.5 px-1 py-2 text-left hover:bg-raised/60 rounded-input"
              >
                <span className={entry.isDir ? 'text-gold' : 'text-dim'}>
                  {entry.isDir ? <Folder size={15} /> : <FileIcon size={15} />}
                </span>
                <span className="flex-1 min-w-0 text-xs truncate">{entry.name}</span>
                {!entry.isDir && (
                  <>
                    <span className="text-2xs text-muted tabular-nums">{formatBytes(entry.size)}</span>
                    <Download size={13} className="text-muted" />
                  </>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex justify-end">
        <Badge tone="muted">Tap a file to have it sent here</Badge>
      </div>
    </Modal>
  );
}
