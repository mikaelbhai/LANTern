/**
 * Real voice, video and screen sharing between peers.
 *
 * The media itself is WebRTC, negotiated directly between the two webviews.
 * Only the negotiation travels over LANTern's signalling link — offers,
 * answers and ICE candidates — because that link is the only thing that knows
 * which peer is which. Once the connection is up, audio and video go straight
 * from one device to the other and never touch the Rust layer.
 *
 * There are no ICE servers configured, and that is deliberate. STUN exists to
 * discover your public address for traversing the internet; on a LAN both
 * devices already have host candidates that reach each other directly, and
 * pointing at a public STUN server would be the one part of LANTern that
 * phoned home. The STUN server this app runs is for peers separated by an
 * internal NAT, and is offered explicitly rather than assumed.
 */
import { api, on } from './bridge';
import type { CallKind } from './types';

/** Host candidates only — see the note above about staying offline. */
const RTC_CONFIG: RTCConfiguration = { iceServers: [] };

export interface SignalMessage {
  /** Stamped by the Rust delivery path; the authenticated sender. */
  from: string;
  callId: string;
  kind: CallKind;
  type: 'offer' | 'answer' | 'ice' | 'hangup' | 'decline';
  sdp?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
}

interface Session {
  callId: string;
  kind: CallKind;
  pc: RTCPeerConnection;
  /** Candidates that arrived before the remote description was set. */
  pending: RTCIceCandidateInit[];
  remote: MediaStream;
}

type RemoteHandler = (peerId: string, stream: MediaStream) => void;
type IncomingHandler = (msg: SignalMessage) => void;
type EndedHandler = (peerId: string, reason: 'hangup' | 'declined' | 'failed') => void;
type ConnectedHandler = (peerId: string) => void;

const sessions = new Map<string, Session>();
let localStream: MediaStream | null = null;
let screenStream: MediaStream | null = null;

const remoteHandlers = new Set<RemoteHandler>();
const incomingHandlers = new Set<IncomingHandler>();
const endedHandlers = new Set<EndedHandler>();
const connectedHandlers = new Set<ConnectedHandler>();

export function onRemoteStream(fn: RemoteHandler): () => void {
  remoteHandlers.add(fn);
  return () => remoteHandlers.delete(fn);
}

export function onIncomingCall(fn: IncomingHandler): () => void {
  incomingHandlers.add(fn);
  return () => incomingHandlers.delete(fn);
}

export function onCallEnded(fn: EndedHandler): () => void {
  endedHandlers.add(fn);
  return () => endedHandlers.delete(fn);
}

/**
 * Fires when media is actually flowing to a peer.
 *
 * The caller has no other way to know it was answered: an answer SDP means
 * the far side picked up, but ICE still has to complete before anything is
 * audible. Without this the caller sat on "Calling…" through the entire
 * conversation.
 */
export function onCallConnected(fn: ConnectedHandler): () => void {
  connectedHandlers.add(fn);
  return () => connectedHandlers.delete(fn);
}

/** The camera/mic stream shared by every session in this call. */
export function getLocalStream(): MediaStream | null {
  return localStream;
}

export function getRemoteStream(peerId: string): MediaStream | null {
  return sessions.get(peerId)?.remote ?? null;
}

async function ensureLocalMedia(kind: CallKind): Promise<MediaStream> {
  const wantVideo = kind === 'video';
  const haveVideo = !!localStream?.getVideoTracks().length;
  if (localStream && (!wantVideo || haveVideo)) return localStream;

  const next = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    // Ask for 1080p30. There is no reason to capture at 720p on a link that
    // is not the internet, and the browser negotiates down on its own if the
    // camera cannot manage it.
    video: wantVideo
      ? {
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        }
      : false,
  });

  // Keep one stream for the whole call so every peer gets the same tracks.
  if (localStream) {
    for (const track of next.getTracks()) localStream.addTrack(track);
    return localStream;
  }
  localStream = next;
  return localStream;
}

function send(peerId: string, msg: Omit<SignalMessage, 'from'>): Promise<boolean> {
  return api.call.signal(peerId, msg).catch(() => false);
}

function createSession(peerId: string, callId: string, kind: CallKind): Session {
  const pc = new RTCPeerConnection(RTC_CONFIG);
  const remote = new MediaStream();
  const session: Session = { callId, kind, pc, pending: [], remote };
  sessions.set(peerId, session);

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      void send(peerId, { callId, kind, type: 'ice', candidate: e.candidate.toJSON() });
    }
  };

  pc.ontrack = (e) => {
    for (const track of e.streams[0]?.getTracks() ?? [e.track]) {
      if (!remote.getTracks().some((t) => t.id === track.id)) remote.addTrack(track);
    }
    remoteHandlers.forEach((fn) => fn(peerId, remote));
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') {
      void tuneForLan(pc);
      connectedHandlers.forEach((fn) => fn(peerId));
      return;
    }
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      teardown(peerId);
      endedHandlers.forEach((fn) => fn(peerId, 'failed'));
    }
  };

  return session;
}

