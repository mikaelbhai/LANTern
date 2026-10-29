import React from 'react';
import { Globe } from 'lucide-react';
import { Button } from './ui';
import { api, on } from '../lib/bridge';

interface Request {
  id: string;
  name: string;
  agent: string;
  ip: string;
}

/**
 * Somebody on the network opened this machine's address in a browser and asked
 * to use LANTern from there.
 *
 * Asked about every time a new device appears, in the corner, over whatever is
 * showing: a guest is a stranger with a keyboard, and the host is the only one
 * who can say whether they are who they claim to be. Silence is a refusal -
 * the request times out on its own - so ignoring this never lets anybody in.
 */
export function GuestPrompt() {
  const [queue, setQueue] = React.useState<Request[]>([]);

  React.useEffect(
    () =>
      on('guest:request', (r: Request) =>
        setQueue((q) => (q.some((x) => x.id === r.id) ? q : [...q, r])),
      ),
    [],
  );

  const current = queue[0];
  if (!current) return null;

  const answer = (allow: boolean) => {
    void api.guest.decide(current.id, allow).catch(() => undefined);
    setQueue((q) => q.slice(1));
  };

  return (
    <div
      role="alertdialog"
      aria-labelledby="guest-ask"
      className="fixed z-[120] right-4 bottom-4 w-[min(92vw,22rem)] rounded-card border border-edge bg-surface shadow-2xl p-4"
    >
      <div className="flex items-start gap-3">
        <span className="h-9 w-9 shrink-0 grid place-items-center rounded-full bg-gold/15 text-gold">
          <Globe size={16} />
        </span>
        <div className="min-w-0">
          <p id="guest-ask" className="text-sm font-medium">
            {current.name} wants to join as a guest
          </p>
          <p className="mt-0.5 text-2xs text-muted">
            {current.agent} · {current.ip}
          </p>
          <p className="mt-2 text-2xs text-muted leading-relaxed">
            They can chat with you, watch what you publish and send you files. They cannot call
            you or reach anything else on this machine.
          </p>
        </div>
      </div>
      <div className="mt-3 flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => answer(false)}>
          Not now
        </Button>
        <Button size="sm" variant="primary" onClick={() => answer(true)}>
          Let them in
        </Button>
      </div>
      {queue.length > 1 && (
        <p className="mt-2 text-2xs text-dim text-right">{queue.length - 1} more waiting</p>
      )}
    </div>
  );
}
