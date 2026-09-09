import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Bookmark,
  Check,
  CheckCheck,
  Copy,
  CornerUpLeft,
  MessageSquare,
  MoreHorizontal,
  Pause,
  Pencil,
  Pin,
  Play,
  Reply,
  Smile,
  Trash2,
} from 'lucide-react';
import { Avatar } from '../../components/Avatar';
import { Badge, IconButton, Tooltip } from '../../components/ui';
import { EmojiPicker } from './Pickers';
import { Markdown, isJumboEmoji } from '../../lib/markdown';
import { MotionClip, Sticker } from '../../lib/stickers';
import { QUICK_REACTIONS } from '../../lib/emoji';
import { useStore } from '../../lib/store';
import { useClickOutside } from '../../lib/hooks';
import {
  clockTime,
  cn,
  exactTime,
  formatBytes,
  formatDuration,
  relativeTime,
} from '../../lib/utils';
import type { Attachment, Message, VoiceClip } from '../../lib/types';
import { copyText } from '../../lib/clipboard';

const EDIT_WINDOW_MS = 30 * 60 * 1000;

export function MessageItem({
  message: m,
  grouped,
  isPinned,
  highlight,
  onReply,
  onOpenThread,
  threadCount,
}: {
  message: Message;
  grouped: boolean;
  isPinned: boolean;
  highlight?: string;
  onReply: () => void;
  onOpenThread: () => void;
  threadCount: number;
}) {
  const profile = useStore((s) => s.profile);
  const peers = useStore((s) => s.peers);
  const rooms = useStore((s) => s.rooms);
  const saved = useStore((s) => s.saved);
  const density = useStore((s) => s.settings.density);
  const toggleReaction = useStore((s) => s.toggleReaction);
  const togglePin = useStore((s) => s.togglePin);
  const toggleSaved = useStore((s) => s.toggleSaved);
  const editMessage = useStore((s) => s.editMessage);
  const deleteMessage = useStore((s) => s.deleteMessage);
  const messages = useStore((s) => s.messages[m.roomId] ?? []);

  const [hovered, setHovered] = React.useState(false);
  const [menuOpen, setMenuOpen] = React.useState(false);
  const [pickerOpen, setPickerOpen] = React.useState(false);
  const [editing, setEditing] = React.useState(false);
  const [editValue, setEditValue] = React.useState(m.body);
  const [copied, setCopied] = React.useState(false);
  // Tapping a message picks it out of the run, which is how you keep your
  // place in a long conversation on a phone where hovering does not exist.
  const [focused, setFocused] = React.useState(false);

  const copyBody = async () => {
    const ok = await copyText(m.body);
    if (!ok) return;
    setCopied(true);
    setTimeout(() => setCopied(false), 1400);
  };

  const menuRef = useClickOutside<HTMLDivElement>(() => setMenuOpen(false));
  const pickerRef = useClickOutside<HTMLDivElement>(() => setPickerOpen(false));

  const mine = m.authorId === profile.id;
  const author = mine ? profile : peers[m.authorId];
  const room = rooms[m.roomId];
  const canEdit = mine && Date.now() - m.ts < EDIT_WINDOW_MS && !m.deleted;
  const isSaved = saved.includes(m.id);
  const mentionsMe = m.mentions.includes(profile.id);

  const replyParent = m.replyTo ? messages.find((x) => x.id === m.replyTo) : null;
  const replyAuthor = replyParent
    ? replyParent.authorId === profile.id
      ? profile
      : peers[replyParent.authorId]
    : null;

  const mentionNames = React.useMemo(
    () =>
      new Set(
        [profile.name, ...(room?.members.map((id) => peers[id]?.name) ?? [])]
          .filter(Boolean)
          .map((n) => n!.toLowerCase()),
      ),
    [profile.name, room, peers],
  );

  const pad = { compact: 'py-0.5', cozy: 'py-1', spacious: 'py-2' }[density];

  if (m.system) {
    return (
      <div className="flex justify-center py-2">
        <Badge tone="muted">{m.body}</Badge>
      </div>
    );
  }

  const receipts = () => {
    if (!mine || m.scheduledFor) return null;
    const memberCount = room?.members.length ?? 0;
    const seen = memberCount > 0 && m.seenBy.length >= memberCount;
    const delivered = m.deliveredTo.length > 0;
    return (
      <Tooltip
        content={seen ? 'Seen by everyone' : delivered ? 'Delivered' : 'Sent'}
        delay={200}
      >
        <span className={seen ? 'text-cyan' : 'text-muted'}>
          {delivered ? <CheckCheck size={12} /> : <Check size={12} />}
        </span>
      </Tooltip>
    );
  };

  return (
    <motion.div
      layout="position"
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.1 }}
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => {
        setHovered(false);
        if (!menuOpen && !pickerOpen) setPickerOpen(false);
      }}
      id={`msg-${m.id}`}
      onClick={() => setFocused((f) => !f)}
      className={cn(
        'group relative flex gap-2.5 px-4 transition-colors selectable',
        pad,
        grouped ? 'mt-0' : 'mt-2',
        mentionsMe && 'bg-gold/[0.06] border-l-2 border-gold -ml-[2px] pl-[calc(1rem-2px)]',
        // Tapping picks a message out of the run. On a phone there is no
        // hover, so without this there is no way to say "this one".
        focused && !mentionsMe && 'bg-gold/[0.08] ring-1 ring-inset ring-gold/25',
        hovered && !focused && !mentionsMe && 'bg-raised/40',
      )}
    >
      <div className="w-8 shrink-0 pt-0.5">
        {grouped ? (
          <span className="text-[10px] text-muted opacity-0 group-hover:opacity-100 block text-right pr-1 pt-1">
            {new Date(m.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </span>
        ) : (
          <Avatar
            name={author?.name ?? 'Unknown'}
            color={author?.color}
            emoji={author?.emoji}
            size={32}
          />
        )}
      </div>

      <div className="min-w-0 flex-1">
        {!grouped && (
          <div className="flex items-baseline gap-2 mb-0.5">
            <span className="text-xs font-semibold">
              {mine ? profile.name || 'You' : (author?.name ?? 'Unknown peer')}
            </span>
            <Tooltip content={exactTime(m.ts)} delay={250}>
              <span className="text-[10px] text-muted">{relativeTime(m.ts)}</span>
            </Tooltip>
            {isPinned && (
              <Tooltip content="Pinned in this room">
                <Pin size={9} className="text-gold" />
              </Tooltip>
            )}
            {m.scheduledFor && (
              <Badge tone="gold">Sends {clockTime(m.scheduledFor)}</Badge>
            )}
          </div>
        )}

        {replyParent && (
          <button
            onClick={() =>
              document
                .getElementById(`msg-${replyParent.id}`)
                ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
            }
            className="flex items-center gap-1.5 mb-1 text-2xs text-muted hover:text-dim max-w-full"
          >
            <CornerUpLeft size={10} className="shrink-0" />
            <span className="text-gold shrink-0">{replyAuthor?.name ?? 'Unknown'}</span>
            <span className="truncate">
              {replyParent.deleted ? 'Message deleted' : replyParent.body || 'Attachment'}
            </span>
          </button>
        )}

        {m.deleted ? (
          <p className="text-xs text-muted italic">This message was deleted.</p>
        ) : editing ? (
          <EditBox
            value={editValue}
            onChange={setEditValue}
            onCancel={() => {
              setEditing(false);
              setEditValue(m.body);
            }}
            onSave={() => {
              if (editValue.trim()) editMessage(m.id, editValue.trim());
              setEditing(false);
            }}
          />
        ) : (
          <>
            {m.sticker && (
              <div className="my-1">
                <Sticker id={m.sticker} size={112} />
              </div>
            )}
            {m.gif && (
              <div className="my-1 rounded-card overflow-hidden w-fit border border-edge">
                <MotionClip id={m.gif} size={140} />
              </div>
            )}
            {m.voice && <VoiceBubble clip={m.voice} />}
            {m.body &&
              (isJumboEmoji(m.body) ? (
                <div className="text-[40px] leading-tight py-0.5">{m.body}</div>
              ) : (
                <div className="text-sm text-txt">
                  <Markdown
                    source={m.body}
                    opts={{ mentionNames, highlight }}
                  />
                </div>
              ))}
            {m.attachments.length > 0 && <Attachments items={m.attachments} />}
          </>
        )}

        <div className="flex items-center gap-2 mt-1">
          {Object.keys(m.reactions).length > 0 && (
            <div className="flex flex-wrap gap-1">
              {Object.entries(m.reactions).map(([emoji, users]) => {
                const reacted = users.includes(profile.id);
                const names = users
                  .map((id) => (id === profile.id ? 'You' : (peers[id]?.name ?? 'Unknown')))
                  .join(', ');
                return (
                  <Tooltip key={emoji} content={`${names} reacted with ${emoji}`}>
                    <button
                      onClick={() => toggleReaction(m.id, emoji)}
                      className={cn(
                        'h-[22px] px-1.5 rounded-pill border text-2xs flex items-center gap-1 transition-colors',
                        reacted
                          ? 'bg-gold/15 border-gold/50 text-gold'
                          : 'bg-raised border-edge text-dim hover:border-edge-strong',
                      )}
                    >
                      <span className="text-[13px] leading-none">{emoji}</span>
                      {users.length}
                    </button>
                  </Tooltip>
                );
              })}
            </div>
          )}

          {threadCount > 0 && (
            <button
              onClick={onOpenThread}
              className="flex items-center gap-1 text-2xs text-cyan hover:underline"
            >
              <MessageSquare size={10} />
              {threadCount} {threadCount === 1 ? 'reply' : 'replies'}
            </button>
          )}

          <div className="ml-auto flex items-center gap-1.5">
            {m.editedAt && (
              <Tooltip content={`Edited ${exactTime(m.editedAt)}`}>
                <span className="text-[10px] text-muted">(edited)</span>
              </Tooltip>
            )}
            {receipts()}
          </div>
        </div>
      </div>

      {/* hover action bar */}
      <AnimatePresence>
        {(hovered || menuOpen || pickerOpen) && !m.deleted && (
          <motion.div
            initial={{ opacity: 0, y: -3 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="absolute -top-3 right-3 flex items-center gap-0.5 glass border border-edge rounded-input p-0.5 shadow-lg z-20"
          >
            {QUICK_REACTIONS.slice(0, 4).map((e) => (
              <button
                key={e}
                onClick={() => toggleReaction(m.id, e)}
                className="h-6 w-6 rounded-[4px] grid place-items-center text-sm hover:bg-raised hover:scale-110 transition-transform"
              >
                {e}
              </button>
            ))}

            <div ref={pickerRef} className="relative">
              <button
                onClick={() => setPickerOpen(!pickerOpen)}
                aria-label="More reactions"
                className="h-6 w-6 rounded-[4px] grid place-items-center text-dim hover:text-txt hover:bg-raised"
              >
                <Smile size={13} />
              </button>
              <AnimatePresence>
                {pickerOpen && (
                  <div className="absolute top-full right-0 mt-1 z-50">
                    <EmojiPicker
                      onPick={(g) => {
                        toggleReaction(m.id, g);
                        setPickerOpen(false);
                      }}
                    />
                  </div>
                )}
              </AnimatePresence>
            </div>

            <button
              onClick={() => void copyBody()}
              aria-label={copied ? 'Copied' : 'Copy message'}
              title={copied ? 'Copied' : 'Copy message'}
              className="h-6 w-6 rounded-[4px] grid place-items-center text-dim hover:text-txt hover:bg-raised"
            >
              {copied ? <Check size={13} className="text-cyan" /> : <Copy size={13} />}
            </button>
            <button
              onClick={onReply}
              aria-label="Reply"
              className="h-6 w-6 rounded-[4px] grid place-items-center text-dim hover:text-txt hover:bg-raised"
            >
              <Reply size={13} />
            </button>
            <button
              onClick={onOpenThread}
              aria-label="Reply in thread"
              className="h-6 w-6 rounded-[4px] grid place-items-center text-dim hover:text-txt hover:bg-raised"
            >
              <MessageSquare size={13} />
            </button>

            <div ref={menuRef} className="relative">
              <button
                onClick={() => setMenuOpen(!menuOpen)}
                aria-label="More actions"
                className="h-6 w-6 rounded-[4px] grid place-items-center text-dim hover:text-txt hover:bg-raised"
              >
                <MoreHorizontal size={13} />
              </button>
              <AnimatePresence>
                {menuOpen && (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.95, y: -4 }}
                    animate={{ opacity: 1, scale: 1, y: 0 }}
                    exit={{ opacity: 0, scale: 0.95 }}
                    className="absolute top-full right-0 mt-1 w-40 glass border border-edge-strong rounded-card shadow-xl overflow-hidden z-50"
                  >
                    <MenuItem
                      icon={<Pin size={12} />}
                      onClick={() => {
                        togglePin(m.roomId, m.id);
                        setMenuOpen(false);
                      }}
                    >
                      {isPinned ? 'Unpin' : 'Pin to room'}
                    </MenuItem>
                    <MenuItem
                      icon={<Bookmark size={12} />}
                      onClick={() => {
                        toggleSaved(m.id);
                        setMenuOpen(false);
                      }}
                    >
                      {isSaved ? 'Remove bookmark' : 'Save message'}
                    </MenuItem>
                    {canEdit && (
                      <MenuItem
                        icon={<Pencil size={12} />}
                        onClick={() => {
                          setEditing(true);
                          setMenuOpen(false);
                        }}
                      >
                        Edit
                      </MenuItem>
                    )}
                    {mine && (
                      <MenuItem
                        icon={<Trash2 size={12} />}
                        danger
                        onClick={() => {
                          deleteMessage(m.id);
                          setMenuOpen(false);
                        }}
                      >
                        Delete
                      </MenuItem>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function MenuItem({
  icon,
  children,
  onClick,
  danger,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'w-full h-8 px-2.5 flex items-center gap-2 text-xs text-left transition-colors',
        danger ? 'text-danger hover:bg-danger/10' : 'text-dim hover:text-txt hover:bg-raised',
      )}
    >
      {icon}
      {children}
    </button>
  );
}

function EditBox({
  value,
  onChange,
  onSave,
  onCancel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <textarea
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            onSave();
          }
          if (e.key === 'Escape') onCancel();
        }}
        rows={2}
        className="w-full bg-raised border border-gold/50 rounded-input px-2.5 py-2 text-sm resize-none focus:ring-1 focus:ring-gold/40"
      />
      <div className="flex gap-2 text-2xs text-muted">
        <button onClick={onSave} className="text-gold hover:underline">
          Save
        </button>
        <button onClick={onCancel} className="hover:text-txt">
          Cancel
        </button>
        <span>· Enter to save, Escape to cancel</span>
      </div>
    </div>
  );
}

function Attachments({ items }: { items: Attachment[] }) {
  const images = items.filter((a) => a.kind === 'image');
  const others = items.filter((a) => a.kind !== 'image');

  return (
    <div className="mt-1.5 space-y-1.5">
      {images.length > 0 && (
        <div className={cn('flex flex-wrap gap-1.5')}>
          {images.map((a) =>
            a.dataUrl ? (
              <img
                key={a.id}
                src={a.dataUrl}
                alt={a.name}
                className="max-h-56 max-w-full rounded-card border border-edge object-cover"
              />
            ) : (
              <div
                key={a.id}
                className="h-24 w-32 rounded-card border border-edge bg-raised grid place-items-center text-2xs text-muted px-2 text-center"
              >
                {a.name}
              </div>
            ),
          )}
        </div>
      )}
      {others.map((a) => (
        <div
          key={a.id}
          className="flex items-center gap-2.5 p-2 rounded-card border border-edge bg-raised max-w-sm"
        >
          <span className="h-8 w-8 rounded-input bg-base border border-edge grid place-items-center text-2xs uppercase text-muted shrink-0">
            {a.name.split('.').pop()?.slice(0, 3)}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-xs truncate">{a.name}</div>
            <div className="text-2xs text-muted">{formatBytes(a.size)}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function VoiceBubble({ clip }: { clip: VoiceClip }) {
  const audioRef = React.useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = React.useState(false);
  const [progress, setProgress] = React.useState(0);

  const peaks = clip.peaks.length ? clip.peaks : Array.from({ length: 32 }, () => 0.4);

  const toggle = () => {
    const el = audioRef.current;
    if (!el) {
      // No decoded audio (history restored from disk) — show the waveform only.
      setPlaying((p) => !p);
      return;
    }
    if (playing) el.pause();
    else void el.play();
    setPlaying(!playing);
  };

  const seek = (e: React.MouseEvent<HTMLDivElement>) => {
    const el = audioRef.current;
    if (!el || !el.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - r.left) / r.width;
    el.currentTime = ratio * el.duration;
    setProgress(ratio);
  };

  return (
    <div className="flex items-center gap-2.5 mt-1 p-2 pr-3 rounded-pill bg-raised border border-edge w-fit max-w-full">
      {clip.dataUrl && (
        <audio
          ref={audioRef}
          src={clip.dataUrl}
          onTimeUpdate={(e) => {
            const el = e.currentTarget;
            if (el.duration) setProgress(el.currentTime / el.duration);
          }}
          onEnded={() => {
            setPlaying(false);
            setProgress(0);
          }}
          hidden
        />
      )}
      <button
        onClick={toggle}
        aria-label={playing ? 'Pause' : 'Play'}
        className="h-7 w-7 rounded-full bg-gold text-[#1a1206] grid place-items-center shrink-0"
      >
        {playing ? <Pause size={13} /> : <Play size={13} className="ml-[1px]" />}
      </button>

      <div
        onClick={seek}
        className="flex items-end gap-[2px] h-6 cursor-pointer"
        style={{ width: Math.min(180, peaks.length * 4) }}
      >
        {peaks.map((p, i) => {
          const played = i / peaks.length <= progress;
          return (
            <span
              key={i}
              className={cn(
                'w-[2px] rounded-full shrink-0 transition-colors',
                played ? 'bg-gold' : 'bg-muted',
              )}
              style={{ height: `${Math.max(14, p * 100)}%` }}
            />
          );
        })}
      </div>

      <span className="text-2xs font-mono text-dim tabular-nums shrink-0">
        {formatDuration(clip.durationMs)}
      </span>
    </div>
  );
}
