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
    [0, -55, 44],
    [-92, 125, 40],
    [92, 125, 40],
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

      {/*
        The mark from assets/brand/lantern-master-1024.svg (made in Claude Design),
        drawn in its own 1024 units and scaled into this 512 box: a tapered lantern
        with a handle, a cap and a base, and the network suspended inside it.
      */}
      <g
        transform="translate(256 256) scale(0.475)"
        fill="none"
        stroke="rgb(var(--c-gold))"
        strokeWidth="48"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path
          d="M -116,-200 H 116 Q 160,-200 163.9,-156.2 L 196.1,206.2 Q 200,250 156,250 H -156 Q -200,250 -196.1,206.2 L -163.9,-156.2 Q -160,-200 -116,-200 Z"
          fill="rgb(var(--c-gold))"
          fillOpacity="0.14"
        />
        <path d="M0,-300 V-252 M-92,-252 H92 M-120,300 H120" />
        <path d="M0,-55 L-92,125 L92,125 Z" strokeWidth="26" />
        <g stroke="none">
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
    sm: { icon: 18, text: 'text-[15px]' },
    md: { icon: 24, text: 'text-[18px]' },
    lg: { icon: 36, text: 'text-[26px]' },
  }[size];

  return (
    <div className={cn('flex items-center gap-2 select-none', className)}>
      <LanternMark size={dims.icon} pulse={pulse} />
      <span className={cn(dims.text, 'font-brand tracking-[-0.035em] leading-none')}>
        <span className="font-extrabold text-gold">LAN</span>
        <span className="font-medium text-txt">tern</span>
      </span>
    </div>
  );
}
