/**
 * Pinch, wheel and drag zooming for a video tile.
 *
 * A shared screen is the case that needs it: someone shares a 4K display, it
 * arrives scaled into a tile a few hundred pixels wide, and the text on it is
 * unreadable. Cropping to fill would make matters worse — the interesting
 * corner is exactly what gets cut. So the picture is fitted whole by default
 * and this provides a way in: scroll or pinch to magnify, drag to move around,
 * double-tap or Reset to come back.
 *
 * The transform is applied to a wrapper rather than the video element, so the
 * video keeps decoding at its own size and the browser composites the zoom on
 * the GPU. Nothing is re-encoded and no extra bandwidth is used — this is a
 * magnifying glass held over the picture already arriving.
 */
import React from 'react';
import { Minus, Plus, RotateCcw } from 'lucide-react';

import { cn } from '../../lib/utils';

const MIN = 1;
const MAX = 6;

/** Keeps a pan within the bounds of the magnified picture. */
export function clampPan(
  offset: { x: number; y: number },
  scale: number,
  box: { width: number; height: number },
): { x: number; y: number } {
  // At scale 1 the picture exactly fits, so there is nothing to pan. Beyond
  // that, half the overflow is available in each direction.
  const maxX = (box.width * (scale - 1)) / 2;
  const maxY = (box.height * (scale - 1)) / 2;
  return {
    x: Math.max(-maxX, Math.min(maxX, offset.x)),
    y: Math.max(-maxY, Math.min(maxY, offset.y)),
  };
}

export function Zoomable({
  children,
  className,
  /** Shows the zoom buttons. Off for small tiles, where they would cover the face. */
  controls = true,
}: {
  children: React.ReactNode;
  className?: string;
  controls?: boolean;
}) {
  const boxRef = React.useRef<HTMLDivElement>(null);
  const [scale, setScale] = React.useState(1);
  const [offset, setOffset] = React.useState({ x: 0, y: 0 });

  const drag = React.useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const pinch = React.useRef<{ distance: number; scale: number } | null>(null);

  const box = () => {
    const rect = boxRef.current?.getBoundingClientRect();
    return { width: rect?.width ?? 0, height: rect?.height ?? 0 };
  };

  const zoomTo = React.useCallback((next: number) => {
    const clamped = Math.max(MIN, Math.min(MAX, next));
    setScale(clamped);
    // Coming back to 1 must land square, or the picture sits off-centre with
    // no way to tell why.
    setOffset((o) => (clamped === 1 ? { x: 0, y: 0 } : o));
  }, []);

  const reset = () => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
  };

  React.useEffect(() => {
    setOffset((o) => clampPan(o, scale, box()));
  }, [scale]);

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && Math.abs(e.deltaY) < 2) return;
    e.preventDefault();
    zoomTo(scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (scale === 1) return;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    drag.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const start = drag.current;
    if (!start) return;
    setOffset(
      clampPan(
        { x: start.ox + (e.clientX - start.x), y: start.oy + (e.clientY - start.y) },
        scale,
        box(),
      ),
    );
  };

  const onPointerUp = () => {
    drag.current = null;
  };

  // Two fingers: the gesture everyone reaches for on a phone or a trackpad.
  const onTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length !== 2) return;
    const [a, b] = [e.touches[0], e.touches[1]];
    pinch.current = {
      distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY),
      scale,
    };
  };

  const onTouchMove = (e: React.TouchEvent) => {
    const start = pinch.current;
    if (!start || e.touches.length !== 2) return;
    const [a, b] = [e.touches[0], e.touches[1]];
    const distance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    zoomTo(start.scale * (distance / start.distance));
  };

  const onTouchEnd = () => {
    pinch.current = null;
  };

  return (
    <div
      ref={boxRef}
      className={cn('relative overflow-hidden', className)}
      onWheel={onWheel}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
      onDoubleClick={() => (scale === 1 ? zoomTo(2) : reset())}
    >
      <div
        className="h-full w-full"
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          // No transition while dragging or pinching, or the picture lags the
          // finger; the buttons below step in increments where it reads well.
          transition: drag.current || pinch.current ? 'none' : 'transform 120ms ease-out',
          cursor: scale > 1 ? (drag.current ? 'grabbing' : 'grab') : undefined,
        }}
      >
        {children}
      </div>

      {controls && (
        <div
          className={cn(
            'absolute bottom-2 right-2 flex items-center gap-1 rounded-input',
            'bg-black/55 backdrop-blur px-1 py-1 transition-opacity',
            scale === 1 && 'opacity-0 hover:opacity-100 focus-within:opacity-100',
          )}
        >
          <button
            aria-label="Zoom out"
            className="h-7 w-7 grid place-items-center rounded text-white/90 hover:bg-white/15 disabled:opacity-35"
            onClick={() => zoomTo(scale / 1.4)}
            disabled={scale <= MIN}
          >
            <Minus size={13} />
          </button>
          <span className="text-[10px] font-mono text-white/80 w-9 text-center tabular-nums">
            {scale.toFixed(1)}x
          </span>
          <button
            aria-label="Zoom in"
            className="h-7 w-7 grid place-items-center rounded text-white/90 hover:bg-white/15 disabled:opacity-35"
            onClick={() => zoomTo(scale * 1.4)}
            disabled={scale >= MAX}
          >
            <Plus size={13} />
          </button>
          <button
            aria-label="Reset zoom"
            className="h-7 w-7 grid place-items-center rounded text-white/90 hover:bg-white/15 disabled:opacity-35"
            onClick={reset}
            disabled={scale === 1}
          >
            <RotateCcw size={12} />
          </button>
        </div>
      )}
    </div>
  );
}
