/**
 * The pixel deck, drawn rather than downloaded.
 *
 * Fifty-two card faces as a sprite sheet would be a binary asset in the
 * bundle, at one fixed resolution, that has to be sliced by index and looks
 * soft the moment a card is drawn larger than it was cut. Every glyph here is
 * a bitmap in a string instead: the whole deck is a few hundred bytes of text,
 * it gzips to almost nothing, and it is sharp at any size because it comes out
 * as rectangles rather than pixels.
 *
 * Bitmaps, not vector letterforms, because a rounded outline scaled down to
 * fourteen pixels stops being pixel art and starts being a blurry serif. A
 * grid of squares is the whole point of the style, and the only way to keep it
 * is to actually have a grid.
 */
import React from 'react';

import { SUITS, isRed, rankLabel } from './cards';
import type { Card, Rank, Suit } from './cards';

/**
 * Ranks on a five-by-seven grid.
 *
 * Small enough to stay legible when a card is an inch tall, and the same
 * proportions as the character cells on the machines this look comes from.
 */
const GLYPHS: Record<string, string[]> = {
  A: ['01110', '10001', '10001', '11111', '10001', '10001', '10001'],
  '0': ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  '1': ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  '2': ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  '3': ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  '4': ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  '5': ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  '6': ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  '7': ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  '8': ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  '9': ['01110', '10001', '10001', '01111', '00001', '00010', '01100'],
  J: ['00111', '00010', '00010', '00010', '00010', '10010', '01100'],
  Q: ['01110', '10001', '10001', '10001', '10101', '10010', '01101'],
  K: ['10001', '10010', '10100', '11000', '10100', '10010', '10001'],
};

/** The four suits on a seven-by-eight grid, stem included. */
const PIPS: Record<Suit, string[]> = {
  s: [
    '0001000',
    '0011100',
    '0111110',
    '1111111',
    '1111111',
    '1111111',
    '0011100',
    '0111110',
  ],
  h: [
    '0110110',
    '1111111',
    '1111111',
    '1111111',
    '0111110',
    '0111110',
    '0011100',
    '0001000',
  ],
  d: [
    '0001000',
    '0011100',
    '0111110',
    '1111111',
    '1111111',
    '0111110',
    '0011100',
    '0001000',
  ],
  c: [
    '0011100',
    '0111110',
    '0011100',
    '1101011',
    '1111111',
    '1111111',
    '0011100',
    '0111110',
  ],
};

/** A crown for the queen and king, a blade for the jack. */
const COURT: Record<number, string[]> = {
  11: ['00001', '00010', '00100', '01000', '10100', '11000', '10000'],
  12: ['10101', '11111', '11111', '01110', '00000', '11111', '00000'],
  13: ['10101', '11111', '11111', '01110', '00000', '11111', '00000'],
};

/**
 * One filled cell per square, as a single path.
 *
 * A path rather than a rect each: a hand of thirteen cards is thirteen court
 * emblems, thirteen pips and up to twenty-six rank glyphs, and every one of
 * those as its own element adds up to a few thousand nodes for a picture of a
 * card game.
 */
function bitmapPath(rows: string[]): string {
  let d = '';
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      if (row[x] === '1') d += `M${x} ${y}h1v1h-1z`;
    }
  });
  return d;
}

/** Built once: the same fourteen glyphs are drawn over and over. */
const GLYPH_PATHS: Record<string, string> = Object.fromEntries(
  Object.entries(GLYPHS).map(([k, v]) => [k, bitmapPath(v)]),
);
const PIP_PATHS: Record<Suit, string> = Object.fromEntries(
  SUITS.map((s) => [s, bitmapPath(PIPS[s])]),
) as Record<Suit, string>;
const COURT_PATHS: Record<number, string> = Object.fromEntries(
  Object.entries(COURT).map(([k, v]) => [Number(k), bitmapPath(v)]),
);

export const PIXEL_FACE = '#F0EBE0';
export const PIXEL_EDGE = '#A9BCC8';
export const PIXEL_EDGE_IN = '#7E96A6';
export const PIXEL_NAVY = '#282C4C';
export const PIXEL_RED = '#C7315A';

