/**
 * Asking before a file lands, and asking where.
 *
 * A transfer already waits as "queued" until it is accepted, so nothing was
 * ever written unasked — but the only sign of one arriving was a toast that
 * faded and a row in a screen you might not be looking at. People missed
 * files, or found them minutes later.
 *
 * So it is put in front of the person, with the two decisions that matter on
 * it: whether to take it at all, and where it should go.
 *
 * The published folders are the second half of that, and the point of this
 * screen. Send a film from a phone to a desktop and it landed in
 * Downloads/LANTern — which Theatre does not look at, because Theatre shows
 * what is *published*. So the one thing anybody sends a film for did not
 * happen, and the fix was to open a file manager and move it by hand. This
 * device already knows every folder it publishes; a video can go straight
 * into one and be on the shelf before the prompt has closed.
 */
import React from 'react';
import { Download, FolderOpen, X } from 'lucide-react';

import { api } from '../lib/bridge';
import { pickFolder } from '../lib/picker';
import { useStore } from '../lib/store';
import { formatBytes, mimeKind } from '../lib/utils';
import { Avatar } from './Avatar';
import { Button, Modal } from './ui';
import type { Share } from '../lib/types';

export function IncomingFile() {
  const offer = useStore((s) => s.pendingOffer);
  const clearOffer = useStore((s) => s.clearPendingOffer);
  const peers = useStore((s) => s.peers);
  const shares = useStore((s) => s.shares);
  const downloadDir = useStore((s) => s.settings.files.downloadDir);

  const [busy, setBusy] = React.useState(false);

  /*
   * Which of this device's published folders to offer, best first.
   *
   * Only ones with a real path: a share staged in a plain browser has none,
   * and handing that to the native side writes nothing. `useMemo` keyed on
   * the offer because the list is stable while one prompt is open, and
   * `shares` is refreshed on a timer underneath it.
   */
  const destinations = React.useMemo(
    () => (offer ? rankShares(shares, offer.name) : []),
    [shares, offer],
  );

  if (!offer) return null;
  const peer = peers[offer.peerId];

  const accept = async (dir?: string) => {
    setBusy(true);
    try {
      await api.files.accept(offer.id, dir);
    } finally {
      setBusy(false);
      clearOffer();
    }
  };

  const saveTo = async () => {
    const picked = await pickFolder();
    // A cancelled picker means "I have not decided", not "put it anywhere".
    if (!picked?.path) return;
    await accept(picked.path);
  };

  return (
    <Modal open onClose={clearOffer} title="Incoming file" width="max-w-md">
      <div className="flex items-center gap-3 mb-4">
        <Avatar
          name={peer?.name ?? 'Unknown'}
          color={peer?.color}
          emoji={peer?.emoji}
          src={peer?.avatar}
          size={40}
        />
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{offer.name}</p>
          <p className="text-2xs text-muted">
            {formatBytes(offer.size)} · from {peer?.name ?? 'an unknown device'}
          </p>
        </div>
      </div>

      {destinations.length > 0 && (
        <div className="mb-4">
          <p className="label mb-1.5">Put it in</p>
          <div className="space-y-1">
            {destinations.map((share) => (
              <button
                key={share.id}
                disabled={busy}
                onClick={() => void accept(share.path)}
                className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-input border border-edge bg-raised hover:border-gold/50 text-left disabled:opacity-40"
              >
                <FolderOpen size={14} className="text-gold shrink-0" />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs truncate">{share.name}</span>
                  <span className="block text-2xs text-muted truncate font-mono">
                    {share.path}
                  </span>
                </span>
                {/* Saying so on the row, because "published" is the whole
                    reason this folder is worth choosing over Downloads. */}
                <span className="text-2xs text-muted shrink-0">On the shelf</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <p className="text-2xs text-muted leading-relaxed mb-4">
        Otherwise it is saved to{' '}
        <span className="font-mono text-dim">{downloadDir || 'your downloads folder'}</span>.
        Nothing is written until you accept.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          icon={<Download size={13} />}
          onClick={() => void accept(downloadDir || undefined)}
          disabled={busy}
        >
          Accept
        </Button>
        <Button icon={<FolderOpen size={13} />} onClick={() => void saveTo()} disabled={busy}>
          Save to…
        </Button>
        <Button icon={<X size={13} />} onClick={clearOffer} disabled={busy}>
          Not now
        </Button>
      </div>
    </Modal>
  );
}

/**
 * Published folders worth offering for this file, best first.
 *
 * A film goes with the films. The kind of the incoming file is matched
 * against what each folder already holds, which is the only signal available
 * without asking anybody to label their folders — and the name is a second
 * one, because a folder called "Films" is a film folder whether or not the
 * scan has reached it yet.
 *
 * Folders that take uploads sort above ones that do not, since somebody has
 * already said that folder is for things arriving.
 */
function rankShares(shares: Share[], fileName: string): Share[] {
  const kind = mimeKind('', fileName);
  const usable = shares.filter((s) => !!s.path && s.path.trim().length > 0);

  const score = (share: Share): number => {
    let n = 0;
    if (share.allowUpload) n += 2;
    if (kind !== 'file' && looksLike(share.name, kind)) n += 3;
    if (share.running) n += 1;
    return n;
  };

  return [...usable]
    .sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name))
    // Three is as many as anybody reads on a prompt they want to dismiss.
    // The rest are still reachable through "Save to…".
    .slice(0, 3);
}

/** Whether a folder's name suggests it is for this kind of thing. */
function looksLike(name: string, kind: 'image' | 'video' | 'audio'): boolean {
  const words = {
    video: ['film', 'films', 'movie', 'movies', 'video', 'videos', 'tv', 'shows', 'series', 'media'],
    audio: ['music', 'audio', 'songs', 'albums', 'media'],
    image: ['photo', 'photos', 'pictures', 'images', 'camera', 'media'],
  }[kind];

  const parts = name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  return parts.some((part) => words.includes(part));
}
