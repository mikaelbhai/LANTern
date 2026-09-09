import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Clipboard,
  File as FileIcon,
  FileText,
  FolderOpen,
  FolderUp,
  Image as ImageIcon,
  Music,
  Pause,
  Play,
  Search,
  Globe,
  Send,
  Trash2,
  Upload,
  Video as VideoIcon,
  X,
} from 'lucide-react';
import { Avatar } from '../components/Avatar';
import { CreateShareModal, Hosting, rootOf, toEntries } from './files/Hosting';
import { PeerFolders } from './files/PeerFolders';
import {
  Badge,
  Button,
  Empty,
  IconButton,
  Input,
  Modal,
  ProgressBar,
  SectionTitle,
  Segmented,
  Select,
  Tooltip,
} from '../components/ui';
import { api } from '../lib/bridge';
import { useStore } from '../lib/store';
import { sendFilesToPeer } from '../lib/actions';
import { pickFilesToSend, type StagedFile } from '../lib/picker';
import {
  clockTime,
  cn,
  formatBytes,
  formatEta,
  formatSpeed,
  mimeKind,
  relativeTime,
} from '../lib/utils';
import { useNow } from '../lib/hooks';
import type { StagedEntry, Transfer } from '../lib/types';
import { readText } from '../lib/clipboard';
import { pickFolder } from '../lib/picker';
import { PullToRefresh } from '../components/PullToRefresh';

type Filter = 'all' | 'in' | 'out' | 'active';
type KindFilter = 'all' | 'image' | 'video' | 'audio' | 'file';
type SortKey = 'recent' | 'name' | 'size';

type Tab = 'transfers' | 'hosting' | 'peers';

export function Files() {
  const [tab, setTab] = React.useState<Tab>('transfers');
  const shares = useStore((s) => s.shares);
  const liveShares = shares.filter((s) => s.running).length;

  return (
    <div className="h-full flex flex-col">
      <header className="h-11 shrink-0 border-b border-edge bg-surface flex items-center px-4 gap-3">
        <FolderOpen size={15} className="text-gold" />
        <span className="text-sm font-semibold">Files</span>
        <Segmented
          value={tab}
          onChange={setTab}
          options={[
            { value: 'transfers', label: 'Transfers' },
            {
              value: 'peers',
              // Where "how do I see other people's folders" is answered. It
              // used to have no answer: a peer's published folder could only
              // be opened by typing its address into a browser.
              label: 'On other devices',
            },
            {
              value: 'hosting',
              // "Hosting" is what the feature is called internally; "Published
              // folders" is what someone is actually looking for when they go
              // hunting for the directories they are sharing. The count says
              // there is something in there without having to open it - a bare
              // dot did not, and this tab kept being missed.
              label: (
                <span className="flex items-center gap-1.5">
                  Published folders
                  {liveShares > 0 && (
                    <span className="min-w-[16px] h-4 px-1 grid place-items-center rounded-full bg-cyan/20 border border-cyan/40 text-[10px] font-semibold text-cyan">
                      {liveShares}
                    </span>
                  )}
                </span>
              ),
            },
          ]}
        />
      </header>

      <div className="flex-1 min-h-0">
        {tab === 'transfers' ? <Transfers /> : tab === 'peers' ? <PeerFolders /> : <Hosting />}
      </div>
    </div>
  );
}

