import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  AppWindow,
  Check,
  Copy,
  ExternalLink,
  Eye,
  Clapperboard,
  FolderTree,
  Globe,
  KeyRound,
  Pause,
  Play,
  Plus,
  QrCode as QrIcon,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import { QrCode } from '../../components/QrCode';
import {
  Badge,
  Button,
  Empty,
  IconButton,
  Input,
  Modal,
  SectionTitle,
  Toggle,
  Tooltip,
} from '../../components/ui';
import { api } from '../../lib/bridge';
import { canHost, hostBlocker, pickFolder } from '../../lib/picker';
import { useStore } from '../../lib/store';
import { cn, formatBytes, relativeTime } from '../../lib/utils';
import { useNow } from '../../lib/hooks';
import type { Share, ShareMode, StagedEntry } from '../../lib/types';
import { copyText } from '../../lib/clipboard';
import { NetworkPrivacy } from '../../components/NetworkPrivacy';

const MODES: {
  id: ShareMode;
  label: string;
  icon: React.ElementType;
  blurb: string;
  hint: string;
}[] = [
  {
    id: 'files',
    label: 'File browser',
    icon: FolderTree,
    blurb: 'A browsable index of the folder',
    hint: 'Visitors see a list they can click through and download from. Best for handing someone a directory.',
  },
  {
    id: 'site',
    label: 'Static site',
    icon: Globe,
    blurb: 'Serve index.html and its assets',
    hint: 'The folder root becomes the home page. Paths map straight onto files — a built site, docs, or a report.',
  },
  {
    id: 'app',
    label: 'Single-page app',
    icon: AppWindow,
    blurb: 'Static site with route fallback',
    hint: 'Same as a static site, but unknown paths return index.html so a client-side router handles them.',
  },
  {
    id: 'media',
    label: 'Video library',
    icon: Clapperboard,
    blurb: 'Streams with seeking, shows in Theatre',
    hint: 'Videos are streamed with range requests so viewers can skip around, and the folder appears in every peer\u2019s Theatre.',
  },
];

/**
 * Keeping the folders served after the window closes.
 *
 * Closing LANTern — or rebuilding it — used to take the file server down with
 * it: anyone mid-download lost the transfer, and a library that was there a
 * moment ago vanished from everyone else's Theatre. A separate, tiny process
 * can hold the port instead. It serves files and nothing else; calls and chat
 * need somebody in front of them.
 */
function KeepHosting() {
  const [on, setOn] = React.useState(false);
  const [supported, setSupported] = React.useState(true);

  React.useEffect(() => {
    void api.service
      .get()
      .then(setOn)
      .catch(() => setSupported(false));
  }, []);

  if (!supported) return null;

  return (
    <div className="rounded-card border border-edge bg-surface px-3 py-2.5 mb-3 flex items-start gap-3">
      <div className="min-w-0 flex-1">
        <p className="text-xs font-medium">Keep serving when LANTern is closed</p>
        <p className="text-2xs text-muted leading-relaxed mt-0.5">
          A small background process holds the published folders open, so downloads survive
          the app closing and your library stays visible to everyone else. It serves files
          only — no calls, no messages — and stops the moment you open LANTern again.
        </p>
      </div>
      <Toggle
        checked={on}
        onChange={(v) => {
          setOn(v);
          void api.service.set(v);
        }}
      />
    </div>
  );
}

