import React from 'react';
import { Send, X } from 'lucide-react';
import { Avatar } from '../../components/Avatar';
import { IconButton } from '../../components/ui';
import { useStore } from '../../lib/store';
import { clockTime, uid } from '../../lib/utils';

interface Line {
  id: string;
  authorId: string;
  body: string;
  ts: number;
}

/** Ephemeral chat that lives only for the duration of the call. */
export function InCallChat({ onClose }: { onClose: () => void }) {
  const profile = useStore((s) => s.profile);
  const peers = useStore((s) => s.peers);
  const [lines, setLines] = React.useState<Line[]>([]);
  const [text, setText] = React.useState('');
  const endRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines.length]);

  const send = () => {
    if (!text.trim()) return;
    setLines((l) => [
      ...l,
      { id: uid(), authorId: profile.id, body: text.trim(), ts: Date.now() },
    ]);
    setText('');
  };

  return (
    <div className="h-full w-[280px] flex flex-col">
      <div className="h-11 px-3 flex items-center justify-between border-b border-edge shrink-0">
        <span className="label">In-call chat</span>
        <IconButton label="Close" size="sm" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>

      <div className="flex-1 scroll-y p-3 space-y-2.5">
        {lines.length === 0 && (
          <p className="text-2xs text-muted text-center py-6">
            Messages here last only as long as the call.
          </p>
        )}
        {lines.map((l) => {
          const me = l.authorId === profile.id;
          const author = me ? profile : peers[l.authorId];
          return (
            <div key={l.id} className="flex gap-2">
              <Avatar
                name={author?.name ?? 'Peer'}
                color={author?.color}
                emoji={author?.emoji}
                size={22}
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-2xs font-medium truncate">
                    {me ? 'You' : (author?.name ?? 'Peer')}
                  </span>
                  <span className="text-[10px] text-muted">{clockTime(l.ts)}</span>
                </div>
                <p className="text-xs text-dim break-words">{l.body}</p>
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      <div className="p-2 border-t border-edge shrink-0 flex gap-1.5">
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Message…"
          className="flex-1 h-8 bg-raised border border-edge rounded-input px-2.5 text-xs focus:border-gold/60"
        />
        <IconButton label="Send" size="md" variant="primary" onClick={send}>
          <Send size={13} />
        </IconButton>
      </div>
    </div>
  );
}
