import React from 'react';
import { Film, FolderTree } from 'lucide-react';
import { Badge, Button, Input, Modal, Toggle } from '../../components/ui';
import { api } from '../../lib/bridge';
import { canHost, hostBlocker, pickFolder } from '../../lib/picker';
import { useStore } from '../../lib/store';
import { formatBytes } from '../../lib/utils';
import type { StagedEntry } from '../../lib/types';

const VIDEO_EXT = /\.(mp4|webm|mkv|mov|m4v|avi|ogv)$/i;

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'theatre';

/**
 * Publishing videos is the same act as publishing a folder — it just uses the
 * `media` mode, which streams with range requests and surfaces the contents in
 * every peer's Theatre.
 */
export function PublishMediaModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const net = useStore((s) => s.net);
  const setShares = useStore((s) => s.setShares);
  const toast = useStore((s) => s.toast);

  const [entries, setEntries] = React.useState<StagedEntry[]>([]);
  const [rootName, setRootName] = React.useState('');
  const [realPath, setRealPath] = React.useState<string | null>(null);
  const [videoCount, setVideoCount] = React.useState(0);
  const [scannedBytes, setScannedBytes] = React.useState(0);
  const [name, setName] = React.useState('');
  const [slug, setSlug] = React.useState('theatre');
  const [requirePhrase, setRequirePhrase] = React.useState(false);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!open) return;
    setEntries([]);
    setRootName('');
    setRealPath(null);
    setVideoCount(0);
    setScannedBytes(0);
    setName('');
    setSlug('theatre');
    setRequirePhrase(false);
  }, [open]);

  const choose = async () => {
    const picked = await pickFolder();
    if (!picked) return;

    setRootName(picked.name);
    setName(picked.name);
    setSlug(slugify(picked.name));
    setRealPath(picked.path);

    if (picked.path) {
      // The backend reads what is actually on disk — the picker only guesses,
      // and a folder published from a guess can never be served.
      const info = await api.host.probe(picked.path);
      setVideoCount(info.videoCount);
      setScannedBytes(info.totalBytes);
      setEntries([]);
      if (info.videoCount === 0) {
        toast({
          kind: 'error',
          title: 'No videos in that folder',
          body: 'LANTern looks for mp4, webm, mkv, mov, m4v, avi and ogv.',
        });
      }
    } else {
      const staged = picked.files
        .filter((f) => VIDEO_EXT.test(f.name))
        .map((f) => ({
          relPath:
            (f as File & { webkitRelativePath?: string }).webkitRelativePath
              ?.split('/')
              .slice(1)
              .join('/') || f.name,
          name: f.name,
          size: f.size,
          mime: f.type || 'video/mp4',
        }));
      setEntries(staged);
      setVideoCount(staged.length);
      setScannedBytes(staged.reduce((n, e) => n + e.size, 0));
    }
  };

  const total = scannedBytes;
  const chosen = realPath !== null || entries.length > 0;

  const publish = async () => {
    setBusy(true);
    try {
      await api.host.create({
        name: name.trim() || 'Theatre',
        path: realPath ?? '',
        slug,
        mode: 'media',
        requirePhrase,
        allowUpload: false,
        fileCount: videoCount,
        totalBytes: total,
      });
      setShares(await api.host.list());
      await api.media.scan();
      toast({
        kind: 'success',
        title: `${videoCount} title${videoCount === 1 ? '' : 's'} published`,
        body: 'They are now in the Theatre of every device on the network.',
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
      title="Add videos to the Theatre"
      width="max-w-lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!chosen || videoCount === 0 || busy || !canHost()}
            onClick={() => void publish()}
          >
            {busy ? 'Publishing…' : 'Publish to the network'}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-xs text-dim leading-relaxed">
          Nothing is copied or uploaded. The files stay where they are and LANTern streams
          them on request, so a peer can start watching immediately and skip around without
          waiting for a download.
        </p>

        {!canHost() && (
          <div className="flex items-start gap-2 rounded-input bg-gold/[0.07] border border-gold/30 px-2.5 py-2">
            <Film size={12} className="text-gold shrink-0 mt-0.5" />
            <p className="text-2xs text-muted leading-relaxed">
              {hostBlocker() === 'android'
                ? 'Publishing needs a desktop device. Android returns content:// URIs rather than folder paths, so nothing could actually be streamed from here — but this phone can watch anything a desktop peer publishes.'
                : 'Publishing needs the desktop app. A browser hides real folder paths, so nothing could actually be streamed from here.'}
            </p>
          </div>
        )}

        <Button full icon={<FolderTree size={13} />} onClick={() => void choose()}>
          {chosen ? 'Choose a different folder' : 'Choose a folder of videos'}
        </Button>

        {chosen && (
          <>
            <div className="panel">
              <div className="flex items-center justify-between px-3 h-8 border-b border-edge">
                <span className="label">
                  {videoCount} video{videoCount === 1 ? '' : 's'} · {formatBytes(total)}
                </span>
                <Badge tone={videoCount > 0 ? 'cyan' : 'danger'}>
                  {videoCount > 0 ? 'Streamed, not copied' : 'No videos found'}
                </Badge>
              </div>
              {realPath ? (
                <div className="px-3 py-2">
                  <div className="label mb-0.5">Streaming from</div>
                  <div className="text-2xs font-mono text-dim break-all">{realPath}</div>
                </div>
              ) : (
                <ul className="max-h-36 scroll-y divide-y divide-edge">
                  {entries.slice(0, 40).map((e) => (
                    <li key={e.relPath} className="flex items-center gap-2 px-3 h-8">
                      <Film size={11} className="text-muted shrink-0" />
                      <span className="text-2xs font-mono text-dim truncate flex-1">
                        {e.relPath}
                      </span>
                      <span className="text-[10px] text-muted shrink-0">
                        {formatBytes(e.size)}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="flex gap-2">
              <div className="flex-1 space-y-1.5">
                <label className="label">Library name</label>
                <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
              </div>
              <div className="flex-1 space-y-1.5">
                <label className="label">Address</label>
                <Input
                  value={slug}
                  onChange={(e) => setSlug(slugify(e.target.value))}
                  className="font-mono"
                />
              </div>
            </div>

            {net && (
              <div className="rounded-input bg-base border border-edge px-2.5 py-2">
                <div className="label mb-0.5">Peers will stream from</div>
                <div className="text-xs font-mono text-gold break-all">
                  http://{net.ip}:{net.hostPort}/{slug}
                </div>
              </div>
            )}

            <Toggle
              checked={requirePhrase}
              onChange={setRequirePhrase}
              label="Require a pairing phrase"
              hint="Only peers who enter the phrase can browse or stream the library"
            />
          </>
        )}
      </div>

    </Modal>
  );
}
