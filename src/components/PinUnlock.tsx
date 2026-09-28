/**
 * The lock: a viewer's own way past a rating, with no host in reach.
 *
 * A device that only watches — a phone, a television — has nowhere to grant
 * itself anything and nobody to ask on the spot. What it has is whoever set
 * a phrase up for it in advance, on whichever machines are actually
 * publishing, and this is where that phrase goes in. It is tried against
 * every host this device is linked to at once, because the phrase does not
 * say which one it belongs to — see `rating_unlock_peers` on the native
 * side — and the device's own local rating store, in case this build ever
 * runs somewhere that is both a viewer and, quietly, a host of its own.
 *
 * This is the one thing a viewer-only device offers instead of the publish
 * controls a host gets: it cannot add a folder, so it gets a way to see
 * further into the folders already there.
 */
import React from 'react';
import { KeyRound, Lock } from 'lucide-react';

import { api, on } from '../lib/bridge';
import { useStore } from '../lib/store';
import { Button, IconButton, Modal } from './ui';
import { PinPad, sanitizePin } from './PinPad';

/** How long to keep listening for hosts to answer after a phrase is sent. */
const COLLECT_MS = 2500;

/** The key `opened` uses for a phrase that unlocked this device's own store. */
const SELF = '__self__';

export function LockButton() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <IconButton label="Enter a PIN" onClick={() => setOpen(true)}>
        <Lock size={16} />
      </IconButton>
      <PinModal open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function PinModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const peers = useStore((s) => s.peers);
  const [pin, setPin] = React.useState('');
  const [state, setState] = React.useState<'idle' | 'trying' | 'done'>('idle');
  const [opened, setOpened] = React.useState<{ from: string; age: number }[]>([]);

  React.useEffect(() => {
    if (state !== 'trying') return;
    const off = on('rating:unlocked', (r: { from: string; age: number | null }) => {
      if (r.age !== null && r.age !== undefined) {
        setOpened((prev) => (prev.some((p) => p.from === r.from) ? prev : [...prev, { from: r.from, age: r.age! }]));
      }
    });
    const timer = setTimeout(() => setState('done'), COLLECT_MS);
    return () => {
      off();
      clearTimeout(timer);
    };
  }, [state]);

  const submit = async () => {
    if (pin.length < 4) return;
    setOpened([]);
    setState('trying');
    // Both at once: every linked host, and this device's own rating store,
    // in case this build is quietly a host too. Neither reveals the PIN
    // to anything but the native side checking it.
    void api.ratings.unlockPeers(pin);
    try {
      const age = await api.ratings.unlock(pin);
      if (age !== null && age !== undefined) {
        setOpened((prev) => [...prev, { from: SELF, age }]);
      }
    } catch {
      // Nothing to do — a host that answered this way just did not
      // recognise the PIN, same as silence from a peer.
    }
  };

  const close = () => {
    setPin('');
    setState('idle');
    setOpened([]);
    onClose();
  };

  return (
    <Modal open={open} onClose={close} title="Enter a PIN" width="max-w-sm">
      <div className="space-y-4">
        <p className="text-2xs text-muted leading-relaxed">
          A PIN set by whoever hosts what you are trying to watch unlocks that rating on this
          device. It only ever raises what you can see — never lowers it.
        </p>

        <PinPad value={pin} onChange={(v) => setPin(sanitizePin(v))} />

        <Button
          variant="primary"
          full
          disabled={pin.length < 4 || state === 'trying'}
          onClick={() => void submit()}
        >
          {state === 'trying' ? 'Trying…' : 'Unlock'}
        </Button>

        {state === 'trying' && (
          <p className="text-2xs text-dim text-center">Asking every device on the network…</p>
        )}

        {state === 'done' && (
          <div className="flex items-start gap-2 p-2.5 rounded-card border border-edge bg-raised">
            <KeyRound size={14} className={opened.length ? 'text-gold' : 'text-muted'} />
            <p className="text-2xs text-dim leading-relaxed">
              {opened.length === 0 ? (
                "That PIN didn't open anything here."
              ) : (
                <>
                  Unlocked {opened.map((o) => `${o.age}+`).join(', ')} on{' '}
                  {opened
                    .map((o) => (o.from === SELF ? 'this device' : peers[o.from]?.name ?? 'a device'))
                    .join(', ')}
                  .
                </>
              )}
            </p>
          </div>
        )}
      </div>
    </Modal>
  );
}
