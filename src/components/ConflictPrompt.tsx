import React from 'react';
import { Files } from 'lucide-react';
import { api, on } from '../lib/bridge';
import { formatBytes } from '../lib/utils';
import { Button, Modal } from './ui';

interface Conflict {
  id: string;
  name: string;
  existingSize: number;
  size: number;
}

/**
 * A file is arriving with the name of one that is already in the folder.
 *
 * The transfer waits on this: the native side has paused at the point of
 * choosing a name and will not write anything until it hears back. The safe
 * answer is first and is also what happens if nobody answers, because it is
 * the only one that cannot lose a file.
 *
 * "Do this for the rest" is for a batch - two hundred photos, three of which
 * were sent before - and lapses after a couple of minutes on the native side,
 * so it never quietly decides tomorrow's.
 */
export function ConflictPrompt() {
  const [queue, setQueue] = React.useState<Conflict[]>([]);
  const [rest, setRest] = React.useState(false);

  React.useEffect(
    () =>
      on('transfer:conflict', (c: Conflict) =>
        setQueue((q) => (q.some((x) => x.id === c.id) ? q : [...q, c])),
      ),
    [],
  );

  const current = queue[0];
  if (!current) return null;

  const answer = (choice: 'keep' | 'replace' | 'skip') => {
    // Ticked: every question already waiting gets the same answer, and the
    // native side remembers it for the ones still to come. Left alone, the
    // second file would sit there asking what the first one just decided.
    const answered = rest ? queue : [current];
    answered.forEach((c, i) =>
      void api.files.resolveConflict(c.id, choice, rest && i === 0).catch(() => undefined),
    );
    setQueue((q) => q.slice(answered.length));
    setRest(false);
  };

  return (
    // Closing it any other way is the unanswered case, which keeps both.
    <Modal open onClose={() => answer('keep')} title="Already here" width="max-w-md">
      <div className="flex items-start gap-3 mb-4">
        <span className="h-9 w-9 shrink-0 grid place-items-center rounded-full bg-gold/15 text-gold">
          <Files size={16} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-medium truncate">{current.name}</p>
          <p className="mt-0.5 text-2xs text-muted leading-relaxed">
            A file with this name is already in the folder ({formatBytes(current.existingSize)}).
            The one arriving is {formatBytes(current.size)}.
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Button full variant="primary" onClick={() => answer('keep')}>
          Keep both
        </Button>
        <Button full variant="outline" onClick={() => answer('replace')}>
          Replace the old one
        </Button>
        <Button full variant="ghost" onClick={() => answer('skip')}>
          Skip this one
        </Button>
      </div>

      <label className="mt-4 flex items-center gap-2 text-2xs text-muted cursor-pointer select-none">
        <input
          type="checkbox"
          checked={rest}
          onChange={(e) => setRest(e.target.checked)}
          className="accent-gold"
        />
        Do this for the rest of these files
      </label>
      {queue.length > 1 && (
        <p className="mt-2 text-2xs text-dim">{queue.length - 1} more waiting</p>
      )}
    </Modal>
  );
}
