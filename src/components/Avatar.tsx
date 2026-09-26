import React from 'react';
import { cn } from '../lib/utils';
import type { PeerStatus } from '../lib/types';

const STATUS_COLOR: Record<PeerStatus, string> = {
  available: 'rgb(var(--c-cyan))',
  busy: 'rgb(var(--c-gold))',
  'in-game': '#9B8CFF',
  dnd: 'rgb(var(--c-muted))',
  offline: 'rgb(var(--c-muted))',
};

export function Avatar({
  name,
  color = '#F5A623',
  emoji,
  size = 32,
  status,
  speaking,
  className,
  ring,
  src,
  icon,
  muted,
}: {
  name: string;
  color?: string;
  emoji?: string;
  size?: number;
  status?: PeerStatus;
  speaking?: boolean;
  className?: string;
  ring?: boolean;
  /** A profile picture. Falls back to the emoji or initial when absent. */
  src?: string | null;
  /** A glyph instead of initials, for things that are not people. */
  icon?: React.ReactNode;
  /** Neutral fill: asleep, or a row that stands for nobody in particular. */
  muted?: boolean;
}) {
  const fontSize = Math.round(size * 0.38);
  // A solid disc with the fill carrying the colour, not a tinted outline
  // around coloured text. The old translucent version put the name's colour
  // on a near-transparent background, which is the one place in the
  // interface where a user-chosen colour had to pass contrast on its own -
  // and half of them did not.
  const fill = muted ? 'rgb(var(--c-raised))' : color;
  const ink = muted ? 'rgb(var(--c-muted))' : '#fff';
  // A picture that fails to load is the normal case for a peer that has none,
  // or one that has gone away mid-render. Fall back rather than show a broken
  // image in a circle.
  const [broken, setBroken] = React.useState(false);
  React.useEffect(() => setBroken(false), [src]);
  const showImage = !!src && !broken;

  return (
    <span className={cn('relative inline-flex shrink-0', className)} style={{ width: size, height: size }}>
      {speaking && (
        <span
          className="absolute inset-0 rounded-full animate-ring-out"
          style={{ boxShadow: `0 0 0 2px ${color}` }}
        />
      )}
      <span
        className={cn(
          'grid place-items-center rounded-full overflow-hidden font-semibold leading-none',
          ring && 'ring-2 ring-gold/70',
        )}
        style={{
          width: size,
          height: size,
          fontSize,
          background: fill,
          border: muted ? '1px solid rgb(var(--c-edge))' : 'none',
          color: ink,
        }}
        title={name}
      >
        {showImage ? (
          <img
            src={src ?? undefined}
            alt={name}
            width={size}
            height={size}
            className="h-full w-full object-cover"
            onError={() => setBroken(true)}
          />
        ) : (
          (icon || emoji || initials(name))
        )}
      </span>
      {status && (
        <span
          className="absolute -bottom-0.5 -right-0.5 rounded-full border-2"
          style={{
            width: Math.max(8, size * 0.3),
            height: Math.max(8, size * 0.3),
            background: STATUS_COLOR[status],
            borderColor: 'rgb(var(--c-surface))',
          }}
        />
      )}
    </span>
  );
}

/**
 * Up to two letters, from the first two words.
 *
 * One letter is ambiguous the moment two people in a house share it, which
 * on a home network is most houses.
 */
function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const first = words[0][0] ?? '';
  const second = words.length > 1 ? (words[1][0] ?? '') : (words[0][1] ?? '');
  return (first + second).toUpperCase();
}
