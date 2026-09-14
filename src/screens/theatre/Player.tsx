import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowLeft,
  Maximize,
  Minimize,
  Pause,
  Play,
  RotateCcw,
  RotateCw,
  SkipBack,
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
import { api } from '../../lib/bridge';
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
  const [buffered, setBuffered] = React.useState(0);
  const [chrome, setChrome] = React.useState(true);
  const [fullscreen, setFullscreen] = React.useState(false);
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

  React.useEffect(() => {
    const el = videoRef.current;
    if (el) {
      el.volume = volume;
      el.muted = muted;
    }
  }, [volume, muted]);

  // Remember where the viewer got to, so Continue watching is accurate.
  React.useEffect(() => {
    const id = setInterval(() => {
      void api.media.setProgress(item.id, Math.floor(time));
    }, 5000);
    return () => {
      clearInterval(id);
      void api.media.setProgress(item.id, Math.floor(time));
    };
  }, [item.id, time]);

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
      <div ref={stageRef} className="absolute inset-0 grid place-items-center overflow-hidden">
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
            }}
            // Deliberately no crossOrigin: the player does not read pixels,
            // and requiring a CORS-checked fetch here turned a perfectly
            // reachable file into "Can't reach". The thumbnail grabber sets it
            // because a canvas read needs it; this does not.
            onTimeUpdate={(e) => {
              if (!scrubbing) setTime(sourceOffset + e.currentTarget.currentTime);
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
        className="absolute inset-0 z-10"
      />

      {/*
        The chrome is always mounted and fades with a CSS transition. A
        JS-driven animation only advances while the window paints, so an
        occluded window could leave the controls stranded invisible — not
        acceptable for the one surface a viewer needs to reach.
      */}
      <>
            {/* top bar */}
            <div
              style={{ transform: chrome ? 'translateY(0)' : 'translateY(-12px)' }}
              className={cn(
                'absolute top-0 inset-x-0 z-20 p-4 bg-gradient-to-b from-black/80 to-transparent flex items-start gap-3',
                'transition-all duration-200',
                chrome ? 'opacity-100' : 'opacity-0 pointer-events-none',
              )}
            >
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

            {/* bottom controls */}
            <div
              style={{ transform: chrome ? 'translateY(0)' : 'translateY(16px)' }}
              className={cn(
                'absolute bottom-0 inset-x-0 z-20 px-4 pb-4 pt-16',
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
                  <div
                    className="h-full bg-gold relative"
                    style={{ width: `${pct}%` }}
                  />
                </div>
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
