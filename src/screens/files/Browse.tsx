/**
 * The phone's own files, and other computers' shared drives, the way VLC lists them.
 *
 * The phone's storage and any folders added here are listed at once. Shared drives
 * (Windows computers, NAS boxes) and media servers are looked for when this opens
 * and on refresh - never in the background. Opening one lists its folders; tapping
 * a video plays it in the ordinary player, remembering where it was left.
 *
 * Nothing is scanned or copied: a folder is read when it is opened.
 */
import React from 'react';
import {
  ChevronLeft,
  FileText,
  Folder,
  FolderPlus,
  HardDrive,
  Lock,
  Plus,
  RefreshCw,
  Server,
  Smartphone,
  Trash2,
  Video as VideoIcon,
} from 'lucide-react';

import { Button, Empty, IconButton, Input, Modal, SectionTitle } from '../../components/ui';
import {
  AuthRequiredError,
  browse,
  type BrowseEntry,
  type BrowseSource,
  type BrowseSources,
} from '../../lib/browse';
import { api } from '../../lib/bridge';
import { useStore } from '../../lib/store';
import type { MediaItem } from '../../lib/types';
import { cn, formatBytes } from '../../lib/utils';
import { Player } from '../theatre/Player';

interface Place {
  source: BrowseSource;
  /** Where in it: a path, or a media server's container id. */
  path: string;
  /** How it was reached, for the way back up. */
  trail: { name: string; path: string }[];
}

const titleOf = (name: string) =>
  name
    .replace(/\.[^.]+$/, '')
    .replace(/[._]+/g, ' ')
    .trim();

/** A language code from "Film.en.srt", else none. */
function languageOf(video: string, subtitle: string): string {
  const stem = subtitle.replace(/\.[^.]+$/, '');
  const base = video.replace(/\.[^.]+$/, '');
  const tail = stem.startsWith(base) ? stem.slice(base.length).replace(/^[._\- ]+/, '') : '';
  return /^[A-Za-z]{2,3}$/.test(tail) ? tail.toLowerCase() : '';
}

