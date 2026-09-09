import React from 'react';
import type { Color, PieceType } from './chess';

/**
 * Three bundled piece sets and five board themes, all drawn as SVG paths on a
 * shared 45×45 grid so a set can be swapped without touching layout.
 */

export type PieceSetId = 'staunton' | 'geometric' | 'illustrated';

export interface BoardTheme {
  id: string;
  name: string;
  light: string;
  dark: string;
  border: string;
  highlight: string;
  lastMove: string;
  check: string;
  coordLight: string;
  coordDark: string;
}

export const BOARD_THEMES: BoardTheme[] = [
  {
    id: 'oak',
    name: 'Oak Wood',
    light: '#E8D3B0',
    dark: '#A97A4E',
    border: '#6B4A2C',
    highlight: 'rgba(245,166,35,0.55)',
    lastMove: 'rgba(245,166,35,0.30)',
    check: 'rgba(224,92,92,0.55)',
    coordLight: '#8A6238',
    coordDark: '#EFE0C6',
  },
  {
    id: 'slate',
    name: 'Dark Slate',
    light: '#8792A6',
    dark: '#3D4757',
    border: '#252E3F',
    highlight: 'rgba(57,217,200,0.55)',
    lastMove: 'rgba(57,217,200,0.28)',
    check: 'rgba(224,92,92,0.6)',
    coordLight: '#3D4757',
    coordDark: '#C4CCDA',
  },
  {
    id: 'arctic',
    name: 'Arctic Ice',
    light: '#EAF3F8',
    dark: '#9FC2D6',
    border: '#6E93A8',
    highlight: 'rgba(57,140,217,0.5)',
    lastMove: 'rgba(57,140,217,0.26)',
    check: 'rgba(224,92,92,0.5)',
    coordLight: '#6E93A8',
    coordDark: '#F2F8FB',
  },
  {
    id: 'neon',
    name: 'Neon Circuit',
    light: '#141C26',
    dark: '#0A0F16',
    border: '#39D9C8',
    highlight: 'rgba(57,217,200,0.5)',
    lastMove: 'rgba(155,140,255,0.32)',
    check: 'rgba(224,92,92,0.6)',
    coordLight: '#39D9C8',
    coordDark: '#39D9C8',
  },
  {
    id: 'parchment',
    name: 'Parchment',
    light: '#F4EAD5',
    dark: '#C9B08A',
    border: '#8A7355',
    highlight: 'rgba(199,124,8,0.5)',
    lastMove: 'rgba(199,124,8,0.26)',
    check: 'rgba(197,51,51,0.5)',
    coordLight: '#8A7355',
    coordDark: '#F7F1E3',
  },
];

/* ------------------------------------------------------------ Staunton */

const STAUNTON: Record<PieceType, React.ReactNode> = {
  p: (
    <g>
      <circle cx="22.5" cy="13" r="5.2" />
      <path d="M17 19h11l3 12H14Z" />
      <path d="M12 31h21l2 6H10Z" />
    </g>
  ),
  n: (
    <g>
      <path d="M14 37h18c0-8-2-11-4-14 3-3 2-8-2-10-2-1-3-3-3-5l-4 3-5 2c-3 1-5 4-5 7 0 2 1 3 3 3l-2 4c-1 3 2 4 4 3-2 3-2 5-2 7Z" />
      <circle cx="17.5" cy="16" r="1.3" fill="var(--piece-eye)" />
    </g>
  ),
  b: (
    <g>
      <circle cx="22.5" cy="10" r="2.6" />
      <path d="M22.5 12c6 3 8 8 8 12 0 3-2 6-8 6s-8-3-8-6c0-4 2-9 8-12Z" />
      <path d="M14 30h17l2 3H12Z" />
      <path d="M11 34h23l1 3H10Z" />
      <path d="M22.5 16v7M19 19.5h7" stroke="var(--piece-eye)" strokeWidth="1.2" fill="none" />
    </g>
  ),
  r: (
    <g>
      <path d="M11 8h4v3h4V8h5v3h4V8h4v7l-3 3v10l3 4v3H11v-3l3-4V18l-3-3Z" />
      <path d="M9 35h27v3H9Z" />
    </g>
  ),
  q: (
    <g>
      <circle cx="22.5" cy="7.5" r="2.4" />
      <circle cx="11" cy="12" r="2" />
      <circle cx="34" cy="12" r="2" />
      <path d="M11 13l4 13h15l4-13-6 7-5-9-5 9Z" />
      <path d="M14 26h17l2 5H12Z" />
      <path d="M10 32h25l1 5H9Z" />
    </g>
  ),
  k: (
    <g>
      <path d="M22.5 5v7M19 8h7" stroke="var(--piece-outline)" strokeWidth="2.2" fill="none" />
      <path d="M22.5 13c5 0 9 4 9 8 0 3-2 5-4 7h-10c-2-2-4-4-4-7 0-4 4-8 9-8Z" />
      <path d="M13 29h19l2 4H11Z" />
      <path d="M10 34h25l1 4H9Z" />
    </g>
  ),
};

/* ----------------------------------------------------------- Geometric */

const GEOMETRIC: Record<PieceType, React.ReactNode> = {
  p: <circle cx="22.5" cy="24" r="8" />,
  n: <path d="M22.5 10l11 19h-22Z" />,
  b: <path d="M22.5 10l10 14-10 14-10-14Z" />,
  r: <rect x="12" y="13" width="21" height="21" rx="2" />,
  q: (
    <g>
      <circle cx="22.5" cy="22" r="9" />
      <circle cx="22.5" cy="22" r="4" fill="var(--piece-eye)" />
    </g>
  ),
  k: (
    <g>
      <rect x="13" y="13" width="19" height="19" rx="2" />
      <path d="M22.5 16v13M16 22.5h13" stroke="var(--piece-eye)" strokeWidth="3" fill="none" />
    </g>
  ),
};

