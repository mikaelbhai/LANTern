import React from 'react';
import { Languages, Pause, Play, SkipBack, SkipForward, Subtitles as SubtitlesIcon } from 'lucide-react';

import { api, isGuest, isTauri } from '../lib/bridge';
import { pushLayer } from '../lib/backstack';
import { useStore } from '../lib/store';
import { runtime, seriesOrder } from '../screens/Theatre';
import { streamOrigin } from '../screens/theatre/keyframe';
import { SubtitleOverlay, useSubtitleCues } from '../screens/theatre/Subtitles';
import { trackNames } from '../screens/theatre/tracks';
import type { MediaItem } from '../lib/types';
import { cn } from '../lib/utils';
import { rememberPosition, startPosition } from '../lib/resumeMirror';
import { intentOf, scrubbed, type Intent } from './remote';
import { u } from './units';

/**
 * The television's player.
 *
 * Not the phone and desktop player with parts hidden: that one is built around
 * a pointer, windows, gestures and a dozen settings, and on a remote its
 * controls could not be reached at all. This does one thing - play a film
 * full screen and be steerable with nine buttons - and keeps its focus as
 * explicit state rather than asking the browser which element is nearest.
 *
 * Where the focus is decides what each button means:
 *
 *   hidden   OK pauses, Left/Right skip, Up reaches the bar, Down the buttons
 *   bar      Left/Right scrub, OK pauses (or commits a scrub), Down the buttons
 *   buttons  Left/Right choose, OK presses, Up returns to the bar
 *
 * Back undoes one layer at a time - a list, then the controls, then the film -
 * so a stray press never throws you out in the middle of it.
 */

type Zone = 'hidden' | 'bar' | 'buttons';
type Menu = 'subs' | 'audio' | null;

const HIDE_AFTER_MS = 4000;
const SCRUB_COMMIT_MS = 900;

