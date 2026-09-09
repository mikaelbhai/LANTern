import React from 'react';
import { cn } from '../lib/utils';

/**
 * The LANTern mark: a lantern drawn as one continuous outline, with a small
 * network of nodes suspended inside it.
 *
 * Colours come from the theme's CSS variables rather than fixed hex, so the
 * mark follows the accent colour a user picks. The halo and node pulse are the
 * only motion, and both are opt-in.
 */
export function LanternMark({
  size = 24,
  className,
  pulse = false,
  interactive = true,
}: {
  size?: number;
  className?: string;
  pulse?: boolean;
  interactive?: boolean;
}) {
  // Node order matters: the apex lights first, then the two feet.
  const nodes: Array<[number, number, number]> = [
    [256, 222, 18],
    [210, 306, 15],
    [302, 306, 15],
  ];

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      className={cn('group shrink-0', className)}
      aria-hidden
    >
      <defs>
        <radialGradient id="lt-halo" cx="256" cy="290" r="190" gradientUnits="userSpaceOnUse">
          <stop stopColor="rgb(var(--c-gold))" stopOpacity="0.45" />
          <stop offset="1" stopColor="rgb(var(--c-gold))" stopOpacity="0" />
        </radialGradient>
      </defs>

      <circle
        cx="256"
        cy="290"
        r="190"
        fill="url(#lt-halo)"
        className={cn(
          'transition-opacity duration-500',
          pulse ? 'opacity-100' : 'opacity-0',
          interactive && 'group-hover:opacity-100',
        )}
      />

      <g
        transform="translate(0 4)"
        fill="none"
        stroke="rgb(var(--c-gold))"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* The lantern body: a single unbroken path, domed at the top. */}
        <path
          d="M192 152 L160 204 L160 340 L192 392 L320 392 L352 340 L352 204 L320 152 A72 72 0 0 0 192 152 Z"
          strokeWidth="30"
        />

        {/* The network inside — the reason it is a lantern and not a lamp. */}
        <path d="M256 222 L210 306 L302 306 Z M256 222 L302 306" strokeWidth="8" />

        {/* Nodes are knocked out of the links with a background-coloured ring. */}
        <g stroke="rgb(var(--c-base))" strokeWidth="9">
          {nodes.map(([cx, cy, r], i) => (
            <circle
              key={i}
              cx={cx}
              cy={cy}
              r={r}
              fill={i === 0 ? 'rgb(var(--c-glow))' : 'rgb(var(--c-gold))'}
              className={cn(
                interactive && 'group-hover:animate-pane-glow',
                pulse && 'animate-pane-glow',
              )}
              style={{ animationDelay: `${i * 200}ms` }}
            />
          ))}
        </g>
      </g>
    </svg>
  );
}

export function Wordmark({
  size = 'md',
  className,
  pulse,
}: {
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  pulse?: boolean;
}) {
  const dims = {
    sm: { icon: 18, text: 'text-sm' },
    md: { icon: 22, text: 'text-base' },
    lg: { icon: 34, text: 'text-xl' },
  }[size];

  return (
    <div className={cn('flex items-center gap-2 select-none', className)}>
      <LanternMark size={dims.icon} pulse={pulse} />
      <span className={cn(dims.text, 'tracking-tight leading-none')}>
        <span className="font-bold text-gold">LAN</span>
        <span className="font-normal text-txt">tern</span>
      </span>
    </div>
  );
}