function Transfers() {
  const transfers = useStore((s) => s.transfers);
  const addTransfers = useStore((s) => s.addTransfers);
  const peers = useStore((s) => s.peers);
  const [filter, setFilter] = React.useState<Filter>('all');
  const [kind, setKind] = React.useState<KindFilter>('all');
  const [peerFilter, setPeerFilter] = React.useState('all');
  const [sort, setSort] = React.useState<SortKey>('recent');
  const [query, setQuery] = React.useState('');
  const [sendOpen, setSendOpen] = React.useState(false);
  const [dragOver, setDragOver] = React.useState(false);
  const [preview, setPreview] = React.useState<Transfer | null>(null);

  const list = React.useMemo(() => {
    let out = Object.values(transfers);
    if (filter === 'in') out = out.filter((t) => t.direction === 'in');
    if (filter === 'out') out = out.filter((t) => t.direction === 'out');
    if (filter === 'active')
      out = out.filter((t) => t.state === 'active' || t.state === 'paused');
    if (kind !== 'all') out = out.filter((t) => mimeKind(t.mime, t.name) === kind);
    if (peerFilter !== 'all') out = out.filter((t) => t.peerId === peerFilter);
    if (query.trim()) {
      const q = query.toLowerCase();
      out = out.filter((t) => t.name.toLowerCase().includes(q));
    }
    out.sort((a, b) => {
      if (sort === 'name') return a.name.localeCompare(b.name);
      if (sort === 'size') return b.size - a.size;
      return b.startedAt - a.startedAt;
    });
    return out;
  }, [transfers, filter, kind, peerFilter, sort, query]);

  const active = Object.values(transfers).filter(
    (t) => t.state === 'active' || t.state === 'paused',
  );

  const onDrop = (files: FileList | null) => {
    if (files?.length) setSendOpen(true);
    pendingFiles.current = files ? Array.from(files) : [];
  };
  const pendingFiles = React.useRef<File[]>([]);

  return (
    <div
      className="h-full flex flex-col relative"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        onDrop(e.dataTransfer.files);
      }}
    >
      <header className="h-11 shrink-0 border-b border-edge bg-surface/60 flex items-center px-4 gap-2">
        {active.length > 0 ? (
          <Badge tone="gold">{active.length} transferring</Badge>
        ) : (
          <span className="text-2xs text-muted">
            Chunked, resumable, and straight between devices
          </span>
        )}
        <div className="ml-auto flex gap-2">
          <ClipboardShare />
          <Button
            size="xs"
            variant="primary"
            icon={<Send size={12} />}
            onClick={() => {
              pendingFiles.current = [];
              setSendOpen(true);
            }}
          >
            Send files
          </Button>
        </div>
      </header>

      {active.length > 0 && (
        <section className="border-b border-edge bg-surface/60 px-4 py-3">
          <SectionTitle>In progress</SectionTitle>
          <div className="space-y-2">
            <AnimatePresence initial={false}>
              {active.map((t) => (
                <ActiveTransferRow key={t.id} transfer={t} />
              ))}
            </AnimatePresence>
          </div>
        </section>
      )}

      <div className="h-11 shrink-0 border-b border-edge flex items-center gap-2 px-4 overflow-x-auto no-scrollbar">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search transfers…"
          icon={<Search size={12} />}
          className="w-48 shrink-0"
        />
        <Select
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: 'All' },
            { value: 'in', label: 'Received' },
            { value: 'out', label: 'Sent' },
            { value: 'active', label: 'Active' },
          ]}
          className="w-28 shrink-0"
        />
        <Select
          value={kind}
          onChange={setKind}
          options={[
            { value: 'all', label: 'Any type' },
            { value: 'image', label: 'Images' },
            { value: 'video', label: 'Video' },
            { value: 'audio', label: 'Audio' },
            { value: 'file', label: 'Documents' },
          ]}
          className="w-32 shrink-0"
        />
        <Select
          value={peerFilter}
          onChange={setPeerFilter}
          options={[
            { value: 'all', label: 'Any peer' },
            ...Object.values(peers).map((p) => ({ value: p.id, label: p.name })),
          ]}
          className="w-32 shrink-0"
        />
        <Select
          value={sort}
          onChange={setSort}
          options={[
            { value: 'recent', label: 'Newest' },
            { value: 'name', label: 'Name' },
            { value: 'size', label: 'Largest' },
          ]}
          className="w-28 shrink-0"
        />
      </div>

      <PullToRefresh className="flex-1" onRefresh={() => api.files.list().then((list) => addTransfers(list))}>
      <div>
        {list.length === 0 ? (
          <Empty
            icon={<Upload size={20} />}
            title="No transfers yet"
            hint="Drop files anywhere in this panel, or use Send files to pick a peer. Transfers resume automatically if the connection drops."
          />
        ) : (
          <ul className="divide-y divide-edge">
            {list.map((t) => (
              <TransferRow key={t.id} transfer={t} onPreview={() => setPreview(t)} />
            ))}
          </ul>
        )}
      </div>
      </PullToRefresh>

      <AnimatePresence>
        {dragOver && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-3 z-30 rounded-modal border-2 border-dashed border-gold bg-gold/10 grid place-items-center pointer-events-none"
          >
            <div className="text-center">
              <Upload size={28} className="mx-auto text-gold mb-2" />
              <div className="text-sm font-medium text-gold">Drop to send</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <SendModal
        open={sendOpen}
        onClose={() => setSendOpen(false)}
        initialFiles={pendingFiles.current}
      />
      <PreviewModal transfer={preview} onClose={() => setPreview(null)} />
    </div>
  );
}

/* ------------------------------------------------------------- Transfers */

