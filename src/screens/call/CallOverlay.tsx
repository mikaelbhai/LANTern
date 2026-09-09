import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Grid2X2,
  Hand,
  MessageSquare,
  Mic,
  MicOff,
  Minimize2,
  Maximize2,
  MonitorUp,
  Pause,
  PhoneOff,
  Play,
  Radio,
  Signal,
  Smile,
  Sliders,
  Square,
  Video,
  VideoOff,
  X,
} from 'lucide-react';
import { Avatar } from '../../components/Avatar';
import { Badge, Button, IconButton, Slider, Tooltip } from '../../components/ui';
import { useStore } from '../../lib/store';
import { startHoldTone, startRingback, sfx } from '../../lib/audio';
import { ring } from '../../lib/ringer';
import * as rtc from '../../lib/webrtc';
import { cn, formatDuration } from '../../lib/utils';
import { ScreenShareStage, ShareSourcePicker } from './ScreenShare';
import { InCallChat } from './InCallChat';
import type { CallParticipant } from '../../lib/types';

const REACTIONS = ['👍', '👏', '❤️', '😂', '🎉', '🔥', '😮', '🙏'];

export function CallOverlay() {
  const call = useStore((s) => s.call)!;
  const peers = useStore((s) => s.peers);
  const profile = useStore((s) => s.profile);
  const endCall = useStore((s) => s.endCall);
  const answerCall = useStore((s) => s.answerCall);
  const updateCall = useStore((s) => s.updateCall);

  const [elapsed, setElapsed] = React.useState(0);
  const [selfMuted, setSelfMuted] = React.useState(false);
  const [selfCam, setSelfCam] = React.useState(call.kind === 'video');
  const [handUp, setHandUp] = React.useState(false);
  const [chatOpen, setChatOpen] = React.useState(false);
  const [mixerOpen, setMixerOpen] = React.useState(false);
  const [reactionsOpen, setReactionsOpen] = React.useState(false);
  const [sourcePicker, setSourcePicker] = React.useState(false);
  const [floatReactions, setFloatReactions] = React.useState<
    { id: number; emoji: string; peerId: string }[]
  >([]);
  const [pushing, setPushing] = React.useState(false);

  const pushToTalk = useStore((s) => s.settings.calls.pushToTalk);
  const pttKey = useStore((s) => s.settings.calls.pushToTalkKey);
  const callAlerts = useStore((s) => s.settings.notifications.call);
  const dnd = useStore((s) => s.settings.notifications.dnd);
  // Whoever is on the other end, for the notification title.
  const ringingFrom = useStore((s) => {
    const first = call.participants[0];
    return (first && (s.peers[first.peerId]?.name ?? first.name)) || 'Unknown caller';
  });

  const selfStream = useSelfVideo(selfCam && call.state === 'active');

  React.useEffect(() => {
    if (call.state !== 'active') return;
    const t = setInterval(() => setElapsed(Date.now() - call.startedAt), 500);
    return () => clearInterval(t);
  }, [call.state, call.startedAt]);

  // Alerting for an incoming call is more than a chime: the window may be
  // parked in the tray and the phone may be asleep, so this also raises an OS
  // notification and brings the window forward. Do-not-disturb, and the
  // per-category call switch, silence it entirely.
  React.useEffect(() => {
    if (call.state === 'ringing') {
      // Only the side being called gets the ringtone and the notification.
      // The caller hears a ringback instead: ringing yourself makes it
      // impossible to tell an outgoing call from an incoming one.
      if (!call.incomingFrom) return startRingback();
      if (!callAlerts || dnd) return;
      return ring({
        from: ringingFrom,
        kind: call.kind === 'video' ? 'Video call' : 'Voice call',
        audible: true,
        raiseWindow: true,
      });
    }
    if (call.state === 'held') return startHoldTone();
  }, [call.state, call.kind, call.incomingFrom, callAlerts, dnd, ringingFrom]);

  // Push-to-talk: transmit only while the configured key is held.
  React.useEffect(() => {
    if (!pushToTalk || call.state !== 'active') return;
    const match = (e: KeyboardEvent) => e.code === pttKey || e.key === pttKey;
    const down = (e: KeyboardEvent) => {
      if (match(e) && !e.repeat) {
        e.preventDefault();
        setPushing(true);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (match(e)) setPushing(false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [pushToTalk, pttKey, call.state]);

  const transmitting = pushToTalk ? pushing : !selfMuted;

  const react = (emoji: string) => {
    const id = Date.now() + Math.random();
    setFloatReactions((r) => [...r, { id, emoji, peerId: profile.id }]);
    setTimeout(() => setFloatReactions((r) => r.filter((x) => x.id !== id)), 2300);
    setReactionsOpen(false);
  };

  /**
   * Starts or stops sharing this screen with everyone on the call.
   *
   * The source picker is the operating system's own — Windows, macOS, Linux
   * and Android all present one for `getDisplayMedia`, and it is the only one
   * allowed to enumerate windows. An in-app list could show names, but could
   * never actually capture what it listed.
   */
  const toggleShare = async () => {
    if (call.screenShare) {
      await rtc.stopScreenShare();
      updateCall((c) => ({ ...c, screenShare: undefined }));
      return;
    }
    const stream = await rtc.startScreenShare();
    if (!stream) return;
    const track = stream.getVideoTracks()[0];
    updateCall((c) => ({
      ...c,
      pip: false,
      screenShare: {
        byPeerId: profile.id,
        source: track?.label || 'Screen',
        audio: false,
        fps: track?.getSettings().frameRate ?? 30,
      },
    }));
    // The browser's own "stop sharing" bar bypasses this button entirely.
    if (track) {
      track.addEventListener('ended', () =>
        updateCall((c) => ({ ...c, screenShare: undefined })),
      );
    }
  };

  /* ------------------------------------------------------------- incoming */

  if (call.state === 'ringing') {
    const other = call.participants[0];
    const from = peers[call.incomingFrom ?? other?.peerId];
    // The live entry when we have it, the name we recorded when we do not.
    const fromName = from?.name ?? other?.name ?? 'Unknown peer';
    return (
      <div className="fixed inset-0 z-[95] scrim grid place-items-center">
        <motion.div
          initial={{ scale: 0.94, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          className="panel p-8 flex flex-col items-center gap-4 w-[300px]"
        >
          <div className="relative">
            <span className="absolute inset-0 rounded-full animate-ring-out border border-gold" />
            <span
              className="absolute inset-0 rounded-full animate-ring-out border border-gold"
              style={{ animationDelay: '0.6s' }}
            />
            <Avatar
              name={fromName}
              color={from?.color}
              emoji={from?.emoji}
              size={72}
            />
          </div>
          <div className="text-center">
            <div className="text-base font-medium">{fromName}</div>
            <div className="text-xs text-dim mt-0.5">
              {call.incomingFrom ? `Incoming ${call.kind} call` : `Calling…`}
            </div>
          </div>
          <div className="flex gap-3 mt-2">
            <Button variant="danger" size="lg" onClick={endCall} icon={<PhoneOff size={16} />}>
              {call.incomingFrom ? 'Decline' : 'Cancel'}
            </Button>
            {/* Only the side being called has anything to answer. */}
            {call.incomingFrom && (
              <Button variant="cyan" size="lg" onClick={answerCall} icon={<Radio size={16} />}>
                Answer
              </Button>
            )}
          </div>
        </motion.div>
      </div>
    );
  }

  /* ---------------------------------------------------------------- PiP */

  if (call.pip) {
    return (
      <motion.div
        drag
        dragMomentum={false}
        dragConstraints={{ top: -window.innerHeight + 140, left: -window.innerWidth + 260, right: 8, bottom: 8 }}
        initial={{ opacity: 0, scale: 0.9 }}
        animate={{ opacity: 1, scale: 1 }}
        className="fixed bottom-5 right-5 z-[95] w-[232px] rounded-card overflow-hidden border border-edge-strong bg-surface shadow-2xl"
      >
        <div className="h-[130px] bg-base relative cursor-grab active:cursor-grabbing">
          {call.kind === 'video' && selfCam && selfStream ? (
            <video
              ref={(el) => {
                if (el && selfStream) el.srcObject = selfStream;
              }}
              autoPlay
              playsInline
              muted
              className="h-full w-full object-cover scale-x-[-1]"
            />
          ) : (
            <div className="h-full w-full grid place-items-center">
              <div className="flex -space-x-2">
                {call.participants.slice(0, 3).map((p) => {
                  const peer = peers[p.peerId];
                  return (
                    <Avatar
                      key={p.peerId}
                      name={peer?.name ?? 'Peer'}
                      color={peer?.color}
                      emoji={peer?.emoji}
                      size={38}
                      speaking={!p.muted}
                    />
                  );
                })}
                {call.participants.length > 3 && (
                  <span className="h-[38px] w-[38px] rounded-full bg-raised border border-edge grid place-items-center text-2xs text-dim">
                    +{call.participants.length - 3}
                  </span>
                )}
              </div>
            </div>
          )}

          <span className="absolute top-1.5 left-1.5">
            <Badge tone={call.state === 'held' ? 'gold' : 'cyan'}>
              {call.state === 'held' ? 'On hold' : formatDuration(elapsed)}
            </Badge>
          </span>

          {call.screenShare && (
            <span className="absolute top-1.5 right-1.5">
              <Badge tone="gold">
                <MonitorUp size={9} />
                Sharing
              </Badge>
            </span>
          )}

          <div className="absolute bottom-1.5 left-1.5 right-1.5">
            <span className="glass border border-edge rounded-input px-1.5 h-5 inline-flex items-center text-2xs max-w-full">
              <span className="truncate">
                {call.participants.length === 1
                  ? (peers[call.participants[0].peerId]?.name ?? 'Peer')
                  : `${call.participants.length + 1} on the call`}
              </span>
            </span>
          </div>
        </div>

        <div className="flex items-center gap-0.5 p-1.5 border-t border-edge">
          <IconButton
            label={selfMuted ? 'Unmute' : 'Mute'}
            size="sm"
            onClick={() => setSelfMuted(!selfMuted)}
          >
            {selfMuted ? <MicOff size={13} className="text-danger" /> : <Mic size={13} />}
          </IconButton>

          {call.kind === 'video' && (
            <IconButton
              label={selfCam ? 'Turn camera off' : 'Turn camera on'}
              size="sm"
              onClick={() => setSelfCam(!selfCam)}
            >
              {selfCam ? <Video size={13} /> : <VideoOff size={13} className="text-danger" />}
            </IconButton>
          )}

          <IconButton
            label={call.screenShare ? 'Stop sharing' : 'Share screen'}
            size="sm"
            onClick={() => void toggleShare()}
          >
            <MonitorUp size={13} className={call.screenShare ? 'text-gold' : undefined} />
          </IconButton>

          <IconButton
            label="Back to call"
            size="sm"
            onClick={() => updateCall((c) => ({ ...c, pip: false }))}
          >
            <Maximize2 size={13} />
          </IconButton>

          <IconButton
            label="Leave call"
            size="sm"
            className="ml-auto text-danger"
            onClick={endCall}
          >
            <PhoneOff size={13} />
          </IconButton>
        </div>
      </motion.div>
    );
  }

  /* --------------------------------------------------------------- full */

  const tiles: (CallParticipant | 'self')[] = ['self', ...call.participants];

  return (
    <div className="fixed inset-0 z-[95] bg-base flex flex-col">
      {/* header */}
      <header className="h-12 shrink-0 border-b border-edge bg-surface flex items-center px-4 gap-3">
        <Badge tone={call.state === 'active' ? 'cyan' : 'gold'}>
          <Signal size={9} />
          {call.state === 'connecting'
            ? 'Connecting…'
            : call.state === 'held'
              ? 'On hold'
              : 'Connected'}
        </Badge>
        <span className="text-sm font-mono">{formatDuration(elapsed)}</span>
        <span className="text-xs text-dim hidden sm:block">
          {call.participants.length + 1} participant
          {call.participants.length ? 's' : ''}
        </span>
        {call.recording && (
          <Badge tone="danger">
            <span className="h-1.5 w-1.5 rounded-full bg-danger animate-pulse" />
            Recording
          </Badge>
        )}
        {call.lowBandwidth && <Badge tone="gold">Low bandwidth</Badge>}

        <div className="ml-auto flex items-center gap-1">
          <IconButton
            label={call.layout === 'grid' ? 'Spotlight layout' : 'Grid layout'}
            onClick={() =>
              updateCall((c) => ({ ...c, layout: c.layout === 'grid' ? 'spotlight' : 'grid' }))
            }
          >
            {call.layout === 'grid' ? <Square size={15} /> : <Grid2X2 size={15} />}
          </IconButton>
          <IconButton
            label="Picture in picture"
            onClick={() => updateCall((c) => ({ ...c, pip: true }))}
          >
            <Minimize2 size={15} />
          </IconButton>
        </div>
      </header>

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 relative p-3">
          {call.screenShare ? (
            <ScreenShareStage />
          ) : (
            <VideoGrid
              tiles={tiles}
              layout={call.layout}
              spotlightId={call.spotlightId}
              selfStream={selfStream}
              selfCam={selfCam}
              selfMuted={!transmitting}
              handUp={handUp}
              onSpotlight={(id) =>
                updateCall((c) => ({ ...c, layout: 'spotlight', spotlightId: id }))
              }
            />
          )}

          {/* floating reactions */}
          <div className="absolute inset-0 pointer-events-none overflow-hidden">
            <AnimatePresence>
              {floatReactions.map((r) => (
                <motion.span
                  key={r.id}
                  initial={{ opacity: 0, y: 0, scale: 0.6 }}
                  animate={{ opacity: [0, 1, 1, 0], y: -170, scale: 1.3 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 2.2, ease: 'easeOut' }}
                  className="absolute bottom-6 left-1/2 text-3xl"
                  style={{ marginLeft: (Math.random() - 0.5) * 180 }}
                >
                  {r.emoji}
                </motion.span>
              ))}
            </AnimatePresence>
          </div>

          {pushToTalk && (
            <div className="absolute bottom-3 left-3">
              <Badge tone={pushing ? 'cyan' : 'muted'}>
                <Mic size={9} />
                {pushing ? 'Transmitting' : `Hold ${pttKey} to talk`}
              </Badge>
            </div>
          )}
        </div>

        <AnimatePresence>
          {chatOpen && (
            <motion.aside
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 280, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              className="shrink-0 border-l border-edge bg-surface overflow-hidden"
            >
              <InCallChat onClose={() => setChatOpen(false)} />
            </motion.aside>
          )}

          {mixerOpen && (
            <motion.aside
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 240, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              className="shrink-0 border-l border-edge bg-surface overflow-hidden"
            >
              <VolumeMixer onClose={() => setMixerOpen(false)} />
            </motion.aside>
          )}
        </AnimatePresence>
      </div>

      {/* raised hands queue */}
      {call.participants.some((p) => p.handRaised) && (
        <div className="shrink-0 px-4 py-2 border-t border-edge bg-surface/60 flex items-center gap-2 overflow-x-auto no-scrollbar">
          <span className="label shrink-0">Speaker queue</span>
          {call.participants
            .filter((p) => p.handRaised)
            .sort((a, b) => (a.handRaisedAt ?? 0) - (b.handRaisedAt ?? 0))
            .map((p, i) => (
              <Badge key={p.peerId} tone="gold">
                {i + 1}. {peers[p.peerId]?.name ?? 'Peer'}
              </Badge>
            ))}
        </div>
      )}

      {/* controls */}
      <footer className="shrink-0 border-t border-edge bg-surface px-4 py-2.5 flex items-center justify-center gap-1.5 flex-wrap safe-b">
        <ControlButton
          label={selfMuted ? 'Unmute' : 'Mute'}
          active={!selfMuted}
          danger={selfMuted}
          onClick={() => setSelfMuted(!selfMuted)}
          icon={selfMuted ? <MicOff size={16} /> : <Mic size={16} />}
        />

        {call.kind === 'video' && (
          <ControlButton
            label={selfCam ? 'Turn camera off' : 'Turn camera on'}
            active={selfCam}
            danger={!selfCam}
            onClick={() => setSelfCam(!selfCam)}
            icon={selfCam ? <Video size={16} /> : <VideoOff size={16} />}
          />
        )}

        <ControlButton
          label={call.screenShare ? 'Stop sharing' : 'Share screen'}
          active={!!call.screenShare}
          onClick={toggleShare}
          icon={<MonitorUp size={16} />}
        />

        <ControlButton
          label={handUp ? 'Lower hand' : 'Raise hand'}
          active={handUp}
          onClick={() => {
            setHandUp(!handUp);
            sfx.click();
          }}
          icon={<Hand size={16} />}
        />

        <div className="relative">
          <ControlButton
            label="React"
            active={reactionsOpen}
            onClick={() => setReactionsOpen(!reactionsOpen)}
            icon={<Smile size={16} />}
          />
          <AnimatePresence>
            {reactionsOpen && (
              <motion.div
                initial={{ opacity: 0, y: 6, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 6, scale: 0.95 }}
                className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 glass border border-edge rounded-pill px-2 py-1.5 flex gap-1 shadow-xl"
              >
                {REACTIONS.map((e) => (
                  <button
                    key={e}
                    onClick={() => react(e)}
                    className="h-8 w-8 grid place-items-center text-lg rounded-full hover:bg-raised hover:scale-110 transition-transform"
                  >
                    {e}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <ControlButton
          label="In-call chat"
          active={chatOpen}
          onClick={() => {
            setChatOpen(!chatOpen);
            setMixerOpen(false);
          }}
          icon={<MessageSquare size={16} />}
        />

        <ControlButton
          label="Volume mixer"
          active={mixerOpen}
          onClick={() => {
            setMixerOpen(!mixerOpen);
            setChatOpen(false);
          }}
          icon={<Sliders size={16} />}
        />

        <ControlButton
          label={call.state === 'held' ? 'Resume' : 'Hold'}
          active={call.state === 'held'}
          onClick={() =>
            updateCall((c) => ({ ...c, state: c.state === 'held' ? 'active' : 'held' }))
          }
          icon={call.state === 'held' ? <Play size={16} /> : <Pause size={16} />}
        />

        <ControlButton
          label={call.recording ? 'Stop recording' : 'Record locally'}
          active={call.recording}
          danger={call.recording}
          onClick={() => updateCall((c) => ({ ...c, recording: !c.recording }))}
          icon={<span className="h-3 w-3 rounded-full border-2 border-current" />}
        />

        <div className="w-px h-7 bg-edge mx-1" />

        <Button variant="danger" size="md" icon={<PhoneOff size={15} />} onClick={endCall}>
          Leave
        </Button>
      </footer>

      <ShareSourcePicker open={sourcePicker} onClose={() => setSourcePicker(false)} />
    </div>
  );
}

function ControlButton({
  label,
  icon,
  onClick,
  active,
  danger,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
}) {
  return (
    <Tooltip content={label}>
      <button
        onClick={onClick}
        aria-label={label}
        className={cn(
          'h-10 w-10 rounded-full grid place-items-center transition-all border active:scale-95',
          danger
            ? 'bg-danger/15 border-danger/50 text-danger'
            : active
              ? 'bg-gold/15 border-gold/50 text-gold shadow-glow'
              : 'bg-raised border-edge text-dim hover:text-txt hover:border-edge-strong',
        )}
      >
        {icon}
      </button>
    </Tooltip>
  );
}

/* ------------------------------------------------------------ Video grid */

function VideoGrid({
  tiles,
  layout,
  spotlightId,
  selfStream,
  selfCam,
  selfMuted,
  handUp,
  onSpotlight,
}: {
  tiles: (CallParticipant | 'self')[];
  layout: 'grid' | 'spotlight';
  spotlightId?: string;
  selfStream: MediaStream | null;
  selfCam: boolean;
  selfMuted: boolean;
  handUp: boolean;
  onSpotlight: (id: string) => void;
}) {
  const n = tiles.length;
  const cols = layout === 'spotlight' ? 1 : n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;

  if (layout === 'spotlight') {
    const main =
      tiles.find((t) => t !== 'self' && (t as CallParticipant).peerId === spotlightId) ??
      tiles.find((t) => t !== 'self') ??
      tiles[0];
    const rest = tiles.filter((t) => t !== main);
    return (
      <div className="h-full flex flex-col gap-2">
        <div className="flex-1 min-h-0">
          <Tile
            tile={main}
            selfStream={selfStream}
            selfCam={selfCam}
            selfMuted={selfMuted}
            handUp={handUp}
            large
            onSpotlight={onSpotlight}
          />
        </div>
        {rest.length > 0 && (
          <div className="h-24 shrink-0 flex gap-2 overflow-x-auto no-scrollbar">
            {rest.map((t, i) => (
              <div key={i} className="w-32 shrink-0">
                <Tile
                  tile={t}
                  selfStream={selfStream}
                  selfCam={selfCam}
                  selfMuted={selfMuted}
                  handUp={handUp}
                  onSpotlight={onSpotlight}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      className="h-full grid gap-2"
      style={{
        gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
        gridAutoRows: '1fr',
      }}
    >
      {tiles.map((t, i) => (
        <Tile
          key={i}
          tile={t}
          selfStream={selfStream}
          selfCam={selfCam}
          selfMuted={selfMuted}
          handUp={handUp}
          onSpotlight={onSpotlight}
        />
      ))}
    </div>
  );
}

function Tile({
  tile,
  selfStream,
  selfCam,
  selfMuted,
  handUp,
  large,
  onSpotlight,
}: {
  tile: CallParticipant | 'self';
  selfStream: MediaStream | null;
  selfCam: boolean;
  selfMuted: boolean;
  handUp: boolean;
  large?: boolean;
  onSpotlight: (id: string) => void;
}) {
  const profile = useStore((s) => s.profile);
  const peers = useStore((s) => s.peers);
  const mirror = useStore((s) => s.settings.calls.camera !== 'no-mirror');
  const videoRef = React.useRef<HTMLVideoElement>(null);

  const isSelf = tile === 'self';
  const p = isSelf ? null : (tile as CallParticipant);
  const peer = p ? peers[p.peerId] : null;

  const name = isSelf ? `${profile.name || 'You'} (you)` : (peer?.name ?? p?.name ?? 'Peer');
  const color = isSelf ? profile.color : peer?.color;
  const emoji = isSelf ? profile.emoji : peer?.emoji;
  const muted = isSelf ? selfMuted : p!.muted;
  const raised = isSelf ? handUp : p!.handRaised;
  const camOn = isSelf ? selfCam : p!.camOn;

  const remoteStream = useRemoteStream(isSelf ? null : (p?.peerId ?? null));
  const stream = isSelf ? selfStream : remoteStream;
  const hasVideo = !!stream?.getVideoTracks().length;
  // Video is shown when there are frames to show; the element itself is
  // mounted whenever there is any stream at all, because it is also the sink
  // that plays the other side's audio on a voice call.
  const showVideo = isSelf ? camOn && hasVideo : hasVideo;

  React.useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  React.useEffect(() => {
    if (!isSelf && videoRef.current && p) {
      videoRef.current.volume = p.volume;
    }
  }, [isSelf, p]);

  return (
    <motion.div
      layout
      onDoubleClick={() => !isSelf && onSpotlight(p!.peerId)}
      className={cn(
        'relative rounded-card overflow-hidden bg-surface border transition-colors min-h-0',
        muted ? 'border-edge' : 'border-cyan/30',
      )}
    >
      {stream && (
        <video
          ref={videoRef}
          autoPlay
          playsInline
          // Never play your own microphone back at yourself.
          muted={isSelf}
          className={cn(
            'h-full w-full object-cover',
            isSelf && mirror && 'scale-x-[-1]',
            !showVideo && 'hidden',
          )}
        />
      )}
      {showVideo ? null : (
        <div className="h-full w-full grid place-items-center bg-base">
          <Avatar
            name={name}
            color={color}
            emoji={emoji}
            size={large ? 88 : 44}
            speaking={!muted}
          />
        </div>
      )}

      <div className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center gap-1.5">
        <span className="glass border border-edge rounded-input px-1.5 h-5 flex items-center gap-1 text-2xs max-w-full">
          {muted ? (
            <MicOff size={9} className="text-danger shrink-0" />
          ) : (
            <Mic size={9} className="text-cyan shrink-0" />
          )}
          <span className="truncate">{name}</span>
        </span>
        {raised && (
          <span className="glass border border-gold/50 rounded-input h-5 w-5 grid place-items-center text-gold shrink-0">
            <Hand size={10} />
          </span>
        )}
      </div>
    </motion.div>
  );
}

/* ---------------------------------------------------------- Volume mixer */

function VolumeMixer({ onClose }: { onClose: () => void }) {
  const call = useStore((s) => s.call)!;
  const peers = useStore((s) => s.peers);
  const updateCall = useStore((s) => s.updateCall);

  return (
    <div className="h-full flex flex-col w-[240px]">
      <div className="h-11 px-3 flex items-center justify-between border-b border-edge shrink-0">
        <span className="label">Volume mixer</span>
        <IconButton label="Close" size="sm" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      <div className="flex-1 scroll-y p-3 space-y-4">
        {call.participants.map((p) => {
          const peer = peers[p.peerId];
          return (
            <div key={p.peerId}>
              <div className="flex items-center gap-2 mb-1.5">
                <Avatar name={peer?.name ?? 'Peer'} color={peer?.color} emoji={peer?.emoji} size={20} />
                <span className="text-xs truncate flex-1">{peer?.name ?? 'Peer'}</span>
                <span className="text-2xs font-mono text-muted">
                  {Math.round(p.volume * 100)}%
                </span>
              </div>
              <Slider
                value={p.volume * 100}
                onChange={(v) =>
                  updateCall((c) => ({
                    ...c,
                    participants: c.participants.map((x) =>
                      x.peerId === p.peerId ? { ...x, volume: v / 100 } : x,
                    ),
                  }))
                }
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The far side's audio and video for one peer.
 *
 * Tracks arrive after the tile has already rendered — often well after, since
 * the camera negotiates more slowly than the connection completes — so this
 * subscribes rather than reading once.
 */
function useRemoteStream(peerId: string | null): MediaStream | null {
  const [stream, setStream] = React.useState<MediaStream | null>(null);
  const [, bump] = React.useReducer((n: number) => n + 1, 0);

  React.useEffect(() => {
    if (!peerId) {
      setStream(null);
      return;
    }
    setStream(rtc.getRemoteStream(peerId));
    const off = rtc.onRemoteStream((id, s) => {
      if (id !== peerId) return;
      setStream(s);
      // The same MediaStream object gains tracks in place, so a state set
      // alone would not re-render when video is added to an audio call.
      bump();
    });
    return off;
  }, [peerId]);

  return stream;
}

/* ------------------------------------------------------------- self video */

/**
 * The local preview.
 *
 * During a call this is the very stream being sent to the other side, not a
 * second capture: opening the camera twice fails outright on most hardware,
 * and where it succeeds it shows a preview that does not match what the peer
 * is actually receiving. Only outside a call — the settings preview — does
 * this open a device of its own.
 */
function useSelfVideo(enabled: boolean): MediaStream | null {
  const [stream, setStream] = React.useState<MediaStream | null>(null);

  React.useEffect(() => {
    if (!enabled) {
      setStream(null);
      return;
    }

    const shared = rtc.getLocalStream();
    if (shared) {
      setStream(shared);
      // Tracks can be added to it later (a voice call upgraded to video), so
      // keep watching rather than reading once.
      return rtc.onRemoteStream(() => setStream(rtc.getLocalStream()));
    }

    let active = true;
    let local: MediaStream | null = null;
    navigator.mediaDevices
      ?.getUserMedia({ video: { width: 640, height: 360 }, audio: false })
      .then((s) => {
        if (!active) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        local = s;
        setStream(s);
      })
      .catch(() => setStream(null));

    return () => {
      active = false;
      local?.getTracks().forEach((t) => t.stop());
    };
  }, [enabled]);

  return stream;
}
