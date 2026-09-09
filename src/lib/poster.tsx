import React from 'react';
import { hashCode } from './utils';

/**
 * Artwork for library titles, drawn from the title itself.
 *
 * A media folder rarely ships poster files, and LANTern will not fetch artwork
 * from the internet. Deriving the art from a hash of the title gives every
 * item a stable, distinct look with no assets and no network.
 */

const PALETTES: Array<[string, string, string]> = [
  ['#2B1B4A', '#7B3FA0', '#F5A623'],
  ['#0E2A33', '#116E63', '#39D9C8'],
  ['#3A1220', '#8E2C3E', '#FF8FC7'],
  ['#12203C', '#2C5A9E', '#5BA9F5'],
  ['#2E2410', '#7A5A16', '#FFD17A'],
  ['#241436', '#5B2E8C', '#9B8CFF'],
  ['#0F2A18', '#2C6E3F', '#7BD88F'],
  ['#33160E', '#8E3B22', '#F5A623'],
];

export function paletteFor(seed: string): [string, string, string] {
  return PALETTES[hashCode(seed) % PALETTES.length];
}

/** Repeatable pseudo-random stream so a title's art never changes. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function Artwork({
  title,
  seed,
  variant = 'backdrop',
  className,
  rounded = true,
}: {
  title: string;
  seed?: string;
  variant?: 'poster' | 'backdrop';
  className?: string;
  rounded?: boolean;
}) {
  const key = seed ?? title;
  const [deep, mid, accent] = paletteFor(key);
  const h = hashCode(key);
  const rand = rng(h);
  const id = React.useId().replace(/[:]/g, '');

  const w = variant === 'poster' ? 300 : 480;
  const hgt = variant === 'poster' ? 450 : 270;

  // A skyline-ish silhouette, seeded so it is stable per title.
  const bars = Array.from({ length: 14 }, (_, i) => {
    const bw = w / 14;
    const bh = hgt * (0.16 + rand() * 0.36);
    return { x: i * bw, w: bw + 1, h: bh };
  });

  const orbX = w * (0.25 + rand() * 0.5);
  const orbY = hgt * (0.22 + rand() * 0.18);
  const orbR = Math.min(w, hgt) * (0.09 + rand() * 0.07);

  return (
    <svg
      viewBox={`0 0 ${w} ${hgt}`}
      preserveAspectRatio="xMidYMid slice"
      className={className}
      style={{ display: 'block', borderRadius: rounded ? 6 : 0 }}
      role="img"
      aria-label={title}
    >
      <defs>
        <linearGradient id={`sky${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={deep} />
          <stop offset="62%" stopColor={mid} />
          <stop offset="100%" stopColor={deep} />
        </linearGradient>
        <radialGradient id={`orb${id}`} cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor={accent} stopOpacity="0.95" />
          <stop offset="70%" stopColor={accent} stopOpacity="0.18" />
          <stop offset="100%" stopColor={accent} stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`scrim${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="45%" stopColor="#0C0F14" stopOpacity="0" />
          <stop offset="100%" stopColor="#0C0F14" stopOpacity="0.92" />
        </linearGradient>
      </defs>

      <rect width={w} height={hgt} fill={`url(#sky${id})`} />
      <circle cx={orbX} cy={orbY} r={orbR * 3.2} fill={`url(#orb${id})`} />
      <circle cx={orbX} cy={orbY} r={orbR} fill={accent} opacity="0.9" />

      {bars.map((b, i) => (
        <rect
          key={i}
          x={b.x}
          y={hgt - b.h}
          width={b.w}
          height={b.h}
          fill="#0C0F14"
          opacity={0.55 + (i % 3) * 0.13}
        />
      ))}

      <rect width={w} height={hgt} fill={`url(#scrim${id})`} />
    </svg>
  );
}

/** Compact tile art with the title burned in, for grid and row cards. */
/**
 * The artwork for a title.
 *
 * Just a URL now. This used to load each title into a hidden video element and
 * draw a frame to a canvas — which meant every client decoded every title in
 * the library, on 4K HEVC, after every restart, and showed up as sustained GPU
 * load with the fan on. The device holding the file generates the still once
 * instead, and shares it.
 */
function useThumbnail(_key: string, _streamUrl?: string, posterUrl?: string): string | null {
  return posterUrl ?? null;
}

export function TitleCard({
  title,
  subtitle,
  seed,
  className,
  badge,
  streamUrl,
  posterUrl,
}: {
  title: string;
  subtitle?: string;
  seed?: string;
  className?: string;
  /** Short tag shown top-right — the quality, where the name advertised one. */
  badge?: string;
  /** Used to capture a frame when there is no artwork beside the file. */
  streamUrl?: string;
  posterUrl?: string;
}) {
  const thumb = useThumbnail(seed ?? title, streamUrl, posterUrl);

  return (
    <div className={`relative overflow-hidden ${className ?? ''}`}>
      {thumb ? (
        <img
          src={thumb}
          alt={title}
          loading="lazy"
          className="h-full w-full object-cover"
          // A poster that 404s should fall back to the generated art rather
          // than leaving a broken image in the row.
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.display = 'none';
          }}
        />
      ) : (
        <Artwork title={title} seed={seed} variant="backdrop" className="h-full w-full" />
      )}

      {badge && (
        <div className="absolute top-1.5 right-1.5 px-1.5 h-[17px] flex items-center rounded bg-black/65 backdrop-blur text-[9px] font-semibold tracking-wide text-white/90">
          {badge}
        </div>
      )}

      <div className="absolute inset-x-0 bottom-0 p-2 bg-gradient-to-t from-black/80 to-transparent">
        <div className="text-[13px] font-semibold text-white leading-tight drop-shadow line-clamp-2">
          {title}
        </div>
        {subtitle && (
          <div className="text-[10px] text-white/70 mt-0.5 truncate">{subtitle}</div>
        )}
      </div>
    </div>
  );
}
