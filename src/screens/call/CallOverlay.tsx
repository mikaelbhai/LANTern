import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  Ear,
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
  Settings2,
  Signal,
  Smile,
  Sliders,
  Square,
  SwitchCamera,
  Video,
  VideoOff,
  Volume2,
  X,
  ExternalLink,
} from 'lucide-react';
import { Avatar } from '../../components/Avatar';
import { Badge, Button, IconButton, Modal, Slider, Tooltip } from '../../components/ui';
import { useStore } from '../../lib/store';
import { startHoldTone, startRingback, sfx } from '../../lib/audio';
import { ring } from '../../lib/ringer';
import * as rtc from '../../lib/webrtc';
import { Zoomable } from './Zoomable';
import { api } from '../../lib/bridge';
import { cn, formatDuration } from '../../lib/utils';
import { bringVideoBack, popOutVideo } from '../../lib/popout';
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
  const navigate = useStore((s) => s.navigate);

  const [elapsed, setElapsed] = React.useState(0);
  const poppedOut = useStore((s) => s.poppedOut);
  const setPoppedOut = useStore((s) => s.setPoppedOut);
  const selfMuted = useStore((s) => s.micMuted);
  const setSelfMuted = useStore((s) => s.setMicMuted);
  const [selfCam, setSelfCam] = React.useState(call.kind === 'video');

  /**
   * Where the call comes out of, on a phone.
   *
   * A call with no picture is held against the ear, and a phone is built for
   * that: the small speaker at the top is aimed at an ear rather than a room,
   * and the microphone the call stack picks in that mode is the one at the
   * bottom, by the mouth. A call with a picture is held away and looked at,
   * so it belongs out loud.
   *
   * The picture decides, and it can change mid-call - a camera turned on has
   * to move the sound with it. Screen sharing counts as a picture for the
   * same reason: nobody holds a shared screen to their ear.
   *
   * Does nothing on a desktop, which has one pair of speakers and no notion
   * of holding it to your face.
   */
  const hasPicture = selfCam || call.kind === 'video' || !!call.screenShare;
  // `null` defers to `hasPicture`; a press of the speaker button pins it
  // either way until the next press, the same override WhatsApp offers over
  // its own picture-driven default.
  const [speakerOverride, setSpeakerOverride] = React.useState<boolean | null>(null);
  const speakerOn = speakerOverride ?? hasPicture;
  // Stays false until a route actually takes, which is also how a desktop or
  // TV - neither has an earpiece to route to - keeps the button off its bar
  // instead of showing a control that would do nothing.
  const [hasEarpiece, setHasEarpiece] = React.useState(false);
  React.useEffect(() => {
    if (call.state === 'ended') return;
    void api.call
      .earpiece(!speakerOn)
      .then(setHasEarpiece)
      .catch(() => setHasEarpiece(false));
  }, [speakerOn, call.state]);

  // And hand the audio stack back, or the phone keeps routing everything
  // through the earpiece after the call is over.
  React.useEffect(() => () => void api.call.resetAudio().catch(() => {}), []);

  // Only a phone has a second camera worth flipping to - checked once the
  // camera actually comes on rather than up front, since `enumerateDevices`
  // needs a granted permission to report anything more than a bare count.
  const [multiCam, setMultiCam] = React.useState(false);
  React.useEffect(() => {
    if (!selfCam) return;
    void rtc.hasMultipleCameras().then(setMultiCam);
  }, [selfCam]);
  const [handUp, setHandUp] = React.useState(false);
  const [chatOpen, setChatOpen] = React.useState(false);
  const [mixerOpen, setMixerOpen] = React.useState(false);
  const [moreOpen, setMoreOpen] = React.useState(false);
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

  /**
   * Starts or stops sending the camera.
   *
   * A call that began as voice becomes a video call here, which is the point:
   * people ring to talk and then want to show something.
   */
  const toggleCamera = async () => {
    if (selfCam) {
      await rtc.disableCamera();
      setSelfCam(false);
      return;
    }
    // `useSelfVideo` watches this flag and picks the stream up from the
    // session, so there is nothing to hand it here.
    const stream = await rtc.enableCamera();
    if (stream) setSelfCam(true);
  };

  const transmitting = pushToTalk ? pushing : !selfMuted;

  /**
   * Mute the microphone for real.
   *
   * This used to be presentation only: the button swapped its icon and the
   * label read "Unmute" while the track carried on transmitting. Someone who
   * believed they were muted was still being heard, which is the worst
   * direction for this particular control to fail in.
   *
   * Driven from `transmitting` rather than `selfMuted` so push-to-talk goes
   * through the same path instead of having one of its own.
   */
  React.useEffect(() => {
    rtc.setMicrophoneEnabled(transmitting);
  }, [transmitting]);

  /**
   * Sends the call out of the application.
   *
   * Two different mechanisms, because a call is two different things. The
   * picture goes to the system's own Picture-in-Picture, which floats above
   * every other application — a second webview could not hold the stream, so
   * this is the only way the video can genuinely leave. The controls go to
   * LANTern's corner window, which already knows how to mute and hang up, and
   * on a voice call is the whole of it.
   */
  const popOut = async () => {
    setPoppedOut(true);
    if (call.kind !== 'video') return;

    // The other person, not a mirror of yourself. Falls back to whatever
    // video is there, which on a screen share is the share.
    const remote = document.querySelector<HTMLVideoElement>('video[data-call-video="remote"]');
    await popOutVideo(remote ?? document.querySelector<HTMLVideoElement>('video'));
  };

  const bringBack = async () => {
    setPoppedOut(false);
    await bringVideoBack();
  };

  const react = (emoji: string) => {
    const id = Date.now() + Math.random();
    setFloatReactions((r) => [...r, { id, emoji, peerId: profile.id }]);
    setTimeout(() => setFloatReactions((r) => r.filter((x) => x.id !== id)), 2300);
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
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="fixed inset-0 z-[95] flex flex-col safe-t"
        style={{
          // The caller's own colour, full-bleed and dim rather than the
          // flat scrim every other layer in this app uses — a call is the
          // one moment this application asks for the whole screen, the
          // same way the person it is from gets the whole screen on a
          // phone call.
          background: from?.color
            ? `radial-gradient(circle at 50% 15%, color-mix(in srgb, ${from.color} 35%, #0a0a0c) 0%, #0a0a0c 70%)`
            : '#0a0a0c',
        }}
      >
        <div className="flex-1 flex flex-col items-center justify-center gap-5 px-6">
          <div className="relative">
            <span className="absolute inset-0 rounded-full animate-ring-out border-2 border-white/40" />
            <span
              className="absolute inset-0 rounded-full animate-ring-out border-2 border-white/40"
              style={{ animationDelay: '0.6s' }}
            />
            <Avatar name={fromName} color={from?.color} emoji={from?.emoji} size={132} />
          </div>
          <div className="text-center">
            <div className="text-[28px] font-semibold text-white leading-tight">{fromName}</div>
            <div className="text-sm text-white/60 mt-1.5">
              {call.incomingFrom
                ? `Incoming ${call.kind} call…`
                : `Calling ${call.kind === 'video' ? 'video' : 'voice'}…`}
            </div>
          </div>
        </div>

        {/*
          Bottom row, WhatsApp's own shape for it: two large circles, red on
          the left, the answer colour on the right, nothing between them
          that needs reading under pressure — a call ringing is not the
          moment for a menu.
        */}
        <div
          className={cn(
            'shrink-0 flex items-center justify-center gap-16 pb-10 px-6',
            '[padding-bottom:max(2.5rem,env(safe-area-inset-bottom))]',
          )}
        >
          <div className="flex flex-col items-center gap-2.5">
            <button
              onClick={endCall}
              aria-label={call.incomingFrom ? 'Decline' : 'Cancel'}
              className="h-16 w-16 rounded-full grid place-items-center bg-danger text-white shadow-xl active:scale-95 transition-transform"
            >
              <PhoneOff size={26} />
            </button>
            <span className="text-2xs text-white/70">
              {call.incomingFrom ? 'Decline' : 'Cancel'}
            </span>
          </div>
          {/* Only the side being called has anything to answer. */}
          {call.incomingFrom && (
            <div className="flex flex-col items-center gap-2.5">
              <button
                onClick={answerCall}
                aria-label="Answer"
                className="h-16 w-16 rounded-full grid place-items-center bg-cyan text-[#04211e] shadow-xl active:scale-95 transition-transform animate-pulse"
              >
                <Radio size={26} />
              </button>
              <span className="text-2xs text-white/70">Answer</span>
            </div>
          )}
        </div>
      </motion.div>
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
        // See `.above-tabbar` in index.css. Draggable, so this is only the
        // resting spot rather than a hard limit — but a resting spot right
        // at the viewport's true bottom edge sat this tile on the mobile
        // tab bar, or a phone's gesture handle, before anybody had touched
        // it.
        className="fixed right-5 z-[95] w-[232px] rounded-card overflow-hidden border border-edge-strong bg-surface shadow-2xl above-tabbar"
      >
        <div className="h-[130px] bg-base relative cursor-grab active:cursor-grabbing">
          {selfCam && selfStream ? (
            <video
              ref={(el) => {
                if (el && selfStream) el.srcObject = selfStream;
              }}
              autoPlay
              playsInline
              muted
              className="h-full w-full object-contain scale-x-[-1]"
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
            label={poppedOut ? 'Bring the call back' : 'Pop out of LANTern'}
            size="sm"
            onClick={() => void (poppedOut ? bringBack() : popOut())}
          >
            <ExternalLink size={13} className={poppedOut ? 'text-gold' : undefined} />
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
          <IconButton
            label={poppedOut ? 'Bring the call back' : 'Pop out of LANTern'}
            onClick={() => void (poppedOut ? bringBack() : popOut())}
          >
            <ExternalLink size={15} className={poppedOut ? 'text-gold' : undefined} />
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

      {/*
        controls

        WhatsApp's own in-call bar is four or five circles and nothing
        else - mute, video, speaker, more, hang up - because a call is
        answered by a thumb that already knows where those are, not read.
        Everything this app can do that WhatsApp's cannot (screen share,
        reactions, a hand raised, the volume mixer, hold, local recording)
        still lives one tap away, in the sheet the "More" circle opens,
        rather than crowded into the row every call shows whether or not
        it is ever used.
      */}
      <footer
        className={cn(
          'shrink-0 border-t border-edge bg-surface px-4 pt-3 flex items-center justify-center gap-3',
          '[padding-bottom:max(0.75rem,env(safe-area-inset-bottom))]',
        )}
      >
        <ControlButton
          label={selfMuted ? 'Unmute' : 'Mute'}
          active={!selfMuted}
          danger={selfMuted}
          onClick={() => setSelfMuted(!selfMuted)}
          icon={selfMuted ? <MicOff size={20} /> : <Mic size={20} />}
          big
        />

        {/*
          Offered on every call, not only ones that started as video. A voice
          call negotiates an empty video track up front (see webrtc.ts), so
          turning the camera on here is a track swap rather than a
          renegotiation - the audio does not break and the other side simply
          starts seeing a picture.
        */}
        <ControlButton
          label={selfCam ? 'Turn camera off' : 'Turn camera on'}
          active={selfCam}
          danger={!selfCam}
          onClick={() => void toggleCamera()}
          icon={selfCam ? <Video size={20} /> : <VideoOff size={20} />}
          big
        />

        {hasEarpiece && (
          <ControlButton
            label={speakerOn ? 'Switch to earpiece' : 'Switch to speaker'}
            active={speakerOn}
            onClick={() => setSpeakerOverride(!speakerOn)}
            icon={speakerOn ? <Volume2 size={20} /> : <Ear size={20} />}
            big
          />
        )}

        <ControlButton
          label="More"
          active={moreOpen}
          onClick={() => setMoreOpen(true)}
          icon={<Grid2X2 size={20} />}
          big
        />

        {/* The one WhatsApp draws bigger than the rest, and the one reason
            nobody has to go looking for it: it is always in the same place,
            plain red, no label, exactly where a thumb expects a call to
            end. */}
        <button
          onClick={endCall}
          aria-label="Leave"
          className="h-14 w-14 rounded-full grid place-items-center bg-danger text-white shadow-lg active:scale-95 transition-transform"
        >
          <PhoneOff size={22} />
        </button>
      </footer>

      <Modal open={moreOpen} onClose={() => setMoreOpen(false)} title="Call options" width="max-w-sm">
        <div className="flex gap-1.5 justify-center pb-3 mb-1 border-b border-edge">
          {REACTIONS.map((e) => (
            <button
              key={e}
              onClick={() => {
                react(e);
                setMoreOpen(false);
              }}
              className="h-9 w-9 grid place-items-center text-lg rounded-full hover:bg-raised hover:scale-110 transition-transform"
            >
              {e}
            </button>
          ))}
        </div>
        <div className="grid grid-cols-4 gap-1">
          {selfCam && multiCam && (
            <MoreTile
              label="Flip camera"
              icon={<SwitchCamera size={18} />}
              onClick={() => {
                void rtc.switchCamera();
                setMoreOpen(false);
              }}
            />
          )}
          <MoreTile
            label={call.screenShare ? 'Stop sharing' : 'Share screen'}
            icon={<MonitorUp size={18} />}
            active={!!call.screenShare}
            onClick={() => {
              toggleShare();
              setMoreOpen(false);
            }}
          />
          <MoreTile
            label={handUp ? 'Lower hand' : 'Raise hand'}
            icon={<Hand size={18} />}
            active={handUp}
            onClick={() => {
              setHandUp(!handUp);
              sfx.click();
              setMoreOpen(false);
            }}
          />
          <MoreTile
            label="In-call chat"
            icon={<MessageSquare size={18} />}
            active={chatOpen}
            onClick={() => {
              setChatOpen(!chatOpen);
              setMixerOpen(false);
              setMoreOpen(false);
            }}
          />
          <MoreTile
            label="Volume mixer"
            icon={<Sliders size={18} />}
            active={mixerOpen}
            onClick={() => {
              setMixerOpen(!mixerOpen);
              setChatOpen(false);
              setMoreOpen(false);
            }}
          />
          <MoreTile
            label={call.state === 'held' ? 'Resume' : 'Hold'}
            icon={call.state === 'held' ? <Play size={18} /> : <Pause size={18} />}
            active={call.state === 'held'}
            onClick={() => {
              updateCall((c) => ({ ...c, state: c.state === 'held' ? 'active' : 'held' }));
              setMoreOpen(false);
            }}
          />
          <MoreTile
            label={call.recording ? 'Stop recording' : 'Record locally'}
            icon={<span className="h-3 w-3 rounded-full border-2 border-current" />}
            active={call.recording}
            danger={call.recording}
            onClick={() => {
              updateCall((c) => ({ ...c, recording: !c.recording }));
              setMoreOpen(false);
            }}
          />
          {/* The mic/camera/speaker pickers already live in Settings > Calls -
              this pops the call into the corner rather than duplicating them
              here, so both are on screen at once instead of one replacing
              the other. A mic changed there takes effect on this same call;
              see CallsTab's own comment on why the speaker needs no such
              wiring and the mic does. */}
          <MoreTile
            label="Mic & speaker"
            icon={<Settings2 size={18} />}
            onClick={() => {
              setMoreOpen(false);
              updateCall((c) => ({ ...c, pip: true }));
              navigate('settings');
            }}
          />
        </div>
      </Modal>

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
  big,
}: {
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
  /** The primary bar's own size — WhatsApp's four circles read as buttons
      from across the room; the old 40px size was sized for a row of ten. */
  big?: boolean;
}) {
  return (
    <Tooltip content={label}>
      <button
        onClick={onClick}
        aria-label={label}
        className={cn(
          'rounded-full grid place-items-center transition-all border active:scale-95',
          big ? 'h-14 w-14' : 'h-10 w-10',
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

/** One tile in the "More" sheet — icon over label, the same shape a phone's
    own share-sheet grid uses, because that is the gesture this is standing
    in for: everything a call can do that does not fit four circles. */
function MoreTile({
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
    <button
      onClick={onClick}
      className="flex flex-col items-center gap-1.5 p-2.5 rounded-input hover:bg-raised transition-colors"
    >
      <span
        className={cn(
          'h-11 w-11 rounded-full grid place-items-center border',
          danger
            ? 'bg-danger/15 border-danger/50 text-danger'
            : active
              ? 'bg-gold/15 border-gold/50 text-gold'
              : 'bg-raised border-edge text-dim',
        )}
      >
        {icon}
      </span>
      <span className="text-2xs text-dim text-center leading-tight">{label}</span>
    </button>
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
  const speaker = useStore((s) => s.settings.calls.speaker);
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

  // Which physical speaker plays this - only meaningful on the far side's
  // tile, which is the element actually carrying their audio (see this
  // component's own note on why it stays mounted for a voice call too).
  // `setSinkId` is Chromium-only and absent on some builds, so a device
  // that cannot change output just keeps using whatever the system
  // default already is rather than throwing.
  React.useEffect(() => {
    const el = videoRef.current as (HTMLVideoElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (isSelf || !el?.setSinkId) return;
    void el.setSinkId(speaker === 'default' ? '' : speaker).catch(() => {});
  }, [isSelf, speaker, stream]);

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
        <Zoomable
          className={cn('h-full w-full', !showVideo && 'hidden')}
          // Only the large tile gets buttons; on a thumbnail they would cover
          // the face they are drawn over.
          controls={large}
        >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          // Which tile this is, so "pop out" can float the other person
          // rather than a mirror of yourself.
          data-call-video={isSelf ? 'self' : 'remote'}
          // Never play your own microphone back at yourself.
          muted={isSelf}
          className={cn(
            // Fitted, not cropped. `object-cover` fills the tile by cutting
            // the edges off, which on a shared screen removes exactly the
            // part someone is pointing at, and on a portrait phone camera
            // takes the top of everyone's head. Letterboxing against the
            // tile's own background is the honest presentation; zooming is
            // there for anyone who wants to fill the frame.
            'h-full w-full object-contain',
            isSelf && mirror && 'scale-x-[-1]',
            !showVideo && 'hidden',
          )}
        />
        </Zoomable>
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