/**
 * Raises the encoder ceiling once a connection is up.
 *
 * WebRTC's defaults assume the public internet: roughly 1-2 Mbps for video,
 * which over a LAN produces the soft, smeared picture this is here to fix.
 * The bandwidth estimator still governs — this only stops it capping itself
 * an order of magnitude below what the network can carry.
 *
 * `maintain-resolution` matters as much as the bitrate: the default is to
 * drop resolution to protect frame rate, which is the wrong trade for a
 * screen share or a face on a big display.
 */
async function tuneForLan(pc: RTCPeerConnection): Promise<void> {
  for (const sender of pc.getSenders()) {
    if (!sender.track) continue;
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];

    for (const encoding of params.encodings) {
      if (sender.track.kind === 'video') {
        encoding.maxBitrate = 12_000_000;
        encoding.maxFramerate = 30;
        encoding.scaleResolutionDownBy = 1;
      } else {
        // Opus tops out well below this; the ceiling simply stops it
        // throttling to telephone quality on a network that never needed it.
        encoding.maxBitrate = 256_000;
      }
    }
    params.degradationPreference = 'maintain-resolution';

    await sender.setParameters(params).catch(() => {
      // Older webviews reject some of these fields; the call still works,
      // just at whatever the default was.
    });
  }
}

function attachLocalTracks(session: Session, stream: MediaStream) {
  for (const track of stream.getTracks()) {
    const already = session.pc
      .getSenders()
      .some((s) => s.track && s.track.id === track.id);
    if (!already) session.pc.addTrack(track, stream);
  }
}

/** Places a call to one peer. Rejects if there is no live link to them. */
export async function placeCall(peerId: string, callId: string, kind: CallKind): Promise<void> {
  const stream = await ensureLocalMedia(kind);
  const session = sessions.get(peerId) ?? createSession(peerId, callId, kind);
  attachLocalTracks(session, stream);

  const offer = await session.pc.createOffer();
  await session.pc.setLocalDescription(offer);

  const delivered = await send(peerId, { callId, kind, type: 'offer', sdp: offer });
  if (!delivered) {
    teardown(peerId);
    throw new Error('No live link to that device');
  }
}

/** Answers a call this device was offered. */
export async function answerCall(peerId: string, msg: SignalMessage): Promise<void> {
  const session = sessions.get(peerId);
  if (!session || !msg.sdp) return;

  const stream = await ensureLocalMedia(msg.kind);
  attachLocalTracks(session, stream);

  const answer = await session.pc.createAnswer();
  await session.pc.setLocalDescription(answer);
  await send(peerId, { callId: msg.callId, kind: msg.kind, type: 'answer', sdp: answer });
}

export function declineCall(peerId: string, callId: string, kind: CallKind) {
  void send(peerId, { callId, kind, type: 'decline' });
  teardown(peerId);
}

export function hangUp(peerId?: string) {
  const targets = peerId ? [peerId] : [...sessions.keys()];
  for (const id of targets) {
    const s = sessions.get(id);
    if (s) void send(id, { callId: s.callId, kind: s.kind, type: 'hangup' });
    teardown(id);
  }
  if (!sessions.size) releaseMedia();
}

function teardown(peerId: string) {
  const s = sessions.get(peerId);
  if (!s) return;
  s.pc.onicecandidate = null;
  s.pc.ontrack = null;
  s.pc.onconnectionstatechange = null;
  try {
    s.pc.close();
  } catch {
    // Already closed; nothing to do.
  }
  sessions.delete(peerId);
  if (!sessions.size) releaseMedia();
}

function releaseMedia() {
  // Stopping the tracks is what actually turns the camera light off.
  localStream?.getTracks().forEach((t) => t.stop());
  localStream = null;
  screenStream?.getTracks().forEach((t) => t.stop());
  screenStream = null;
}

/* --------------------------------------------------------- screen share */

/**
 * Replaces the outgoing video track with the screen, on every live session.
 *
 * `replaceTrack` rather than a new negotiation: the peers have already agreed
 * on a video track, so swapping what feeds it avoids a second offer/answer
 * round and the visible stall that comes with it.
 */
/**
 * The graph that mixes the microphone with whatever the screen is playing.
 *
 * Held open for the life of a share and torn down with it: an AudioContext is
 * a real audio device, and leaving one running keeps the process awake.
 */
let shareMix: { ctx: AudioContext; track: MediaStreamTrack } | null = null;

/**
 * Combines the microphone and the shared screen's audio into one track.
 *
 * There is already an audio sender carrying the microphone, and adding a
 * second track would mean a fresh offer/answer for a new m-line — the same
 * stall `replaceTrack` exists to avoid. Mixing both sources into a single
 * track keeps the negotiated shape of the call exactly as it was.
 *
 * The screen's audio is captured digitally rather than through a speaker, so
 * it cannot feed back into the microphone; no echo cancellation is needed on
 * that side.
 */
