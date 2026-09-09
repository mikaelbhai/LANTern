import React from 'react';
import { X } from 'lucide-react';
import { IconButton } from '../../components/ui';
import { MessageItem } from './MessageItem';
import { Composer } from './Composer';
import { useStore } from '../../lib/store';
import type { Room } from '../../lib/types';

export function ThreadPanel({ room, rootId }: { room: Room; rootId: string }) {
  const messages = useStore((s) => s.messages[room.id] ?? []);
  const openThread = useStore((s) => s.openThread);

  const root = messages.find((m) => m.id === rootId);
  const replies = messages.filter((m) => m.threadRoot === rootId);

  if (!root) return null;

  return (
    <div className="h-full flex flex-col w-[340px]">
      <header className="h-11 shrink-0 px-3 flex items-center justify-between border-b border-edge">
        <div>
          <span className="text-xs font-semibold">Thread</span>
          <span className="text-2xs text-muted ml-2">
            {replies.length} {replies.length === 1 ? 'reply' : 'replies'}
          </span>
        </div>
        <IconButton label="Close thread" size="sm" onClick={() => openThread(null)}>
          <X size={14} />
        </IconButton>
      </header>

      <div className="flex-1 scroll-y py-3">
        <MessageItem
          message={root}
          grouped={false}
          isPinned={room.pinned.includes(root.id)}
          threadCount={0}
          onReply={() => {}}
          onOpenThread={() => {}}
        />
        <div className="flex items-center gap-3 px-4 my-2">
          <span className="flex-1 h-px bg-edge" />
          <span className="text-2xs text-muted shrink-0">
            {replies.length ? 'Replies' : 'No replies yet'}
          </span>
          <span className="flex-1 h-px bg-edge" />
        </div>
        {replies.map((m, i) => (
          <MessageItem
            key={m.id}
            message={m}
            grouped={i > 0 && replies[i - 1].authorId === m.authorId}
            isPinned={false}
            threadCount={0}
            onReply={() => {}}
            onOpenThread={() => {}}
          />
        ))}
      </div>

      <Composer room={room} threadRoot={rootId} />
    </div>
  );
}
