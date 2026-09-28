import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft,
  Bookmark,
  CheckSquare,
  Copy,
  Download,
  Hash,
  Images,
  MessageSquare,
  MoreVertical,
  Phone,
  Pin,
  Plus,
  Radio,
  Search,
  Trash2,
  Users,
  Video,
  X,
} from 'lucide-react';
import { Avatar } from '../components/Avatar';
import { ScreenHeader } from '../components/ScreenHeader';
import {
  Badge,
  Button,
  Empty,
  IconButton,
  Input,
  Modal,
  Segmented,
  Tooltip,
} from '../components/ui';
import { MessageList } from './chat/MessageList';
import { Composer } from './chat/Composer';
import { ThreadPanel } from './chat/ThreadPanel';
import { MediaGallery } from './chat/MediaGallery';
import { useClickOutside } from '../lib/hooks';
import { useStore } from '../lib/store';
import { useIsMobile } from '../lib/hooks';
import { attachmentFromFile } from '../lib/actions';
import { copyText } from '../lib/clipboard';
import {
  clockTime,
  cn,
  download,
  fileToDataUrl,
  mimeKind,
  whenLabel,
  relativeTime,
} from '../lib/utils';
import type { Message, Room } from '../lib/types';

export function Chats() {
  const rooms = useStore((s) => s.rooms);
  const activeRoomId = useStore((s) => s.activeRoomId);
  const openRoom = useStore((s) => s.openRoom);
  const threadRootId = useStore((s) => s.threadRootId);
  const isMobile = useIsMobile();

  const [replyTo, setReplyTo] = React.useState<Message | null>(null);
  const [galleryOpen, setGalleryOpen] = React.useState(false);
  const [pinnedOpen, setPinnedOpen] = React.useState(false);
  const [searchOpen, setSearchOpen] = React.useState(false);
  const [searchTerm, setSearchTerm] = React.useState('');
  // Picking several messages out to act on together, rather than one at a
  // time through each row's own hover menu.
  const [selectMode, setSelectMode] = React.useState(false);
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set());

  const room = activeRoomId ? rooms[activeRoomId] : null;

  React.useEffect(() => {
    setReplyTo(null);
    setPinnedOpen(false);
    setSearchTerm('');
    setSelectMode(false);
    setSelectedIds(new Set());
  }, [activeRoomId]);

  const toggleSelect = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const exitSelectMode = () => {
    setSelectMode(false);
    setSelectedIds(new Set());
  };

  const showList = !isMobile || !room;
  const showRoom = !isMobile || !!room;

  return (
    <div className="h-full flex">
      {showList && (
        <RoomList
          onOpenSearch={() => setSearchOpen(true)}
          className={isMobile ? 'flex-1' : 'w-[264px] shrink-0 border-r border-edge'}
        />
      )}

      {showRoom &&
        (room ? (
          <div className="flex-1 min-w-0 flex">
            <div className="flex-1 min-w-0 flex flex-col">
              <RoomHeader
                room={room}
                onBack={isMobile ? () => openRoom(null) : undefined}
                onGallery={() => setGalleryOpen(!galleryOpen)}
                onPinned={() => setPinnedOpen(!pinnedOpen)}
                galleryOpen={galleryOpen}
                pinnedOpen={pinnedOpen}
                searchTerm={searchTerm}
                onSearch={setSearchTerm}
                selectMode={selectMode}
                selectedIds={selectedIds}
                onEnterSelectMode={() => setSelectMode(true)}
                onExitSelectMode={exitSelectMode}
              />

              <AnimatePresence>
                {pinnedOpen && <PinnedDrawer room={room} onClose={() => setPinnedOpen(false)} />}
              </AnimatePresence>

              <MessageList
                room={room}
                highlight={searchTerm}
                onReply={setReplyTo}
                onOpenThread={(m) => useStore.getState().openThread(m.id)}
                onDropFiles={(files) => void attachAndSend(room.id, files)}
                selectMode={selectMode}
                selectedIds={selectedIds}
                onToggleSelect={toggleSelect}
              />

              <Composer
                room={room}
                replyTo={
                  replyTo
                    ? {
                        id: replyTo.id,
                        author: authorName(replyTo.authorId),
                        excerpt: replyTo.body || 'Attachment',
                      }
                    : null
                }
                onCancelReply={() => setReplyTo(null)}
              />
            </div>

            <AnimatePresence>
              {threadRootId && (
                <motion.aside
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 340, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  className="shrink-0 border-l border-edge bg-surface overflow-hidden hidden md:block"
                >
                  <ThreadPanel room={room} rootId={threadRootId} />
                </motion.aside>
              )}
              {galleryOpen && !threadRootId && (
                <motion.aside
                  initial={{ width: 0, opacity: 0 }}
                  animate={{ width: 300, opacity: 1 }}
                  exit={{ width: 0, opacity: 0 }}
                  className="shrink-0 border-l border-edge bg-surface overflow-hidden hidden lg:block"
                >
                  <MediaGallery room={room} onClose={() => setGalleryOpen(false)} />
                </motion.aside>
              )}
            </AnimatePresence>
          </div>
        ) : (
          <div className="flex-1 grid place-items-center">
            <Empty
              icon={<MessageSquare size={20} />}
              title="Pick a conversation"
              hint="Direct messages, group rooms and broadcasts all live here. Everything is stored locally on this device."
            />
          </div>
        ))}

      <GlobalSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </div>
  );
}