export function Browse() {
  const [sources, setSources] = React.useState<BrowseSources | null>(null);
  const [scanning, setScanning] = React.useState(false);
  const [place, setPlace] = React.useState<Place | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState<'folder' | 'server' | null>(null);

  const refresh = React.useCallback(async () => {
    setScanning(true);
    try {
      setSources(await browse.scan());
    } catch {
      /* what was shown stays */
    } finally {
      setScanning(false);
    }
  }, []);

  React.useEffect(() => {
    void browse.sources().then(setSources).catch(() => undefined);
    void refresh();
  }, [refresh]);

  if (place) {
    return <FolderView place={place} onPlace={setPlace} onBack={() => setPlace(null)} onSources={setSources} />;
  }

  const open = (source: BrowseSource) =>
    setPlace({ source, path: source.path ?? '', trail: [{ name: source.name, path: source.path ?? '' }] });

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto p-4 space-y-5">
        {error && <div className="text-xs text-danger">{error}</div>}

        <section>
          <SectionTitle
            right={
              <IconButton label="Add a folder from this phone" onClick={() => setAdding('folder')}>
                <FolderPlus size={16} />
              </IconButton>
            }
          >
            This phone
          </SectionTitle>
          {sources && !sources.allFiles && (
            <div className="mb-2 rounded-card border border-gold/30 bg-gold/10 px-3 py-2 text-xs text-gold/90 leading-relaxed">
              Android only shows this app its own files until it is allowed to see all of them, so folders look empty.{' '}
              <button className="underline font-medium" onClick={() => void api.storage.requestAllFiles()}>
                Allow
              </button>
            </div>
          )}
          <div className="rounded-card border border-edge divide-y divide-edge/70 overflow-hidden">
            {[...(sources?.phone ?? []), ...(sources?.folders ?? [])].map((s) => (
              <Row
                key={s.path}
                icon={s.pinned ? <Folder size={18} /> : <Smartphone size={18} />}
                title={s.name}
                hint={s.path}
                onClick={() => open(s)}
                right={
                  s.pinned ? (
                    <IconButton label={`Remove ${s.name}`} onClick={() => void browse.removeFolder(s.path!).then(setSources)}>
                      <Trash2 size={14} />
                    </IconButton>
                  ) : undefined
                }
              />
            ))}
          </div>
        </section>

        <section>
          <SectionTitle
            right={
              <span className="flex items-center gap-1">
                <IconButton label="Add a computer by name or address" onClick={() => setAdding('server')}>
                  <Plus size={16} />
                </IconButton>
                <IconButton label="Look for shared drives again" onClick={() => void refresh()}>
                  <RefreshCw size={15} className={cn(scanning && 'animate-spin')} />
                </IconButton>
              </span>
            }
          >
            On the network
          </SectionTitle>
          {sources && sources.network.length === 0 ? (
            <Empty
              icon={<Server size={22} />}
              title={scanning ? 'Looking...' : 'No shared drives found'}
              hint={
                scanning
                  ? 'Asking this network for computers sharing folders and media servers.'
                  : 'Computers that share a folder, NAS boxes and media servers appear here by themselves. Add one by name with +.'
              }
            />
          ) : (
            <div className="rounded-card border border-edge divide-y divide-edge/70 overflow-hidden">
              {sources?.network.map((s) => (
                <Row
                  key={s.id}
                  icon={s.kind === 'upnp' ? <VideoIcon size={18} /> : <HardDrive size={18} />}
                  title={s.name}
                  hint={s.kind === 'upnp' ? 'Media server' : (s.host ?? 'Shared drives')}
                  onClick={() => open(s)}
                  right={
                    <span className="flex items-center gap-1">
                      {s.saved && <Lock size={12} className="text-muted" aria-label="Login saved" />}
                      {s.added && (
                        <IconButton label={`Forget ${s.name}`} onClick={() => void browse.removeServer(s.host!).then(setSources)}>
                          <Trash2 size={14} />
                        </IconButton>
                      )}
                    </span>
                  }
                />
              ))}
            </div>
          )}
        </section>
      </div>

      {adding === 'folder' && (
        <FolderChooser
          start={sources?.phone[0]?.path ?? '/storage/emulated/0'}
          onClose={() => setAdding(null)}
          onPick={(path, name) => {
            setAdding(null);
            void browse.addFolder(path, name).then(setSources).catch((e) => setError(String(e.message ?? e)));
          }}
        />
      )}
      {adding === 'server' && (
        <AddServer
          onClose={() => setAdding(null)}
          onAdd={(host, name) => {
            setAdding(null);
            void browse.addServer(host, name).then(setSources).catch((e) => setError(String(e.message ?? e)));
          }}
        />
      )}
    </div>
  );
}

function Row({
  icon,
  title,
  hint,
  onClick,
  right,
}: {
  icon: React.ReactNode;
  title: string;
  hint?: string;
  onClick?: () => void;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-3 min-h-[56px] bg-surface">
      <button onClick={onClick} className="flex-1 min-w-0 flex items-center gap-3 text-left py-2">
        <span className="text-gold shrink-0">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium truncate">{title}</span>
          {hint && <span className="block text-2xs text-muted truncate">{hint}</span>}
        </span>
      </button>
      {right}
    </div>
  );
}

/* ------------------------------------------------------------------ a folder */

