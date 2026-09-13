import React from 'react';
import { Gamepad2, Hand, Keyboard, MousePointer2, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { api, on } from '../lib/bridge';
import * as rtc from '../lib/webrtc';
import {
  Held,
  PAD_KEYS,
  Pointer,
  clickEvents,
  coalesce,
  isTap,
  touchPoint,
  type PadButton,
  type RemoteEvent,
  type Touch,
} from '../lib/remote';

/**
 * The thing you hold, when the machine is across the room.
 *
 * Three surfaces, because they are three genuinely different acts and one
 * control cannot be all of them. A trackpad pushes a pointer about and is
 * what you want for working. A touchscreen points at the thing you can see
 * and is what you want for driving another touchscreen. A pad is buttons, and
 * is what you want when you are looking at a television and not at the phone
 * in your hands at all.
 *
 * Events are gathered for a frame and sent together. A finger produces sixty
 * a second and sixty messages a second on the link, for movement that adds up
 * to one number, is waste that shows as lag on the far end.
 */
export type Surface = 'trackpad' | 'touch' | 'pad';

/**
 * Keeps the gesture with the element it started on, if the browser will.
 *
 * Capture is an optimisation - it stops a finger that slides off a button
 * from stranding the press - and it throws when the pointer is no longer
 * active, which happens when a gesture is cancelled underneath you. Calling
 * it before registering the press meant that throw swallowed the input and
 * the button silently did nothing. It is now both guarded and last.
 */
function keepGesture(e: React.PointerEvent): void {
  try {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  } catch {
    /* the gesture simply is not ours to keep */
  }
}


export function RemoteControl({
  peerId,
  onClose,
}: {
  peerId: string;
  onClose: () => void;
}) {
  const [surface, setSurface] = React.useState<Surface>('pad');
  // The picture of their screen. Null until they grant control, because the
  // secret that opens it is minted by the grant.
  const [screen, setScreen] = React.useState<string | null>(null);
  // Their screen as real video, once they agree to send it. Preferred over the
  // still frames the moment it arrives: it is the same picture at six times
  // the rate and a fraction of the bandwidth.
  const [video, setVideo] = React.useState<MediaStream | null>(null);
  // How many still frames a second to ask for, when it is still frames. No
  // effect on the video path, where the encoder decides.
  const [fps, setFps] = React.useState(10);

  // Everything held down at the far end, so it can all be let go of.
  const held = React.useRef(new Held());
  const queue = React.useRef<RemoteEvent[]>([]);
  const timer = React.useRef<number | null>(null);

  const flush = React.useCallback(() => {
    timer.current = null;
    const batch = coalesce(queue.current);
    queue.current = [];
    if (!batch.length) return;
    void api.control.send(peerId, batch).catch(() => {});
  }, [peerId]);

  const push = React.useCallback(
    (...events: (RemoteEvent | null)[]) => {
      for (const event of events) if (event) queue.current.push(event);
      if (timer.current === null) {
        // One frame. Long enough to gather a burst, short enough that a click
        // does not feel delayed.
        timer.current = window.setTimeout(flush, 16);
      }
    },
    [flush],
  );

  /**
   * Let go of everything, whatever happened.
   *
   * A phone can be locked, backgrounded or lose its link mid-press, and any of
   * those would leave a key down on a machine in another room. This is the
   * only thing standing between that and a desktop nobody can use.
   */
  const releaseEverything = React.useCallback(() => {
    const ups = held.current.releaseAll();
    if (ups.length) void api.control.send(peerId, ups).catch(() => {});
  }, [peerId]);

  React.useEffect(() => {
    const onHidden = () => {
      if (document.visibilityState === 'hidden') releaseEverything();
    };
    document.addEventListener('visibilitychange', onHidden);
    window.addEventListener('pagehide', releaseEverything);
    window.addEventListener('blur', releaseEverything);
    return () => {
      document.removeEventListener('visibilitychange', onHidden);
      window.removeEventListener('pagehide', releaseEverything);
      window.removeEventListener('blur', releaseEverything);
      releaseEverything();
    };
  }, [releaseEverything]);

  // The far end taking control away is not a failure, but it does mean
  // everything held is now held by nobody.
  // Read by listeners registered once, so it cannot be the captured value.
  const fpsRef = React.useRef(fps);
  fpsRef.current = fps;

  // Their screen arriving as video supersedes the still frames.
  React.useEffect(
    () =>
      rtc.onScreenStream((from, stream) => {
        if (from === peerId) setVideo(stream);
      }),
    [peerId],
  );

  React.useEffect(
    () =>
      on(
        'control:message',
        (msg: { op?: string; from?: string; token?: string }) => {
          if (msg.from !== peerId) return;
          if (msg.op === 'granted' && msg.token) {
            // Their address is asked for rather than assumed: the one a device
            // picked for itself is not necessarily the one that works here.
            void api.control
              .screenUrl(peerId, msg.token)
              .then((url) => setScreen(`${url}&fps=${fpsRef.current}`))
              .catch(() => setScreen(null));
            // And ask for the better one. It costs them a dialog, so it is a
            // request rather than an assumption, and the still frames carry
            // on either way until it answers.
            void api.control.askScreen(peerId).catch(() => {});
            // Touch is the mode that makes sense once there is a picture to
            // point at, so it becomes the one on screen.
            setSurface('touch');
          }
          if (msg.op === 'ended' || msg.op === 'denied') {
            held.current.releaseAll();
            setScreen(null);
            setVideo(null);
            rtc.stopScreenTo(peerId);
            onClose();
          }
        },
      ),
    [peerId, onClose],
  );

  return (
    <div className="flex flex-col h-full min-h-0 bg-base">
      <div className="shrink-0 flex items-center gap-1 px-2 py-2 border-b border-edge">
        <SurfaceTab now={surface} id="pad" onPick={setSurface} icon={Gamepad2} label="Pad" />
        <SurfaceTab
          now={surface}
          id="trackpad"
          onPick={setSurface}
          icon={MousePointer2}
          label="Trackpad"
        />
        <SurfaceTab now={surface} id="touch" onPick={setSurface} icon={Hand} label="Touch" />
        <button
          onClick={() => {
            releaseEverything();
            void api.control.end();
            onClose();
          }}
          className="ml-auto inline-flex items-center gap-1 text-2xs text-dim hover:text-danger px-2 py-1"
        >
          <X size={13} />
          Disconnect
        </button>
      </div>

      {/*
        Their screen, as an ordinary image.

        A multipart JPEG stream, which an img tag has understood since before
        browsers understood video - no player, no codec, no negotiation. It is
        not good video and is not trying to be: ten frames a second of a
        scaled desktop is enough to find a window and press a button, and
        anything smoother would mean negotiating a peer connection, which
        means the operating system's share picker, which needs somebody
        standing at the machine nobody is standing at.
      */}
      {(video || screen) && (
        <Screen
          src={screen}
          video={video}
          push={push}
          held={held.current}
          pointing={surface === 'touch'}
        />
      )}

      {/*
        Only for the still frames. On the video path the encoder decides, and
        offering a number that changes nothing is worse than offering none.
      */}
      {screen && !video && (
        <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 border-t border-edge">
          <span className="text-[10px] text-muted mr-1">Frames a second</span>
          {[5, 10, 15, 30].map((rate) => (
            <button
              key={rate}
              onClick={() => {
                setFps(rate);
                setScreen((was) => (was ? was.replace(/&fps=\d+/, `&fps=${rate}`) : was));
              }}
              className={cn(
                'px-2 py-0.5 rounded-input text-[10px]',
                fps === rate ? 'bg-gold/20 text-gold' : 'text-dim hover:text-txt',
              )}
            >
              {rate}
            </button>
          ))}
          <span className="ml-auto text-[10px] text-muted">
            waiting for video&hellip;
          </span>
        </div>
      )}

      <div className={cn('min-h-0', screen ? 'shrink-0' : 'flex-1')}>
        {surface === 'pad' && <Pad held={held.current} push={push} />}
        {surface === 'trackpad' && <Trackpad push={push} held={held.current} />}
        {surface === 'touch' && !screen && <TouchPad push={push} held={held.current} />}
      </div>
    </div>
  );
}

function SurfaceTab({
  now,
  id,
  onPick,
  icon: Icon,
  label,
}: {
  now: Surface;
  id: Surface;
  onPick: (s: Surface) => void;
  icon: React.ElementType;
  label: string;
}) {
  return (
    <button
      onClick={() => onPick(id)}
      className={cn(
        'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-input text-2xs font-medium',
        now === id ? 'bg-gold/15 text-gold' : 'text-dim hover:text-txt',
      )}
    >
      <Icon size={14} />
      {label}
    </button>
  );
}

/* -------------------------------------------------------------------- pad */

const PAD_LAYOUT: { id: PadButton; label: string; className: string }[] = [
  { id: 'up', label: '▲', className: 'col-start-2 row-start-1' },
  { id: 'left', label: '◀', className: 'col-start-1 row-start-2' },
  { id: 'down', label: '▼', className: 'col-start-2 row-start-3' },
  { id: 'right', label: '▶', className: 'col-start-3 row-start-2' },
];

/**
 * A directional pad and four buttons.
 *
 * Press and release are separate events rather than a click, because holding
 * a direction is the whole of how you move in most things. That is also the
 * one that can go wrong: a press whose release never arrives leaves the far
 * end walking into a wall for ever, so every handler that starts a press has
 * a matching one on pointer-up, pointer-cancel and pointer-leave.
 */
function Pad({ held, push }: { held: Held; push: (...e: (RemoteEvent | null)[]) => void }) {
  const hold = (button: PadButton, down: boolean) => push(held.key(PAD_KEYS[button], down));

  const bind = (button: PadButton) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      // The press first. Nothing after it may prevent it happening.
      hold(button, true);
      keepGesture(e);
    },
    onPointerUp: () => hold(button, false),
    onPointerCancel: () => hold(button, false),
    onPointerLeave: () => hold(button, false),
  });

  return (
    <div className="h-full flex items-center justify-between gap-6 px-6 select-none touch-none">
      <div className="grid grid-cols-3 grid-rows-3 gap-1.5">
        {PAD_LAYOUT.map((key) => (
          <button
            key={key.id}
            {...bind(key.id)}
            className={cn(
              key.className,
              'h-14 w-14 rounded-card bg-raised border border-edge text-txt text-lg',
              'active:bg-gold/25 active:border-gold/50',
            )}
            aria-label={key.id}
          >
            {key.label}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2.5">
        {(['y', 'b', 'x', 'a'] as PadButton[]).map((button) => (
          <button
            key={button}
            {...bind(button)}
            className="h-14 w-14 rounded-pill bg-raised border border-edge text-txt text-sm font-semibold uppercase active:bg-gold/25 active:border-gold/50"
          >
            {button}
          </button>
        ))}
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- trackpad */

/** Pushing a pointer about, the way a laptop's trackpad does. */
function Trackpad({
  push,
  held,
}: {
  push: (...e: (RemoteEvent | null)[]) => void;
  held: Held;
}) {
  const pointer = React.useRef(new Pointer());
  const start = React.useRef<Touch | null>(null);
  const last = React.useRef<{ x: number; y: number } | null>(null);

  return (
    <div className="h-full flex flex-col">
      <div
        className="flex-1 m-3 rounded-card border border-dashed border-edge-strong bg-surface touch-none select-none grid place-items-center text-2xs text-muted"
        onPointerDown={(e) => {
          pointer.current.reset();
          start.current = { x: e.clientX, y: e.clientY, at: Date.now() };
          last.current = { x: e.clientX, y: e.clientY };
          keepGesture(e);
        }}
        onPointerMove={(e) => {
          if (!last.current) return;
          push(pointer.current.move(e.clientX - last.current.x, e.clientY - last.current.y));
          last.current = { x: e.clientX, y: e.clientY };
        }}
        onPointerUp={(e) => {
          const began = start.current;
          start.current = null;
          last.current = null;
          if (began && isTap(began, { x: e.clientX, y: e.clientY, at: Date.now() })) {
            push(...clickEvents('left'));
          }
        }}
        onPointerCancel={() => {
          start.current = null;
          last.current = null;
        }}
      >
        Drag to move · tap to click
      </div>
      <ClickRow push={push} held={held} />
    </div>
  );
}

/* ------------------------------------------------------------ touchscreen */

/**
 * Pointing at the thing rather than pushing a pointer to it.
 *
 * The surface stands for the whole of the far screen, so a tap two thirds of
 * the way across lands two thirds of the way across over there. It needs no
 * picture to be useful — the far screen is usually the one you are looking at
 * — but it is what the shared picture is laid over when there is one.
 */
function TouchPad({
  push,
  held,
}: {
  push: (...e: (RemoteEvent | null)[]) => void;
  held: Held;
}) {
  const surface = React.useRef<HTMLDivElement>(null);

  const pointAt = (e: React.PointerEvent) => {
    const box = surface.current?.getBoundingClientRect();
    if (!box) return null;
    return touchPoint({ x: e.clientX, y: e.clientY }, box);
  };

  return (
    <div className="h-full flex flex-col">
      <div
        ref={surface}
        className="flex-1 m-3 rounded-card border border-edge-strong bg-surface touch-none select-none grid place-items-center text-2xs text-muted"
        onPointerDown={(e) => {
          // Move first, then press. The other order presses wherever the
          // pointer happened to be, which is not where the finger is.
          push(pointAt(e), held.button('left', true));
          keepGesture(e);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 0) return;
          push(pointAt(e));
        }}
        onPointerUp={() => push(held.button('left', false))}
        onPointerCancel={() => push(held.button('left', false))}
      >
        Tap where you want them to tap
      </div>
      <ClickRow push={push} held={held} />
    </div>
  );
}

/* -------------------------------------------------------------- the extras */

function ClickRow({
  push,
  held,
}: {
  push: (...e: (RemoteEvent | null)[]) => void;
  held: Held;
}) {
  const [text, setText] = React.useState('');

  return (
    <div className="shrink-0 px-3 pb-3 flex items-center gap-2">
      <button
        onClick={() => push(...clickEvents('left'))}
        className="flex-1 h-10 rounded-input bg-raised border border-edge text-2xs active:bg-gold/20"
      >
        Click
      </button>
      <button
        onClick={() => push(...clickEvents('right'))}
        className="flex-1 h-10 rounded-input bg-raised border border-edge text-2xs active:bg-gold/20"
      >
        Right click
      </button>
      <form
        className="flex-[2] flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text) return;
          push({ t: 'x', s: text });
          setText('');
        }}
      >
        <span className="text-dim">
          <Keyboard size={14} />
        </span>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type over there"
          className="min-w-0 flex-1 h-10 rounded-input bg-surface border border-edge px-2 text-2xs"
        />
        <button
          type="button"
          onPointerDown={() => push(held.key('Return', true))}
          onPointerUp={() => push(held.key('Return', false))}
          className="h-10 px-2 rounded-input bg-raised border border-edge text-2xs"
        >
          ⏎
        </button>
      </form>
    </div>
  );
}

/* ------------------------------------------------------------- the picture */

/**
 * Their screen, and tapping on it.
 *
 * A tap lands where you put your finger, which is the only arrangement that
 * makes sense when you can see the thing you are aiming at. The surface is a
 * fraction of the far screen rather than pixels of it, because the two devices
 * do not share a resolution and neither knows the other's.
 *
 * Dragging with a finger down is a drag over there: press, move, release,
 * exactly as it reads. That is also what makes a scrollbar or a window title
 * work without a separate mode for it.
 */
function Screen({
  src,
  video,
  push,
  held,
  pointing,
}: {
  src: string | null;
  video: MediaStream | null;
  push: (...e: (RemoteEvent | null)[]) => void;
  held: Held;
  pointing: boolean;
}) {
  const picture = React.useRef<HTMLImageElement>(null);
  const player = React.useRef<HTMLVideoElement>(null);
  const [broken, setBroken] = React.useState(false);

  React.useEffect(() => {
    if (player.current && video) player.current.srcObject = video;
  }, [video]);

  const pointAt = (e: React.PointerEvent) => {
    // Whichever is actually on screen. The two are never both visible, and
    // measuring the hidden one would put every tap in the wrong place.
    const box = (video ? player.current : picture.current)?.getBoundingClientRect();
    if (!box) return null;
    return touchPoint({ x: e.clientX, y: e.clientY }, box);
  };

  return (
    <div className="relative flex-1 min-h-0 bg-black grid place-items-center overflow-hidden">
      {video && (
        <video
          ref={player}
          autoPlay
          playsInline
          muted
          className="max-h-full max-w-full object-contain touch-none select-none"
          onPointerDown={
            pointing
              ? (e) => {
                  e.preventDefault();
                  push(pointAt(e), held.button('left', true));
                  keepGesture(e);
                }
              : undefined
          }
          onPointerMove={
            pointing
              ? (e) => {
                  if (e.buttons === 0) return;
                  push(pointAt(e));
                }
              : undefined
          }
          onPointerUp={pointing ? () => push(held.button('left', false)) : undefined}
          onPointerCancel={pointing ? () => push(held.button('left', false)) : undefined}
        />
      )}
      <img
        hidden={!!video || !src}
        ref={picture}
        src={src ?? undefined}
        alt="The screen of the device you are controlling"
        className="max-h-full max-w-full object-contain touch-none select-none"
        draggable={false}
        onError={() => setBroken(true)}
        onLoad={() => setBroken(false)}
        // Only when Touch is the chosen surface. With the pad on screen a
        // stray thumb on the picture should not click something over there.
        onPointerDown={
          pointing
            ? (e) => {
                e.preventDefault();
                push(pointAt(e), held.button('left', true));
                keepGesture(e);
              }
            : undefined
        }
        onPointerMove={
          pointing
            ? (e) => {
                if (e.buttons === 0) return;
                push(pointAt(e));
              }
            : undefined
        }
        onPointerUp={pointing ? () => push(held.button('left', false)) : undefined}
        onPointerCancel={pointing ? () => push(held.button('left', false)) : undefined}
      />
      {broken && (
        <div className="absolute inset-0 grid place-items-center bg-base/90 px-6 text-center">
          <p className="text-2xs text-muted leading-relaxed">
            That device stopped sending its screen. It may have ended the session, or it
            may not be a machine that can share one — only Windows can, for now. The pad
            and trackpad still work.
          </p>
        </div>
      )}
    </div>
  );
}