/* --------------------------------------------------------- Illustrated */

const ILLUSTRATED: Record<PieceType, React.ReactNode> = {
  p: (
    <g>
      <path
        d="M22.5 9c3.4 0 6 2.6 6 5.8 0 2-1 3.7-2.6 4.8 3 1.6 5 4.6 5.4 8.4l.4 4H13.3l.4-4c.4-3.8 2.4-6.8 5.4-8.4A5.8 5.8 0 0 1 16.5 15c0-3.2 2.6-6 6-6Z"
        strokeLinejoin="round"
      />
      <path d="M12 32.5h21l1.5 4.5h-24Z" strokeLinejoin="round" />
    </g>
  ),
  n: (
    <g>
      <path
        d="M15 37c-.5-6 1-9.5 3.5-12.5-3 .5-5 2-6.5 4-1-4 .5-8 4-10.5.5-2 1.5-3.5 3-4.5l1.5 2.5 3.5-3c5 1.5 8 6.5 8.5 12 .4 4.6.4 8.6.5 12Z"
        strokeLinejoin="round"
      />
      <circle cx="17.8" cy="15.5" r="1.4" fill="var(--piece-eye)" stroke="none" />
      <path d="M20 20c2 1 4 1 6 0" stroke="var(--piece-eye)" strokeWidth="1" fill="none" />
    </g>
  ),
  b: (
    <g>
      <circle cx="22.5" cy="9.5" r="2.6" />
      <path
        d="M22.5 12.5c5.5 3 8.5 7.5 8.5 12 0 3.6-3.4 6-8.5 6s-8.5-2.4-8.5-6c0-4.5 3-9 8.5-12Z"
        strokeLinejoin="round"
      />
      <path d="M19 21h7M22.5 17.5v7" stroke="var(--piece-eye)" strokeWidth="1.3" fill="none" />
      <path d="M12 31.5h21l1.5 5.5h-24Z" strokeLinejoin="round" />
    </g>
  ),
  r: (
    <g>
      <path
        d="M11 8.5h5v3.5h4.5V8.5h4V12H29V8.5h5v8l-3.5 3.5v10L34 34v3H11v-3l3.5-3.5v-10L11 16.5Z"
        strokeLinejoin="round"
      />
      <path d="M16 20h13v9H16Z" fill="var(--piece-eye)" stroke="none" opacity="0.25" />
    </g>
  ),
  q: (
    <g>
      <circle cx="22.5" cy="7" r="2.3" />
      <circle cx="10.5" cy="12.5" r="2" />
      <circle cx="34.5" cy="12.5" r="2" />
      <circle cx="16" cy="9" r="1.7" />
      <circle cx="29" cy="9" r="1.7" />
      <path
        d="M10.5 14.5 15 27h15l4.5-12.5-6.5 7.5-2.5-11-3 11-6.5-7.5Z"
        strokeLinejoin="round"
      />
      <path d="M13.5 28.5h18l2 5h-22Z" strokeLinejoin="round" />
    </g>
  ),
  k: (
    <g>
      <path d="M22.5 4.5v8M18.5 8h8" stroke="var(--piece-outline)" strokeWidth="2.4" fill="none" />
      <path
        d="M22.5 13c6 0 10 4.4 10 9 0 3.4-2.4 5.8-5 7.5h-10c-2.6-1.7-5-4.1-5-7.5 0-4.6 4-9 10-9Z"
        strokeLinejoin="round"
      />
      <path
        d="M17 22c2-3 9-3 11 0"
        stroke="var(--piece-eye)"
        strokeWidth="1.2"
        fill="none"
      />
      <path d="M12 31h21l2 6H10Z" strokeLinejoin="round" />
    </g>
  ),
};

const SETS: Record<PieceSetId, Record<PieceType, React.ReactNode>> = {
  staunton: STAUNTON,
  geometric: GEOMETRIC,
  illustrated: ILLUSTRATED,
};

export const PIECE_SET_NAMES: { id: PieceSetId; name: string }[] = [
  { id: 'staunton', name: 'Staunton Classic' },
  { id: 'geometric', name: 'Minimal Geometric' },
  { id: 'illustrated', name: 'Illustrated' },
];

export function ChessPiece({
  type,
  color,
  set = 'staunton',
  size = 45,
}: {
  type: PieceType;
  color: Color;
  set?: PieceSetId;
  /** A number is pixels; pass "100%" to fill the parent square. */
  size?: number | string;
}) {
  const white = color === 'w';
  const fill = white ? '#F5F1E8' : '#22262E';
  const outline = white ? '#2B2F38' : '#0A0C10';
  const eye = white ? '#2B2F38' : '#F5F1E8';

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 45 45"
      style={
        {
          '--piece-outline': outline,
          '--piece-eye': eye,
          filter: 'drop-shadow(0 1px 1.5px rgba(0,0,0,0.35))',
        } as React.CSSProperties
      }
      aria-label={`${white ? 'White' : 'Black'} ${type}`}
    >
      <g fill={fill} stroke={outline} strokeWidth="1.4" strokeLinecap="round">
        {SETS[set][type]}
      </g>
    </svg>
  );
}
