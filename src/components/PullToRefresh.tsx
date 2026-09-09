/**
 * Drag down to refresh.
 *
 * On a phone this is the gesture people already have in their hands — they
 * reach for it before they look for a button, and its absence reads as the
 * screen being stuck. LANTern has refresh buttons, but they live in headers
 * that are small under a thumb.
 *
 * Only on touch devices, and only from the top of a scroll area: a mouse has
 * a button to press and stealing the scrollwheel would be worse than nothing.
 */
import React from 'react';
import { Loader2, ArrowDown } from 'lucide-react';

import { cn } from '../lib/utils';

/** How far the finger must travel before letting go refreshes. */
export const TRIGGER_AT = 64;

/** Where the indicator stops being dragged any further. */
const MAX = 96;

/**
 * Converts finger travel into how far the indicator actually moves.
 *
 * Applying the raw distance makes the gesture feel loose and lets the
 * indicator run off the screen. Real pull-to-refresh resists progressively:
 * the first pixels track the finger closely and it stiffens from there, so
 * the control feels attached to something. This is a square-root curve, which
 * gives that shape and has a hard ceiling.
 */
export function pullDistance(travel: number): number {
  if (travel <= 0) return 0;
  const resisted = Math.sqrt(travel * 42);
  return Math.min(MAX, resisted);
}

/** Whether letting go at this distance should refresh. */
export function shouldRefresh(distance: number): boolean {
  return distance >= TRIGGER_AT;
}

export function PullToRefresh({
  onRefresh,
  children,
  className,
}: {
  /** Runs on release. The spinner shows until it settles. */
  onRefresh: () => void | Promise<unknown>;
  children: React.ReactNode;
  className?: string;
}) {
  const scroller = React.useRef<HTMLDivElement>(null);
  const start = React.useRef<number | null>(null);
  const armed = React.useRef(false);

  const [distance, setDistance] = React.useState(0);
  const [refreshing, setRefreshing] = React.useState(false);

  const ready = shouldRefresh(distance);
  // Buzz once as it crosses the threshold, the way the platform ones do, so
  // you know it will fire without watching the screen.
  const buzzed = React.useRef(false);
  React.useEffect(() => {
    if (ready && !buzzed.current) {
      buzzed.current = true;
      navigator.vibrate?.(8);
    } else if (!ready) {
      buzzed.current = false;
    }
  }, [ready]);

  const onTouchStart = (e: React.TouchEvent) => {
    // Only from the very top, and never mid-refresh. Starting the gesture
    // part-way down a list would fight the scroll.
    if (refreshing || (scroller.current?.scrollTop ?? 0) > 0) {
      armed.current = false;
      return;
    }
    armed.current = true;
    start.current = e.touches[0].clientY;
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (!armed.current || start.current === null) return;

    const travel = e.touches[0].clientY - start.current;
    if (travel <= 0) {
      // Scrolling up again: hand the gesture back to the list.
      setDistance(0);
      armed.current = false;
      return;
    }
    setDistance(pullDistance(travel));
  };

  const onTouchEnd = async () => {
    if (!armed.current) return;
    armed.current = false;
    start.current = null;

    if (!shouldRefresh(distance)) {
      setDistance(0);
      return;
    }

    // Hold the indicator at the trigger point while the work happens, rather
    // than snapping back and leaving nothing on screen to explain the wait.
    setRefreshing(true);
    setDistance(TRIGGER_AT);
    try {
      await onRefresh();
    } finally {
      setRefreshing(false);
      setDistance(0);
    }
  };

  return (
    <div className={cn('relative h-full min-h-0 flex flex-col', className)}>
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center"
        style={{
          height: distance,
          opacity: distance > 4 ? 1 : 0,
          transition: distance === 0 ? 'height 180ms ease-out, opacity 180ms' : 'none',
        }}
      >
        <div className="self-end mb-1.5 grid place-items-center h-8 w-8 rounded-full bg-surface border border-edge shadow-lg">
          {refreshing ? (
            <Loader2 size={14} className="text-gold animate-spin" />
          ) : (
            <ArrowDown
              size={14}
              className={cn(
                'transition-transform duration-150',
                ready ? 'text-gold rotate-180' : 'text-muted',
              )}
            />
          )}
        </div>
      </div>

      <div
        ref={scroller}
        className="flex-1 min-h-0 scroll-y"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        style={{
          transform: distance ? `translateY(${distance}px)` : undefined,
          transition: distance === 0 ? 'transform 180ms ease-out' : 'none',
        }}
      >
        {children}
      </div>
    </div>
  );
}
