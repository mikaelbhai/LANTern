/**
 * The phone's line while it is mirroring its screen to a television: what is
 * happening, and the way to stop it.
 *
 * It sits where the network strip does. Mirroring shows everything on this
 * screen on a television across the room, so it is never something to leave
 * running without being able to see that it is.
 */
import { Cast, X } from 'lucide-react';

import { useMirror } from '../lib/mirror';

export function MirrorBanner() {
  const phase = useMirror((s) => s.phase);
  const name = useMirror((s) => s.name);
  const stop = useMirror((s) => s.stop);
  if (phase === 'idle') return null;

  const line =
    phase === 'asking'
      ? `Asking ${name}...`
      : phase === 'consent'
        ? 'Allow screen capture to start'
        : phase === 'connecting'
          ? `Connecting to ${name}...`
          : `Mirroring to ${name}`;

  return (
    <div className="w-full shrink-0 flex items-center gap-2.5 px-4 py-2.5 bg-gold/[0.14] border-b border-gold/30">
      <Cast size={15} className="text-gold shrink-0" />
      <span className="min-w-0 flex-1 text-xs text-gold font-medium truncate">{line}</span>
      <button
        onClick={stop}
        className="shrink-0 inline-flex items-center gap-1 h-7 px-2.5 rounded-full bg-gold text-on-gold text-xs font-semibold"
      >
        <X size={13} />
        Stop
      </button>
    </div>
  );
}
