/**
 * Asking before a file lands.
 *
 * A transfer already waits as "queued" until it is accepted, so nothing was
 * ever written unasked — but the only sign of one arriving was a toast that
 * faded and a row in a screen you might not be looking at. People missed
 * files, or found them minutes later.
 *
 * So it is put in front of the person, with the two decisions that matter on
 * it: whether to take it at all, and where it should go. "Save to…" is there
 * because the usual folder is right most of the time and wrong exactly when
 * it matters — the one big file you want on the other drive.
 */
import React from 'react';
import { Download, FolderOpen, X } from 'lucide-react';

import { api } from '../lib/bridge';
import { pickFolder } from '../lib/picker';
import { useStore } from '../lib/store';
import { formatBytes } from '../lib/utils';
import { Avatar } from './Avatar';
import { Button, Modal } from './ui';

export function IncomingFile() {
  const offer = useStore((s) => s.pendingOffer);
  const clearOffer = useStore((s) => s.clearPendingOffer);
  const peers = useStore((s) => s.peers);
  const downloadDir = useStore((s) => s.settings.files.downloadDir);

  const [busy, setBusy] = React.useState(false);

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
          size={40}
        />
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{offer.name}</p>
          <p className="text-2xs text-muted">
            {formatBytes(offer.size)} · from {peer?.name ?? 'an unknown device'}
          </p>
        </div>
      </div>

      <p className="text-2xs text-muted leading-relaxed mb-4">
        Saved to{' '}
        <span className="font-mono text-dim">{downloadDir || 'your downloads folder'}</span>{' '}
        unless you choose somewhere else. Nothing is written until you accept.
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
