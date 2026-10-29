import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft,
  Gauge,
  Maximize,
  Maximize2,
  Minimize,
  Pause,
  PictureInPicture2,
  Play,
  Repeat,
  RotateCcw,
  RotateCw,
  SkipBack,
  Sun,
  Subtitles,
  SkipForward,
  Users,
  X,
  Volume2,
  VolumeX,
  WifiOff,
  Languages,
  Crop,
  Lock,
  LockKeyhole,
  LockOpen,
  Moon,
  Scan,
  Smartphone,
} from 'lucide-react';
import { Artwork } from '../../lib/poster';
import { api, on } from '../../lib/bridge';
import { useStore } from '../../lib/store';
import {
  rotatesWithDevice,
  setOrientationLocked,
  useOrientation,
} from '../../lib/orientation';
import { cn } from '../../lib/utils';
import type { MediaItem, WatchParty } from '../../lib/types';
import { useBackDismiss } from '../../lib/hooks';
import { browserCanPlay, needsRemux } from '../../lib/audiocap';
import { claimArrowKeys } from '../../lib/tv';
import { RotationLock } from '../../components/RotationLock';
import { streamOrigin } from './keyframe';
import { setBoost } from './loudness';
import { trackNames } from './tracks';
import { useDetectedSubtitles } from './useDetectedSubtitles';
import {
  SubtitleOverlay,
  SUBTITLE_STYLES,
  useSubtitleCues,
  type SubtitleStyle,
} from './Subtitles';
import { useLocalStorage } from '../../lib/hooks';
import {
  boxFor,
  croppedAway,
  fitLabel,
  loadFit,
  otherFit,
  saveFit,
  type Fit,
} from '../../lib/aspect';

const HIDE_AFTER_MS = 2800;
// How close, in pixels, the pointer has to come to where the film is now for a
// drag to let go of the pointer and hold on to that spot.
const SNAP_PX = 16;
// A full-height vertical swipe covers the full 0-1 brightness/volume range.
const SWIPE_RANGE_PX = 220;

/**
 * Finds the track carrying a language, or -1.
 *
 * Where a release has several tracks in one language — full subtitles, signs
 * only, SDH — the first is taken. There is nothing in the file that says which
 * is which, so any other choice would be a guess dressed up as a decision.
 */
function matchLanguage(
  tracks: { lang?: string }[] | undefined,
  lang: string | undefined,
): number {
  if (!tracks?.length || !lang) return -1;
  const want = lang.trim().toLowerCase();
  if (!want) return -1;
  return tracks.findIndex((t) => (t.lang ?? '').trim().toLowerCase() === want);
}

