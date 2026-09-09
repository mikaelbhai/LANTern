/**
 * Other people's published folders.
 *
 * Theatre shows what peers share as *media* — films and episodes, presented as
 * a library. A folder published in "files" mode had nowhere to appear at all:
 * the only way in was to know its address and type it into a browser, which
 * is not something anyone should have to do on their own network.
 *
 * So this is the other half of Hosting. Your own published folders are one tab
 * across; these are everyone else's.
 */
import React from 'react';
import { ChevronRight, ExternalLink, File, Folder, Home, RefreshCw } from 'lucide-react';

import { Button, Empty, IconButton } from '../../components/ui';
import { api } from '../../lib/bridge';
import { useStore } from '../../lib/store';
import { cn, formatBytes } from '../../lib/utils';

interface Share {
  slug: string;
  name: string;
  mode: string;
  url: string;
}

interface Entry {
  name: string;
  isDir: boolean;
  size: number;
  path: string;
  url: string;
}

export function PeerFolders() {
  const peers = useStore((s) => s.peers);
  const online = React.useMemo(
    () => Object.values(peers).filter((p) => p.status !== 'offline'),
    [peers],
  );

  const [shares, setShares] = React.useState<Record<string, Share[]>>({});
  const [loading, setLoading] = React.useState(false);

  // Which folder is open, if any.
  const [open, setOpen] = React.useState<{ peerId: string; share: Share } | null>(null);
  const [path, setPath] = React.useState('');
  const [entries, setEntries] = React.useState<Entry[]>([]);
  const [problem, setProblem] = React.useState<string | null>(null);
  const [browsing, setBrowsing] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const found: Record<string, Share[]> = {};
      // Sequentially rather than all at once: each one dials a peer over the
      // network, and a burst of them on a busy Wi-Fi is how timeouts happen.
      for (const peer of online) {
        const list = await api.peers.shares(peer.id).catch(() => []);
        // Media shares already have a home in Theatre.
        const folders = list.filter((s) => s.mode !== 'media');
        if (folders.length) found[peer.id] = folders;
      }
      setShares(found);
    } finally {
      setLoading(false);
    }
  }, [online]);

  React.useEffect(() => {
    void load();
    // Only when the set of peers changes, not on every render of their state.
  }, [online.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const browse = React.useCallback(
    async (peerId: string, share: Share, next: string) => {
      setBrowsing(true);
      try {
        const listing = await api.peers.browse(peerId, share.slug, next);
        setEntries((listing?.entries as Entry[]) ?? []);
        setProblem((listing as { error?: string })?.error ?? null);
        setPath(next);
        setOpen({ peerId, share });
      } finally {
        setBrowsing(false);
      }
    },
    [],
  );

  /* ------------------------------------------------------------ browsing */

  if (open) {
    const crumbs = path.split('/').filter(Boolean);
    const peer = peers[open.peerId];

    return (
      <div className="h-full flex flex-col">
        <div className="shrink-0 flex items-center gap-1.5 px-4 py-2.5 border-b border-edge flex-wrap">
          <IconButton
            label="Back to all folders"
            size="xs"
            onClick={() => {
              setOpen(null);
              setEntries([]);
              setPath('');
            }}
          >
            <Home size={12} />
          </IconButton>
          <span className="text-2xs text-muted">{peer?.name ?? 'Peer'} /</span>
          <button
            className="text-2xs text-gold hover:underline"
            onClick={() => void browse(open.peerId, open.share, '')}
          >
            {open.share.name}
          </button>
          {crumbs.map((part, i) => (
            <React.Fragment key={i}>
              <ChevronRight size={11} className="text-muted" />
              <button
                className="text-2xs text-dim hover:text-gold hover:underline"
                onClick={() =>
                  void browse(open.peerId, open.share, crumbs.slice(0, i + 1).join('/'))
                }
              >
                {part}
              </button>
            </React.Fragment>
          ))}
        </div>

        <div className="flex-1 scroll-y p-3">
          {browsing ? (
            <p className="text-xs text-muted px-1">Reading…</p>
          ) : problem ? (
            <p className="text-xs text-gold/90 px-1 leading-relaxed max-w-lg">{problem}</p>
          ) : entries.length === 0 ? (
            <p className="text-xs text-muted px-1">This folder is empty.</p>
          ) : (
            <div className="space-y-1">
              {entries.map((entry) => (
                <div
                  key={entry.path}
                  className={cn(
                    'flex items-center gap-2.5 rounded-input px-2.5 h-11 border border-transparent',
                    entry.isDir ? 'hover:bg-raised cursor-pointer' : 'hover:border-edge',
                  )}
                  onClick={() =>
                    entry.isDir ? void browse(open.peerId, open.share, entry.path) : undefined
                  }
                >
                  {entry.isDir ? (
                    <Folder size={14} className="text-gold shrink-0" />
                  ) : (
                    <File size={14} className="text-dim shrink-0" />
                  )}
                  <span className="text-xs truncate flex-1">{entry.name}</span>
                  {!entry.isDir && (
                    <>
                      <span className="text-2xs text-muted shrink-0">
                        {formatBytes(entry.size)}
                      </span>
                      {/* Opening it hands the URL to the system, which is what
                          downloads it — the same address any browser on the
                          network can already use. */}
                      <IconButton
                        label="Open"
                        size="xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          void api.files.open(entry.url);
                        }}
                      >
                        <ExternalLink size={11} />
                      </IconButton>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  /* -------------------------------------------------------------- listing */

  const withFolders = online.filter((p) => (shares[p.id] ?? []).length > 0);

  return (
    <div className="h-full flex flex-col">
      <div className="shrink-0 flex items-center gap-2 px-4 py-2.5 border-b border-edge">
        <span className="text-2xs text-muted flex-1">
          Folders other devices have published. Media libraries appear in Theatre instead.
        </span>
        <Button size="sm" icon={<RefreshCw size={12} />} onClick={() => void load()}>
          {loading ? 'Looking…' : 'Refresh'}
        </Button>
      </div>

      <div className="flex-1 scroll-y p-4">
        {withFolders.length === 0 ? (
          <Empty
            icon={<Folder size={20} />}
            title={loading ? 'Looking…' : 'Nothing published by anyone else'}
            hint="When someone on your network publishes a folder, it appears here and you can open it without leaving LANTern."
          />
        ) : (
          <div className="space-y-4">
            {withFolders.map((peer) => (
              <div key={peer.id}>
                <p className="label mb-1.5">{peer.name}</p>
                <div className="space-y-1">
                  {(shares[peer.id] ?? []).map((share) => (
                    <button
                      key={share.slug}
                      onClick={() => void browse(peer.id, share, '')}
                      className="w-full flex items-center gap-2.5 rounded-card border border-edge bg-surface px-3 h-12 hover:border-gold/40 transition-colors text-left"
                    >
                      <Folder size={15} className="text-gold shrink-0" />
                      <span className="text-xs font-medium truncate flex-1">{share.name}</span>
                      <ChevronRight size={13} className="text-muted shrink-0" />
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