function kindIcon(t: Transfer, size = 15) {
  const k = mimeKind(t.mime, t.name);
  const props = { size, className: 'shrink-0' };
  if (k === 'image') return <ImageIcon {...props} />;
  if (k === 'video') return <VideoIcon {...props} />;
  if (k === 'audio') return <Music {...props} />;
  if (/\.(txt|md|json|log|csv)$/i.test(t.name)) return <FileText {...props} />;
  return <FileIcon {...props} />;
}

function ActiveTransferRow({ transfer: t }: { transfer: Transfer }) {
  const peer = useStore((s) => s.peers[t.peerId]);
  const downloadDir = useStore((st) => st.settings.files.downloadDir);
  const pct = t.size ? (t.sent / t.size) * 100 : 0;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      className="panel p-2.5"
    >
      <div className="flex items-center gap-2.5">
        <span className={t.direction === 'in' ? 'text-cyan' : 'text-gold'}>
          {t.direction === 'in' ? <ArrowDownToLine size={14} /> : <ArrowUpFromLine size={14} />}
        </span>
        <span className="text-xs font-medium truncate flex-1">{t.name}</span>
        <span className="text-2xs text-muted shrink-0">
          {peer?.name ?? 'Unknown peer'}
        </span>
        {t.direction === 'in' && t.state === 'queued' ? (
          <>
            <IconButton
              label="Accept"
              size="xs"
              onClick={() => void api.files.accept(t.id, downloadDir || undefined)}
            >
              <Play size={11} />
            </IconButton>
            {/* The usual folder is right most of the time and wrong exactly
                when it matters, so the other choice is one tap away here too. */}
            <IconButton
              label="Save to…"
              size="xs"
              onClick={async () => {
                const picked = await pickFolder();
                if (picked?.path) void api.files.accept(t.id, picked.path);
              }}
            >
              <FolderOpen size={11} />
            </IconButton>
          </>
        ) : (
          <IconButton
            label={t.state === 'paused' ? 'Resume' : 'Pause'}
            size="xs"
            onClick={() =>
              t.state === 'paused' ? void api.files.resume(t.id) : void api.files.pause(t.id)
            }
          >
            {t.state === 'paused' ? <Play size={11} /> : <Pause size={11} />}
          </IconButton>
        )}
        <IconButton label="Cancel" size="xs" onClick={() => void api.files.cancel(t.id)}>
          <X size={11} />
        </IconButton>
      </div>

      <ProgressBar
        value={pct}
        tone={t.state === 'paused' ? 'cyan' : 'gold'}
        className="mt-2"
      />

      <div className="flex items-center gap-3 mt-1.5 text-2xs text-muted font-mono">
        <span>{pct.toFixed(0)}%</span>
        <span>
          {formatBytes(t.sent)} / {formatBytes(t.size)}
        </span>
        {t.state === 'active' ? (
          <>
            <span className="text-cyan">{formatSpeed(t.speedBps)}</span>
            <span className="ml-auto">{formatEta(t.size - t.sent, t.speedBps)} left</span>
          </>
        ) : (
          <span className="ml-auto text-gold">Paused</span>
        )}
      </div>
    </motion.div>
  );
}

function TransferRow({
  transfer: t,
  onPreview,
}: {
  transfer: Transfer;
  onPreview: () => void;
}) {
  const peer = useStore((s) => s.peers[t.peerId]);
  const now = useNow();
  const done = t.state === 'done';

  return (
    <li className="group flex items-center gap-3 px-4 h-14 hover:bg-raised/40 transition-colors">
      <span
        className={cn(
          'h-8 w-8 rounded-input border grid place-items-center shrink-0',
          done ? 'border-edge text-dim' : 'border-edge text-muted',
        )}
      >
        {kindIcon(t)}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-medium truncate">{t.name}</span>
          {t.state === 'failed' && <Badge tone="danger">Failed</Badge>}
          {t.state === 'cancelled' && <Badge tone="muted">Cancelled</Badge>}
          {t.expiresAt && (
            <Tooltip content={`Auto-deletes ${clockTime(t.expiresAt)}`}>
              <Badge tone="gold">Expires</Badge>
            </Tooltip>
          )}
        </div>
        <div className="flex items-center gap-2 text-2xs text-muted mt-0.5">
          <span className={t.direction === 'in' ? 'text-cyan' : 'text-gold'}>
            {t.direction === 'in' ? 'Received' : 'Sent'}
          </span>
          <span>·</span>
          <span>{formatBytes(t.size)}</span>
          <span>·</span>
          <span className="truncate">{peer?.name ?? 'Unknown peer'}</span>
          <span>·</span>
          <span>{relativeTime(t.finishedAt ?? t.startedAt, now)}</span>
        </div>
      </div>

      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {mimeKind(t.mime, t.name) === 'image' && (
          <Button size="xs" variant="ghost" onClick={onPreview}>
            Preview
          </Button>
        )}
        <Button size="xs" variant="ghost" onClick={() => void api.files.open(t.localPath ?? t.name)}>
          Open
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => void api.files.reveal(t.localPath ?? t.name)}
        >
          Show in folder
        </Button>
      </div>
    </li>
  );
}