export function Player({
  item,
  upNext,
  previous,
  ownerName,
  party,
  isHost,
  partyMembers,
  onClose,
  onPlayNext,
  onShape,
  onProgress,
  docked = false,
  onExpand,
}: {
  item: MediaItem;
  upNext: MediaItem | null;
  /** The episode before this one, when there is one. */
  previous?: MediaItem | null;
  ownerName: string;
  party?: WatchParty | null;
  isHost?: boolean;
  partyMembers?: { name: string; color?: string; emoji?: string }[];
  onClose: () => void;
  onPlayNext: (next: MediaItem) => void;
  /** Told whether the picture is taller than it is wide, once that is known. */
  onShape?: (portrait: boolean) => void;
  /** Told each time the position is saved, so the caller can keep a fresh copy. */
  onProgress?: (id: string, sec: number) => void;
  /**
   * Shrunk to a strip across the top of a portrait screen, with the library
   * below it. The film keeps playing - this is the same player, resized, not
   * a second one - so the controls shown are the few that fit.
   */
  docked?: boolean;
  /** Asks for the full screen back, from the docked strip. */
  onExpand?: () => void;
}) {
  // Through a ref: the saving effect is installed once per title and must not
  // be torn down and rebuilt every time the parent makes a new callback.
  const onProgressRef = React.useRef(onProgress);
  onProgressRef.current = onProgress;
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const shellRef = React.useRef<HTMLDivElement>(null);

  const [playing, setPlaying] = React.useState(true);
  const [time, setTime] = React.useState(item.progressSec);
  const [duration, setDuration] = React.useState(item.durationSec);
  // 0-2: above 1 is gain, which needs the media fetched with a CORS check so
  // the audio graph may read it.
  const [volume, setVolume] = React.useState(1);
  const [muted, setMuted] = React.useState(false);
  // Set when a host refused the CORS check (media is then fetched plain, and
  // cannot be amplified) or the audio graph could not be built at all.
  const [plainMedia, setPlainMedia] = React.useState(false);
  const [unboostable, setUnboostable] = React.useState(false);
  const maxVolume = plainMedia || unboostable ? 1 : 2;
  const maxVolumeRef = React.useRef(maxVolume);
  maxVolumeRef.current = maxVolume;
  // Where to resume when the element is replaced for the sake of the above.
  const retryAt = React.useRef<number | null>(null);
  /**
   * A software dim, VLC's own answer to there being no web API for the
   * screen's actual backlight. `filter: brightness()` on the picture itself
   * — honest about what it is: a swipe that visibly does something, not a
   * claim about the panel underneath it.
   */
  const [brightness, setBrightness] = React.useState(1);
  const [buffered, setBuffered] = React.useState(0);
  const [chrome, setChrome] = React.useState(true);
  const [fullscreen, setFullscreen] = React.useState(false);
  const [pip, setPip] = React.useState(false);
  /**
   * Whether this webview has a floating window to offer at all.
   *
   * Read once, from the runtime rather than from the platform: asking "is this
   * Android" would be guessing at the answer to a question the browser will
   * answer plainly, and it is wrong on any desktop build that has it disabled.
   */
  const pipSupported =
    typeof document !== 'undefined' &&
    'pictureInPictureEnabled' in document &&
    document.pictureInPictureEnabled;
  const [unreachable, setUnreachable] = React.useState(false);
  const [scrubbing, setScrubbing] = React.useState(false);
  // Where a drag on the bar currently points. The stream is only asked to
  // move when the finger or button is let go: a remuxed stream is re-requested
  // from the new point, and doing that on every pixel of a drag would restart
  // it dozens of times a second.
  const [scrubTime, setScrubTime] = React.useState<number | null>(null);
  // True while the drag is held on the place the film is at now, so letting go
  // there changes nothing - the way to take a seek back.
  const [scrubSnapped, setScrubSnapped] = React.useState(false);
  // The time under a mouse resting on the bar, with its x offset for the label.
  const [hover, setHover] = React.useState<{ x: number; t: number } | null>(null);
  const barRef = React.useRef<HTMLDivElement>(null);
  const previewEver = React.useRef(false);
  // Seconds, positive meaning later. The one fix for subtitles that were timed
  // against a different cut of the film, which is most of the ones found
  // beside a file rather than inside it.
  const [subDelay, setSubDelay] = React.useState(0);
  // Falling asleep to a film: the timer pauses it, and "after this one" stops
  // a series from rolling on into the next episode all night.
  const [sleepAt, setSleepAt] = React.useState<number | null>(null);
  const [sleepAtEnd, setSleepAtEnd] = React.useState(false);
  const [sleepOpen, setSleepOpen] = React.useState(false);
  // VLC's padlock: with the controls locked a pocket or a child's finger
  // cannot seek, pause or leave. Tapping shows the unlock for a moment.
  const [controlsLocked, setControlsLocked] = React.useState(false);
  const [unlockShown, setUnlockShown] = React.useState(false);
  // Index into item.subtitles, or -1 for off. Off by default: burning
  // subtitles on unasked is worse than one extra click — unless this title,
  // or the last one watched, was being read with them on.
  const [subtitle, setSubtitle] = React.useState(() =>
    matchLanguage(item.subtitles, item.subtitleLang),
  );
  const [tracksOpen, setTracksOpen] = React.useState(false);
  const [audioOpen, setAudioOpen] = React.useState(false);
  // How the picture meets the frame. Kept across titles the way every other
  // player keeps it: somebody who chose Crop because their monitor and their
  // films disagree means it for the next film too.
  const [fit, setFitState] = React.useState<Fit>(loadFit);
  const setFit = React.useCallback((next: Fit) => {
    setFitState(next);
    saveFit(next);
  }, []);
  // The frame the picture is fitted into, and the picture's own size. Both
  // are measured rather than assumed — a forced ratio needs neither, but
  // everything else needs both.
  const [frame, setFrame] = React.useState({ w: 0, h: 0 });
  const [natural, setNatural] = React.useState({ w: 0, h: 0 });
  const stageRef = React.useRef<HTMLDivElement>(null);
  const [subStyle, setSubStyle] = useLocalStorage<SubtitleStyle>(
    'lantern.subtitleStyle',
    'classic',
  );

  // Playback speed. Not persisted across titles — a 1.5x lecture and the
  // film that follows it are not the same request.
  const [rate, setRate] = React.useState(1);
  const [speedOpen, setSpeedOpen] = React.useState(false);

  /**
   * A-B repeat: one point set, then two, loops between them until cleared.
   *
   * One button cycling through three states rather than three buttons -
   * "set the start", "set the end", "stop" is one decision at a time, the
   * same order VLC's own single repeat button asks it in.
   */
  const [repeatA, setRepeatA] = React.useState<number | null>(null);
  const [repeatB, setRepeatB] = React.useState<number | null>(null);
  const cycleRepeat = () => {
    if (repeatA === null) {
      setRepeatA(time);
    } else if (repeatB === null) {
      // The later of the two, whichever order they were pressed in - a
      // press before the first point is a mistake, not a request to loop
      // backwards.
      if (time > repeatA) setRepeatB(time);
      else {
        setRepeatB(repeatA);
        setRepeatA(time);
      }
    } else {
      setRepeatA(null);
      setRepeatB(null);
    }
  };
  React.useEffect(() => {
    setRepeatA(null);
    setRepeatB(null);
    setBrightness(1);
  }, [item.id]);

  /**
   * Double-tap the left or right edge to seek, the way VLC's mobile app
   * does. Layered on top of the existing single-tap-to-toggle-chrome
   * surface rather than replacing any of it: a fast second tap in the same
   * edge within the window additionally seeks, on top of whatever the taps
   * already did on their own (the first showed the controls, is all).
   * Nothing here calls preventDefault, so that behaviour is untouched.
   */
  const lastEdgeTap = React.useRef<{ time: number; zone: 'left' | 'right' | null }>({
    time: 0,
    zone: null,
  });
  const [seekFlash, setSeekFlash] = React.useState<{ zone: 'left' | 'right'; amount: number } | null>(
    null,
  );
  const seekFlashTimer = React.useRef<ReturnType<typeof setTimeout>>();

  /**
   * Vertical swipe for brightness (left third) and volume (right third),
   * VLC's other pair of mobile gestures. A drag is told from a tap by
   * movement past a small threshold — under that, this stays out of the
   * way entirely and the touch is free to become a tap or a double-tap.
   */
  const dragRef = React.useRef<{
    zone: 'left' | 'right';
    startY: number;
    startValue: number;
    dragging: boolean;
  } | null>(null);
  const [swipeFlash, setSwipeFlash] = React.useState<{ zone: 'left' | 'right'; pct: number } | null>(
    null,
  );

  const onStageTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const xPct = (touch.clientX - rect.left) / rect.width;
    const zone: 'left' | 'right' | null = xPct < 0.35 ? 'left' : xPct > 0.65 ? 'right' : null;
    if (!zone) {
      dragRef.current = null;
      return;
    }
    dragRef.current = {
      zone,
      startY: touch.clientY,
      startValue: zone === 'left' ? brightness : muted ? 0 : volume,
      dragging: false,
    };
  };

  /**
   * A plain DOM listener rather than React's onTouchMove.
   *
   * React attaches touch listeners passively at the root for scroll
   * performance, and a passive listener's preventDefault is silently
   * ignored — confirmed in the browser sim as a console error, "Unable to
   * preventDefault inside passive event listener invocation," with the
   * drag itself still working but the page free to bounce under it. Only a
   * listener added with { passive: false } can actually stop that.
   */
  const touchSurfaceRef = React.useRef<HTMLButtonElement>(null);
  const onStageTouchMove = React.useCallback(
    (e: TouchEvent) => {
      const drag = dragRef.current;
      const touch = e.touches[0];
      if (!drag || !touch) return;

      const deltaY = drag.startY - touch.clientY; // up is positive
      if (!drag.dragging && Math.abs(deltaY) < 12) return;
      drag.dragging = true;
      // A drag in progress is not a scroll, and this page has nothing to
      // scroll anyway — left default the gesture would otherwise bounce the
      // whole webview on some Android builds.
      e.preventDefault();

      if (drag.zone === 'left') {
        // 0.4-1.6: dim to less than half, or brighten enough to matter,
        // without washing the picture out past recognition.
        const next = Math.max(0.4, Math.min(1.6, drag.startValue + (deltaY / SWIPE_RANGE_PX) * 1.2));
        setBrightness(next);
        setSwipeFlash({ zone: 'left', pct: Math.round(((next - 0.4) / 1.2) * 100) });
      } else {
        // A full swipe is the whole range, so 200% is not a second swipe away.
        const next = Math.max(
          0,
          Math.min(maxVolumeRef.current, drag.startValue + (deltaY / SWIPE_RANGE_PX) * maxVolumeRef.current),
        );
        setVolume(next);
        setMuted(false);
        setSwipeFlash({ zone: 'right', pct: Math.round(next * 100) });
      }
    },
    // SWIPE_RANGE_PX is a module-scope constant, not a dependency.
    [],
  );
  React.useEffect(() => {
    const el = touchSurfaceRef.current;
    if (!el) return;
    el.addEventListener('touchmove', onStageTouchMove, { passive: false });
    return () => el.removeEventListener('touchmove', onStageTouchMove);
  }, [onStageTouchMove]);

  const onStageTouchEnd = (e: React.TouchEvent) => {
    const wasDragging = dragRef.current?.dragging ?? false;
    dragRef.current = null;
    if (wasDragging) {
      setSwipeFlash(null);
      // A drag is not a tap, so it must not seed the next double-tap check
      // with a stale zone from before the finger moved.
      lastEdgeTap.current = { time: 0, zone: null };
      return;
    }

    const touch = e.changedTouches[0];
    if (!touch) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const xPct = (touch.clientX - rect.left) / rect.width;
    // The middle third is the toggle-chrome zone and stays exactly that -
    // a middle tap here does not chain into anything.
    const zone: 'left' | 'right' | null = xPct < 0.35 ? 'left' : xPct > 0.65 ? 'right' : null;
    if (!zone) return;

    const now = Date.now();
    const chained = now - lastEdgeTap.current.time < 400 && lastEdgeTap.current.zone === zone;
    lastEdgeTap.current = { time: now, zone };
    if (!chained) return;

    const delta = zone === 'left' ? -10 : 10;
    seekTo(time + delta);
    setSeekFlash((f) => ({ zone, amount: f && f.zone === zone ? f.amount + delta : delta }));
    clearTimeout(seekFlashTimer.current);
    seekFlashTimer.current = setTimeout(() => setSeekFlash(null), 650);
  };

  const subtitles = item.subtitles ?? [];
  const audioTracks = item.audioTracks ?? [];

  // Only the chosen subtitle is fetched — the others would each be a request
  // to another machine for a file nobody asked to read.
  // Readable, unambiguous names for both menus.
  const detected = useDetectedSubtitles(subtitles, tracksOpen);
  // `detected` is a module-level cache that fills in after the menu opens, so
  // it cannot be a memo dependency; the hook re-renders when it grows.
  const subtitleNames = trackNames(
    subtitles.map((s) => {
      const found = detected.get(s.url);
      return found ? { ...s, lang: found.lang, kind: found.kind } : s;
    }),
  );
  const audioNames = React.useMemo(() => trackNames(audioTracks), [audioTracks]);

  const cues = useSubtitleCues(subtitle >= 0 ? (subtitles[subtitle]?.url ?? null) : null);

  // Which audio track is playing, and whether this device can change it.
  const [audioTrack, setAudioTrack] = React.useState(() =>
    matchLanguage(item.audioTracks, item.audioLang),
  );
  // A remuxed stream has no timeline of its own, so seeking re-requests it
  // rather than scrubbing: `sourceOffset` is the point it was asked to begin at.
  const [sourceOffset, setSourceOffset] = React.useState(0);
  // And where it really begins - a keyframe at or before that - which is what
  // the player's clock is measured from.
  const [streamStart, setStreamStart] = React.useState(0);
  /**
   * How far to move the audio, in milliseconds, positive for later.
   *
   * The shift is applied where the file is, not here: one <video> element has
   * a single clock, so a page cannot slide its own audio against its own
   * picture. Asking the far side to re-cut the stream is the only lever there
   * is, which is why this re-requests rather than adjusting something local.
   */
  const [audioDelay, setAudioDelay] = React.useState(0);
  const [canSwitchAudio, setCanSwitchAudio] = React.useState(false);

  /**
   * Starts the remuxed stream at `at`, or as near before it as the video allows.
   *
   * The video is copied, so the stream can only begin on a keyframe. The host
   * says which, before the stream is requested, and the clock is measured from
   * there. Assuming the request was granted put the clock and the subtitles up
   * to a GOP ahead of the picture after every skip.
   *
   * Changes that belong in the same request (a track, a delay) wait for the
   * answer and go in together: applied at once they would each re-request the
   * stream from the old offset first.
   */
  const startGen = React.useRef(0);
  const startWith = React.useRef<{ track?: number; delay?: number }>({});
  const startRemuxAt = React.useCallback(
    (at: number, change: { track?: number; delay?: number } = {}) => {
      Object.assign(startWith.current, change);
      const gen = ++startGen.current;
      void streamOrigin(item.streamUrl, at).then((start) => {
        if (gen !== startGen.current) return;
        const wanted = startWith.current;
        startWith.current = {};
        setSourceOffset(at);
        setStreamStart(start);
        if (wanted.track !== undefined) setAudioTrack(wanted.track);
        if (wanted.delay !== undefined) setAudioDelay(wanted.delay);
      });
    },
    [item.streamUrl],
  );

  /*
   * Moving to another episode starts it afresh.
   *
   * This component is not remounted when `item` changes - doing so would
   * drop fullscreen on every episode of a binge - so everything that belongs
   * to one title has to be put back by hand. It was not: the clock and the
   * length stayed what the last episode's were, so E2 opened at E1's
   * 22 minutes with E1's 53 minute total, and the progress then saved against
   * E2 was E1's position. Each episode now begins at its own saved place.
   */
  const shownItem = React.useRef(item.id);
  React.useEffect(() => {
    if (shownItem.current === item.id) return;
    shownItem.current = item.id;
    setTime(item.progressSec);
    latestTime.current = item.progressSec;
    setDuration(item.durationSec);
    setBuffered(0);
    setSourceOffset(0);
    setStreamStart(0);
    setNatural({ w: 0, h: 0 });
    setUnreachable(false);
    setRepeatA(null);
    setRepeatB(null);
    setPlaying(true);
    setSubtitle(matchLanguage(item.subtitles, item.subtitleLang));
    setAudioTrack(matchLanguage(item.audioTracks, item.audioLang));
    setAudioDelay(0);
    // An answer still in flight belongs to the last episode.
    startGen.current++;
    startWith.current = {};
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id]);

  // True when some track here cannot be decoded on this device — which is a
  // reason to offer the control even with nothing to switch between.
  const unplayable = React.useMemo(
    () =>
      audioTracks.some((t: any) =>
        needsRemux(t?.codec ?? '', t?.webSafe !== false, browserCanPlay),
      ),
    [audioTracks],
  );

  React.useEffect(() => {
    if (audioTracks.length < 2 && !unplayable) return;
    void api.media.canSwitchAudio().then(setCanSwitchAudio).catch(() => setCanSwitchAudio(false));
  }, [audioTracks.length, unplayable]);

  /**
   * Asks for the remuxed stream when the only track is one this device cannot
   * decode, without waiting to be told.
   *
   * Five episodes played in silence because their sole track was E-AC-3:
   * nothing to switch to, so nothing was offered, so the one thing that would
   * have fixed it was never reachable. Chosen once per title, and never over
   * a choice already made by hand.
   */
  const autoPicked = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (autoPicked.current === item.id) return;
    if (audioTrack >= 0 || audioTracks.length === 0) return;
    const track: any =
      audioTracks.find((t: any) => t?.default) ?? audioTracks[0];
    if (!track) return;
    if (!needsRemux(track.codec ?? '', track.webSafe !== false, browserCanPlay)) return;
    autoPicked.current = item.id;
    // From where the viewer is, not from the start: the remuxed stream begins
    // at whatever it is asked for, and this used to ask for nothing.
    // `time` would still be the previous episode's on a change of title.
    startRemuxAt(item.progressSec, { track: typeof track.index === 'number' ? track.index : 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.id, audioTracks, audioTrack, startRemuxAt]);

  /**
   * Remembers the pair whenever either changes.
   *
   * Stored as languages rather than positions in the list, so the choice
   * survives the file being replaced by another release and carries to the
   * next episode, which is where it matters most.
   */
  const savedChoice = React.useRef<string>('');
  React.useEffect(() => {
    const audioLang = audioTrack >= 0 ? (audioTracks[audioTrack]?.lang ?? '') : '';
    const subtitleLang = subtitle >= 0 ? (subtitles[subtitle]?.lang ?? '') : '';

    // The first run reports what was just restored; writing it back would be
    // harmless but pointless, and would promote a default to a real choice.
    const key = `${audioLang}|${subtitleLang}`;
    if (savedChoice.current === '') {
      savedChoice.current = key;
      return;
    }
    if (savedChoice.current === key) return;
    savedChoice.current = key;

    void api.media.setTracks(item.id, audioLang, subtitleLang).catch(() => {
      /* a lost preference is not worth interrupting playback for */
    });
  }, [item.id, audioTrack, subtitle, audioTracks, subtitles]);

  /**
   * The URL to play.
   *
   * Choosing a track re-serves the file with that audio selected, resuming at
   * the current position — the remuxed stream starts wherever it was asked to,
   * so switching language mid-film does not start it over.
   */
  const source =
    audioTrack >= 0
      ? `${item.streamUrl}${item.streamUrl.includes('?') ? '&' : '?'}audio=${audioTrack}` +
        `&codec=${encodeURIComponent(audioTracks[audioTrack]?.codec ?? '')}` +
        `&t=${sourceOffset.toFixed(3)}` +
        (audioDelay !== 0 ? `&adelay=${audioDelay}` : '')
      : item.streamUrl;


  /**
   * Moves the audio, keeping the place.
   *
   * Re-requesting restarts the stream, so the current position goes with it.
   * On a file playing untouched there is nothing to re-cut, so this also takes
   * the remuxed path — which costs a re-encode, and is the only way to apply
   * a shift at all.
   */
  const nudgeDelay = (deltaMs: number) => {
    // From the request still in flight, if there is one: two quick taps are
    // +200, not two readings of +100.
    const current = startWith.current.delay ?? audioDelay;
    const next = Math.max(-5000, Math.min(5000, current + deltaMs));
    if (next === current) return;
    let track: number | undefined;
    if (audioTrack < 0) {
      const fallback: any = audioTracks.find((t: any) => t?.default) ?? audioTracks[0];
      if (fallback) track = typeof fallback.index === 'number' ? fallback.index : 0;
    }
    startRemuxAt(time, { delay: next, track });
  };

  // A shift belongs to the file it was judged against, not to the player.
  React.useEffect(() => setAudioDelay(0), [item.id]);

  const chooseAudio = (index: number) => {
    if (index >= 0) {
      startRemuxAt(time, { track: index });
    } else {
      // Back to the file as it is: it has a timeline of its own to seek in.
      startGen.current++;
      startWith.current = {};
      setSourceOffset(0);
      setStreamStart(0);
      setAudioTrack(index);
    }
    setTracksOpen(false);
  };

  // Track modes are managed by SubtitleOverlay, which sets the chosen one to
  // "hidden" rather than "showing" so the browser parses the cues without
  // painting them. Chromium ignores ::cue styling whenever the OS has a
  // closed-caption preference set, which is how subtitles ended up invisible.

  const hideTimer = React.useRef<number>();

  // Back closes the player. Without this it quit the app mid-film.
  useBackDismiss(true, onClose);

  /* ------------------------------------------------------ chrome timing */

  const scrubbingNow = React.useRef(false);
  const wake = React.useCallback(() => {
    setChrome(true);
    clearTimeout(hideTimer.current);
    // Not while a seek is being aimed: the bar being dragged is the thing that
    // would vanish out from under the finger.
    if (scrubbingNow.current) return;
    hideTimer.current = window.setTimeout(() => setChrome(false), HIDE_AFTER_MS);
  }, []);

  React.useEffect(() => {
    wake();
    return () => clearTimeout(hideTimer.current);
  }, [wake]);

  /* --------------------------------------------------- playback plumbing */

  const seekTo = React.useCallback(
    (next: number) => {
      const clamped = Math.max(0, Math.min(duration, next));
      setTime(clamped);

      // A remuxed stream has no timeline to seek within — it starts wherever
      // it was asked to. Moving the scrubber means requesting it again from
      // the new point, which the source URL carries.
      if (audioTrack >= 0) {
        startRemuxAt(clamped);
        return;
      }

      const el = videoRef.current;
      if (el && !unreachable && Number.isFinite(el.duration)) el.currentTime = clamped;
    },
    [duration, unreachable, audioTrack, startRemuxAt],
  );

  // When the file cannot be fetched the transport still has to behave, so the
  // clock is driven locally. Controls, seeking and progress all stay live.
  React.useEffect(() => {
    if (!unreachable || !playing) return;
    const id = setInterval(() => {
      setTime((t) => {
        const next = t + 0.25;
        return next >= duration ? duration : next;
      });
    }, 250);
    return () => clearInterval(id);
  }, [unreachable, playing, duration]);

  React.useEffect(() => {
    const el = videoRef.current;
    if (!el || unreachable) return;
    if (playing) void el.play().catch(() => setPlaying(false));
    else el.pause();
  }, [playing, unreachable]);

  // Reapplied on every rate change, and again in onLoadedMetadata below - a
  // remuxed seek loads a fresh <video> source, which resets playbackRate to
  // 1 on its own with no event this effect would otherwise catch.
  React.useEffect(() => {
    const el = videoRef.current;
    if (el) el.playbackRate = rate;
  }, [rate]);

  // A-B repeat's loop: once both points exist, reaching the second jumps
  // back to the first rather than playing past it. `unreachable`'s local
  // clock and the video element's own ticks both flow through `time`, so
  // one check here covers either source.
  React.useEffect(() => {
    if (repeatA === null || repeatB === null) return;
    if (time >= repeatB) seekTo(repeatA);
  }, [time, repeatA, repeatB, seekTo]);

  /*
   * The tap on Android's own PiP overlay button.
   *
   * A floating picture-in-picture window has no room for this app's own
   * controls and no accurate way to reach them with a finger even if it did
   * — Android's system overlay is the only button a window that size gets,
   * and it says nothing about what is inside except a play/pause action id.
   * See pip.rs and MainActivity.kt for the native half; this is the only
   * listener, so there is exactly one thing "toggle" can mean.
   */
  React.useEffect(() => on('pip:toggle', () => setPlaying((p) => !p)), []);

  React.useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    // The element's own volume stops at 1; anything above that is a gain stage.
    el.volume = Math.min(1, volume);
    el.muted = muted;
    // Without the CORS check the media is opaque to the audio graph, and
    // routing it through would turn it silent.
    if (plainMedia) return;
    if (!setBoost(el, volume)) setUnboostable(true);
  }, [volume, muted, unreachable, plainMedia]);

  // The loudest this device will go, once it has found it cannot go further.
  React.useEffect(() => {
    if (volume > maxVolume) setVolume(maxVolume);
  }, [volume, maxVolume]);

  /**
   * Where the viewer has got to, for the saver below to read.
   *
   * A ref rather than the dependency of an effect. Keying the saver on `time`
   * re-ran it four times a second, and every re-run fired its own cleanup -
   * so the position was written on every tick rather than every five seconds,
   * and any momentary wrong value was in the database before the next frame.
   */
  /**
   * Tells Android a film is on screen, for as long as one is.
   *
   * That is what decides whether leaving the app puts it in a floating window.
   * It used to be guessed from whether the device was making any sound at all,
   * which is true of a game's effects and of another app's music - so leaving
   * LANTern during a game popped the whole application out.
   */
  React.useEffect(() => {
    void api.pip.setPlaying(true).catch(() => {});
    return () => {
      void api.pip.setPlaying(false).catch(() => {});
    };
  }, []);

  const latestTime = React.useRef(time);
  latestTime.current = time;

  /**
   * True while the stream is being replaced.
   *
   * Changing the audio track, the delay, or scrubbing a remuxed stream all
   * mean asking the far side for the file again from a new point. In between,
   * the element reports a position belonging to no stream in particular -
   * zero, usually, briefly. Writing that down is how switching language lost
   * an hour of a film: the clock recovered a moment later, and the saved
   * position did not.
   */
  const swapping = React.useRef(false);
  React.useEffect(() => {
    swapping.current = true;
  }, [source]);

  // Remember where the viewer got to, so Continue watching is accurate.
  React.useEffect(() => {
    const save = () => {
      if (swapping.current) return;
      const at = Math.floor(latestTime.current);
      // A position before the point the stream was asked to start at cannot
      // be real, whatever the element says.
      if (at < Math.floor(streamStart)) return;
      void api.media.setProgress(item.id, at);
      onProgressRef.current?.(item.id, at);
    };
    const id = setInterval(save, 5000);
    return () => {
      clearInterval(id);
      save();
    };
  }, [item.id, streamStart]);

  /* -------------------------------------------------------- watch party */

  const following = !!party && !isHost;

  // The host publishes its transport a few times a minute, and immediately on
  // any deliberate change, so followers converge quickly without a chatty loop.
  React.useEffect(() => {
    if (!party || !isHost) return;
    void api.party.sync(party.id, playing, time);
    const id = setInterval(() => {
      void api.party.sync(party.id, playing, time);
    }, 5000);
    return () => clearInterval(id);
    // `time` deliberately omitted: including it would resend every tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party?.id, isHost, playing]);

  // A follower matches the host, correcting only when it has drifted enough to
  // notice. Chasing every small difference would stutter playback.
  React.useEffect(() => {
    if (!following || !party) return;
    const elapsed = (Date.now() - party.updatedAt) / 1000;
    const target = party.positionSec + (party.playing ? elapsed : 0);
    if (Math.abs(target - time) > 2) seekTo(target);
    if (party.playing !== playing) setPlaying(party.playing);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [party?.updatedAt, party?.playing, party?.positionSec, following]);

  const broadcast = React.useCallback(
    (nextPlaying: boolean, nextTime: number) => {
      if (party && isHost) void api.party.sync(party.id, nextPlaying, nextTime);
    },
    [party, isHost],
  );

  /* ------------------------------------------------------------ hotkeys */

  // The arrows seek and set the volume. On a television they would also
  // move focus - off the video and into whatever is behind it - because
  // D-pad navigation listens on the window exactly as this does.
  React.useEffect(claimArrowKeys, []);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && ['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
      // A locked player listens to nothing but the way out of the lock, and
      // does not so much as show its controls for a key.
      if (controlsLocked) {
        if (e.key === 'Escape') setControlsLocked(false);
        return;
      }
      wake();
      // A held modifier means the browser's own shortcut (Ctrl+L, Alt+Left to
      // go back); none of the keys below should swallow those.
      const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
      // One path for every way of moving the playhead, so the keyboard obeys
      // the same rule the on-screen buttons do: only the host moves a watch
      // party's clock, and a move is told to the followers.
      const jump = (target: number) => {
        if (following) return;
        const clamped = Math.max(0, Math.min(duration, target));
        seekTo(clamped);
        broadcast(playing, clamped);
      };
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          setPlaying((p) => !p);
          break;
        // Shift for a minute at a time - ten seconds is the wrong size for
        // getting across a film, and holding the key down is not a way to
        // cross an hour.
        case 'ArrowRight':
          e.preventDefault();
          jump(time + (e.shiftKey ? 60 : 10));
          break;
        case 'ArrowLeft':
          e.preventDefault();
          jump(time - (e.shiftKey ? 60 : 10));
          break;
        // The same ten seconds the arrows do, on the keys YouTube users reach
        // for with the left hand already on K.
        case 'l':
          if (plain) jump(time + 10);
          break;
        case 'j':
          if (plain) jump(time - 10);
          break;
        case 'Home':
          e.preventDefault();
          jump(0);
          break;
        // VLC's own keys for subtitles that are early or late: g shows them
        // sooner, h later, a tenth of a second at a time.
        case 'g':
          if (plain) setSubDelay((d) => Math.round((d - 0.1) * 10) / 10);
          break;
        case 'h':
          if (plain) setSubDelay((d) => Math.round((d + 0.1) * 10) / 10);
          break;
        // Ten percent steps: 0 is the start, 5 is halfway.
        case '0':
        case '1':
        case '2':
        case '3':
        case '4':
        case '5':
        case '6':
        case '7':
        case '8':
        case '9':
          if (plain && duration > 0) jump((Number(e.key) / 10) * duration);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setVolume((v) => Math.min(maxVolume, v + 0.05));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setVolume((v) => Math.max(0, v - 0.05));
          break;
        case 'm':
          setMuted((m) => !m);
          break;
        case 'f':
          void toggleFullscreen();
          break;
        // The shortcut every other player uses for this.
        case 'p':
          void togglePip();
          break;
        case 'a':
          setFit(otherFit(fit));
          break;
        case 'Escape':
          if (!document.fullscreenElement) onClose();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [time, seekTo, wake, onClose, following, duration, playing, broadcast, controlsLocked, maxVolume]);

  /**
   * Turns the phone sideways for fullscreen, and back on the way out.
   *
   * A film is wider than it is tall and a phone is not, so fullscreen in
   * portrait is a letterboxed strip with the rest of the screen black. Every
   * video app rotates here, and its absence reads as the app being unfinished.
   *
   * The lock is only allowed while actually fullscreen, and only on a device
   * that can rotate — a desktop has no orientation to lock and the call throws,
   * which is why every one of these is allowed to fail quietly.
   */
  const lockLandscape = async () => {
    try {
      await (screen.orientation as ScreenOrientation & {
        lock?: (o: string) => Promise<void>;
      }).lock?.('landscape');
    } catch {
      /* desktop, or the platform refuses; the video plays either way */
    }
  };

  const releaseOrientation = () => {
    try {
      // Unlock rather than forcing portrait: the phone returns to whatever its
      // own rotation setting says, which is what someone holding it sideways
      // on purpose expects.
      screen.orientation?.unlock?.();
    } catch {
      /* as above */
    }
  };

  /**
   * Whether the file itself is taller than it is wide — a phone-shot clip,
   * not a film. `false` until the first frame's metadata arrives, which
   * defaults a title still loading to the landscape behaviour every normal
   * film wants rather than momentarily refusing to rotate one.
   */
  const isPortraitVideo = natural.h > natural.w;

  // Theatre decides what turning the phone does, and for an upright clip that
  // is nothing - but it cannot know the shape before the first frame.
  React.useEffect(() => {
    if (natural.w && natural.h) onShape?.(isPortraitVideo);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [natural.w, natural.h]);

  // The screen stays on while a film plays, and only then: a paused film left
  // on a table should let the phone sleep. A window flag on Android (see
  // `MainActivity.setKeepScreenOn`), the web's own wake lock elsewhere - which
  // the browser drops by itself whenever the page is hidden.
  React.useEffect(() => {
    if (!playing) return;
    void api.pip.keepAwake(true).catch(() => {});
    let lock: { release: () => Promise<void> } | null = null;
    const wake = (navigator as Navigator & {
      wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> };
    }).wakeLock;
    void wake
      ?.request('screen')
      .then((l) => {
        lock = l;
      })
      .catch(() => {});
    return () => {
      void api.pip.keepAwake(false).catch(() => {});
      void lock?.release().catch(() => {});
    };
  }, [playing]);

  const orientationLocked = useOrientation((s) => s.locked);

  /* --------------------------------------------- subtitle delay, sleep, lock */

  React.useEffect(() => setSubDelay(0), [item.id]);

  React.useEffect(() => {
    if (sleepAt === null) return;
    const id = setTimeout(() => {
      setPlaying(false);
      setSleepAt(null);
      useStore.getState().toast({ kind: 'info', title: 'Sleep timer', body: 'Paused. Good night.' });
    }, Math.max(0, sleepAt - Date.now()));
    return () => clearTimeout(id);
  }, [sleepAt]);

  React.useEffect(() => {
    if (!unlockShown) return;
    const id = setTimeout(() => setUnlockShown(false), 2500);
    return () => clearTimeout(id);
  }, [unlockShown]);

  /*
   * Lock-screen and notification controls.
   *
   * Without this Android plays the film with a notification that has no
   * buttons, and the lock screen has nothing to offer - so the only way to
   * pause is to unlock the phone. Handlers read the player through a ref so
   * they are registered once rather than on every tick of the clock.
   */
  const session = React.useRef({
    time,
    duration,
    playing,
    following,
    upNext,
    previous,
    seekTo,
    broadcast,
    onPlayNext,
  });
  session.current = { time, duration, playing, following, upNext, previous, seekTo, broadcast, onPlayNext };
  const mediaSession = (typeof navigator !== 'undefined' &&
    (navigator as Navigator & { mediaSession?: MediaSession }).mediaSession) as MediaSession | undefined;
  React.useEffect(() => {
    if (!mediaSession || typeof MediaMetadata === 'undefined') return;
    mediaSession.metadata = new MediaMetadata({
      title: item.title,
      artist: ownerName,
      album: item.series ?? '',
      artwork: item.posterUrl ? [{ src: item.posterUrl }] : [],
    });
    return () => {
      mediaSession.metadata = null;
    };
  }, [mediaSession, item.id, item.title, item.series, item.posterUrl, ownerName]);
  React.useEffect(() => {
    if (mediaSession) mediaSession.playbackState = playing ? 'playing' : 'paused';
  }, [mediaSession, playing]);
  React.useEffect(() => {
    if (!mediaSession) return;
    const move = (to: number) => {
      const s = session.current;
      // Only the host moves a watch party's clock - the same rule the buttons
      // and the keyboard follow.
      if (s.following) return;
      const clamped = Math.max(0, Math.min(s.duration, to));
      s.seekTo(clamped);
      s.broadcast(s.playing, clamped);
    };
    const set = (action: MediaSessionAction, handler: MediaSessionActionHandler | null) => {
      try {
        mediaSession.setActionHandler(action, handler);
      } catch {
        /* an action this WebView does not know */
      }
    };
    set('play', () => session.current.following || setPlaying(true));
    set('pause', () => session.current.following || setPlaying(false));
    set('seekbackward', (d) => move(session.current.time - (d.seekOffset ?? 10)));
    set('seekforward', (d) => move(session.current.time + (d.seekOffset ?? 10)));
    set('seekto', (d) => d.seekTime !== undefined && move(d.seekTime));
    set('previoustrack', () => session.current.previous && session.current.onPlayNext(session.current.previous));
    set('nexttrack', () => session.current.upNext && session.current.onPlayNext(session.current.upNext));
    return () => {
      (['play', 'pause', 'seekbackward', 'seekforward', 'seekto', 'previoustrack', 'nexttrack'] as const).forEach((a) =>
        set(a, null),
      );
    };
  }, [mediaSession]);
  React.useEffect(() => {
    if (!mediaSession?.setPositionState || !(duration > 0)) return;
    try {
      mediaSession.setPositionState({
        duration,
        position: Math.max(0, Math.min(duration, time)),
        playbackRate: rate,
      });
    } catch {
      /* a position past the end while a stream is being re-requested */
    }
    // A whole second is as fine as a lock screen draws it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaSession, Math.floor(time), duration, rate]);
  // The portrait exception, opted into rather than assumed: forcing every
  // fullscreen video to landscape used to mean a phone-shot clip played
  // pillarboxed to a third of the screen with no way to ask for the rest of
  // it back, copied from VLC's own mobile player - which does not rotate a
  // portrait video to landscape unless told to either.
  const [forceLandscape, setForceLandscape] = React.useState(false);
  React.useEffect(() => setForceLandscape(false), [item.id]);

  const toggleForceLandscape = async () => {
    const next = !forceLandscape;
    setForceLandscape(next);
    if (!fullscreen) return;
    if (next) await lockLandscape();
    else releaseOrientation();
  };

  /**
   * Pops the picture out into a floating window.
   *
   * The film keeps playing above whatever you go to next, which is the one
   * thing fullscreen cannot do: fullscreen is for giving a film the whole
   * screen, and this is for giving it none of it while still watching.
   *
   * The browser owns the window - its size, where it sits, and the small set
   * of controls on it. What LANTern draws over the video does not come along,
   * so subtitles burnt into the picture stay and subtitles drawn as an overlay
   * do not. That is the trade, and it is why the button says what it does
   * rather than promising the player in miniature.
   *
   * Not offered where it does not exist. Android's WebView has no such thing -
   * a phone puts the whole app in a corner instead, which the activity already
   * does on its own when you leave mid-playback - and a button that silently
   * fails is worse than one that was never there.
   */
  const togglePip = async () => {
    const el = videoRef.current;
    if (!el) return;
    try {
      if (document.pictureInPictureElement) {
        await document.exitPictureInPicture();
      } else {
        // Fullscreen and a floating window are two answers to the same
        // question, so asking for one puts the other away first. Chromium
        // refuses the request outright otherwise.
        if (document.fullscreenElement) {
          await document.exitFullscreen();
          releaseOrientation();
        }
        await el.requestPictureInPicture();
      }
    } catch {
      /* refused, or the video has no picture yet — nothing changes */
    }
  };

  /**
   * Whether the picture is currently out, however it got there.
   *
   * The window has a close button of its own and the browser can take it away
   * without asking, so the button follows the video rather than the other way
   * round.
   */
  React.useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    const enter = () => setPip(true);
    const leave = () => setPip(false);
    el.addEventListener('enterpictureinpicture', enter);
    el.addEventListener('leavepictureinpicture', leave);
    return () => {
      el.removeEventListener('enterpictureinpicture', enter);
      el.removeEventListener('leavepictureinpicture', leave);
    };
  }, []);

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        setFullscreen(false);
        releaseOrientation();
      } else if (shellRef.current) {
        await shellRef.current.requestFullscreen();
        setFullscreen(true);
        // A landscape film still rotates automatically - it is the one
        // shape fullscreen was always for. A portrait clip does not, unless
        // the person watching has actually asked for that with the button
        // below; see isPortraitVideo's own comment.
        if (!isPortraitVideo || forceLandscape) await lockLandscape();
      }
    } catch {
      /* fullscreen refused — controls stay as they are */
    }
  };

  /**
   * Leaving fullscreen by any other route still puts the phone back.
   *
   * Back, the system gesture, and Escape all exit fullscreen without going
   * through the button, and a phone left locked sideways afterwards is worse
   * than never having rotated it.
   */
  React.useEffect(() => {
    const onChange = () => {
      const on = !!document.fullscreenElement;
      setFullscreen(on);
      if (!on) releaseOrientation();
    };
    document.addEventListener('fullscreenchange', onChange);
    return () => {
      document.removeEventListener('fullscreenchange', onChange);
      // Closing the player mid-fullscreen must not strand the rotation.
      releaseOrientation();
    };
  }, []);

  // The frame changes on resize, on entering fullscreen, and when a phone is
  // turned sideways. An observer catches all three; a resize listener would
  // miss the ones that do not change the window.
  React.useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const rect = stage.getBoundingClientRect();
      setFrame({ w: rect.width, h: rect.height });
    };
    measure();
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure);
      return () => window.removeEventListener('resize', measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [unreachable]);

  // Forgotten when the file changes, so a 4:3 episode following a scope film
  // does not spend its first frames in the shape of the one before it.
  React.useEffect(() => {
    setNatural({ w: 0, h: 0 });
  }, [source]);

  const box = boxFor(fit, frame, natural);
  // What Crop would cut, or what Fit is leaving as bars — the same number
  // either way. Shown on the button because "Crop" says what it does and not
  // what it costs, and the cost is the entire question.
  const lost = Math.round(croppedAway(frame, natural) * 100);

  // While dragging, the bar and the clock follow the pointer rather than the
  // video, which has not moved yet.
  const shownTime = scrubTime ?? time;
  const pct = duration ? (shownTime / duration) * 100 : 0;
  const bufferedPct = duration ? (buffered / duration) * 100 : 0;
  const nearEnd = duration > 0 && duration - time < 40 && duration - time > 0;

  // The preview is only built once somebody first reaches for the bar: it
  // opens a second connection to the file, which is not worth doing for a
  // film that is watched straight through.
  const previewWanted = scrubTime !== null || hover !== null || previewEver.current;
  // Kept clear of both ends of the bar so the frame is never cut off, which a
  // plain centre on the pointer does for the first and last seconds.
  const barWidth = barRef.current?.clientWidth ?? 0;
  const previewHalf = PREVIEW_WIDTH / 2 + 4;
  const rawLeft =
    scrubTime !== null && duration ? (scrubTime / duration) * barWidth : (hover?.x ?? 0);
  const previewLeft = barWidth
    ? Math.max(previewHalf, Math.min(barWidth - previewHalf, rawLeft))
    : rawLeft;

  const pointAt = (clientX: number) => {
    const rect = barRef.current?.getBoundingClientRect();
    if (!rect || !rect.width) return { x: 0, t: 0, snapped: false };
    const f = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const x = f * rect.width;
    // A pull toward where the film is now. Without it, taking back a seek
    // meant finding that one pixel again by eye.
    const here = duration ? (time / duration) * rect.width : -Infinity;
    if (Math.abs(x - here) <= SNAP_PX) return { x: here, t: time, snapped: true };
    return { x, t: f * duration, snapped: false };
  };

  const aim = (at: { t: number; snapped: boolean }) => {
    setScrubTime(at.t);
    setScrubSnapped((was) => {
      // A tick under the finger as it lands, where the phone can give one.
      if (at.snapped && !was) {
        try {
          navigator.vibrate?.(8);
        } catch {
          /* no haptics here */
        }
      }
      return at.snapped;
    });
  };

  // Pointer events rather than mouse events, so one handler covers a mouse, a
  // finger and a pen - a phone had only the click that follows a tap, and no
  // way to drag at all.
  const scrubDown = (e: React.PointerEvent<HTMLDivElement>) => {
    // Only the host moves the party's clock.
    if (following || !duration) return;
    // Capture keeps a drag alive after the pointer leaves the bar. It is a
    // nicety, and can be refused (the pointer already gone) - the scrub must
    // still start.
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      /* the drag simply ends at the bar's edge */
    }
    setScrubbing(true);
    previewEver.current = true;
    aim(pointAt(e.clientX));
  };
  const scrubMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!duration) return;
    const at = pointAt(e.clientX);
    if (scrubTime !== null) aim(at);
    if (e.pointerType === 'mouse') {
      previewEver.current = true;
      setHover(at);
    }
  };
  const scrubUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (scrubTime === null) return;
    const at = pointAt(e.clientX);
    setScrubTime(null);
    setScrubSnapped(false);
    setScrubbing(false);
    // Let go on the spot the film is at: the seek is cancelled, and the
    // stream is not restarted to go nowhere.
    if (at.snapped) return;
    seekTo(at.t);
    broadcast(playing, at.t);
  };
  const scrubCancel = () => {
    setScrubTime(null);
    setScrubSnapped(false);
    setScrubbing(false);
  };

  // The controls stay up for as long as a seek is being aimed, and the usual
  // countdown starts again when it ends.
  React.useEffect(() => {
    scrubbingNow.current = scrubbing;
    if (scrubbing) {
      clearTimeout(hideTimer.current);
      setChrome(true);
    } else {
      wake();
    }
  }, [scrubbing, wake]);

  return (
    <div
      ref={shellRef}
      onMouseMove={wake}
      onClick={wake}
      className="h-full w-full bg-black relative select-none"
      style={{ cursor: chrome ? 'default' : 'none' }}
    >
      {/* stage */}
      {/*
        Overflow is hidden because Fill deliberately makes the picture larger
        than the frame. Without this the crop spills over the controls and out
        of the window instead of being a crop at all.
      */}
      <div
        ref={stageRef}
        // The tracks are pinned to the stage. Left automatic they grew to fit
        // a picture larger than the stage - Crop's whole job - and a track
        // taller than the stage starts at the top, so the overflow all fell
        // off the bottom instead of half off each edge.
        className="absolute inset-0 grid grid-cols-[minmax(0,100%)] grid-rows-[minmax(0,100%)] place-items-center overflow-hidden"
        style={brightness !== 1 ? { filter: `brightness(${brightness})` } : undefined}
      >
        {unreachable ? (
          <div className="relative h-full w-full">
            <Artwork
              title={item.title}
              seed={item.id}
              variant="backdrop"
              rounded={false}
              className="h-full w-full opacity-40"
            />
            <div className="absolute inset-0 grid place-items-center">
              <div className="text-center max-w-sm px-6">
                <WifiOff size={28} className="mx-auto text-muted mb-3" />
                <div className="text-sm font-medium text-white">
                  Can't reach {ownerName}
                </div>
                <p className="text-xs text-white/60 mt-1.5 leading-relaxed">
                  The file is served from that device — it needs to be awake and on the
                  network. Playback controls stay live so you can keep your place.
                </p>
              </div>
            </div>
          </div>
        ) : (
          <video
            ref={videoRef}
            src={source}
            // The real first frame, not the WebView's own oversized play-glyph
            // placeholder — that generic icon is what shows in the gap between
            // the element mounting and the first frame actually decoding when
            // no poster is set, and on Android it renders large enough to look
            // like part of the design rather than a loading state.
            poster={item.posterUrl}
            // A new element when the fetch mode changes: crossOrigin is read
            // when the media loads, so flipping it on a live element does
            // nothing until the next source.
            key={plainMedia ? 'plain' : 'cors'}
            // The CORS check is what lets the audio graph read the sound for
            // volume past 100% (see loudness.ts). Every host sends the header
            // on file bytes; one that does not fails here, and the fallback in
            // onError fetches it plain at the cost of the boost.
            crossOrigin={plainMedia ? undefined : 'anonymous'}
            className="bg-black"
            // Sized rather than classed. `object-fit: cover` would crop, but
            // it crops to the element, so the element still has to be the
            // right size first - and once it is the right size there is
            // nothing left for object-fit to do.
            style={{ width: box.width, height: box.height }}
            autoPlay
            playsInline
            onLoadedMetadata={(e) => {
              const el = e.currentTarget;
              el.playbackRate = rate;
              setNatural({ w: el.videoWidth, h: el.videoHeight });
              // A remuxed stream is fragmented MP4 with no index, so it
              // reports a duration of a few seconds — the length of what has
              // been generated so far, not the film. The library already
              // knows the real runtime; keep it.
              if (audioTrack < 0 && Number.isFinite(el.duration) && el.duration > 0) {
                setDuration(el.duration);
              }
              // The stream already begins at the requested offset, so seeking
              // again would jump a second time.
              // (After the element was replaced mid-film, from where it was.)
              const resumeAt = retryAt.current ?? item.progressSec;
              retryAt.current = null;
              if (audioTrack < 0 && resumeAt > 0) {
                el.currentTime = resumeAt;
              }
              // A remuxed stream's own clock starts at zero however far in it
              // begins, so the offset is the position until it reports one.
              // Set here rather than waiting for the first tick: that tick is
              // what the saver would otherwise have written down.
              if (audioTrack >= 0) setTime(streamStart);
              swapping.current = false;
            }}
            onTimeUpdate={(e) => {
              if (scrubbing) return;
              // Between asking for a new stream and it being ready, the
              // element still ticks against the old one. Those readings belong
              // to a position that no longer exists.
              if (swapping.current) return;
              setTime(streamStart + e.currentTarget.currentTime);
            }}
            onProgress={(e) => {
              const el = e.currentTarget;
              if (el.buffered.length) setBuffered(el.buffered.end(el.buffered.length - 1));
            }}
            onEnded={() => {
              setPlaying(false);
              // "Stop after this one" means the next episode is not started.
              if (sleepAtEnd) {
                setSleepAtEnd(false);
                return;
              }
              if (upNext) onPlayNext(upNext);
            }}
            onError={() => {
              // Requiring the CORS check once turned a reachable file into
              // "Can't reach". Before believing that, ask for it plain: the
              // film plays, just not louder than 100%.
              if (!plainMedia) {
                retryAt.current = latestTime.current;
                // The new element reports zero before it has found its place;
                // that is not a position to write down.
                swapping.current = true;
                // A remuxed stream starts where its URL says, not where the
                // element had got to.
                if (audioTrack >= 0) startRemuxAt(latestTime.current);
                setPlainMedia(true);
                return;
              }
              setUnreachable(true);
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
          >
          </video>
        )}
      </div>

      {/*
        Click-to-toggle surface, beneath the chrome.

        With the controls hidden, the first press only brings them back; it
        takes a second one to pause. Otherwise a tap meant to find out where
        you are in a film stops the film — which is the thing you least want
        while someone is watching it with you.

        This costs a mouse nothing: moving it already wakes the controls, so a
        pointer user is essentially always in the second state and one click
        still pauses. It is touch, where there is no movement to wake
        anything, that gets the two-step.
      */}
      <button
        ref={touchSurfaceRef}
        aria-label={!chrome ? 'Show controls' : playing ? 'Pause' : 'Play'}
        onClick={() => {
          if (following) return;
          if (!chrome) {
            wake();
            return;
          }
          const next = !playing;
          setPlaying(next);
          broadcast(next, time);
        }}
        onDoubleClick={() => void toggleFullscreen()}
        onTouchStart={onStageTouchStart}
        onTouchEnd={onStageTouchEnd}
        className="absolute inset-0 z-10"
      />

      {/* The double-tap-to-seek flash, VLC's own confirmation that the tap
          landed and counted rather than a seek that happened with nothing
          on screen to say so. */}
      <AnimatePresence>
        {seekFlash && (
          <motion.div
            key={seekFlash.zone}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={cn(
              'absolute inset-y-0 z-10 w-1/3 flex items-center justify-center pointer-events-none',
              seekFlash.zone === 'left' ? 'left-0' : 'right-0',
            )}
          >
            <div className="rounded-full bg-black/60 h-20 w-20 grid place-items-center">
              {seekFlash.zone === 'left' ? (
                <RotateCcw size={22} className="text-white" />
              ) : (
                <RotateCw size={22} className="text-white" />
              )}
              <span className="absolute mt-9 text-[11px] font-semibold text-white tabular-nums">
                {seekFlash.amount > 0 ? `+${seekFlash.amount}s` : `${seekFlash.amount}s`}
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Vertical swipe: brightness on the left, volume on the right - a
          filled bar rather than a number, since a fast swipe is read at a
          glance, not by reading digits. */}
      <AnimatePresence>
        {swipeFlash && (
          <motion.div
            key={swipeFlash.zone}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className={cn(
              'absolute top-1/2 -translate-y-1/2 z-10 pointer-events-none',
              swipeFlash.zone === 'left' ? 'left-8' : 'right-8',
            )}
          >
            <div className="rounded-full bg-black/60 px-2.5 py-3 flex flex-col items-center gap-2 w-11">
              {swipeFlash.zone === 'left' ? (
                <Sun size={16} className="text-white shrink-0" />
              ) : swipeFlash.pct === 0 ? (
                <VolumeX size={16} className="text-white shrink-0" />
              ) : (
                <Volume2 size={16} className="text-white shrink-0" />
              )}
              <div className="h-24 w-1.5 rounded-full bg-white/25 overflow-hidden flex flex-col justify-end">
                <div
                  className="w-full bg-white rounded-full transition-[height]"
                  style={{ height: `${swipeFlash.pct}%` }}
                />
              </div>
              <span className="text-[10px] font-semibold text-white tabular-nums">
                {swipeFlash.pct}%
              </span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/*
        The chrome is always mounted and fades with a CSS transition. A
        JS-driven animation only advances while the window paints, so an
        occluded window could leave the controls stranded invisible — not
        acceptable for the one surface a viewer needs to reach.
      */}
      {!docked && (
      <>
            {/*
              top bar

              `safe-t` sits on this outer element, not mixed into the same
              padding as the content: the gradient still has to reach the
              true top edge of the screen, under the status bar, and only
              the button and title need pushing down below it. A fixed `p-4`
              on this same div put the back button under a notch or the
              status bar's own clock/battery row on a phone that draws its
              webview edge-to-edge — reachable in principle, unreadable and
              easy to miss in practice.
            */}
            <div
              style={{ transform: chrome ? 'translateY(0)' : 'translateY(-12px)' }}
              className={cn(
                'absolute top-0 inset-x-0 z-20 bg-gradient-to-b from-black/80 to-transparent safe-t',
                'transition-all duration-200',
                chrome ? 'opacity-100' : 'opacity-0 pointer-events-none',
              )}
            >
              <div className="p-4 flex items-start gap-3">
              <button
                onClick={onClose}
                aria-label="Back to Theatre"
                className="h-9 w-9 rounded-full bg-black/50 grid place-items-center text-white hover:bg-black/70"
              >
                <ArrowLeft size={18} />
              </button>
              {party && (
                <div className="flex items-center gap-2 glass border border-cyan/40 rounded-pill pl-2 pr-2.5 h-8 shrink-0">
                  <Users size={13} className="text-cyan" />
                  <span className="text-[11px] text-cyan font-medium">
                    {isHost ? 'Hosting' : `Following ${ownerName}`}
                  </span>
                  <div className="flex -space-x-1.5">
                    {(partyMembers ?? []).slice(0, 4).map((m, i) => (
                      <span
                        key={i}
                        title={m.name}
                        className="h-5 w-5 rounded-full grid place-items-center text-[10px] border"
                        style={{
                          background: `${m.color ?? '#F5A623'}33`,
                          borderColor: `${m.color ?? '#F5A623'}88`,
                        }}
                      >
                        {m.emoji ?? m.name.slice(0, 1)}
                      </span>
                    ))}
                  </div>
                </div>
              )}
              <div className="min-w-0">
                <div className="text-sm font-semibold text-white truncate">{item.title}</div>
                <div className="text-[11px] text-white/60 truncate">
                  {item.series
                    ? `${item.series} · S${item.season} E${item.episode} · ${ownerName}`
                    : `Streaming from ${ownerName}`}
                </div>
              </div>
              </div>
            </div>

            {/* bottom controls */}
            <div
              style={{ transform: chrome ? 'translateY(0)' : 'translateY(16px)' }}
              className={cn(
                'absolute bottom-0 inset-x-0 z-20 px-4 pt-16',
                // At least the usual gap, or the real gesture-nav inset,
                // whichever is bigger — a plain `pb-4` sat every control in
                // this bar right under Android's own swipe-up handle.
                '[padding-bottom:max(1rem,env(safe-area-inset-bottom))]',
                'bg-gradient-to-t from-black/90 via-black/60 to-transparent',
                'transition-all duration-200',
                chrome ? 'opacity-100' : 'opacity-0 pointer-events-none',
              )}
            >
              {/* scrubber */}
              <div
                ref={barRef}
                onPointerDown={scrubDown}
                onPointerMove={scrubMove}
                onPointerUp={scrubUp}
                onPointerCancel={scrubCancel}
                onPointerLeave={() => setHover(null)}
                // `touch-none`: without it the browser claims a horizontal
                // drag for scrolling and the bar only ever sees the start.
                className="group/bar relative h-6 flex items-center cursor-pointer touch-none"
              >
                {/* The time a click here would land on - what every other
                    player shows, and the only way to aim at a moment in a
                    two-hour film rather than guess at a pixel - with the
                    frame from the nearest fifteen seconds above it. */}
                {previewWanted && duration > 0 && (
                  <div
                    className={cn(
                      'absolute bottom-full mb-1.5 flex flex-col items-center gap-1 pointer-events-none',
                      hover || scrubTime !== null ? 'opacity-100' : 'opacity-0',
                    )}
                    style={{
                      left: `${previewLeft}px`,
                      transform: 'translateX(-50%)',
                    }}
                  >
                    {!unreachable && (
                      <SeekPreview
                        src={item.streamUrl}
                        at={scrubTime ?? hover?.t ?? 0}
                        aspect={natural.w && natural.h ? natural.w / natural.h : 16 / 9}
                      />
                    )}
                    <span
                      className={cn(
                        'px-1.5 py-0.5 rounded text-2xs tabular-nums',
                        scrubSnapped ? 'bg-gold text-on-gold font-medium' : 'bg-black/80 text-white',
                      )}
                    >
                      {scrubSnapped ? `Stay at ${clock(scrubTime ?? 0)}` : clock(scrubTime ?? hover?.t ?? 0)}
                    </span>
                  </div>
                )}
                <div className="h-1 w-full bg-white/25 rounded-full overflow-hidden group-hover/bar:h-1.5 transition-all">
                  <div
                    className="h-full bg-white/30 absolute"
                    style={{ width: `${bufferedPct}%` }}
                  />
                  {/* The loop region, so it reads as a range rather than two
                      unrelated marks someone has to remember the meaning of. */}
                  {repeatA !== null && repeatB !== null && duration > 0 && (
                    <div
                      className="h-full bg-gold/25 absolute"
                      style={{
                        left: `${(repeatA / duration) * 100}%`,
                        width: `${((repeatB - repeatA) / duration) * 100}%`,
                      }}
                    />
                  )}
                  <div
                    className="h-full bg-gold relative"
                    style={{ width: `${pct}%` }}
                  />
                </div>
                {/* Where the film is now, while a seek is being aimed: the
                    thing the drag is pulled toward, and ringed when it holds. */}
                {scrubTime !== null && duration > 0 && (
                  <span
                    className={cn(
                      'absolute -ml-1.5 h-3 w-3 rounded-full border-2 pointer-events-none transition-transform',
                      scrubSnapped ? 'border-gold bg-gold/40 scale-125' : 'border-white/80 bg-black/40',
                    )}
                    style={{ left: `${(time / duration) * 100}%` }}
                    aria-hidden
                  />
                )}
                {repeatA !== null && duration > 0 && (
                  <span
                    className="absolute h-3 w-0.5 bg-gold -ml-px"
                    style={{ left: `${(repeatA / duration) * 100}%` }}
                    title="Loop start"
                  />
                )}
                {repeatB !== null && duration > 0 && (
                  <span
                    className="absolute h-3 w-0.5 bg-gold -ml-px"
                    style={{ left: `${(repeatB / duration) * 100}%` }}
                    title="Loop end"
                  />
                )}
                <span
                  className="absolute h-3 w-3 rounded-full bg-gold shadow -ml-1.5 opacity-0 group-hover/bar:opacity-100 transition-opacity"
                  style={{ left: `${pct}%` }}
                />
              </div>

              <div className="flex items-center gap-3 mt-2">
                <IconBtn
                  label={
                    following ? 'The host controls playback' : playing ? 'Pause' : 'Play'
                  }
                  onClick={() => {
                    if (following) return;
                    const next = !playing;
                    setPlaying(next);
                    broadcast(next, time);
                  }}
                >
                  {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" />}
                </IconBtn>
                <IconBtn
                  label="Back 10 seconds"
                  onClick={() => {
                    if (following) return;
                    seekTo(time - 10);
                    broadcast(playing, time - 10);
                  }}
                >
                  <RotateCcw size={18} />
                </IconBtn>
                <IconBtn
                  label="Forward 10 seconds"
                  onClick={() => {
                    if (following) return;
                    seekTo(time + 10);
                    broadcast(playing, time + 10);
                  }}
                >
                  <RotateCw size={18} />
                </IconBtn>

                <div className="flex items-center gap-1.5 group/vol">
                  <IconBtn
                    label={muted ? 'Unmute' : 'Mute'}
                    onClick={() => setMuted((m) => !m)}
                  >
                    {muted || volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
                  </IconBtn>
                  <input
                    type="range"
                    min={0}
                    max={maxVolume}
                    step={0.01}
                    value={muted ? 0 : volume}
                    onChange={(e) => {
                      setVolume(parseFloat(e.target.value));
                      setMuted(false);
                    }}
                    aria-label="Volume"
                    title={`${Math.round((muted ? 0 : volume) * 100)}%`}
                    className={cn(
                      'w-0 group-hover/vol:w-20 transition-all duration-200 h-1 cursor-pointer',
                      // Past 100% is amplification, which can distort: say so.
                      volume > 1 ? 'accent-gold' : 'accent-white',
                    )}
                  />
                </div>

                <span className="text-[11px] font-mono text-white/80 tabular-nums">
                  {clock(shownTime)} / {clock(duration)}
                </span>

                <div className="ml-auto flex items-center gap-3">
                  {/*
                    A toggle rather than a menu, because there are two states
                    and a menu to choose between two things is a menu too many.
                    The label names what pressing it will do, not what is
                    already true, so nobody has to work out which way it reads.
                  */}
                  <button
                    onClick={() => setFit(otherFit(fit))}
                    className={cn(
                      'flex items-center gap-1.5 text-[11px] hover:text-white',
                      fit === 'crop' ? 'text-gold' : 'text-white/80',
                    )}
                    title={
                      lost > 0
                        ? fit === 'fit'
                          ? `Crop to fill the screen — loses ${lost}% of the picture (a)`
                          : `Fit the whole picture — ${lost}% of the screen becomes bars (a)`
                        : 'This film already matches the screen (a)'
                    }
                    aria-label={fit === 'fit' ? 'Crop to fill the screen' : 'Fit the whole picture'}
                  >
                    {fit === 'fit' ? <Crop size={15} /> : <Scan size={15} />}
                    {fit === 'fit' ? 'Crop' : 'Fit'}
                    {/*
                      Only worth saying when there is something to lose. On a
                      film that already matches the screen the button does
                      nothing visible, and a percentage of nothing beside it
                      would just be noise.
                    */}
                    {lost > 0 && <span className="text-white/50">{lost}%</span>}
                  </button>
                  <div className="relative">
                    <button
                      onClick={() => setSpeedOpen((o) => !o)}
                      className={cn(
                        'flex items-center gap-1.5 text-[11px] hover:text-white',
                        rate !== 1 ? 'text-gold' : 'text-white/80',
                      )}
                      aria-haspopup="menu"
                      aria-expanded={speedOpen}
                    >
                      <Gauge size={15} />
                      {rate === 1 ? 'Speed' : `${rate}x`}
                    </button>
                    {speedOpen && (
                      <>
                        <button
                          aria-label="Close speed menu"
                          className="track-scrim fixed inset-0 z-20 cursor-default"
                          onClick={() => setSpeedOpen(false)}
                        />
                        <div className="track-menu absolute bottom-7 right-0 z-30 w-24 rounded-card border border-edge bg-surface/95 backdrop-blur p-1 shadow-lg">
                          {[0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].map((s) => (
                            <button
                              key={s}
                              onClick={() => {
                                setRate(s);
                                setSpeedOpen(false);
                              }}
                              className={cn(
                                'track-row w-full text-left px-2 h-7 rounded-input text-2xs hover:bg-raised',
                                rate === s && 'text-gold',
                              )}
                            >
                              {s === 1 ? 'Normal' : `${s}x`}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  <button
                    onClick={cycleRepeat}
                    className={cn(
                      'flex items-center gap-1.5 text-[11px] hover:text-white',
                      repeatA !== null ? 'text-gold' : 'text-white/80',
                    )}
                    title={
                      repeatA === null
                        ? 'Mark the start of a loop (A-B repeat)'
                        : repeatB === null
                          ? 'Mark the end of the loop'
                          : 'Clear the loop'
                    }
                  >
                    <Repeat size={15} />
                    {repeatA !== null && repeatB !== null
                      ? 'A-B'
                      : repeatA !== null
                        ? 'A-…'
                        : 'Repeat'}
                  </button>
                  <div className="relative">
                    <button
                      onClick={() => setSleepOpen((o) => !o)}
                      className={cn(
                        'flex items-center gap-1.5 text-[11px] hover:text-white',
                        sleepAt !== null || sleepAtEnd ? 'text-gold' : 'text-white/80',
                      )}
                      aria-haspopup="menu"
                      aria-expanded={sleepOpen}
                    >
                      <Moon size={15} />
                      {sleepAtEnd
                        ? 'After this'
                        : sleepAt !== null
                          ? `Sleep ${Math.max(1, Math.round((sleepAt - Date.now()) / 60000))}m`
                          : 'Sleep'}
                    </button>
                    {sleepOpen && (
                      <>
                        <button
                          aria-label="Close sleep timer menu"
                          className="track-scrim fixed inset-0 z-20 cursor-default"
                          onClick={() => setSleepOpen(false)}
                        />
                        <div className="track-menu absolute bottom-7 right-0 z-30 w-[170px] rounded-card border border-edge bg-surface/95 backdrop-blur p-1 shadow-lg">
                          {[
                            { label: 'Off', apply: () => { setSleepAt(null); setSleepAtEnd(false); } },
                            ...[15, 30, 45, 60].map((m) => ({
                              label: `${m} minutes`,
                              apply: () => { setSleepAtEnd(false); setSleepAt(Date.now() + m * 60000); },
                            })),
                            { label: 'After this one', apply: () => { setSleepAt(null); setSleepAtEnd(true); } },
                          ].map((option) => (
                            <button
                              key={option.label}
                              onClick={() => {
                                option.apply();
                                setSleepOpen(false);
                              }}
                              className="track-row w-full text-left px-2 h-7 rounded-input text-2xs hover:bg-raised"
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                  {audioTracks.length > 1 && (
                    <div className="relative">
                      <button
                        onClick={() => setAudioOpen((o) => !o)}
                        className={cn(
                          'flex items-center gap-1.5 text-[11px] hover:text-white',
                          audioTrack >= 0 ? 'text-gold' : 'text-white/80',
                        )}
                        aria-haspopup="menu"
                        aria-expanded={audioOpen}
                      >
                        <Languages size={15} />
                        {audioTrack >= 0 ? audioNames[audioTrack] : 'Audio'}
                      </button>
                      {audioOpen && (
                        <>
                          <button
                            aria-label="Close audio menu"
                            className="track-scrim fixed inset-0 z-20 cursor-default"
                            onClick={() => setAudioOpen(false)}
                          />
                        <div className="track-menu absolute bottom-7 right-0 z-30 w-[210px] rounded-card border border-edge bg-surface/95 backdrop-blur p-1 shadow-lg flex flex-col max-h-[min(60vh,26rem)]">
                          <div className="overflow-y-auto overscroll-contain min-h-0">
                            <button
                              onClick={() => chooseAudio(-1)}
                              className={cn(
                                'track-row w-full text-left px-2 h-7 rounded-input text-2xs hover:bg-raised',
                                audioTrack < 0 && 'text-gold',
                              )}
                            >
                              Default
                            </button>
                            {audioTracks.map((track, i) => (
                              <button
                                key={`${track.lang}-${i}`}
                                onClick={() => canSwitchAudio && chooseAudio(i)}
                                disabled={!canSwitchAudio}
                                className={cn(
                                  'track-row w-full text-left px-2 h-7 rounded-input text-2xs truncate',
                                  canSwitchAudio
                                    ? 'hover:bg-raised'
                                    : 'opacity-40 cursor-not-allowed',
                                  audioTrack === i && 'text-gold',
                                )}
                              >
                                {audioNames[i]}
                              </button>
                            ))}
                          </div>
                          {!canSwitchAudio && (
                            <p className="shrink-0 px-2 py-1.5 text-[10px] text-muted leading-relaxed">
                              Switching needs ffmpeg on the device sharing this file. The
                              browser cannot change audio tracks on its own.
                            </p>
                          )}
                        </div>
                        </>
                      )}
                    </div>
                  )}
                  {subtitles.length > 0 && (
                    <div className="relative">
                      <button
                        onClick={() => setTracksOpen((o) => !o)}
                        className={cn(
                          'flex items-center gap-1.5 text-[11px] hover:text-white',
                          subtitle >= 0 ? 'text-gold' : 'text-white/80',
                        )}
                        aria-haspopup="menu"
                        aria-expanded={tracksOpen}
                      >
                        <Subtitles size={15} />
                        {subtitle >= 0 ? subtitleNames[subtitle] : 'Subtitles'}
                      </button>
                      {tracksOpen && (
                        <>
                          <button
                            aria-label="Close subtitle menu"
                            className="track-scrim fixed inset-0 z-20 cursor-default"
                            onClick={() => setTracksOpen(false)}
                          />
                        <div className="track-menu absolute bottom-7 right-0 z-30 w-[210px] rounded-card border border-edge bg-surface/95 backdrop-blur p-1 shadow-lg flex flex-col max-h-[min(60vh,26rem)]">
                          <div className="overflow-y-auto overscroll-contain min-h-0">
                            <button
                              onClick={() => {
                                setSubtitle(-1);
                                setTracksOpen(false);
                              }}
                              className={cn(
                                'track-row w-full text-left px-2 h-7 rounded-input text-2xs hover:bg-raised',
                                subtitle < 0 && 'text-gold',
                              )}
                            >
                              Off
                            </button>
                            {subtitles.map((sub, i) => (
                              <button
                                key={sub.url}
                                onClick={() => {
                                  setSubtitle(i);
                                  setTracksOpen(false);
                                }}
                                className={cn(
                                  'track-row w-full text-left px-2 h-7 rounded-input text-2xs hover:bg-raised truncate',
                                  subtitle === i && 'text-gold',
                                )}
                              >
                                {subtitleNames[i]}
                              </button>
                            ))}
                          </div>

                          {subtitle >= 0 && (
                            <div className="shrink-0">
                              <div className="my-1 border-t border-edge" />
                              <div className="px-2 pb-1 pt-0.5 label">Appearance</div>
                              {SUBTITLE_STYLES.map((option) => (
                                <button
                                  key={option.id}
                                  onClick={() => setSubStyle(option.id)}
                                  title={option.hint}
                                  className={cn(
                                    'track-row w-full text-left px-2 h-7 rounded-input text-2xs hover:bg-raised',
                                    subStyle === option.id && 'text-gold',
                                  )}
                                >
                                  {option.label}
                                </button>
                              ))}
                              <div className="my-1 border-t border-edge" />
                              <div className="px-2 pb-1 pt-0.5 label">Subtitle delay</div>
                              <div className="flex items-center gap-1 px-2 pb-1">
                                <button
                                  onClick={() => setSubDelay((d) => Math.round((d - 0.1) * 10) / 10)}
                                  className="track-row h-7 flex-1 rounded-input text-2xs hover:bg-raised"
                                  title="Subtitles sooner (G)"
                                >
                                  −0.1 s
                                </button>
                                <span
                                  className={cn(
                                    'w-16 text-center text-2xs tabular-nums',
                                    subDelay !== 0 ? 'text-gold' : 'text-dim',
                                  )}
                                >
                                  {subDelay > 0 ? '+' : ''}
                                  {subDelay.toFixed(1)} s
                                </span>
                                <button
                                  onClick={() => setSubDelay((d) => Math.round((d + 0.1) * 10) / 10)}
                                  className="track-row h-7 flex-1 rounded-input text-2xs hover:bg-raised"
                                  title="Subtitles later (H)"
                                >
                                  +0.1 s
                                </button>
                              </div>
                            </div>
                          )}

                          {audioTracks.length > 0 && (
                            <div className="shrink-0">
                              <div className="my-1 border-t border-edge" />
                              <div className="px-2 pb-1 pt-0.5 label">Audio delay</div>
                              <div className="flex items-center gap-1 px-2 pb-1">
                                <button
                                  onClick={() => nudgeDelay(-50)}
                                  className="track-row h-7 flex-1 rounded-input text-2xs hover:bg-raised"
                                  title="Audio earlier"
                                >
                                  −50 ms
                                </button>
                                <span
                                  className={cn(
                                    'w-16 text-center text-2xs tabular-nums',
                                    audioDelay !== 0 ? 'text-gold' : 'text-dim',
                                  )}
                                >
                                  {audioDelay > 0 ? `+${audioDelay}` : audioDelay} ms
                                </span>
                                <button
                                  onClick={() => nudgeDelay(50)}
                                  className="track-row h-7 flex-1 rounded-input text-2xs hover:bg-raised"
                                  title="Audio later"
                                >
                                  +50 ms
                                </button>
                              </div>
                              {audioDelay !== 0 && (
                                <button
                                  onClick={() => nudgeDelay(-audioDelay)}
                                  className="track-row w-full text-left px-2 h-7 rounded-input text-2xs hover:bg-raised text-dim"
                                >
                                  Back to none
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                        </>
                      )}
                    </div>
                  )}
                  {previous && (
                    <button
                      onClick={() => onPlayNext(previous)}
                      className="flex items-center gap-1.5 text-[11px] text-white/80 hover:text-white"
                      title={previous.title}
                    >
                      <SkipBack size={15} />
                      Previous
                    </button>
                  )}
                  {upNext && (
                    <button
                      onClick={() => onPlayNext(upNext)}
                      className="flex items-center gap-1.5 text-[11px] text-white/80 hover:text-white"
                      title={upNext.title}
                    >
                      <SkipForward size={15} />
                      Next episode
                    </button>
                  )}
                  {pipSupported && (
                    <IconBtn
                      label={pip ? 'Put the picture back' : 'Pop the picture out'}
                      onClick={() => void togglePip()}
                    >
                      <PictureInPicture2 size={18} />
                    </IconBtn>
                  )}
                  {/* Only a portrait clip has anything to toggle - a
                      landscape film already rotates on its own, the same
                      as it always did. */}
                  {isPortraitVideo && (
                    <IconBtn
                      label={forceLandscape ? 'Use portrait' : 'Rotate to landscape'}
                      onClick={() => void toggleForceLandscape()}
                    >
                      {forceLandscape ? (
                        <Smartphone size={18} />
                      ) : (
                        <Smartphone size={18} className="rotate-90" />
                      )}
                    </IconBtn>
                  )}
                  <IconBtn
                    label="Lock controls"
                    onClick={() => {
                      setControlsLocked(true);
                      setChrome(false);
                    }}
                  >
                    <LockKeyhole size={18} />
                  </IconBtn>
                  {/* The app's own rotation lock. The phone's system switch is
                      ignored here on purpose - this is the only one that
                      counts, and it freezes whichever way up the screen is
                      now, so locking while sideways keeps the player. */}
                  {rotatesWithDevice() && <RotationLock className="text-white/90" />}
                  <IconBtn
                    label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
                    onClick={() => void toggleFullscreen()}
                  >
                    {fullscreen ? <Minimize size={18} /> : <Maximize size={18} />}
                  </IconBtn>
                </div>
              </div>
            </div>
      </>
      )}

      {/* What is left of the controls when the player is a strip: play and
          pause, a thin line showing where the film is, and the two ways out -
          back to the full screen, or stop. */}
      {docked && (
        <div className="absolute inset-0 z-20 pointer-events-none">
          <div className="absolute top-2 right-2 flex gap-2 pointer-events-auto">
            {onExpand && (
              <button
                onClick={onExpand}
                aria-label="Full screen"
                className="h-9 w-9 rounded-full bg-black/55 grid place-items-center text-white"
              >
                <Maximize2 size={16} />
              </button>
            )}
            <button
              onClick={onClose}
              aria-label="Stop and close"
              className="h-9 w-9 rounded-full bg-black/55 grid place-items-center text-white"
            >
              <X size={16} />
            </button>
          </div>
          <button
            onClick={() => {
              const next = !playing;
              setPlaying(next);
              broadcast(next, time);
            }}
            aria-label={playing ? 'Pause' : 'Play'}
            className="absolute left-2 bottom-3 h-10 w-10 rounded-full bg-black/55 grid place-items-center text-white pointer-events-auto"
          >
            {playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" className="ml-0.5" />}
          </button>
          <span className="absolute left-14 bottom-4 max-w-[60%] truncate text-xs font-medium text-white drop-shadow">
            {item.title}
          </span>
          <div className="absolute bottom-0 inset-x-0 h-[3px] bg-white/25">
            <div className="h-full bg-gold" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      <SubtitleOverlay cues={cues} time={time - subDelay} style={subStyle} chromeVisible={chrome} />

      {/* The padlock. Everything beneath it is out of reach - taps, the
          gestures, the seek bar - until the unlock is pressed, which only
          appears after a touch so the picture stays clean. */}
      {controlsLocked && (
        <div className="absolute inset-0 z-[60]" onPointerDown={() => setUnlockShown(true)}>
          {unlockShown && (
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => {
                setControlsLocked(false);
                setUnlockShown(false);
                wake();
              }}
              className="absolute left-1/2 bottom-24 -translate-x-1/2 flex items-center gap-2 h-10 px-4 rounded-pill bg-black/80 border border-white/25 text-white text-xs"
            >
              <LockOpen size={16} />
              Unlock controls
            </button>
          )}
        </div>
      )}

      {following && chrome && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-30 glass border border-edge rounded-pill px-3 h-7 flex items-center">
          <span className="text-[11px] text-dim">
            {ownerName} controls playback in this watch party
          </span>
        </div>
      )}

      {/* up-next prompt */}
      <AnimatePresence>
        {nearEnd && upNext && !docked && (
          <motion.div
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 24 }}
            className="absolute bottom-24 right-6 z-30 w-64 rounded-card overflow-hidden border border-white/20 bg-black/80 backdrop-blur"
          >
            <Artwork
              title={upNext.title}
              seed={upNext.id}
              variant="backdrop"
              rounded={false}
              className="h-24 w-full"
            />
            <div className="p-3">
              <div className="text-[10px] uppercase tracking-wide text-white/50">Up next</div>
              <div className="text-xs font-medium text-white mt-0.5 truncate">
                {upNext.series
                  ? `S${upNext.season} E${upNext.episode} · ${upNext.title}`
                  : upNext.title}
              </div>
              <button
                onClick={() => onPlayNext(upNext)}
                className="mt-2 w-full h-8 rounded-input bg-white text-black text-xs font-semibold hover:bg-white/85"
              >
                Play now
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function IconBtn({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={cn(
        'h-9 w-9 rounded-full grid place-items-center text-white/90',
        'hover:bg-white/15 hover:text-white transition-colors active:scale-95',
      )}
    >
      {children}
    </button>
  );
}

/** One preview frame for every this many seconds of film. */
const PREVIEW_STEP_SEC = 15;
const PREVIEW_WIDTH = 168;

/**
 * The frame shown above the seek bar, one per fifteen seconds.
 *
 * A second, muted <video> parked on the nearest fifteen-second mark, rather
 * than a canvas the frame is drawn onto and read back: the main player is
 * deliberately not cross-origin (requiring it turned reachable files into
 * "Can't reach"), and a canvas read of a video that is not CORS-approved is
 * refused. The element shows its own frame and nothing has to be read.
 *
 * It points at the file itself, never at a remuxed stream: that one has no
 * timeline to seek in, and the picture is the same whichever soundtrack is on.
 * The frame only changes when the pointer crosses into another fifteen
 * seconds, which keeps it to a handful of seeks per drag instead of one for
 * every pixel.
 */
function SeekPreview({ src, at, aspect }: { src: string; at: number; aspect: number }) {
  const ref = React.useRef<HTMLVideoElement>(null);
  const nearest = Math.floor(Math.max(0, at) / PREVIEW_STEP_SEC) * PREVIEW_STEP_SEC;

  // Sweeping the pointer along the bar crosses a mark every few pixels, and
  // each one used to be a fresh range request against the device sharing the
  // film - the same one feeding the picture being watched. Only a mark the
  // pointer rests on is fetched.
  const [snapped, setSnapped] = React.useState(nearest);
  React.useEffect(() => {
    const id = setTimeout(() => setSnapped(nearest), 120);
    return () => clearTimeout(id);
  }, [nearest]);

  React.useEffect(() => {
    const el = ref.current;
    // Before metadata there is nothing to seek; onLoadedMetadata catches up.
    if (el && el.readyState >= 1) el.currentTime = snapped;
  }, [snapped]);

  return (
    <div
      className="overflow-hidden rounded-md border border-white/25 bg-black shadow-lg"
      style={{ width: PREVIEW_WIDTH, height: Math.round(PREVIEW_WIDTH / aspect) }}
    >
      <video
        ref={ref}
        src={src}
        muted
        playsInline
        // "auto" read the file on from wherever it had seeked, sharing the
        // host's disk and the Wi-Fi with the film being played. A still frame
        // needs only the bytes around it.
        preload="metadata"
        onLoadedMetadata={(e) => {
          e.currentTarget.currentTime = snapped;
        }}
        className="h-full w-full object-cover"
      />
    </div>
  );
}

function clock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