export function Hosting() {
  const shares = useStore((s) => s.shares);
  const setShares = useStore((s) => s.setShares);
  const net = useStore((s) => s.net);
  const [createOpen, setCreateOpen] = React.useState(false);
  const [qrShare, setQrShare] = React.useState<Share | null>(null);

  React.useEffect(() => {
    void api.host.list().then(setShares);
  }, [setShares]);

  const baseUrl = net ? `http://${net.ip}:${net.hostPort}` : '';
  const running = shares.filter((s) => s.running);

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 px-4 py-3 border-b border-edge flex items-center gap-2 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Published folders</span>
            {running.length > 0 && (
              <Badge tone="cyan">
                {running.length} live
              </Badge>
            )}
          </div>
          <p className="text-2xs text-muted mt-0.5">
            LANTern serves these over plain HTTP on your LAN — any browser on the network can
            open them, no app required.
          </p>
        </div>
        <Button
          size="sm"
          variant="primary"
          icon={<Plus size={13} />}
          onClick={() => setCreateOpen(true)}
        >
          Publish a folder
        </Button>
      </div>

      <div className="flex-1 scroll-y p-4">
        {/* Publishing is exactly where "nobody can reach my files" matters. */}
        <NetworkPrivacy />
        <KeepHosting />

        {shares.length === 0 ? (
          <Empty
            icon={<Globe size={20} />}
            title="Nothing published yet"
            hint="Point LANTern at a folder and it becomes a URL on your network — a file browser, a static site, or a single-page app."
            action={
              <Button variant="primary" onClick={() => setCreateOpen(true)}>
                Publish a folder
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
            {shares.map((s) => (
              <ShareCard
                key={s.id}
                share={s}
                baseUrl={baseUrl}
                onQr={() => setQrShare(s)}
              />
            ))}
          </div>
        )}
      </div>

      <CreateShareModal open={createOpen} onClose={() => setCreateOpen(false)} />

      <Modal
        open={!!qrShare}
        onClose={() => setQrShare(null)}
        title={qrShare ? `Open ${qrShare.name}` : ''}
      >
        {qrShare && (
          <div className="space-y-3">
            <p className="text-xs text-dim">
              Point a phone camera at this. It opens in any browser on the network — the other
              device does not need LANTern installed.
            </p>
            <div className="flex justify-center">
              <div className="p-2.5 bg-[#E6EAF3] rounded-card">
                <QrCode value={`${baseUrl}/${qrShare.slug}`} size={168} />
              </div>
            </div>
            <div className="text-center text-xs font-mono text-gold break-all">
              {baseUrl}/{qrShare.slug}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

/* ---------------------------------------------------------- Share card */

function ShareCard({
  share,
  baseUrl,
  onQr,
}: {
  share: Share;
  baseUrl: string;
  onQr: () => void;
}) {
  const setShares = useStore((s) => s.setShares);
  const toast = useStore((s) => s.toast);
  const now = useNow(10_000);
  const [copied, setCopied] = React.useState(false);
  const [confirmRemove, setConfirmRemove] = React.useState(false);

  const url = `${baseUrl}/${share.slug}`;
  const mode = MODES.find((m) => m.id === share.mode)!;
  const ModeIcon = mode.icon;

  const refresh = async () => setShares(await api.host.list());

  const copy = async () => {
    try {
      await copyText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        'panel p-3 flex flex-col transition-colors',
        share.running ? 'border-cyan/30' : 'border-edge',
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            'h-9 w-9 rounded-card grid place-items-center border shrink-0',
            share.running
              ? 'bg-cyan/10 border-cyan/40 text-cyan'
              : 'bg-raised border-edge text-muted',
          )}
        >
          <ModeIcon size={16} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium truncate">{share.name}</span>
            {share.running ? (
              <Badge tone="cyan">
                <span className="h-1.5 w-1.5 rounded-full bg-cyan animate-pulse" />
                Live
              </Badge>
            ) : (
              <Badge tone="muted">Stopped</Badge>
            )}
          </div>
          <button
            className="text-2xs text-muted truncate mt-0.5 block max-w-full text-left hover:text-gold"
            title={`Open ${share.path}`}
            onClick={() => void api.files.open(share.path)}
          >
            {share.path}
          </button>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <Badge tone="neutral">{mode.label}</Badge>
            <span className="text-2xs text-muted">
              {share.fileCount} files · {formatBytes(share.totalBytes)}
            </span>
          </div>
        </div>
      </div>

      {/* address */}
      <div className="flex items-center gap-1 mt-3 bg-base border border-edge rounded-input px-2.5 h-8">
        <span
          className={cn(
            'text-2xs font-mono flex-1 truncate',
            share.running ? 'text-gold' : 'text-muted line-through',
          )}
        >
          {url}
        </span>
        <IconButton label="Copy address" size="xs" onClick={() => void copy()}>
          {copied ? <Check size={11} className="text-cyan" /> : <Copy size={11} />}
        </IconButton>
        <IconButton label="Show QR code" size="xs" onClick={onQr}>
          <QrIcon size={11} />
        </IconButton>
        <IconButton
          label="Open in browser"
          size="xs"
          onClick={() => void api.host.openInBrowser(url)}
        >
          <ExternalLink size={11} />
        </IconButton>
      </div>

      {/* live stats */}
      <div className="grid grid-cols-3 gap-2 mt-2.5">
        <Stat
          icon={<Users size={10} />}
          label="Viewing"
          value={String(share.activeViewers)}
          tone={share.activeViewers > 0 ? 'text-cyan' : 'text-dim'}
        />
        <Stat
          icon={<Eye size={10} />}
          label="Requests"
          value={share.requests.toLocaleString()}
          tone="text-dim"
        />
        <Stat
          icon={<Upload size={10} />}
          label="Served"
          value={formatBytes(share.bytesServed)}
          tone="text-dim"
        />
      </div>

      {share.requirePhrase && share.phrase && (
        <div className="mt-2.5 flex items-center gap-2 rounded-input bg-gold/[0.07] border border-gold/30 px-2.5 h-8">
          <KeyRound size={11} className="text-gold shrink-0" />
          <span className="text-2xs text-muted shrink-0">Phrase</span>
          <span className="text-2xs font-mono text-gold truncate">{share.phrase}</span>
        </div>
      )}

      <div className="flex items-center gap-1.5 mt-3 pt-2.5 border-t border-edge">
        <Button
          size="xs"
          variant={share.running ? 'outline' : 'primary'}
          icon={share.running ? <Pause size={11} /> : <Play size={11} />}
          onClick={async () => {
            await api.host.setRunning(share.id, !share.running);
            void refresh();
          }}
        >
          {share.running ? 'Stop' : 'Start'}
        </Button>

        <Tooltip content="Let visitors add files to this folder">
          <span>
            <Button
              size="xs"
              active={share.allowUpload}
              icon={<Upload size={11} />}
              onClick={async () => {
                await api.host.update(share.id, { allowUpload: !share.allowUpload });
                void refresh();
              }}
            >
              Uploads
            </Button>
          </span>
        </Tooltip>

        <span className="ml-auto text-2xs text-muted">
          {share.lastRequestAt ? relativeTime(share.lastRequestAt, now) : 'no visits'}
        </span>

        <IconButton
          label="Unpublish"
          size="xs"
          className="text-danger"
          onClick={() => setConfirmRemove(true)}
        >
          <Trash2 size={11} />
        </IconButton>
      </div>

      <Modal
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title={`Unpublish ${share.name}?`}
        footer={
          <>
            <Button onClick={() => setConfirmRemove(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={async () => {
                await api.host.remove(share.id);
                setConfirmRemove(false);
                toast({ kind: 'info', title: `${share.name} is no longer published` });
                void refresh();
              }}
            >
              Unpublish
            </Button>
          </>
        }
      >
        <p className="text-xs text-dim">
          The address stops responding. Nothing on disk is touched — only the folder's
          publication is removed.
        </p>
      </Modal>
    </motion.div>
  );
}

function Stat({
  icon,
  label,
  value,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone: string;
}) {
  return (
    <div className="bg-raised/60 border border-edge rounded-input px-2 py-1.5">
      <div className="flex items-center gap-1 text-[10px] uppercase tracking-wide text-muted">
        {icon}
        {label}
      </div>
      <div className={cn('text-xs font-mono mt-0.5', tone)}>{value}</div>
    </div>
  );
}

/* -------------------------------------------------------- Create modal */

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'share';

export function CreateShareModal({
  open,
  onClose,
  initialEntries,
  initialName,
}: {
  open: boolean;
  onClose: () => void;
  initialEntries?: StagedEntry[];
  initialName?: string;
}) {
  const setShares = useStore((s) => s.setShares);
  const net = useStore((s) => s.net);
  const toast = useStore((s) => s.toast);

  const [entries, setEntries] = React.useState<StagedEntry[]>([]);
  const [rootName, setRootName] = React.useState('');
  const [realPath, setRealPath] = React.useState<string | null>(null);
  const [probe, setProbe] = React.useState<{
    fileCount: number;
    totalBytes: number;
    hasIndexHtml: boolean;
    videoCount: number;
  } | null>(null);
  const [name, setName] = React.useState('');
  const [slug, setSlug] = React.useState('');
  const [slugEdited, setSlugEdited] = React.useState(false);
  const [mode, setMode] = React.useState<ShareMode>('files');
  const [requirePhrase, setRequirePhrase] = React.useState(false);
  const [allowUpload, setAllowUpload] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    const seeded = initialEntries ?? [];
    setEntries(seeded);
    setRootName(initialName ?? '');
    setRealPath(null);
    setProbe(null);
    setName(initialName ?? '');
    setSlug(initialName ? slugify(initialName) : '');
    setSlugEdited(false);
    setMode(detectMode(seeded));
    setRequirePhrase(false);
    setAllowUpload(false);
  }, [open, initialEntries, initialName]);

  const choose = async () => {
    const picked = await pickFolder();
    if (!picked) return;

    setRootName(picked.name);
    setName(picked.name);
    if (!slugEdited) setSlug(slugify(picked.name));
    setRealPath(picked.path);
    setEntries(picked.files.length ? toEntries(picked.files) : []);

    if (picked.path) {
      // The backend knows what is really on disk; the picker only guesses.
      const info = await api.host.probe(picked.path);
      setProbe(info);
      setMode(info.videoCount > 0 ? 'media' : info.hasIndexHtml ? 'site' : 'files');
    } else {
      setProbe(null);
      setMode(detectMode(toEntries(picked.files)));
    }
  };

  const totalBytes = probe?.totalBytes ?? entries.reduce((n, e) => n + e.size, 0);
  const fileCount = probe?.fileCount ?? entries.length;
  const hasIndex =
    probe?.hasIndexHtml ?? entries.some((e) => e.relPath.toLowerCase() === 'index.html');
  const chosen = realPath !== null || entries.length > 0;
  const canPublish = chosen && name.trim().length > 0 && slug.length > 0 && canHost();

  const publish = async () => {
    setBusy(true);
    try {
      await api.host.create({
        name: name.trim(),
        path: realPath ?? '',
        slug,
        mode,
        requirePhrase,
        allowUpload,
        fileCount,
        totalBytes,
      });
      setShares(await api.host.list());
      toast({
        kind: 'success',
        title: `${name.trim()} is live`,
        body: net ? `http://${net.ip}:${net.hostPort}/${slug}` : undefined,
      });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Publish a folder"
      width="max-w-lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!canPublish || busy} onClick={() => void publish()}>
            {busy ? 'Starting…' : 'Publish'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {!canHost() && (
          <div className="flex items-start gap-2 rounded-input bg-gold/[0.07] border border-gold/30 px-2.5 py-2">
            <Globe size={12} className="text-gold shrink-0 mt-0.5" />
            <p className="text-2xs text-muted leading-relaxed">
              {hostBlocker() === 'android'
                ? 'Publishing needs a desktop device. Android returns content:// URIs rather than folder paths, so the server has nothing to open — this phone can browse and download from peers instead.'
                : 'Hosting needs the desktop app. A browser hides real folder paths, so the server has nothing to open — this preview can stage a folder but not serve it.'}
            </p>
          </div>
        )}

        <Button full icon={<FolderTree size={13} />} onClick={() => void choose()}>
          {chosen ? 'Choose a different folder' : 'Choose a folder'}
        </Button>

        {chosen && (
          <>
            <div className="panel">
              <div className="flex items-center justify-between px-3 h-8 border-b border-edge">
                <span className="label">
                  {fileCount} files · {formatBytes(totalBytes)}
                </span>
                <div className="flex gap-1.5">
                  {probe && probe.videoCount > 0 && (
                    <Badge tone="cyan">{probe.videoCount} videos</Badge>
                  )}
                  {hasIndex && <Badge tone="cyan">index.html found</Badge>}
                </div>
              </div>
              {realPath ? (
                <div className="px-3 py-2">
                  <div className="label mb-0.5">Serving from</div>
                  <div className="text-2xs font-mono text-dim break-all">{realPath}</div>
                </div>
              ) : (
                <ul className="max-h-32 scroll-y divide-y divide-edge">
                  {entries.slice(0, 60).map((e) => (
                    <li key={e.relPath} className="flex items-center gap-2 px-3 h-7">
                      <span className="text-2xs font-mono text-dim truncate flex-1">
                        {e.relPath}
                      </span>
                      <span className="text-[10px] text-muted shrink-0">
                        {formatBytes(e.size)}
                      </span>
                    </li>
                  ))}
                  {entries.length > 60 && (
                    <li className="px-3 h-7 flex items-center text-[10px] text-muted">
                      and {entries.length - 60} more…
                    </li>
                  )}
                </ul>
              )}
            </div>

            <div className="space-y-2">
              <span className="label">How should it be served?</span>
              <div className="grid gap-1.5">
                {MODES.map((m) => {
                  const Icon = m.icon;
                  const on = mode === m.id;
                  const unavailable =
                    m.id === 'media'
                      ? probe !== null && probe.videoCount === 0
                      : m.id !== 'files' && !hasIndex;
                  return (
                    <button
                      key={m.id}
                      disabled={unavailable}
                      onClick={() => setMode(m.id)}
                      className={cn(
                        'flex items-start gap-2.5 p-2.5 rounded-card border text-left transition-colors',
                        on
                          ? 'border-gold/50 bg-gold/10 shadow-glow'
                          : 'border-edge bg-raised hover:border-edge-strong',
                        unavailable && 'opacity-40 pointer-events-none',
                      )}
                    >
                      <Icon size={15} className={cn('mt-0.5 shrink-0', on ? 'text-gold' : 'text-muted')} />
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="text-xs font-medium">{m.label}</span>
                          <span className="text-2xs text-muted">{m.blurb}</span>
                        </span>
                        <span className="block text-2xs text-muted mt-0.5 leading-relaxed">
                          {unavailable
                            ? m.id === 'media'
                              ? 'No video files found in this folder.'
                              : 'Needs an index.html at the folder root.'
                            : m.hint}
                        </span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex gap-2">
              <div className="flex-1 space-y-1.5">
                <label className="label">Name</label>
                <Input
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (!slugEdited) setSlug(slugify(e.target.value));
                  }}
                  maxLength={40}
                />
              </div>
              <div className="flex-1 space-y-1.5">
                <label className="label">Address</label>
                <Input
                  value={slug}
                  onChange={(e) => {
                    setSlugEdited(true);
                    setSlug(slugify(e.target.value));
                  }}
                  className="font-mono"
                />
              </div>
            </div>

            {net && (
              <div className="rounded-input bg-base border border-edge px-2.5 py-2">
                <div className="label mb-0.5">Will be reachable at</div>
                <div className="text-xs font-mono text-gold break-all">
                  http://{net.ip}:{net.hostPort}/{slug}
                </div>
              </div>
            )}

            <div className="space-y-2.5 pt-1">
              <Toggle
                checked={requirePhrase}
                onChange={setRequirePhrase}
                label="Require a pairing phrase"
                hint="Visitors must enter a phrase before the folder loads"
              />
              <Toggle
                checked={allowUpload}
                onChange={setAllowUpload}
                label="Allow uploads into this folder"
                hint="Anyone who can open the address can add files"
              />
            </div>
          </>
        )}
      </div>

    </Modal>
  );
}

/* ------------------------------------------------------------- helpers */

/** `webkitRelativePath` is "root/sub/file.ext"; the first segment is the root. */
export function rootOf(files: File[]): string {
  const rel = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
  return rel ? rel.split('/')[0] : 'folder';
}

export function toEntries(files: File[]): StagedEntry[] {
  return files.map((f) => {
    const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath ?? f.name;
    const stripped = rel.includes('/') ? rel.split('/').slice(1).join('/') : rel;
    return {
      relPath: stripped || f.name,
      name: f.name,
      size: f.size,
      mime: f.type || 'application/octet-stream',
    };
  });
}

/** A folder with an index.html at its root is almost certainly a site. */
function detectMode(entries: StagedEntry[]): ShareMode {
  return entries.some((e) => e.relPath.toLowerCase() === 'index.html') ? 'site' : 'files';
}
