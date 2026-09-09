import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Upload } from 'lucide-react';
import { Avatar } from '../../components/Avatar';
import { Empty } from '../../components/ui';
import { MessageItem } from './MessageItem';
import { useStore } from '../../lib/store';
import { dayKey, dayLabel } from '../../lib/utils';
import type { Message, Room } from '../../lib/types';

const GROUP_WINDOW_MS = 5 * 60 * 1000;

export function MessageList({
  room,
  highlight,
  onReply,
  onOpenThread,
  onDropFiles,
}: {
  room: Room;
  highlight?: string;
  onReply: (m: Message) => void;
  onOpenThread: (m: Message) => void;
  onDropFiles: (files: File[]) => void;
}) {
  const all = useStore((s) => s.messages[room.id] ?? []);
  const typing = useStore((s) => s.typing[room.id]);
  const peers = useStore((s) => s.peers);
  const profile = useStore((s) => s.profile);

  const scroller = React.useRef<HTMLDivElement>(null);
  const [pinnedToBottom, setPinnedToBottom] = React.useState(true);
  const [dragOver, setDragOver] = React.useState(false);

  // Only top-level messages appear in the main transcript; thread replies live
  // in the side panel and are counted here.
  const messages = React.useMemo(() => all.filter((m) => !m.threadRoot), [all]);
  const threadCounts = React.useMemo(() => {
    const counts: Record<string, number> = {};
    for (const m of all) if (m.threadRoot) counts[m.threadRoot] = (counts[m.threadRoot] ?? 0) + 1;
    return counts;
  }, [all]);

  React.useEffect(() => {
    if (pinnedToBottom) {
      scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
    }
  }, [messages.length, pinnedToBottom]);

  const typingNames = Object.keys(typing ?? {})
    .map((id) => peers[id]?.name)
    .filter(Boolean) as string[];

  if (!messages.length) {
    return (
      <div className="flex-1 min-h-0 grid place-items-center">
        <Empty
          title={`This is the start of ${room.name}`}
          hint={
            room.kind === 'broadcast'
              ? 'Only you can post here. Everyone on the network receives it.'
              : 'Messages, files and voice notes travel directly between devices — nothing passes through a server.'
          }
        />
      </div>
    );
  }

  return (
    <div
      className="flex-1 min-h-0 relative"
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget === e.target) setDragOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        onDropFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          setPinnedToBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 80);
        }}
        className="h-full scroll-y py-3"
      >
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const newDay = !prev || dayKey(prev.ts) !== dayKey(m.ts);
          const grouped =
            !newDay &&
            !!prev &&
            prev.authorId === m.authorId &&
            !prev.system &&
            !m.system &&
            m.ts - prev.ts < GROUP_WINDOW_MS &&
            !m.replyTo;

          return (
            <React.Fragment key={m.id}>
              {newDay && <DayDivider ts={m.ts} />}
              <MessageItem
                message={m}
                grouped={grouped}
                isPinned={room.pinned.includes(m.id)}
                highlight={highlight}
                threadCount={threadCounts[m.id] ?? 0}
                onReply={() => onReply(m)}
                onOpenThread={() => onOpenThread(m)}
              />
            </React.Fragment>
          );
        })}

        <AnimatePresence>
          {typingNames.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-2.5 px-4 py-2"
            >
              <div className="w-8 flex justify-end pr-1">
                <Avatar
                  name={typingNames[0]}
                  color={Object.values(peers).find((p) => p.name === typingNames[0])?.color}
                  emoji={Object.values(peers).find((p) => p.name === typingNames[0])?.emoji}
                  size={20}
                />
              </div>
              <div className="flex items-center gap-2">
                <span className="flex gap-[3px] items-end h-3">
                  {[0, 1, 2].map((i) => (
                    <span
                      key={i}
                      className="h-1.5 w-1.5 rounded-full bg-gold animate-typing-dot"
                      style={{ animationDelay: `${i * 140}ms` }}
                    />
                  ))}
                </span>
                <span className="text-2xs text-muted">
                  {typingNames.slice(0, 3).join(', ')}
                  {typingNames.length > 3 ? ` and ${typingNames.length - 3} more` : ''}{' '}
                  {typingNames.length === 1 ? 'is' : 'are'} typing…
                </span>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {dragOver && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="absolute inset-3 rounded-modal border-2 border-dashed border-gold bg-gold/10 grid place-items-center pointer-events-none z-30"
          >
            <div className="text-center">
              <Upload size={26} className="mx-auto text-gold mb-2" />
              <div className="text-sm font-medium text-gold">Drop to attach</div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function DayDivider({ ts }: { ts: number }) {
  return (
    <div className="flex items-center gap-3 px-4 my-3">
      <span className="flex-1 h-px bg-edge" />
      <span className="text-2xs text-muted font-medium shrink-0">{dayLabel(ts)}</span>
      <span className="flex-1 h-px bg-edge" />
    </div>
  );
}
