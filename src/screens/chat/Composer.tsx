import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Bold,
  Clock,
  Code,
  Film,
  Italic,
  Mic,
  Paperclip,
  Quote,
  Send,
  Smile,
  Sticker as StickerIcon,
  Strikethrough,
  Trash2,
  X,
} from 'lucide-react';
import { Avatar } from '../../components/Avatar';
import { Button, IconButton, Modal, Tooltip } from '../../components/ui';
import { EmojiPicker, MotionPicker, StickerPicker } from './Pickers';
import { useStore } from '../../lib/store';
import { useClickOutside } from '../../lib/hooks';
import { api } from '../../lib/bridge';
import { attachmentFromFile } from '../../lib/actions';
import { cn, fileToDataUrl, formatDuration, mimeKind } from '../../lib/utils';
import type { Attachment, Room, VoiceClip } from '../../lib/types';

export function Composer({
  room,
  replyTo,
  onCancelReply,
  threadRoot,
}: {
  room: Room;
  replyTo?: { id: string; author: string; excerpt: string } | null;
  onCancelReply?: () => void;
  threadRoot?: string;
}) {
  const draft = useStore((s) => s.drafts[room.id] ?? '');
  const setDraft = useStore((s) => s.setDraft);
  const sendMessage = useStore((s) => s.sendMessage);
  const peers = useStore((s) => s.peers);

  const [picker, setPicker] = React.useState<'emoji' | 'sticker' | 'motion' | null>(null);
  const [attachments, setAttachments] = React.useState<Attachment[]>([]);
  const [mentionQuery, setMentionQuery] = React.useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = React.useState(0);
  const [selection, setSelection] = React.useState<{ start: number; end: number } | null>(null);
  const [scheduleOpen, setScheduleOpen] = React.useState(false);
  const [pastePreview, setPastePreview] = React.useState<Attachment | null>(null);

  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const pickerRef = useClickOutside<HTMLDivElement>(() => setPicker(null));

  const members = room.members.map((id) => peers[id]).filter(Boolean);
  const mentionMatches = React.useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return members.filter((m) => m.name.toLowerCase().startsWith(q)).slice(0, 6);
  }, [mentionQuery, members]);

  const autoGrow = React.useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(160, el.scrollHeight)}px`;
  }, []);

  React.useEffect(autoGrow, [draft, autoGrow]);

  const onChange = (value: string) => {
    setDraft(room.id, value);
    void api.chat.typing(room.id);
    const caret = textareaRef.current?.selectionStart ?? value.length;
    const before = value.slice(0, caret);
    const m = before.match(/(?:^|\s)@([A-Za-z0-9_\-.]*)$/);
    setMentionQuery(m ? m[1] : null);
    setMentionIndex(0);
  };

  const insertMention = (name: string) => {
    const el = textareaRef.current;
    if (!el) return;
    const caret = el.selectionStart;
    const before = draft.slice(0, caret).replace(/@([A-Za-z0-9_\-.]*)$/, `@${name} `);
    const next = before + draft.slice(caret);
    setDraft(room.id, next);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, before.length);
    });
  };

  const wrap = (prefix: string, suffix = prefix) => {
    const el = textareaRef.current;
    if (!el) return;
    const { selectionStart: a, selectionEnd: b } = el;
    const next = draft.slice(0, a) + prefix + draft.slice(a, b) + suffix + draft.slice(b);
    setDraft(room.id, next);
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(a + prefix.length, b + prefix.length);
    });
  };

  const insert = (text: string) => {
    const el = textareaRef.current;
    const caret = el?.selectionStart ?? draft.length;
    const next = draft.slice(0, caret) + text + draft.slice(caret);
    setDraft(room.id, next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(caret + text.length, caret + text.length);
    });
  };

  const send = (scheduledFor?: number) => {
    const body = draft.trim();
    if (!body && !attachments.length) return;
    const mentions = members
      .filter((m) => new RegExp(`@${m.name}\\b`, 'i').test(body))
      .map((m) => m.id);
    sendMessage(room.id, {
      body,
      attachments,
      mentions,
      replyTo: replyTo?.id,
      threadRoot,
      scheduledFor,
      pending: !!scheduledFor,
    });
    setDraft(room.id, '');
    setAttachments([]);
    onCancelReply?.();
    requestAnimationFrame(autoGrow);
  };

  const sendSticker = (id: string) => {
    sendMessage(room.id, { sticker: id, threadRoot, replyTo: replyTo?.id });
    setPicker(null);
    onCancelReply?.();
  };

  const sendMotion = (id: string) => {
    sendMessage(room.id, { gif: id, threadRoot, replyTo: replyTo?.id });
    setPicker(null);
    onCancelReply?.();
  };

  const addFiles = async (files: File[]) => {
    const next: Attachment[] = [];
    for (const f of files) {
      const isImage = mimeKind(f.type, f.name) === 'image';
      next.push(attachmentFromFile(f, isImage ? await fileToDataUrl(f) : undefined));
    }
    setAttachments((a) => [...a, ...next]);
  };

  const onPaste = async (e: React.ClipboardEvent) => {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith('image/'));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    e.preventDefault();
    setPastePreview(attachmentFromFile(file, await fileToDataUrl(file)));
  };

  const canSend = draft.trim().length > 0 || attachments.length > 0;

  return (
    <div className="shrink-0 border-t border-edge bg-surface p-2.5 safe-b">
      {/* reply banner */}
      <AnimatePresence>
        {replyTo && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="flex items-center gap-2 mb-2 px-2.5 py-1.5 rounded-input bg-raised border-l-2 border-gold">
              <div className="min-w-0 flex-1">
                <div className="text-2xs text-gold font-medium">
                  Replying to {replyTo.author}
                </div>
                <div className="text-2xs text-muted truncate">{replyTo.excerpt}</div>
              </div>
              <IconButton label="Cancel reply" size="xs" onClick={onCancelReply}>
                <X size={11} />
              </IconButton>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* attachments */}
      {attachments.length > 0 && (
        <div className="flex gap-2 mb-2 overflow-x-auto no-scrollbar">
          {attachments.map((a) => (
            <div
              key={a.id}
              className="relative shrink-0 rounded-input border border-edge bg-raised overflow-hidden"
            >
              {a.dataUrl ? (
                <img src={a.dataUrl} alt={a.name} className="h-16 w-16 object-cover" />
              ) : (
                <div className="h-16 w-24 grid place-items-center px-2">
                  <span className="text-2xs text-dim truncate">{a.name}</span>
                </div>
              )}
              <button
                onClick={() => setAttachments((x) => x.filter((y) => y.id !== a.id))}
                className="absolute top-0.5 right-0.5 h-4 w-4 rounded-full glass border border-edge grid place-items-center"
                aria-label="Remove attachment"
              >
                <X size={9} />
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="relative">
        {/* mention autocomplete */}
        <AnimatePresence>
          {mentionMatches.length > 0 && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 6 }}
              className="absolute bottom-full mb-1.5 left-0 w-56 glass border border-edge-strong rounded-card shadow-xl overflow-hidden z-30"
            >
              {mentionMatches.map((m, i) => (
                <button
                  key={m.id}
                  onMouseEnter={() => setMentionIndex(i)}
                  onClick={() => insertMention(m.name)}
                  className={cn(
                    'w-full flex items-center gap-2 px-2.5 h-8 text-left',
                    i === mentionIndex ? 'bg-gold/15' : 'hover:bg-raised',
                  )}
                >
                  <Avatar name={m.name} color={m.color} emoji={m.emoji} size={18} />
                  <span className="text-xs truncate">{m.name}</span>
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>

        {/* selection formatting toolbar */}
        <AnimatePresence>
          {selection && selection.end > selection.start && (
            <motion.div
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 4 }}
              className="absolute bottom-full mb-1.5 right-0 flex gap-0.5 glass border border-edge rounded-input p-0.5 z-30"
            >
              <FormatButton label="Bold" onClick={() => wrap('**')}>
                <Bold size={12} />
              </FormatButton>
              <FormatButton label="Italic" onClick={() => wrap('*')}>
                <Italic size={12} />
              </FormatButton>
              <FormatButton label="Strikethrough" onClick={() => wrap('~~')}>
                <Strikethrough size={12} />
              </FormatButton>
              <FormatButton label="Code" onClick={() => wrap('`')}>
                <Code size={12} />
              </FormatButton>
              <FormatButton label="Quote" onClick={() => wrap('\n> ', '')}>
                <Quote size={12} />
              </FormatButton>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-end gap-1.5">
          <div className="flex gap-0.5 pb-1">
            <IconButton label="Attach files" onClick={() => fileRef.current?.click()}>
              <Paperclip size={15} />
            </IconButton>
            <VoiceRecorder
              onSend={(voice) => {
                sendMessage(room.id, { voice, threadRoot });
              }}
            />
          </div>

          <textarea
            ref={textareaRef}
            value={draft}
            rows={1}
            onChange={(e) => onChange(e.target.value)}
            onPaste={onPaste}
            onSelect={(e) => {
              const el = e.currentTarget;
              setSelection({ start: el.selectionStart, end: el.selectionEnd });
            }}
            onBlur={() => setTimeout(() => setSelection(null), 150)}
            onKeyDown={(e) => {
              if (mentionMatches.length) {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setMentionIndex((i) => (i + 1) % mentionMatches.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setMentionIndex(
                    (i) => (i - 1 + mentionMatches.length) % mentionMatches.length,
                  );
                  return;
                }
                if (e.key === 'Enter' || e.key === 'Tab') {
                  e.preventDefault();
                  insertMention(mentionMatches[mentionIndex].name);
                  return;
                }
                if (e.key === 'Escape') {
                  setMentionQuery(null);
                  return;
                }
              }
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={
              room.kind === 'broadcast'
                ? 'Broadcast to everyone…'
                : `Message ${room.name}`
            }
            className="flex-1 min-h-[34px] max-h-40 bg-raised border border-edge rounded-card px-3 py-2 text-sm resize-none focus:border-gold/60 focus:ring-1 focus:ring-gold/30 placeholder:text-muted"
          />

          <div ref={pickerRef} className="relative flex gap-0.5 pb-1">
            <AnimatePresence>
              {picker && (
                <div className="absolute bottom-full right-0 mb-2 z-40">
                  {picker === 'emoji' && <EmojiPicker onPick={insert} />}
                  {picker === 'sticker' && <StickerPicker onPick={sendSticker} />}
                  {picker === 'motion' && <MotionPicker onPick={sendMotion} />}
                </div>
              )}
            </AnimatePresence>

            <IconButton
              label="Emoji"
              active={picker === 'emoji'}
              onClick={() => setPicker(picker === 'emoji' ? null : 'emoji')}
            >
              <Smile size={15} />
            </IconButton>
            <IconButton
              label="Stickers"
              active={picker === 'sticker'}
              onClick={() => setPicker(picker === 'sticker' ? null : 'sticker')}
            >
              <StickerIcon size={15} />
            </IconButton>
            <IconButton
              label="Motion pack"
              active={picker === 'motion'}
              onClick={() => setPicker(picker === 'motion' ? null : 'motion')}
            >
              <Film size={15} />
            </IconButton>
            <IconButton
              label="Schedule message"
              disabled={!canSend}
              onClick={() => setScheduleOpen(true)}
            >
              <Clock size={15} />
            </IconButton>
            <IconButton
              label="Send"
              variant={canSend ? 'primary' : 'ghost'}
              disabled={!canSend}
              onClick={() => send()}
            >
              <Send size={15} />
            </IconButton>
          </div>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void addFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />

      <ScheduleModal
        open={scheduleOpen}
        onClose={() => setScheduleOpen(false)}
        onSchedule={(ts) => {
          send(ts);
          setScheduleOpen(false);
        }}
      />

      <Modal
        open={!!pastePreview}
        onClose={() => setPastePreview(null)}
        title="Send pasted image?"
        footer={
          <>
            <Button onClick={() => setPastePreview(null)}>Cancel</Button>
            <Button
              variant="primary"
              onClick={() => {
                if (pastePreview) setAttachments((a) => [...a, pastePreview]);
                setPastePreview(null);
              }}
            >
              Attach
            </Button>
          </>
        }
      >
        {pastePreview?.dataUrl && (
          <img
            src={pastePreview.dataUrl}
            alt="Pasted"
            className="max-h-64 mx-auto rounded-card border border-edge"
          />
        )}
      </Modal>
    </div>
  );
}

function FormatButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip content={label}>
      <button
        onMouseDown={(e) => {
          e.preventDefault();
          onClick();
        }}
        aria-label={label}
        className="h-6 w-6 rounded-[4px] grid place-items-center text-dim hover:text-txt hover:bg-raised"
      >
        {children}
      </button>
    </Tooltip>
  );
}

/* ------------------------------------------------------------ Voice notes */

function VoiceRecorder({ onSend }: { onSend: (v: VoiceClip) => void }) {
  const [recording, setRecording] = React.useState(false);
  const [ms, setMs] = React.useState(0);
  const [peaks, setPeaks] = React.useState<number[]>([]);
  const toast = useStore((s) => s.toast);

  const media = React.useRef<{
    recorder: MediaRecorder;
    stream: MediaStream;
    ctx: AudioContext;
    chunks: Blob[];
  } | null>(null);
  const raf = React.useRef<number>();
  const timer = React.useRef<number>();

  const stopAll = React.useCallback(() => {
    cancelAnimationFrame(raf.current!);
    clearInterval(timer.current);
    const m = media.current;
    if (m) {
      if (m.recorder.state !== 'inactive') m.recorder.stop();
      m.stream.getTracks().forEach((t) => t.stop());
      void m.ctx.close();
    }
    media.current = null;
  }, []);

  React.useEffect(() => stopAll, [stopAll]);

  const start = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      ctx.createMediaStreamSource(stream).connect(analyser);

      const recorder = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      recorder.ondataavailable = (e) => chunks.push(e.data);
      recorder.start();

      media.current = { recorder, stream, ctx, chunks };
      setRecording(true);
      setMs(0);
      setPeaks([]);

      const started = Date.now();
      timer.current = window.setInterval(() => setMs(Date.now() - started), 100);

      const data = new Uint8Array(analyser.frequencyBinCount);
      let last = 0;
      const sample = () => {
        analyser.getByteTimeDomainData(data);
        const now = Date.now();
        if (now - last > 90) {
          last = now;
          let peak = 0;
          for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
          setPeaks((p) => [...p, Math.min(1, peak * 1.6)].slice(-64));
        }
        raf.current = requestAnimationFrame(sample);
      };
      sample();
    } catch {
      toast({
        kind: 'error',
        title: 'Microphone unavailable',
        body: 'Grant microphone access to record voice messages.',
      });
    }
  };

  const finish = (send: boolean) => {
    const m = media.current;
    const duration = ms;
    const captured = [...peaks];
    if (m && send) {
      m.recorder.onstop = async () => {
        const blob = new Blob(m.chunks, { type: 'audio/webm' });
        const url = URL.createObjectURL(blob);
        onSend({ durationMs: duration, peaks: captured, dataUrl: url });
      };
    }
    stopAll();
    setRecording(false);
    setMs(0);
    setPeaks([]);
  };

  if (!recording) {
    return (
      <IconButton label="Record voice message" onClick={() => void start()}>
        <Mic size={15} />
      </IconButton>
    );
  }

  return (
    <div className="flex items-center gap-1.5 h-8 px-2 rounded-input bg-danger/10 border border-danger/40">
      <span className="h-1.5 w-1.5 rounded-full bg-danger animate-pulse shrink-0" />
      <span className="text-2xs font-mono text-danger tabular-nums w-9">
        {formatDuration(ms)}
      </span>
      <div className="flex items-end gap-[1px] h-4 w-20 overflow-hidden">
        {peaks.slice(-26).map((p, i) => (
          <span
            key={i}
            className="w-[2px] bg-danger rounded-full shrink-0"
            style={{ height: `${Math.max(12, p * 100)}%` }}
          />
        ))}
      </div>
      <IconButton label="Discard" size="xs" onClick={() => finish(false)}>
        <Trash2 size={11} />
      </IconButton>
      <IconButton label="Send voice message" size="xs" variant="primary" onClick={() => finish(true)}>
        <Send size={11} />
      </IconButton>
    </div>
  );
}

/* -------------------------------------------------------------- Schedule */

function ScheduleModal({
  open,
  onClose,
  onSchedule,
}: {
  open: boolean;
  onClose: () => void;
  onSchedule: (ts: number) => void;
}) {
  const [value, setValue] = React.useState('');

  React.useEffect(() => {
    if (!open) return;
    const d = new Date(Date.now() + 60 * 60 * 1000);
    d.setSeconds(0, 0);
    setValue(
      `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`,
    );
  }, [open]);

  const ts = value ? new Date(value).getTime() : 0;
  const valid = ts > Date.now();

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Schedule message"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!valid} onClick={() => onSchedule(ts)}>
            Schedule
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <p className="text-xs text-dim">
          The message is held on this device and sent when the time arrives — no server is
          involved, so LANTern must be running.
        </p>
        <input
          type="datetime-local"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full h-9 bg-raised border border-edge rounded-input px-2.5 text-sm focus:border-gold/60"
        />
        {value && !valid && <p className="text-2xs text-danger">Pick a time in the future.</p>}
      </div>
    </Modal>
  );
}