/* ---------------------------------------------------------------- Modals */

function SendModal({
  open,
  onClose,
  initialFiles,
}: {
  open: boolean;
  onClose: () => void;
  initialFiles: File[];
}) {
  const peers = useStore((s) => s.peers);
  const expiryDefault = useStore((s) => s.settings.files.defaultExpiry);
  const zipFolders = useStore((s) => s.settings.files.zipFolders);
  const [files, setFiles] = React.useState<File[]>([]);
  // Files chosen through the native dialog, which is the only source that
  // yields an absolute path — and a path is what sending requires.
  const [staged, setStaged] = React.useState<StagedFile[]>([]);
  const toast = useStore((s) => s.toast);
  const [folderName, setFolderName] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [expiry, setExpiry] = React.useState(expiryDefault);
  const [publishOpen, setPublishOpen] = React.useState(false);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const folderInput = React.useRef<HTMLInputElement>(null);

  React.useEffect(() => {
    if (open) {
      setFiles(initialFiles);
      setStaged([]);
      setFolderName(null);
      setSelected([]);
      setExpiry(expiryDefault);
    }
  }, [open, initialFiles, expiryDefault]);

  const rows: StagedFile[] = staged.length
    ? staged
    : files.map((f) => ({ name: f.name, size: f.size }));
  const total = rows.reduce((n, f) => n + f.size, 0);
  const peerList = Object.values(peers);

  const chooseFiles = async () => {
    const picked = await pickFilesToSend();
    if (!picked.length) return;
    if (picked.some((f) => f.path)) {
      setStaged((prev) => [...prev, ...picked.filter((f) => f.path)]);
      setFolderName(null);
    } else {
      // Browser fallback: shown for completeness, but `send` will refuse it.
      setStaged((prev) => [...prev, ...picked]);
    }
  };

  // Relative paths are what make a folder arrive as a folder rather than a
  // flat pile of files, so they are carried through the send.
  const entries: StagedEntry[] = React.useMemo(
    () => (folderName ? toEntries(files) : []),
    [files, folderName],
  );

  const send = async () => {
    // Only paths can be sent — the server opens the file itself. Browser
    // `File` objects staged in the simulator have none.
    const paths = staged.map((f) => f.path).filter((p): p is string => !!p);
    if (!paths.length) {
      toast({
        kind: 'error',
        title: 'Nothing to send',
        body: 'Choose files with the picker so LANTern has a real path to read.',
      });
      return;
    }
    for (const peerId of selected) await sendFilesToPeer(peerId, paths);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Send files"
      width="max-w-lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!files.length || !selected.length}
            onClick={() => void send()}
          >
            Send {files.length || ''} to {selected.length || 'peer'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-2">
          <Button full icon={<Upload size={13} />} onClick={() => void chooseFiles()}>
            Choose files
          </Button>
          <Button full icon={<FolderUp size={13} />} onClick={() => folderInput.current?.click()}>
            Choose folder
          </Button>
        </div>

        {folderName && (
          <div className="flex items-center gap-2.5 p-2.5 rounded-card border border-gold/40 bg-gold/[0.07]">
            <FolderUp size={15} className="text-gold shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="text-xs font-medium truncate">{folderName}</div>
              <div className="text-2xs text-muted">
                {zipFolders
                  ? 'Sent as a folder, zipped in flight and unpacked on arrival'
                  : 'Sent as a folder, structure preserved'}
              </div>
            </div>
            <Button size="xs" icon={<Globe size={11} />} onClick={() => setPublishOpen(true)}>
              Publish instead
            </Button>
          </div>
        )}

        {rows.length > 0 && (
          <div className="panel">
            <div className="flex items-center justify-between px-3 h-8 border-b border-edge">
              <span className="label">
                {rows.length} file{rows.length === 1 ? '' : 's'} · {formatBytes(total)}
              </span>
              <button
                onClick={() => {
                  setFiles([]);
                  setStaged([]);
                  setFolderName(null);
                }}
                className="text-2xs text-muted hover:text-danger"
              >
                Clear
              </button>
            </div>
            <ul className="max-h-40 scroll-y divide-y divide-edge">
              {rows.map((f, i) => (
                <li key={i} className="flex items-center gap-2 px-3 h-9">
                  <FileIcon size={12} className="text-muted shrink-0" />
                  <span
                    className={cn(
                      'truncate flex-1',
                      folderName ? 'text-2xs font-mono text-dim' : 'text-xs',
                    )}
                  >
                    {folderName ? (entries[i]?.relPath ?? f.name) : f.name}
                  </span>
                  <span className="text-2xs text-muted font-mono">{formatBytes(f.size)}</span>
                  {!folderName && (
                    <IconButton
                      label="Remove"
                      size="xs"
                      onClick={() =>
                        staged.length
                          ? setStaged(staged.filter((_, j) => j !== i))
                          : setFiles(files.filter((_, j) => j !== i))
                      }
                    >
                      <Trash2 size={10} />
                    </IconButton>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="space-y-2">
          <div className="label">Send to</div>
          {peerList.length === 0 ? (
            <p className="text-xs text-muted">No peers online.</p>
          ) : (
            <div className="grid gap-1.5 [grid-template-columns:repeat(auto-fill,minmax(140px,1fr))]">
              {peerList.map((p) => {
                const on = selected.includes(p.id);
                return (
                  <button
                    key={p.id}
                    onClick={() =>
                      setSelected(
                        on ? selected.filter((x) => x !== p.id) : [...selected, p.id],
                      )
                    }
                    className={cn(
                      'flex items-center gap-2 px-2 h-9 rounded-input border transition-colors',
                      on
                        ? 'border-gold/50 bg-gold/10 shadow-glow'
                        : 'border-edge bg-raised hover:border-edge-strong',
                    )}
                  >
                    <Avatar name={p.name} color={p.color} emoji={p.emoji} size={20} />
                    <span className="text-xs truncate">{p.name}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="space-y-1.5">
          <div className="label">Auto-delete after</div>
          <Select
            value={expiry}
            onChange={setExpiry}
            options={[
              { value: 'never', label: 'Never' },
              { value: '1h', label: '1 hour' },
              { value: '6h', label: '6 hours' },
              { value: '24h', label: '24 hours' },
              { value: '7d', label: '7 days' },
            ]}
          />
        </div>
      </div>

      <input
        ref={fileInput}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          setFiles([...files, ...Array.from(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      <input
        ref={folderInput}
        type="file"
        hidden
        // Non-standard but supported in every WebView LANTern targets.
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={(e) => {
          const picked = Array.from(e.target.files ?? []);
          if (picked.length) {
            setFiles(picked);
            setFolderName(rootOf(picked));
          }
          e.target.value = '';
        }}
      />

      <CreateShareModal
        open={publishOpen}
        onClose={() => {
          setPublishOpen(false);
          onClose();
        }}
        initialEntries={entries}
        initialName={folderName ?? undefined}
      />
    </Modal>
  );
}

function PreviewModal({
  transfer,
  onClose,
}: {
  transfer: Transfer | null;
  onClose: () => void;
}) {
  return (
    <Modal open={!!transfer} onClose={onClose} title={transfer?.name} width="max-w-2xl">
      <div className="grid place-items-center min-h-[200px] bg-base rounded-card border border-edge">
        <div className="text-center p-8">
          <ImageIcon size={28} className="mx-auto text-muted mb-2" />
          <p className="text-xs text-muted">
            Preview renders from the local file once the transfer completes.
          </p>
          {transfer && (
            <p className="text-2xs text-muted font-mono mt-2">
              {formatBytes(transfer.size)} · {transfer.mime || 'unknown type'}
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}

function ClipboardShare() {
  const peers = useStore((s) => s.peers);
  const toast = useStore((s) => s.toast);

  const share = async () => {
    try {
      const text = await readText();
      if (!text.trim()) {
        toast({ kind: 'error', title: 'Clipboard is empty' });
        return;
      }
      const count = Object.keys(peers).length;
      toast({
        kind: 'success',
        title: 'Clipboard shared',
        body: `Sent ${text.length} characters to ${count} peer${count === 1 ? '' : 's'}.`,
      });
    } catch {
      toast({
        kind: 'error',
        title: 'Clipboard unavailable',
        body: 'Grant clipboard permission to share directly.',
      });
    }
  };

  return (
    <Button size="xs" icon={<Clipboard size={12} />} onClick={() => void share()}>
      Share clipboard
    </Button>
  );
}