function FolderView({
  place,
  onPlace,
  onBack,
  onSources,
}: {
  place: Place;
  onPlace: (p: Place | null) => void;
  onBack: () => void;
  onSources: (s: BrowseSources) => void;
}) {
  const [entries, setEntries] = React.useState<BrowseEntry[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [login, setLogin] = React.useState(false);
  const [playing, setPlaying] = React.useState<MediaItem | null>(null);
  const [neighbours, setNeighbours] = React.useState<{ previous: MediaItem | null; next: MediaItem | null }>({
    previous: null,
    next: null,
  });
  const ownerName = place.source.name;

  const load = React.useCallback(async () => {
    setEntries(null);
    setError(null);
    try {
      setEntries(await browse.list(place.source.id, place.path));
    } catch (e) {
      if (e instanceof AuthRequiredError) setLogin(true);
      else setError(String((e as Error).message ?? e));
    }
  }, [place.source.id, place.path]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const videos = React.useMemo(() => (entries ?? []).filter((e) => e.video), [entries]);

  /** A playable item for one entry: its address, and any subtitles beside it. */
  const itemFor = React.useCallback(
    async (entry: BrowseEntry): Promise<MediaItem> => {
      const id = place.source.id;
      const url = entry.url ?? (await browse.open(id, entry.path));
      const subtitles = await Promise.all(
        (entries ?? [])
          .filter((e) => e.subtitle && e.name.replace(/\.[^.]+$/, '').startsWith(entry.name.replace(/\.[^.]+$/, '')))
          .slice(0, 6)
          .map(async (s) => ({
            label: languageOf(entry.name, s.name) || 'Subtitles',
            lang: languageOf(entry.name, s.name),
            url: await browse.open(id, s.path, true),
          })),
      );
      return {
        id: `browse:${id}:${entry.path}`,
        title: titleOf(entry.name),
        shareId: 'browse',
        relPath: entry.path,
        durationSec: 0,
        sizeBytes: entry.size,
        kind: 'clip',
        genres: [],
        addedAt: Date.now(),
        progressSec: 0,
        streamUrl: url,
        subtitles,
      } as MediaItem;
    },
    [entries, place.source.id],
  );

  const play = async (entry: BrowseEntry) => {
    try {
      const item = await itemFor(entry);
      setPlaying(item);
      const at = videos.findIndex((v) => v.path === entry.path);
      // The video before and after, resolved while this one plays, so the player has
      // an address to hand over when it is asked for either.
      const [previous, next] = await Promise.all(
        [videos[at - 1], videos[at + 1]].map((v) => (v ? itemFor(v).catch(() => null) : Promise.resolve(null))),
      );
      setNeighbours({ previous, next });
    } catch (e) {
      if (e instanceof AuthRequiredError) setLogin(true);
      else useStore.getState().toast({ kind: 'error', title: 'Could not open that video', body: String((e as Error).message ?? e) });
    }
  };

  const up = () => {
    if (place.trail.length <= 1) return onBack();
    const trail = place.trail.slice(0, -1);
    onPlace({ ...place, path: trail[trail.length - 1].path, trail });
  };

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-1 px-2 py-2 border-b border-edge">
        <IconButton label="Back" onClick={up}>
          <ChevronLeft size={18} />
        </IconButton>
        <div className="min-w-0 flex-1 text-xs text-muted truncate">
          {place.trail.map((t) => t.name).join(' / ')}
        </div>
        <IconButton label="Reload this folder" onClick={() => void load()}>
          <RefreshCw size={15} />
        </IconButton>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {error && <div className="p-4 text-xs text-danger">{error}</div>}
        {!entries && !error && <div className="p-4 text-xs text-muted">Reading...</div>}
        {entries && entries.length === 0 && <Empty title="Nothing here" hint="This folder is empty, or its contents are not visible to this app." />}
        <div className="divide-y divide-edge/60">
          {entries?.map((e) => (
            <button
              key={e.path}
              disabled={!e.dir && !e.video}
              onClick={() =>
                e.dir
                  ? onPlace({ ...place, path: e.path, trail: [...place.trail, { name: e.name, path: e.path }] })
                  : void play(e)
              }
              className={cn('w-full flex items-center gap-3 px-4 min-h-[52px] text-left bg-surface', !e.dir && !e.video && 'opacity-45')}
            >
              <span className={cn('shrink-0', e.video ? 'text-gold' : 'text-muted')}>
                {e.dir ? <Folder size={18} /> : e.video ? <VideoIcon size={18} /> : <FileText size={18} />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm truncate">{e.name}</span>
                {!e.dir && e.size > 0 && <span className="block text-2xs text-muted">{formatBytes(e.size)}</span>}
              </span>
            </button>
          ))}
        </div>
      </div>

      {login && (
        <Login
          host={place.source.host ?? place.source.name}
          onClose={() => setLogin(false)}
          onDone={() => {
            setLogin(false);
            void browse.sources().then(onSources);
            void load();
          }}
        />
      )}

      {playing && (
        <div className="cinema fixed inset-0 z-50 bg-base">
          <Player
            item={playing}
            upNext={neighbours.next}
            previous={neighbours.previous}
            ownerName={ownerName}
            onClose={() => {
              setPlaying(null);
              setNeighbours({ previous: null, next: null });
            }}
            onPlayNext={(next) => {
              const index = videos.findIndex((v) => next.id.endsWith(`:${v.path}`));
              setPlaying(next);
              void Promise.all(
                [videos[index - 1], videos[index + 1]].map((v) => (v ? itemFor(v).catch(() => null) : Promise.resolve(null))),
              ).then(([previous, nextOne]) => setNeighbours({ previous, next: nextOne }));
            }}
          />
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- dialogs */

function Login({ host, onClose, onDone }: { host: string; onClose: () => void; onDone: () => void }) {
  const [user, setUser] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [remember, setRemember] = React.useState(true);
  return (
    <Modal
      open
      onClose={onClose}
      title={`Sign in to ${host}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="accent"
            disabled={!user}
            onClick={() => void browse.login(host, user, password, remember).then(onDone)}
          >
            Sign in
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-muted leading-relaxed">
          This computer asks who you are. Use the name and password you sign in to it with.
        </p>
        <Input placeholder="User name" value={user} onChange={(e) => setUser(e.target.value)} autoCapitalize="none" autoCorrect="off" />
        <Input placeholder="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <label className="flex items-center gap-2 text-xs text-muted">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember it on this phone
        </label>
      </div>
    </Modal>
  );
}

function AddServer({ onClose, onAdd }: { onClose: () => void; onAdd: (host: string, name: string) => void }) {
  const [host, setHost] = React.useState('');
  return (
    <Modal
      open
      onClose={onClose}
      title="Add a computer"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="accent" disabled={!host.trim()} onClick={() => onAdd(host.trim(), '')}>
            Add
          </Button>
        </>
      }
    >
      <p className="text-xs text-muted leading-relaxed mb-3">
        Its name or address on this network, like <span className="font-mono">192.168.1.20</span> or{' '}
        <span className="font-mono">NAS</span>. It is listed even when it is switched off.
      </p>
      <Input placeholder="Name or address" value={host} onChange={(e) => setHost(e.target.value)} autoCapitalize="none" autoCorrect="off" />
    </Modal>
  );
}

/** Picks a folder on this phone, by walking down to it. */
function FolderChooser({
  start,
  onClose,
  onPick,
}: {
  start: string;
  onClose: () => void;
  onPick: (path: string, name: string) => void;
}) {
  const [path, setPath] = React.useState(start);
  const [dirs, setDirs] = React.useState<BrowseEntry[] | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    setDirs(null);
    setFailed(false);
    browse
      .list('local', path)
      .then((all) => setDirs(all.filter((e) => e.dir)))
      .catch(() => setFailed(true));
  }, [path]);

  const parent = path.replace(/\/[^/]+$/, '');
  const top = path === start || parent.length < 'storage'.length;
  const name = path.split('/').filter(Boolean).pop() ?? 'Folder';

  return (
    <Modal
      open
      onClose={onClose}
      title="Add a folder"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="accent" onClick={() => onPick(path, name)}>
            Use this folder
          </Button>
        </>
      }
    >
      <div className="text-2xs text-muted truncate mb-2">{path}</div>
      <div className="max-h-[50vh] overflow-y-auto rounded-card border border-edge divide-y divide-edge/60">
        {!top && (
          <button className="w-full flex items-center gap-2 px-3 min-h-[44px] text-left text-sm" onClick={() => setPath(parent)}>
            <ChevronLeft size={16} /> Up
          </button>
        )}
        {failed && <div className="p-3 text-xs text-danger">Cannot read this folder. Is All files access allowed?</div>}
        {!dirs && !failed && <div className="p-3 text-xs text-muted">Reading...</div>}
        {dirs?.length === 0 && <div className="p-3 text-xs text-muted">No folders in here.</div>}
        {dirs?.map((d) => (
          <button key={d.path} className="w-full flex items-center gap-2 px-3 min-h-[44px] text-left text-sm" onClick={() => setPath(d.path)}>
            <Folder size={16} className="text-gold" /> <span className="truncate">{d.name}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