const clock = (sec: number): string => {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const rest = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${rest}` : `${m}:${rest}`;
};

export function TvPlayer({
  item,
  items,
  onPlay,
  onClose,
  suspended = false,
}: {
  item: MediaItem;
  /** The whole library, for what comes before and after in a series. */
  items: MediaItem[];
  onPlay: (next: MediaItem) => void;
  onClose: () => void;
  /** Something else (the exit prompt) has the remote; this one stands down. */
  suspended?: boolean;
}) {
  const suspendedRef = React.useRef(suspended);
  suspendedRef.current = suspended;
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const bufferMb = useStore((s) => s.settings.playback?.bufferMb ?? 128);

  const [playing, setPlaying] = React.useState(true);
  const [time, setTime] = React.useState(0);
  const [duration, setDuration] = React.useState(item.durationSec);
  const [zone, setZone] = React.useState<Zone>('bar');
  const [button, setButton] = React.useState(0);
  const [menu, setMenu] = React.useState<Menu>(null);
  const [menuAt, setMenuAt] = React.useState(0);
  const [scrub, setScrub] = React.useState<number | null>(null);
  const [failed, setFailed] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);

  const subtitles = item.subtitles ?? [];
  const audioTracks = item.audioTracks ?? [];
  const subtitleNames = React.useMemo(
    () => trackNames(subtitles.map((s) => ({ lang: s.lang, label: s.label }))),
    [subtitles],
  );
  const audioNames = React.useMemo(() => trackNames(audioTracks), [audioTracks]);

  const [subtitle, setSubtitle] = React.useState(() => {
    if (!item.subtitleLang) return -1;
    return subtitles.findIndex((s) => s.lang === item.subtitleLang);
  });
  const [audioTrack, setAudioTrack] = React.useState(() => {
    if (!item.audioLang) return -1;
    const at = audioTracks.findIndex((a) => a.lang === item.audioLang);
    return at >= 0 && !audioTracks[at].default ? at : -1;
  });
  const [sourceOffset, setSourceOffset] = React.useState(0);
  const [streamStart, setStreamStart] = React.useState(0);

  const cues = useSubtitleCues(subtitle >= 0 ? (subtitles[subtitle]?.url ?? null) : null);

  /* ----------------------------------------------------------- the stream */

  const source =
    audioTrack >= 0
      ? `${item.streamUrl}${item.streamUrl.includes('?') ? '&' : '?'}audio=${audioTrack}` +
        `&codec=${encodeURIComponent(audioTracks[audioTrack]?.codec ?? '')}` +
        `&t=${sourceOffset.toFixed(3)}`
      : item.streamUrl;

  // A film from another device is read through the local buffer (readahead.rs),
  // and played from the address it came from if that cannot be had.
  const relayable = isTauri() && !isGuest() && !!item.peerId && bufferMb > 0 && /^http:\/\//i.test(source);
  const [relay, setRelay] = React.useState<{ for: string; url: string } | null>(null);
  const [relayFailed, setRelayFailed] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!relayable) return;
    let cancelled = false;
    let opened: string | null = null;
    api.readahead
      .open(source, bufferMb)
      .then((local) => {
        if (!local) throw new Error('no relay');
        if (cancelled) {
          void api.readahead.close(local);
          return;
        }
        opened = local;
        setRelay({ for: source, url: local });
      })
      .catch(() => {
        if (!cancelled) setRelayFailed(source);
      });
    return () => {
      cancelled = true;
      if (opened) void api.readahead.close(opened);
    };
  }, [relayable, source, bufferMb]);
  const relayed = relayable && relayFailed !== source;
  const playSrc = !relayed ? source : relay?.for === source ? relay.url : undefined;

  /* ----------------------------------------------------------- the clock */

  const latest = React.useRef({ time: 0, duration });
  latest.current = { time, duration };
  // Where to go once the video has its metadata: where it was left, or where it
  // was when the stream had to be replaced.
  // startPosition is already the start for a title left in its credits.
  const resumeAt = React.useRef<number | null>(startPosition(item) > 30 ? startPosition(item) : null);
  // Where the film really is, for when the stream has to be replaced: the
  // open-time position is stale as soon as anything has been watched.
  const bestKnown = React.useRef(startPosition(item));
  const ready = React.useRef(false);
  const lastSaved = React.useRef(startPosition(item));
  const failedRef = React.useRef(false);
  failedRef.current = failed;
  const generation = React.useRef(0);

  /** Starts a remuxed stream at a position, learning where its clock really begins. */
  const restartAt = React.useCallback(
    (to: number) => {
      const mine = ++generation.current;
      void streamOrigin(item.streamUrl, to).then((origin) => {
        if (mine !== generation.current) return;
        setStreamStart(origin);
        setSourceOffset(to);
        setTime(to);
        setPlaying(true);
      });
    },
    [item.streamUrl],
  );

  const seekTo = React.useCallback(
    (to: number) => {
      const target = Math.max(0, Math.min(to, latest.current.duration > 0 ? latest.current.duration - 1 : to));
      if (audioTrack >= 0) {
        restartAt(target);
        return;
      }
      const el = videoRef.current;
      if (el) el.currentTime = target;
      setTime(target);
    },
    [audioTrack, restartAt],
  );

  // Saved as it goes, so a film left half-way is half-way next time.
  React.useEffect(() => {
    const save = () => {
      const at = Math.floor(latest.current.time);
      // Only a position that was really reached: not while the picture is down,
      // not before the stream is up, not a sudden fall of more than a minute and
      // a half (which is the clock losing its place, not somebody rewinding by
      // pressing a button).
      if (failedRef.current || !ready.current || at <= 5) return;
      if (at < lastSaved.current - 90) return;
      void api.media.setProgress(item.id, at).catch(() => {});
      rememberPosition(item, at);
      lastSaved.current = at;
    };
    const id = window.setInterval(save, 10_000);
    return () => {
      window.clearInterval(id);
      save();
    };
  }, [item.id]);

  React.useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (playing) void el.play().catch(() => setPlaying(false));
    else el.pause();
  }, [playing, playSrc]);

  /* ---------------------------------------------------- what is on screen */

  const order = React.useMemo(() => seriesOrder(items, item), [items, item]);
  const at = order.findIndex((i) => i.id === item.id);
  const previous = at > 0 ? order[at - 1] : null;
  const next = at >= 0 && at < order.length - 1 ? order[at + 1] : null;

  const buttons = React.useMemo(() => {
    const list: { id: 'prev' | 'next' | 'subs' | 'audio'; label: string; icon: React.ReactNode }[] = [];
    if (previous) list.push({ id: 'prev', label: 'Previous', icon: <SkipBack /> });
    if (next) list.push({ id: 'next', label: 'Next episode', icon: <SkipForward /> });
    if (subtitles.length) {
      list.push({
        id: 'subs',
        label: subtitle >= 0 ? subtitleNames[subtitle] : 'Subtitles',
        icon: <SubtitlesIcon />,
      });
    }
    if (audioTracks.length > 1) {
      list.push({
        id: 'audio',
        label: audioTrack >= 0 ? audioNames[audioTrack] : 'Audio',
        icon: <Languages />,
      });
    }
    return list;
  }, [previous, next, subtitles.length, subtitle, subtitleNames, audioTracks.length, audioTrack, audioNames]);

  const remember = (audio: number, subs: number) =>
    void api.media
      .setTracks(item.id, audio >= 0 ? (audioTracks[audio]?.lang ?? '') : '', subs >= 0 ? (subtitles[subs]?.lang ?? '') : '')
      .catch(() => {});

  const chooseSubtitle = (to: number) => {
    setSubtitle(to);
    remember(audioTrack, to);
  };
  const chooseAudio = (to: number) => {
    if (to === audioTrack) return;
    const here = latest.current.time;
    setAudioTrack(to);
    remember(to, subtitle);
    if (to >= 0) {
      restartAt(here);
    } else {
      // Back to the file's own audio, from where it was.
      generation.current++;
      setStreamStart(0);
      setSourceOffset(0);
      resumeAt.current = here;
    }
  };

  /* ---------------------------------------------------------- the remote */

  const lastPress = React.useRef(Date.now());
  const held = React.useRef({ key: '', count: 0 });
  const scrubTimer = React.useRef<number>();

  const wake = () => {
    lastPress.current = Date.now();
  };

  const menuItems = menu === 'subs' ? ['Off', ...subtitleNames] : menu === 'audio' ? ['Default', ...audioNames] : [];

  /** One layer of Back. True when there was nothing left to undo, so the film should close. */
  const back = (): boolean => {
    if (menu) {
      setMenu(null);
      return false;
    }
    if (scrub !== null) {
      window.clearTimeout(scrubTimer.current);
      setScrub(null);
      return false;
    }
    if (zone !== 'hidden') {
      setZone('hidden');
      return false;
    }
    return true;
  };
  const backRef = React.useRef(back);
  backRef.current = back;

  const press = (intent: Intent, repeats: number) => {
    wake();

    if (failed) {
      if (intent === 'ok') {
        setFailed(false);
        setAttempt((a) => a + 1);
      } else if (intent === 'back') onClose();
      return;
    }

    if (intent === 'back') {
      if (backRef.current()) onClose();
      return;
    }

    // Media keys mean the same wherever the focus is.
    if (intent === 'playpause') {
      setPlaying((p) => !p);
      setZone((z) => (z === 'hidden' ? 'bar' : z));
      return;
    }
    if (intent === 'ff' || intent === 'rw') {
      seekTo(latest.current.time + (intent === 'ff' ? 30 : -10));
      setZone((z) => (z === 'hidden' ? 'bar' : z));
      return;
    }
    if (intent === 'next' && next) return onPlay(next);
    if (intent === 'prev' && previous) return onPlay(previous);

    if (menu) {
      if (intent === 'up') setMenuAt((i) => Math.max(0, i - 1));
      else if (intent === 'down') setMenuAt((i) => Math.min(menuItems.length - 1, i + 1));
      else if (intent === 'ok') {
        if (menu === 'subs') chooseSubtitle(menuAt - 1);
        else chooseAudio(menuAt - 1);
        setMenu(null);
      } else if (intent === 'left') setMenu(null);
      return;
    }

    if (zone === 'hidden') {
      if (intent === 'ok') {
        setPlaying((p) => !p);
        setZone('bar');
      } else if (intent === 'left' || intent === 'right') {
        seekTo(latest.current.time + (intent === 'right' ? 10 : -10));
        setZone('bar');
      } else if (intent === 'up') setZone('bar');
      else if (intent === 'down') setZone(buttons.length ? 'buttons' : 'bar');
      return;
    }

    if (zone === 'bar') {
      if (intent === 'left' || intent === 'right') {
        const base = scrub ?? latest.current.time;
        const to = scrubbed(base, intent === 'right' ? 1 : -1, repeats, latest.current.duration);
        setScrub(to);
        window.clearTimeout(scrubTimer.current);
        scrubTimer.current = window.setTimeout(() => {
          seekTo(to);
          setScrub(null);
        }, SCRUB_COMMIT_MS);
      } else if (intent === 'ok') {
        if (scrub !== null) {
          window.clearTimeout(scrubTimer.current);
          seekTo(scrub);
          setScrub(null);
        } else setPlaying((p) => !p);
      } else if (intent === 'down' && buttons.length) {
        setButton((b) => Math.min(b, buttons.length - 1));
        setZone('buttons');
      }
      return;
    }

    // buttons
    if (intent === 'left') setButton((b) => Math.max(0, b - 1));
    else if (intent === 'right') setButton((b) => Math.min(buttons.length - 1, b + 1));
    else if (intent === 'up') setZone('bar');
    else if (intent === 'ok') {
      const chosen = buttons[button];
      if (!chosen) return;
      if (chosen.id === 'prev' && previous) onPlay(previous);
      else if (chosen.id === 'next' && next) onPlay(next);
      else if (chosen.id === 'subs') {
        setMenuAt(subtitle + 1);
        setMenu('subs');
      } else if (chosen.id === 'audio') {
        setMenuAt(audioTrack + 1);
        setMenu('audio');
      }
    }
  };
  const pressRef = React.useRef(press);
  pressRef.current = press;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (suspendedRef.current) return;
      const intent = intentOf(e);
      if (!intent) return;
      // The page must not scroll or move focus on its own: this is the only
      // thing on screen that listens.
      e.preventDefault();
      e.stopPropagation();
      const same = held.current.key === e.key;
      held.current = { key: e.key, count: e.repeat && same ? held.current.count + 1 : 0 };
      pressRef.current(intent, held.current.count);
    };
    const onUp = () => {
      held.current = { key: '', count: 0 };
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('keyup', onUp, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('keyup', onUp, true);
    };
  }, []);

  // The system's Back (and a browser's) arrives as history, not as a key. Each
  // press undoes one layer; the entry it consumed is put back until the film
  // itself is what is left to close.
  //
  // Armed once, and let go of a moment after unmounting rather than at once:
  // in development React mounts, unmounts and mounts again, and releasing the
  // entry in between rewinds history past the page - Back then pressed itself
  // and left the app the instant a film started.
  const closeRef = React.useRef(onClose);
  closeRef.current = onClose;
  const layer = React.useRef<(() => void) | null>(null);
  const alive = React.useRef(false);
  React.useEffect(() => {
    alive.current = true;
    const arm = () => {
      layer.current = pushLayer(() => {
        layer.current = null;
        if (backRef.current()) closeRef.current();
        else arm();
      });
    };
    if (!layer.current) arm();
    return () => {
      alive.current = false;
      window.setTimeout(() => {
        if (!alive.current && layer.current) {
          layer.current();
          layer.current = null;
        }
      }, 0);
    };
  }, []);

  // Controls go away by themselves while the film plays, and stay while it is
  // paused: somebody who paused it is looking at them.
  React.useEffect(() => {
    const id = window.setInterval(() => {
      if (zone !== 'hidden' && playing && !menu && scrub === null && Date.now() - lastPress.current > HIDE_AFTER_MS) {
        setZone('hidden');
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [zone, playing, menu, scrub]);

  /* -------------------------------------------------------------- render */

  const shown = scrub ?? time;
  const pct = duration > 0 ? Math.min(100, (shown / duration) * 100) : 0;
  const donePct = duration > 0 ? Math.min(100, (time / duration) * 100) : 0;
  const controls = zone !== 'hidden' || menu !== null || failed;
  const barFocus = zone === 'bar';

  return (
    <div className="fixed inset-0 z-[60] bg-black text-white overflow-hidden select-none">
      <video
        key={attempt}
        ref={videoRef}
        src={playSrc}
        autoPlay
        playsInline
        className="absolute inset-0 h-full w-full bg-black object-contain"
        onLoadedMetadata={(e) => {
          const el = e.currentTarget;
          if (audioTrack < 0 && Number.isFinite(el.duration) && el.duration > 0) setDuration(el.duration);
          if (audioTrack < 0 && resumeAt.current !== null) {
            el.currentTime = resumeAt.current;
            resumeAt.current = null;
          }
          ready.current = true;
        }}
        onTimeUpdate={(e) => {
          const here = streamStart + e.currentTarget.currentTime;
          setTime(here);
          if (ready.current && here > 0) bestKnown.current = here;
        }}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onEnded={() => {
          void api.media.setProgress(item.id, latest.current.duration || latest.current.time).catch(() => {});
          if (next) onPlay(next);
          else onClose();
        }}
        onError={() => {
          // The buffer in the middle failing is not the other device being
          // gone: go round it, from where the film had got to.
          ready.current = false;
          if (relayed && relay?.url === playSrc) {
            resumeAt.current = bestKnown.current;
            setRelayFailed(source);
            return;
          }
          // Remembered, so trying again picks up where the film was and not
          // where it was opened.
          resumeAt.current = bestKnown.current;
          setFailed(true);
        }}
      />

      <SubtitleOverlay cues={cues} time={time} style="large" chromeVisible={controls} />

      {/* Paused, with nothing else up: the one thing worth saying. */}
      {!playing && zone === 'hidden' && !failed && (
        <div className="absolute inset-0 grid place-items-center pointer-events-none">
          <span
            className="grid place-items-center rounded-full bg-black/55 backdrop-blur"
            style={{ width: u(11), height: u(11) }}
          >
            <Play style={{ width: u(4.6), height: u(4.6) }} fill="currentColor" />
          </span>
        </div>
      )}

      {failed && (
        <div className="absolute inset-0 grid place-items-center bg-black/80">
          <div className="text-center" style={{ maxWidth: u(70) }}>
            <p className="font-semibold" style={{ fontSize: u(3.4) }}>
              Can’t play this right now
            </p>
            <p className="mt-2 text-white/65" style={{ fontSize: u(2) }}>
              The device holding it may be asleep or off the network.
            </p>
            <span
              className="mt-6 inline-flex items-center rounded-full bg-gold text-on-gold font-semibold ring-4 ring-white/80"
              style={{ height: u(5.6), paddingInline: u(4), fontSize: u(2.1) }}
            >
              Try again
            </span>
          </div>
        </div>
      )}

      {/* Top: what is playing. */}
      <div
        className={cn(
          'absolute inset-x-0 top-0 bg-gradient-to-b from-black/80 to-transparent transition-opacity duration-200',
          controls && !failed ? 'opacity-100' : 'opacity-0',
        )}
        style={{ padding: `${u(3)} ${u(4)} ${u(8)}` }}
      >
        <div className="font-semibold leading-tight truncate" style={{ fontSize: u(3) }}>
          {item.title}
        </div>
        {item.series && (
          <div className="text-white/70 truncate" style={{ fontSize: u(1.9), marginTop: u(0.5) }}>
            {item.series} · Season {item.season ?? 1}, Episode {item.episode ?? 1}
          </div>
        )}
      </div>

      {/* Bottom: the bar and the buttons. */}
      <div
        className={cn(
          'absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent transition-opacity duration-200',
          controls && !failed ? 'opacity-100' : 'opacity-0 pointer-events-none',
        )}
        style={{ padding: `${u(10)} ${u(4)} ${u(3.5)}` }}
      >
        {menu ? (
          <div
            className="mx-auto rounded-2xl bg-black/75 backdrop-blur-md border border-white/10"
            style={{ width: u(46), padding: u(1.2) }}
          >
            <div className="text-white/60 uppercase tracking-wider" style={{ fontSize: u(1.5), padding: `${u(0.6)} ${u(1.4)}` }}>
              {menu === 'subs' ? 'Subtitles' : 'Audio'}
            </div>
            {menuItems.map((label, i) => {
              const current = (menu === 'subs' ? subtitle : audioTrack) === i - 1;
              return (
                <div
                  key={`${label}-${i}`}
                  className={cn(
                    'flex items-center justify-between rounded-xl transition-colors',
                    i === menuAt ? 'bg-gold text-on-gold font-semibold' : 'text-white/85',
                  )}
                  style={{ height: u(5), paddingInline: u(1.8), fontSize: u(2.1) }}
                  data-active={i === menuAt}
                >
                  <span className="truncate">{label}</span>
                  {current && <span style={{ fontSize: u(1.7) }}>●</span>}
                </div>
              );
            })}
          </div>
        ) : (
          <>
            {/* The bar. Taller and brighter when it has the focus. */}
            <div
              className="relative rounded-full bg-white/25 transition-all"
              style={{ height: barFocus ? u(1.1) : u(0.55) }}
            >
              <div className="absolute inset-y-0 left-0 rounded-full bg-white/45" style={{ width: `${donePct}%` }} />
              <div className="absolute inset-y-0 left-0 rounded-full bg-gold" style={{ width: `${pct}%` }} />
              {barFocus && (
                <span
                  className="absolute top-1/2 rounded-full bg-white ring-4 ring-gold/60"
                  style={{
                    left: `${pct}%`,
                    width: u(2.2),
                    height: u(2.2),
                    transform: 'translate(-50%, -50%)',
                  }}
                />
              )}
            </div>
            <div className="flex items-center justify-between tabular-nums text-white/80" style={{ fontSize: u(1.9), marginTop: u(1.2) }}>
              <span className={cn(scrub !== null && 'text-gold font-semibold')}>{clock(shown)}</span>
              <span className="text-white/60">
                {duration > 0 ? `${runtime(Math.max(0, duration - shown))} left` : ''}
              </span>
            </div>

            {buttons.length > 0 && (
              <div className="flex items-center justify-center" style={{ gap: u(1.6), marginTop: u(2) }}>
                {buttons.map((b, i) => {
                  const focused = zone === 'buttons' && i === button;
                  return (
                    <div
                      key={b.id}
                      className={cn(
                        'flex items-center rounded-full transition-all duration-150',
                        focused ? 'bg-gold text-on-gold font-semibold scale-105 shadow-glow' : 'bg-white/12 text-white/90',
                      )}
                      style={{ height: u(5.4), paddingInline: u(2.4), gap: u(1.1), fontSize: u(2) }}
                    >
                      {React.cloneElement(b.icon as React.ReactElement, {
                        style: { width: u(2.4), height: u(2.4) },
                        fill: b.id === 'subs' || b.id === 'audio' ? 'none' : 'currentColor',
                      })}
                      <span className="whitespace-nowrap">{b.label}</span>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="flex justify-center text-white/45" style={{ fontSize: u(1.5), marginTop: u(1.8) }}>
              {playing ? <Pause style={{ width: u(1.6), height: u(1.6) }} /> : <Play style={{ width: u(1.6), height: u(1.6) }} />}
              <span style={{ marginLeft: u(0.8) }}>
                OK {playing ? 'pauses' : 'plays'} · ◀ ▶ {zone === 'bar' ? 'scrub' : 'move'} · Back {zone === 'hidden' ? 'leaves' : 'hides this'}
              </span>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