/** A whole face, on a grid twenty-two cells wide. */
const W = 22;
const H = 32;

export function PixelFace({
  card,
  width = 62,
  className,
  style,
}: {
  card: Card;
  width?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const ink = isRed(card.suit) ? PIXEL_RED : PIXEL_NAVY;
  const label = rankLabel(card.rank);
  const court = COURT_PATHS[card.rank];

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={width}
      height={Math.round(width * (H / W))}
      className={className}
      style={{ display: 'block', imageRendering: 'pixelated', ...style }}
      shapeRendering="crispEdges"
    >
      {/* The double border the printed pixel decks use: a light outer rule and
          a darker one just inside it. */}
      <path d={frame(0, 0, W, H)} fill={PIXEL_EDGE} />
      <path d={frame(1, 1, W - 2, H - 2)} fill={PIXEL_EDGE_IN} />
      <rect x={2} y={2} width={W - 4} height={H - 4} fill={PIXEL_FACE} />

      {/* Suit, top left. */}
      <g transform="translate(3 3) scale(0.72)" fill={ink}>
        <path d={PIP_PATHS[card.suit]} />
      </g>

      {/* The court emblem sits opposite it, which is the only thing that tells
          a Jack from a Queen at a glance on a card this size. */}
      {court && (
        <g transform={`translate(${W - 8} 3) scale(0.8)`} fill={ink} opacity={0.85}>
          <path d={court} />
        </g>
      )}

      {/* Rank, bottom left and large: it is what you actually read. */}
      <Rank label={label} ink={ink} />
    </svg>
  );
}

/** A hollow rectangle one cell thick, as a path. */
function frame(x: number, y: number, w: number, h: number): string {
  return (
    `M${x} ${y}h${w}v${h}h-${w}z` + `M${x + 1} ${y + 1}v${h - 2}h${w - 2}v-${h - 2}z`
  );
}

/**
 * The rank, which is two glyphs for a ten and one for everything else.
 *
 * A ten drawn at the same size as a nine would run off the card, so it is set
 * narrower and the two digits are kerned together.
 */
function Rank({ label, ink }: { label: string; ink: string }) {
  if (label === '10') {
    return (
      <g fill={ink}>
        <g transform="translate(3 20) scale(1.15)">
          <path d={GLYPH_PATHS['1']} />
        </g>
        <g transform="translate(8.2 20) scale(1.15)">
          <path d={GLYPH_PATHS['0']} />
        </g>
      </g>
    );
  }
  return (
    <g fill={ink} transform="translate(3 18) scale(1.7)">
      <path d={GLYPH_PATHS[label] ?? GLYPH_PATHS['0']} />
    </g>
  );
}

/**
 * The back of a card in the same style.
 *
 * Not a photograph of a pattern: a two-tone check on the same grid, so a
 * face-down card is obviously from the same deck as a face-up one.
 */
export function PixelBack({
  width = 62,
  className,
  style,
}: {
  width?: number;
  className?: string;
  style?: React.CSSProperties;
}) {
  const cells: React.ReactElement[] = [];
  for (let y = 3; y < H - 3; y++) {
    for (let x = 3; x < W - 3; x++) {
      if ((x + y) % 2 === 0) continue;
      cells.push(<rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} />);
    }
  }

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      width={width}
      height={Math.round(width * (H / W))}
      className={className}
      style={{ display: 'block', ...style }}
      shapeRendering="crispEdges"
    >
      <path d={frame(0, 0, W, H)} fill={PIXEL_EDGE} />
      <path d={frame(1, 1, W - 2, H - 2)} fill={PIXEL_EDGE_IN} />
      <rect x={2} y={2} width={W - 4} height={H - 4} fill="#2E4A6B" />
      <g fill="#4C7BA8">{cells}</g>
    </svg>
  );
}

/** Every card in the deck, for the theme picker's preview. */
export const sampleCard = (rank: Rank, suit: Suit): Card => ({
  rank,
  suit,
  faceUp: true,
  id: `${rank}${suit}`,
});
