import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft,
  Gauge,
  Maximize,
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
  Volume2,
  VolumeX,
  WifiOff,
  Languages,
  Crop,
  Scan,
} from 'lucide-react';
import { Artwork } from '../../lib/poster';
import { api, on } from '../../lib/bridge';
import { cn } from '../../lib/utils';
import type { MediaItem, WatchParty } from '../../lib/types';
import { useBackDismiss } from '../../lib/hooks';
import { browserCanPlay, needsRemux } from '../../lib/audiocap';
import { claimArrowKeys } from '../../lib/tv';
import { trackNames } from './tracks';
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
}) {
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const shellRef = React.useRef<HTMLDivElement>(null);

  const [playing, setPlaying] = React.useState(true);
  const [time, setTime] = React.useState(item.progressSec);
  const [duration, setDuration] = React.useState(item.durationSec);
  const [volume, setVolume] = React.useState(1);
  const [muted, setMuted] = React.useState(false);
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
        const next = Math.max(0, Math.min(1, drag.startValue + deltaY / SWIPE_RANGE_PX));
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
  const subtitleNames = React.useMemo(() => trackNames(subtitles), [subtitles]);
  const audioNames = React.useMemo(() => trackNames(audioTracks), [audioTracks]);

  const cues = useSubtitleCues(subtitle >= 0 ? (subtitles[subtitle]?.url ?? null) : null);

  // Which audio track is playing, and whether this device can change it.
  const [audioTrack, setAudioTrack] = React.useState(() =>
    matchLanguage(item.audioTracks, item.audioLang),
  );
  // A remuxed stream has no timeline of its own: it begins at the point it was
  // asked for, so the player's clock is offset by that amount and seeking
  // re-requests rather than scrubbing.
  const [sourceOffset, setSourceOffset] = React.useState(0);
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
    setAudioTrack(typeof track.index === 'number' ? track.index : 0);
  }, [item.id, audioTracks, audioTrack]);

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
        `&t=${Math.floor(sourceOffset)}` +
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
    const next = Math.max(-5000, Math.min(5000, audioDelay + deltaMs));
    if (next === audioDelay) return;
    setSourceOffset(Math.max(0, Math.floor(time)));
    if (audioTrack < 0) {
      const track: any = audioTracks.find((t: any) => t?.default) ?? audioTracks[0];
      if (track) setAudioTrack(typeof track.index === 'number' ? track.index : 0);
    }
    setAudioDelay(next);
  };

  // A shift belongs to the file it was judged against, not to the player.
  React.useEffect(() => setAudioDelay(0), [item.id]);

  const chooseAudio = (index: number) => {
    setSourceOffset(index >= 0 ? Math.max(0, Math.floor(time)) : 0);
    setAudioTrack(index);
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

  const wake = React.useCallback(() => {
    setChrome(true);
    clearTimeout(hideTimer.current);
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
        setSourceOffset(clamped);
        return;
      }

      const el = videoRef.current;
      if (el && !unreachable && Number.isFinite(el.duration)) el.currentTime = clamped;
    },
    [duration, unreachable, audioTrack],
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
    if (el) {
      el.volume = volume;
      el.muted = muted;
    }
  }, [volume, muted]);

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
      if (at < Math.floor(sourceOffset)) return;
      void api.media.setProgress(item.id, at);
    };
    const id = setInterval(save, 5000);
    return () => {
      clearInterval(id);
      save();
    };
  }, [item.id, sourceOffset]);

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
      wake();
      switch (e.key) {
        case ' ':
        case 'k':
          e.preventDefault();
          setPlaying((p) => !p);
          break;
        case 'ArrowRight':
          e.preventDefault();
          seekTo(time + 10);
          break;
        case 'ArrowLeft':
          e.preventDefault();
          seekTo(time - 10);
          break;
        case 'ArrowUp':
          e.preventDefault();
          setVolume((v) => Math.min(1, v + 0.05));
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
  }, [time, seekTo, wake, onClose]);

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
        await lockLandscape();
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

  const pct = duration ? (time / duration) * 100 : 0;
  const bufferedPct = duration ? (buffered / duration) * 100 : 0;
  const nearEnd = duration > 0 && duration - time < 40 && duration - time > 0;

  const scrub = (e: React.MouseEvent<HTMLDivElement>) => {
    // Only the host moves the party's clock.
    if (following) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const target = ((e.clientX - rect.left) / rect.width) * duration;
    seekTo(target);
    broadcast(playing, target);
  };

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
        className="absolute inset-0 grid place-items-center overflow-hidden"
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
              if (audioTrack < 0 && item.progressSec > 0) {
                el.currentTime = item.progressSec;
              }
              // A remuxed stream's own clock starts at zero however far in it
              // begins, so the offset is the position until it reports one.
              // Set here rather than waiting for the first tick: that tick is
              // what the saver would otherwise have written down.
              if (audioTrack >= 0) setTime(sourceOffset);
              swapping.current = false;
            }}
            // Deliberately no crossOrigin: the player does not read pixels,
            // and requiring a CORS-checked fetch here turned a perfectly
            // reachable file into "Can't reach". The thumbnail grabber sets it
            // because a canvas read needs it; this does not.
            onTimeUpdate={(e) => {
              if (scrubbing) return;
              // Between asking for a new stream and it being ready, the
              // element still ticks against the old one. Those readings belong
              // to a position that no longer exists.
              if (swapping.current) return;
              setTime(sourceOffset + e.currentTarget.currentTime);
            }}
            onProgress={(e) => {
              const el = e.currentTarget;
              if (el.buffered.length) setBuffered(el.buffered.end(el.buffered.length - 1));
            }}
            onEnded={() => {
              setPlaying(false);
              if (upNext) onPlayNext(upNext);
            }}
            onError={() => setUnreachable(true)}
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
                onClick={scrub}
                onMouseDown={() => setScrubbing(true)}
                onMouseUp={() => setScrubbing(false)}
                onMouseLeave={() => setScrubbing(false)}
                className="group/bar relative h-4 flex items-center cursor-pointer"
              >
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
                    max={1}
                    step={0.01}
                    value={muted ? 0 : volume}
                    onChange={(e) => {
                      setVolume(parseFloat(e.target.value));
                      setMuted(false);
                    }}
                    aria-label="Volume"
                    className="w-0 group-hover/vol:w-20 transition-all duration-200 h-1 accent-white cursor-pointer"
                  />
                </div>

                <span className="text-[11px] font-mono text-white/80 tabular-nums">
                  {clock(time)} / {clock(duration)}
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

      <SubtitleOverlay cues={cues} time={time} style={subStyle} chromeVisible={chrome} />

      {following && chrome && (
        <div className="absolute bottom-24 left-1/2 -translate-x-1/2 z-30 glass border border-edge rounded-pill px-3 h-7 flex items-center">
          <span className="text-[11px] text-dim">
            {ownerName} controls playback in this watch party
          </span>
        </div>
      )}

      {/* up-next prompt */}
      <AnimatePresence>
        {nearEnd && upNext && (
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

function clock(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '0:00';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}
