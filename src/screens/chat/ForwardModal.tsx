import React from 'react';
import { Hash, Radio, Search, Check } from 'lucide-react';
import { Avatar } from '../../components/Avatar';
import { Button, Input, Modal } from '../../components/ui';
import { useStore } from '../../lib/store';
import { cn } from '../../lib/utils';

/**
 * Where to send one or more messages that are being forwarded.
 *
 * A plain room picker rather than a fresh compose flow: forwarding always
 * goes to an existing chat, never starts a new one, so there is nothing here
 * that `createRoom`'s own modal already has to offer.
 */
export function ForwardModal({
  open,
  messageIds,
  onClose,
}: {
  open: boolean;
  messageIds: string[];
  onClose: () => void;
}) {
  const rooms = useStore((s) => s.rooms);
  const forwardMessage = useStore((s) => s.forwardMessage);
  const [query, setQuery] = React.useState('');
  const [targets, setTargets] = React.useState<Set<string>>(new Set());
  const [sending, setSending] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setQuery('');
      setTargets(new Set());
      setSending(false);
    }
  }, [open]);

  const list = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const all = Object.values(rooms);
    return (q ? all.filter((r) => r.name.toLowerCase().includes(q)) : all).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [rooms, query]);

  const toggle = (id: string) =>
    setTargets((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const send = async () => {
    setSending(true);
    const targetIds = [...targets];
    // One message at a time, in the order they were selected - a forward of
    // several messages should land in the same order it was picked in, the
    // same reason a normal multi-file send does not reorder its files.
    for (const id of messageIds) await forwardMessage(id, targetIds);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={messageIds.length > 1 ? `Forward ${messageIds.length} messages` : 'Forward message'}
      width="max-w-sm"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!targets.size || sending} onClick={() => void send()}>
            {targets.size > 1 ? `Forward to ${targets.size} chats` : 'Forward'}
          </Button>
        </>
      }
    >
      <Input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search chats…"
        icon={<Search size={13} />}
        className="h-9 text-sm mb-3"
      />

      {list.length === 0 ? (
        <p className="text-2xs text-muted text-center py-8">No chats match “{query}”.</p>
      ) : (
        <ul className="space-y-1 max-h-72 overflow-y-auto">
          {list.map((r) => {
            const on = targets.has(r.id);
            return (
              <li key={r.id}>
                <button
                  onClick={() => toggle(r.id)}
                  className={cn(
                    'w-full flex items-center gap-2.5 px-2 h-11 rounded-input border transition-colors',
                    on ? 'border-gold/50 bg-gold/10' : 'border-edge bg-raised hover:border-edge-strong',
                  )}
                >
                  <Avatar
                    name={r.name}
                    size={28}
                    muted={r.kind !== 'dm'}
                    icon={
                      r.kind === 'broadcast' ? (
                        <Radio size={14} />
                      ) : r.kind !== 'dm' ? (
                        <Hash size={14} />
                      ) : undefined
                    }
                  />
                  <span className="text-xs flex-1 truncate text-left">{r.name}</span>
                  <span
                    className={cn(
                      'h-4 w-4 rounded-full border grid place-items-center shrink-0',
                      on ? 'bg-gold border-gold text-on-gold' : 'border-edge-strong',
                    )}
                  >
                    {on && <Check size={10} strokeWidth={3} />}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
