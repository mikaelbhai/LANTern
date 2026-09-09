import React from 'react';
import {
  PhoneIncoming,
  PhoneMissed,
  PhoneOutgoing,
  Phone,
  Users,
  Video,
} from 'lucide-react';
import { Avatar } from '../components/Avatar';
import { Badge, Button, Empty, IconButton, Modal, SectionTitle } from '../components/ui';
import { useStore } from '../lib/store';
import { cn, exactTime, formatDuration, relativeTime } from '../lib/utils';
import { useNow } from '../lib/hooks';

export function Calls() {
  const log = useStore((s) => s.callLog);
  const peers = useStore((s) => s.peers);
  const startCall = useStore((s) => s.startCall);
  const now = useNow();
  const [groupOpen, setGroupOpen] = React.useState(false);

  const peerList = Object.values(peers);

  return (
    <div className="h-full flex flex-col">
      <header className="h-11 shrink-0 border-b border-edge bg-surface flex items-center px-4 gap-2">
        <Phone size={15} className="text-gold" />
        <span className="text-sm font-semibold">Calls</span>
        <div className="ml-auto">
          <Button
            size="xs"
            variant="primary"
            icon={<Users size={12} />}
            onClick={() => setGroupOpen(true)}
            disabled={!peerList.length}
          >
            New group call
          </Button>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex">
        <div className="w-[300px] shrink-0 border-r border-edge scroll-y p-3 hidden md:block">
          <SectionTitle>Quick dial</SectionTitle>
          {peerList.length === 0 ? (
            <p className="text-xs text-muted">No peers online.</p>
          ) : (
            <ul className="space-y-1">
              {peerList.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-2.5 px-2 h-11 rounded-input hover:bg-raised/60 group"
                >
                  <Avatar
                    name={p.name}
                    color={p.color}
                    emoji={p.emoji}
                    size={28}
                    status={p.status}
                  />
                  <span className="text-xs truncate flex-1">{p.name}</span>
                  <div className="flex gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                    <IconButton
                      label="Voice call"
                      size="sm"
                      onClick={() => startCall('voice', [p.id])}
                    >
                      <Phone size={13} />
                    </IconButton>
                    <IconButton
                      label="Video call"
                      size="sm"
                      onClick={() => startCall('video', [p.id])}
                    >
                      <Video size={13} />
                    </IconButton>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="flex-1 min-w-0 scroll-y">
          {log.length === 0 ? (
            <Empty
              icon={<Phone size={20} />}
              title="No calls yet"
              hint="Voice and video calls run peer-to-peer over WebRTC. Up to 16 on voice, 8 cameras on video."
            />
          ) : (
            <ul className="divide-y divide-edge">
              {log.map((c) => {
                const first = peers[c.peers[0]];
                const Icon =
                  c.outcome === 'missed'
                    ? PhoneMissed
                    : c.kind === 'video'
                      ? Video
                      : PhoneOutgoing;
                return (
                  <li
                    key={c.id}
                    className="flex items-center gap-3 px-4 h-14 hover:bg-raised/40 group"
                  >
                    <Avatar
                      name={first?.name ?? 'Peer'}
                      color={first?.color}
                      emoji={first?.emoji}
                      size={32}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-medium truncate">
                          {c.peers.length > 1
                            ? `${first?.name ?? 'Peer'} +${c.peers.length - 1}`
                            : (first?.name ?? 'Unknown peer')}
                        </span>
                        {c.outcome === 'missed' && <Badge tone="danger">Missed</Badge>}
                      </div>
                      <div className="flex items-center gap-2 text-2xs text-muted mt-0.5">
                        <Icon
                          size={10}
                          className={c.outcome === 'missed' ? 'text-danger' : 'text-cyan'}
                        />
                        <span className="capitalize">{c.kind}</span>
                        <span>·</span>
                        <span title={exactTime(c.startedAt)}>
                          {relativeTime(c.startedAt, now)}
                        </span>
                        {c.outcome === 'completed' && (
                          <>
                            <span>·</span>
                            <span className="font-mono">{formatDuration(c.durationMs)}</span>
                          </>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <IconButton
                        label="Call back"
                        onClick={() => startCall(c.kind, c.peers.filter((id) => peers[id]))}
                      >
                        {c.kind === 'video' ? <Video size={14} /> : <Phone size={14} />}
                      </IconButton>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <GroupCallModal open={groupOpen} onClose={() => setGroupOpen(false)} />
    </div>
  );
}

function GroupCallModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const peers = useStore((s) => s.peers);
  const startCall = useStore((s) => s.startCall);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [kind, setKind] = React.useState<'voice' | 'video'>('voice');

  const limit = kind === 'voice' ? 16 : 8;
  const overLimit = selected.length > limit;

  React.useEffect(() => {
    if (open) setSelected([]);
  }, [open]);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New group call"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={!selected.length || overLimit}
            onClick={() => {
              startCall(kind, selected);
              onClose();
            }}
          >
            Start {kind} call
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex gap-2">
          <Button
            full
            variant={kind === 'voice' ? 'primary' : 'outline'}
            icon={<Phone size={13} />}
            onClick={() => setKind('voice')}
          >
            Voice · up to 16
          </Button>
          <Button
            full
            variant={kind === 'video' ? 'primary' : 'outline'}
            icon={<Video size={13} />}
            onClick={() => setKind('video')}
          >
            Video · up to 8
          </Button>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between">
            <span className="label">Participants</span>
            <span className={cn('text-2xs', overLimit ? 'text-danger' : 'text-muted')}>
              {selected.length} / {limit}
            </span>
          </div>
          <div className="grid gap-1.5 [grid-template-columns:repeat(auto-fill,minmax(140px,1fr))]">
            {Object.values(peers).map((p) => {
              const on = selected.includes(p.id);
              return (
                <button
                  key={p.id}
                  onClick={() =>
                    setSelected(on ? selected.filter((x) => x !== p.id) : [...selected, p.id])
                  }
                  className={cn(
                    'flex items-center gap-2 px-2 h-9 rounded-input border transition-colors',
                    on
                      ? 'border-gold/50 bg-gold/10 shadow-glow'
                      : 'border-edge bg-raised hover:border-edge-strong',
                  )}
                >
                  <Avatar name={p.name} color={p.color} emoji={p.emoji} size={20} />
                  <span className="text-xs truncate">{p.name}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </Modal>
  );
}