function authorName(id: string): string {
  const s = useStore.getState();
  return id === s.profile.id ? s.profile.name || 'You' : (s.peers[id]?.name ?? 'Unknown');
}

async function attachAndSend(roomId: string, files: File[]) {
  const s = useStore.getState();
  const attachments = [];
  for (const f of files) {
    const isImage = mimeKind(f.type, f.name) === 'image';
    attachments.push(attachmentFromFile(f, isImage ? await fileToDataUrl(f) : undefined));
  }
  s.sendMessage(roomId, { attachments });
}

/* ----------------------------------------------------------- Room list */

function RoomList({
  className,
  onOpenSearch,
}: {
  className?: string;
  onOpenSearch: () => void;
}) {
  const rooms = useStore((s) => s.rooms);
  const messages = useStore((s) => s.messages);
  const peers = useStore((s) => s.peers);
  const activeRoomId = useStore((s) => s.activeRoomId);
  const openRoom = useStore((s) => s.openRoom);
  const saved = useStore((s) => s.saved);

  const [filter, setFilter] = React.useState<'all' | 'dm' | 'group' | 'broadcast'>('all');
  const [query, setQuery] = React.useState('');
  const [newOpen, setNewOpen] = React.useState(false);
  const [savedOpen, setSavedOpen] = React.useState(false);

  const list = Object.values(rooms)
    .filter((r) => (filter === 'all' ? true : r.kind === filter))
    .filter((r) => (query ? r.name.toLowerCase().includes(query.toLowerCase()) : true))
    .sort((a, b) => {
      const la = messages[a.id]?.at(-1)?.ts ?? a.createdAt;
      const lb = messages[b.id]?.at(-1)?.ts ?? b.createdAt;
      return lb - la;
    });

  return (
    <aside className={cn('flex flex-col bg-surface/40 min-w-0', className)}>
      <ScreenHeader
        icon={<MessageSquare size={15} />}
        title="Chats"
        actions={
          <>
            <IconButton label="Saved messages" onClick={() => setSavedOpen(true)}>
              <Bookmark size={17} />
            </IconButton>
            <IconButton label="Search all rooms" onClick={onOpenSearch}>
              <Search size={17} />
            </IconButton>
            <IconButton label="New room" onClick={() => setNewOpen(true)}>
              <Plus size={19} />
            </IconButton>
          </>
        }
      />

      <div className="px-4 pt-2.5 pb-2 space-y-2.5 shrink-0">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Filter rooms…"
          icon={<Search size={15} />}
          className="h-11 rounded-full bg-raised border-transparent pl-10 text-sm"
        />
        <Segmented
          value={filter}
          onChange={setFilter}
          size="xs"
          className="w-full"
          options={[
            { value: 'all', label: 'All' },
            { value: 'dm', label: 'Direct' },
            { value: 'group', label: 'Groups' },
            { value: 'broadcast', label: 'Cast' },
          ]}
        />
      </div>

      <div className="flex-1 scroll-y">
        {list.length === 0 ? (
          <Empty
            title="No rooms yet"
            hint="Message a peer from Home, or create a group room."
            action={
              <Button size="sm" variant="primary" onClick={() => setNewOpen(true)}>
                New room
              </Button>
            }
          />
        ) : (
          <ul>
            {list.map((r) => {
              const last = messages[r.id]?.at(-1);
              const dmPeer = r.kind === 'dm' ? peers[r.members[0]] : null;
              const on = r.id === activeRoomId;
              return (
                <li key={r.id}>
                  <button
                    onClick={() => openRoom(r.id)}
                    className={cn(
                      'w-full flex items-center gap-3 pl-4 pr-3 py-2.5 text-left transition-colors',
                      'border-b border-edge/70',
                      on ? 'bg-gold/[0.08]' : 'hover:bg-raised/50',
                    )}
                  >
                    {r.kind === 'dm' ? (
                      <Avatar
                        name={dmPeer?.name ?? r.name}
                        color={dmPeer?.color}
                        emoji={dmPeer?.emoji}
                        src={dmPeer?.avatar}
                        size={44}
                      />
                    ) : (
                      <span
                        className={cn(
                          'h-11 w-11 rounded-full grid place-items-center border border-edge',
                          'bg-raised text-dim shrink-0',
                        )}
                      >
                        {r.kind === 'broadcast' ? <Radio size={20} /> : <Hash size={20} />}
                      </span>
                    )}

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-[15px] leading-tight font-medium truncate flex-1">
                          {r.name}
                        </span>
                        {last && (
                          <span className="text-2xs text-muted shrink-0">
                            {whenLabel(last.ts)}
                          </span>
                        )}
                      </div>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-dim truncate flex-1">
                          {last
                            ? last.deleted
                              ? 'Message deleted'
                              : last.body ||
                                (last.voice
                                  ? 'Voice message'
                                  : last.sticker || last.gif
                                    ? 'Sticker'
                                    : 'Attachment')
                            : 'No messages yet'}
                        </span>
                        {r.unread > 0 && (
                          <span className="min-w-[20px] h-5 px-1.5 grid place-items-center rounded-full bg-gold text-on-gold text-2xs font-semibold shrink-0">
                            {r.unread > 99 ? '99+' : r.unread}
                          </span>
                        )}
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <NewRoomModal open={newOpen} onClose={() => setNewOpen(false)} />
      <SavedModal open={savedOpen} onClose={() => setSavedOpen(false)} ids={saved} />
    </aside>
  );
}

/* --------------------------------------------------------- Room header */

function RoomHeader({
  room,
  onBack,
  onGallery,
  onPinned,
  galleryOpen,
  pinnedOpen,
  searchTerm,
  onSearch,
  selectMode,
  selectedIds,
  onEnterSelectMode,
  onExitSelectMode,
}: {
  room: Room;
  onBack?: () => void;
  onGallery: () => void;
  onPinned: () => void;
  galleryOpen: boolean;
  pinnedOpen: boolean;
  searchTerm: string;
  onSearch: (v: string) => void;
  selectMode: boolean;
  selectedIds: Set<string>;
  onEnterSelectMode: () => void;
  onExitSelectMode: () => void;
}) {
  const peers = useStore((s) => s.peers);
  const messages = useStore((s) => s.messages[room.id] ?? []);
  const startCall = useStore((s) => s.startCall);
  const deleteRoom = useStore((s) => s.deleteRoom);
  const deleteMessage = useStore((s) => s.deleteMessage);
  const [searching, setSearching] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [membersOpen, setMembersOpen] = React.useState(false);

  const authorNameFor = (authorId: string) =>
    authorId === useStore.getState().profile.id
      ? useStore.getState().profile.name || 'You'
      : (peers[authorId]?.name ?? 'Unknown');

  const copySelected = async () => {
    const text = messages
      .filter((m) => selectedIds.has(m.id))
      .sort((a, b) => a.ts - b.ts)
      .map((m) => `[${clockTime(m.ts)}] ${authorNameFor(m.authorId)}: ${m.deleted ? '(deleted)' : m.body || '(attachment)'}`)
      .join('\n');
    await copyText(text);
    onExitSelectMode();
  };

  const deleteSelected = () => {
    for (const id of selectedIds) deleteMessage(id);
    onExitSelectMode();
  };

  const dmPeer = room.kind === 'dm' ? peers[room.members[0]] : null;
  const online = room.members.filter((id) => peers[id]).length;

  const exportRoom = (format: 'txt' | 'json') => {
    if (format === 'json') {
      download(
        `${room.name.replace(/\W+/g, '-')}.json`,
        JSON.stringify({ room, messages }, null, 2),
        'application/json',
      );
      return;
    }
    const text = messages
      .map((m) => {
        const who =
          m.authorId === useStore.getState().profile.id
            ? useStore.getState().profile.name || 'You'
            : (peers[m.authorId]?.name ?? 'Unknown');
        return `[${clockTime(m.ts)}] ${who}: ${m.deleted ? '(deleted)' : m.body}`;
      })
      .join('\n');
    download(`${room.name.replace(/\W+/g, '-')}.txt`, text);
  };

  return (
    /*
      On a phone this IS the title bar - the app's own stands down while a
      room is open, because two bars and a composer left about four messages
      of screen. Hence the status-bar inset and the height, which only apply
      when it is doing that job.
    */
    <header className="shrink-0 border-b border-edge bg-surface safe-t">
      {/*
        The safe-area inset lives on this outer element, with no height of
        its own to compete with it — `h-14 safe-t` on the same box fixed the
        header at 56px total and then asked padding-top to eat into that
        fixed budget for the status bar, which on a phone that actually
        reports an inset left about thirty-two pixels for a 34px avatar and
        two lines of text. The row below always gets its full height; the
        inset adds to the top of the box instead of subtracting from what
        was already inside it.
      */}
      {selectMode ? (
        <div className="flex items-center px-2 gap-2 h-14 md:h-11 md:px-3">
          <IconButton label="Cancel" onClick={onExitSelectMode}>
            <X size={18} />
          </IconButton>
          <div className="text-sm font-semibold flex-1">
            {selectedIds.size} selected
          </div>
          <IconButton
            label="Copy selected"
            disabled={!selectedIds.size}
            onClick={() => void copySelected()}
          >
            <Copy size={15} />
          </IconButton>
          <IconButton
            label="Delete selected"
            disabled={!selectedIds.size}
            onClick={deleteSelected}
          >
            <Trash2 size={15} />
          </IconButton>
        </div>
      ) : (
      <div className="flex items-center px-2 gap-2 h-14 md:h-11 md:px-3">
      {onBack && (
        <IconButton label="Back" onClick={onBack}>
          <ArrowLeft size={18} />
        </IconButton>
      )}

      {room.kind === 'dm' ? (
        <Avatar
          name={dmPeer?.name ?? room.name}
          color={dmPeer?.color}
          emoji={dmPeer?.emoji}
          src={dmPeer?.avatar}
          size={34}
        />
      ) : (
        <span className="h-[34px] w-[34px] shrink-0 rounded-full grid place-items-center bg-raised border border-edge text-dim">
          {room.kind === 'broadcast' ? <Radio size={16} /> : <Hash size={16} />}
        </span>
      )}

      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold truncate">{room.name}</div>
        <div className="text-2xs text-muted truncate">
          {room.kind === 'dm'
            ? dmPeer
              ? `${dmPeer.ip} · ${dmPeer.latencyMs.toFixed(1)} ms`
              : 'Peer offline'
            : `${online} of ${room.members.length} online`}
        </div>
      </div>

      <div className="ml-auto flex items-center gap-0.5 shrink-0">
        <AnimatePresence>
          {searching && (
            <motion.div initial={{ width: 0 }} animate={{ width: 180 }} exit={{ width: 0 }}>
              <Input
                autoFocus
                value={searchTerm}
                onChange={(e) => onSearch(e.target.value)}
                onBlur={() => !searchTerm && setSearching(false)}
                placeholder="Search this room…"
                icon={<Search size={12} />}
              />
            </motion.div>
          )}
        </AnimatePresence>

        {!searching && (
          <IconButton
            label="Search this room"
            className="hidden md:inline-flex"
            onClick={() => setSearching(true)}
          >
            <Search size={15} />
          </IconButton>
        )}
        {searchTerm && (
          <IconButton
            label="Clear search"
            onClick={() => {
              onSearch('');
              setSearching(false);
            }}
          >
            <X size={15} />
          </IconButton>
        )}

        {room.pinned.length > 0 && (
          <Tooltip content={`${room.pinned.length} pinned`}>
            <IconButton
              label="Pinned messages"
              className="hidden md:inline-flex"
              active={pinnedOpen}
              onClick={onPinned}
            >
              <Pin size={15} />
            </IconButton>
          </Tooltip>
        )}

        <IconButton
          label="Media gallery"
          className="hidden md:inline-flex"
          active={galleryOpen}
          onClick={onGallery}
        >
          <Images size={15} />
        </IconButton>

        {/* The two that stay on a phone. Calling the person you are typing to
            is the reason anybody looks at the top of a conversation. */}
        {room.kind !== 'broadcast' && (
          <>
            <IconButton
              label="Voice call"
              onClick={() => startCall('voice', room.members, room.id)}
            >
              <Phone size={17} />
            </IconButton>
            <IconButton
              label="Video call"
              onClick={() => startCall('video', room.members, room.id)}
            >
              <Video size={17} />
            </IconButton>
          </>
        )}

        {room.kind !== 'dm' && (
          <IconButton
            label="Members"
            className="hidden md:inline-flex"
            onClick={() => setMembersOpen(true)}
          >
            <Users size={15} />
          </IconButton>
        )}

        <Tooltip content="Export history">
          <IconButton
            label="Export as text"
            className="hidden md:inline-flex"
            onClick={() => exportRoom('txt')}
          >
            <Download size={15} />
          </IconButton>
        </Tooltip>

        <IconButton
          label="Select messages"
          className="hidden md:inline-flex"
          onClick={onEnterSelectMode}
        >
          <CheckSquare size={15} />
        </IconButton>

        <IconButton
          label="Delete room"
          className="hidden md:inline-flex"
          onClick={() => setConfirmDelete(true)}
        >
          <Trash2 size={15} />
        </IconButton>

        {/*
          Everything above, on a phone, behind one glyph.

          Nine buttons across 375px left each of them about thirty pixels and
          the name of the person truncated to make room for a delete button
          nobody was reaching for mid-conversation.
        */}
        <RoomMenu
          room={room}
          className="md:hidden"
          onSearch={() => setSearching(true)}
          onPinned={onPinned}
          onGallery={onGallery}
          onMembers={() => setMembersOpen(true)}
          onExport={() => exportRoom('txt')}
          onSelect={onEnterSelectMode}
          onDelete={() => setConfirmDelete(true)}
        />
      </div>

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete ${room.name}?`}
        footer={
          <>
            <Button onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                deleteRoom(room.id);
                setConfirmDelete(false);
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-xs text-dim">
          Every message in this room is removed from this device. Other peers keep their own
          copies — there is no server to delete from.
        </p>
        <div className="flex gap-2 mt-3">
          <Button size="xs" onClick={() => exportRoom('txt')}>
            Export .txt first
          </Button>
          <Button size="xs" onClick={() => exportRoom('json')}>
            Export .json first
          </Button>
        </div>
      </Modal>

      </div>
      )}

      <MembersModal room={room} open={membersOpen} onClose={() => setMembersOpen(false)} />
    </header>
  );
}

/* -------------------------------------------------------- Pinned drawer */

function PinnedDrawer({ room, onClose }: { room: Room; onClose: () => void }) {
  const messages = useStore((s) => s.messages[room.id] ?? []);
  const togglePin = useStore((s) => s.togglePin);
  const pinned = room.pinned
    .map((id) => messages.find((m) => m.id === id))
    .filter(Boolean) as Message[];

  return (
    <motion.div
      initial={{ height: 0, opacity: 0 }}
      animate={{ height: 'auto', opacity: 1 }}
      exit={{ height: 0, opacity: 0 }}
      className="shrink-0 border-b border-edge bg-raised/40 overflow-hidden"
    >
      <div className="p-2.5 space-y-1.5 max-h-40 scroll-y">
        <div className="flex items-center justify-between">
          <span className="label">Pinned · {pinned.length} of 10</span>
          <IconButton label="Close" size="xs" onClick={onClose}>
            <X size={11} />
          </IconButton>
        </div>
        {pinned.map((m) => (
          <div
            key={m.id}
            className="flex items-center gap-2 px-2 py-1.5 rounded-input bg-surface border border-edge"
          >
            <Pin size={10} className="text-gold shrink-0" />
            <button
              onClick={() =>
                document
                  .getElementById(`msg-${m.id}`)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
              }
              className="text-2xs text-dim truncate flex-1 text-left hover:text-txt"
            >
              {m.body || 'Attachment'}
            </button>
            <IconButton
              label="Unpin"
              size="xs"
              onClick={() => togglePin(room.id, m.id)}
            >
              <X size={10} />
            </IconButton>
          </div>
        ))}
      </div>
    </motion.div>
  );
}

/* ------------------------------------------------------------- Modals */

function NewRoomModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const peers = useStore((s) => s.peers);
  const createRoom = useStore((s) => s.createRoom);
  const openRoom = useStore((s) => s.openRoom);
  const [kind, setKind] = React.useState<'group' | 'broadcast'>('group');
  const [name, setName] = React.useState('');
  const [members, setMembers] = React.useState<string[]>([]);

  React.useEffect(() => {
    if (open) {
      setName('');
      setMembers([]);
      setKind('group');
    }
  }, [open]);

  const create = () => {
    const id = createRoom(
      name.trim(),
      kind === 'broadcast' ? Object.keys(peers) : members,
      kind,
    );
    openRoom(id);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New room"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!name.trim() || (kind === 'group' && !members.length)}
            onClick={create}
          >
            Create
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <Segmented
          value={kind}
          onChange={setKind}
          className="w-full"
          options={[
            { value: 'group', label: 'Group room' },
            { value: 'broadcast', label: 'Broadcast' },
          ]}
        />

        <p className="text-2xs text-muted">
          {kind === 'group'
            ? 'Everyone in a group room can post and see each other.'
            : 'Only you can post to a broadcast. Everyone on the network receives it read-only.'}
        </p>

        <div className="space-y-1.5">
          <label className="label">Room name</label>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={kind === 'group' ? 'e.g. Workshop' : 'e.g. Announcements'}
            maxLength={32}
          />
        </div>

        {kind === 'group' && (
          <div className="space-y-1.5">
            <label className="label">Members</label>
            {Object.keys(peers).length === 0 ? (
              <p className="text-xs text-muted">No peers online yet.</p>
            ) : (
              <div className="grid gap-1.5 [grid-template-columns:repeat(auto-fill,minmax(140px,1fr))]">
                {Object.values(peers).map((p) => {
                  const on = members.includes(p.id);
                  return (
                    <button
                      key={p.id}
                      onClick={() =>
                        setMembers(
                          on ? members.filter((x) => x !== p.id) : [...members, p.id],
                        )
                      }
                      className={cn(
                        'flex items-center gap-2 px-2 h-9 rounded-input border transition-colors',
                        on
                          ? 'border-gold/50 bg-gold/10 shadow-glow'
                          : 'border-edge bg-raised hover:border-edge-strong',
                      )}
                    >
                      <Avatar name={p.name} color={p.color} emoji={p.emoji} src={p.avatar} size={20} />
                      <span className="text-xs truncate">{p.name}</span>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

function MembersModal({
  room,
  open,
  onClose,
}: {
  room: Room;
  open: boolean;
  onClose: () => void;
}) {
  const peers = useStore((s) => s.peers);
  return (
    <Modal open={open} onClose={onClose} title={`${room.name} · members`}>
      <ul className="space-y-1">
        {room.members.map((id) => {
          const p = peers[id];
          return (
            <li key={id} className="flex items-center gap-2.5 px-2 h-11 rounded-input bg-raised/50">
              <Avatar
                name={p?.name ?? 'Offline peer'}
                color={p?.color}
                emoji={p?.emoji}
                size={26}
                status={p?.status ?? 'offline'}
              />
              <span className="text-xs flex-1 truncate">{p?.name ?? 'Offline peer'}</span>
              {p ? (
                <Badge tone="cyan">{p.latencyMs.toFixed(1)} ms</Badge>
              ) : (
                <Badge tone="muted">Offline</Badge>
              )}
            </li>
          );
        })}
      </ul>
    </Modal>
  );
}

function SavedModal({
  open,
  onClose,
  ids,
}: {
  open: boolean;
  onClose: () => void;
  ids: string[];
}) {
  const messages = useStore((s) => s.messages);
  const rooms = useStore((s) => s.rooms);
  const openRoom = useStore((s) => s.openRoom);
  const toggleSaved = useStore((s) => s.toggleSaved);

  const found = ids
    .map((id) => {
      for (const [roomId, list] of Object.entries(messages)) {
        const m = list.find((x) => x.id === id);
        if (m) return { m, roomId };
      }
      return null;
    })
    .filter(Boolean) as { m: Message; roomId: string }[];

  return (
    <Modal open={open} onClose={onClose} title="Saved messages" width="max-w-lg">
      {found.length === 0 ? (
        <Empty
          icon={<Bookmark size={18} />}
          title="Nothing saved yet"
          hint="Bookmark any message from its ⋯ menu to keep it here."
        />
      ) : (
        <ul className="space-y-1.5">
          {found.map(({ m, roomId }) => (
            <li key={m.id} className="p-2.5 rounded-card bg-raised border border-edge">
              <div className="flex items-center gap-2 mb-1">
                <Badge tone="muted">{rooms[roomId]?.name ?? 'Unknown room'}</Badge>
                <span className="text-[10px] text-muted">{relativeTime(m.ts)}</span>
                <div className="ml-auto flex gap-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      openRoom(roomId);
                      onClose();
                      setTimeout(
                        () =>
                          document
                            .getElementById(`msg-${m.id}`)
                            ?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
                        200,
                      );
                    }}
                  >
                    Jump
                  </Button>
                  <Button size="xs" variant="ghost" onClick={() => toggleSaved(m.id)}>
                    Remove
                  </Button>
                </div>
              </div>
              <p className="text-xs text-dim line-clamp-3">{m.body || 'Attachment'}</p>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function GlobalSearch({ open, onClose }: { open: boolean; onClose: () => void }) {
  const messages = useStore((s) => s.messages);
  const rooms = useStore((s) => s.rooms);
  const peers = useStore((s) => s.peers);
  const openRoom = useStore((s) => s.openRoom);
  const [query, setQuery] = React.useState('');

  React.useEffect(() => {
    if (open) setQuery('');
  }, [open]);

  const results = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const out: { m: Message; roomId: string }[] = [];
    for (const [roomId, list] of Object.entries(messages)) {
      for (const m of list) {
        if (!m.deleted && m.body.toLowerCase().includes(q)) out.push({ m, roomId });
      }
    }
    return out.sort((a, b) => b.m.ts - a.m.ts).slice(0, 60);
  }, [query, messages]);

  return (
    <Modal open={open} onClose={onClose} title="Search all rooms" width="max-w-xl">
      <Input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search every message on this device…"
        icon={<Search size={13} />}
        className="h-9 text-sm mb-3"
      />

      {query.trim().length < 2 ? (
        <p className="text-2xs text-muted text-center py-8">
          Type at least two characters. Search runs entirely locally.
        </p>
      ) : results.length === 0 ? (
        <p className="text-2xs text-muted text-center py-8">No messages match “{query}”.</p>
      ) : (
        <ul className="space-y-1.5">
          {results.map(({ m, roomId }) => {
            const who =
              m.authorId === useStore.getState().profile.id
                ? 'You'
                : (peers[m.authorId]?.name ?? 'Unknown');
            const idx = m.body.toLowerCase().indexOf(query.trim().toLowerCase());
            const start = Math.max(0, idx - 40);
            return (
              <li key={m.id}>
                <button
                  onClick={() => {
                    openRoom(roomId);
                    onClose();
                    setTimeout(
                      () =>
                        document
                          .getElementById(`msg-${m.id}`)
                          ?.scrollIntoView({ behavior: 'smooth', block: 'center' }),
                      200,
                    );
                  }}
                  className="w-full text-left p-2.5 rounded-card bg-raised border border-edge hover:border-gold/40 transition-colors"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <Badge tone="muted">{rooms[roomId]?.name ?? 'Room'}</Badge>
                    <span className="text-2xs text-gold">{who}</span>
                    <span className="text-[10px] text-muted ml-auto">{relativeTime(m.ts)}</span>
                  </div>
                  <p className="text-xs text-dim">
                    {start > 0 && '…'}
                    {m.body.slice(start, idx)}
                    <mark className="bg-gold/30 text-txt rounded-[3px] px-0.5">
                      {m.body.slice(idx, idx + query.trim().length)}
                    </mark>
                    {m.body.slice(idx + query.trim().length, idx + query.trim().length + 60)}
                  </p>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}

/**
 * The rest of a room's actions, on a phone.
 *
 * Search, pins, the gallery, members, export and delete were nine buttons
 * across the top of a 375px conversation, each about thirty pixels wide,
 * with the name of the person being pushed out to make room for them. Calls
 * stay on the bar; everything else is here, where it costs one tap and is
 * readable.
 */
function RoomMenu({
  room,
  className,
  onSearch,
  onPinned,
  onGallery,
  onMembers,
  onExport,
  onSelect,
  onDelete,
}: {
  room: Room;
  className?: string;
  onSearch: () => void;
  onPinned: () => void;
  onGallery: () => void;
  onMembers: () => void;
  onExport: () => void;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const [open, setOpen] = React.useState(false);
  const close = React.useCallback(() => setOpen(false), []);
  const ref = useClickOutside<HTMLDivElement>(close);

  const items: { label: string; icon: React.ReactNode; run: () => void; danger?: boolean }[] = [
    { label: 'Search this room', icon: <Search size={14} />, run: onSearch },
    ...(room.pinned.length
      ? [{ label: `Pinned (${room.pinned.length})`, icon: <Pin size={14} />, run: onPinned }]
      : []),
    { label: 'Photos and files', icon: <Images size={14} />, run: onGallery },
    ...(room.kind !== 'dm'
      ? [{ label: 'Members', icon: <Users size={14} />, run: onMembers }]
      : []),
    { label: 'Select messages', icon: <CheckSquare size={14} />, run: onSelect },
    { label: 'Export history', icon: <Download size={14} />, run: onExport },
    { label: 'Delete room', icon: <Trash2 size={14} />, run: onDelete, danger: true },
  ];

  return (
    <div ref={ref} className={cn('relative', className)}>
      {open && (
        <div className="absolute top-full right-0 mt-1 z-40 w-52 glass border border-edge-strong rounded-card shadow-xl overflow-hidden">
          {items.map((item) => (
            <button
              key={item.label}
              onClick={() => {
                setOpen(false);
                item.run();
              }}
              className={cn(
                'w-full flex items-center gap-2.5 px-3 h-11 text-left text-xs hover:bg-raised',
                item.danger ? 'text-danger' : 'text-txt',
              )}
            >
              <span className={item.danger ? 'text-danger' : 'text-dim'}>{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}
      <IconButton label="More" active={open} onClick={() => setOpen(!open)}>
        <MoreVertical size={18} />
      </IconButton>
    </div>
  );
}