function mixShareAudio(microphone: MediaStreamTrack | null, system: MediaStreamTrack): MediaStreamTrack | null {
  try {
    const ctx = new AudioContext();
    const destination = ctx.createMediaStreamDestination();

    ctx.createMediaStreamSource(new MediaStream([system])).connect(destination);
    if (microphone && microphone.readyState === 'live') {
      ctx.createMediaStreamSource(new MediaStream([microphone])).connect(destination);
    }

    const mixed = destination.stream.getAudioTracks()[0] ?? null;
    if (!mixed) {
      void ctx.close();
      return null;
    }

    shareMix = { ctx, track: mixed };
    return mixed;
  } catch {
    // No WebAudio, or the device refused another context. The share still
    // works; it just carries picture only.
    return null;
  }
}

export async function startScreenShare(): Promise<MediaStream | null> {
  // Asking for audio is a request, not a guarantee: the picker offers a
  // "share audio" tick on Chromium desktop, Android has no such capture at
  // all, and a machine with no loopback device simply returns video. Any of
  // those is fine, but a request for audio that the platform rejects outright
  // would fail the whole call, so it falls back to video alone.
  const display = await navigator.mediaDevices
    .getDisplayMedia({ video: { frameRate: 30 }, audio: true })
    .catch(() =>
      navigator.mediaDevices
        .getDisplayMedia({ video: { frameRate: 30 }, audio: false })
        .catch(() => null),
    );
  if (!display) return null;

  screenStream = display;
  const track = display.getVideoTracks()[0];
  if (!track) return null;

  const systemAudio = display.getAudioTracks()[0] ?? null;
  const mixed = systemAudio ? mixShareAudio(localStream?.getAudioTracks()[0] ?? null, systemAudio) : null;

  for (const session of sessions.values()) {
    const sender = session.pc.getSenders().find((s) => s.track?.kind === 'video');
    if (sender) await sender.replaceTrack(track).catch(() => {});
    else session.pc.addTrack(track, display);

    if (mixed) {
      const audio = session.pc.getSenders().find((s) => s.track?.kind === 'audio');
      if (audio) await audio.replaceTrack(mixed).catch(() => {});
    }
  }

  // The browser's own "stop sharing" bar bypasses our UI entirely.
  track.onended = () => void stopScreenShare();
  return display;
}

export async function stopScreenShare(): Promise<void> {
  screenStream?.getTracks().forEach((t) => t.stop());
  screenStream = null;

  const camera = localStream?.getVideoTracks()[0] ?? null;
  // Back to the bare microphone: the mix included the screen, which is gone.
  const microphone = localStream?.getAudioTracks()[0] ?? null;

  for (const session of sessions.values()) {
    const sender = session.pc.getSenders().find((s) => s.track?.kind === 'video');
    if (sender) await sender.replaceTrack(camera).catch(() => {});

    if (shareMix) {
      const audio = session.pc.getSenders().find((s) => s.track?.kind === 'audio');
      if (audio) await audio.replaceTrack(microphone).catch(() => {});
    }
  }

  shareMix?.track.stop();
  void shareMix?.ctx.close().catch(() => {});
  shareMix = null;
}

export function isSharingScreen(): boolean {
  return !!screenStream;
}

/* ------------------------------------------------------------ signalling */

let wired = false;

/** Subscribes to inbound signalling. Idempotent. */
export function startCallSignalling() {
  if (wired) return;
  wired = true;

  on('call:state', (msg: SignalMessage) => {
    if (!msg?.from || !msg.type) return;
    void handle(msg).catch((err) => console.error('LANTern: call signalling failed', err));
  });
}

async function handle(msg: SignalMessage) {
  const peerId = msg.from;

  switch (msg.type) {
    case 'offer': {
      if (!msg.sdp) return;
      const session = sessions.get(peerId) ?? createSession(peerId, msg.callId, msg.kind);
      await session.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      await drainPending(session);
      // The UI decides whether to answer; it rings until someone does.
      incomingHandlers.forEach((fn) => fn(msg));
      return;
    }

    case 'answer': {
      const session = sessions.get(peerId);
      if (!session || !msg.sdp) return;
      await session.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      await drainPending(session);
      return;
    }

    case 'ice': {
      const session = sessions.get(peerId);
      if (!session || !msg.candidate) return;
      // Candidates can outrun the description they belong to.
      if (!session.pc.remoteDescription) {
        session.pending.push(msg.candidate);
        return;
      }
      await session.pc.addIceCandidate(new RTCIceCandidate(msg.candidate)).catch(() => {});
      return;
    }

    case 'decline':
      teardown(peerId);
      endedHandlers.forEach((fn) => fn(peerId, 'declined'));
      return;

    case 'hangup':
      teardown(peerId);
      endedHandlers.forEach((fn) => fn(peerId, 'hangup'));
      return;
  }
}

async function drainPending(session: Session) {
  const queued = session.pending.splice(0);
  for (const candidate of queued) {
    await session.pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {});
  }
}
