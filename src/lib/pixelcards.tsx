/**
 * The pixel deck.
 *
 * One sprite sheet, `assets/cards.png`: thirteen ranks across, four suits
 * down, fifty-two cards in seven kilobytes. A card is a div with the sheet as
 * its background and the right corner of it scrolled into view, which is one
 * element and one shared image however many are on screen.
 *
 * That last part is the reason it is a sheet rather than drawn geometry. The
 * Sequence board is a hundred cards at once; as inline vectors that is several
 * thousand nodes for one screen, and every one of them re-rendered when a chip
 * moves. As background positions it is a hundred divs pointing at one texture
 * the browser has already decoded.
 *
 * The sheet's rows are clubs, diamonds, spades, hearts, and its columns run
 * ace through king. The black the corners were painted in has been made
 * transparent, so a card composites onto whatever is behind it rather than
 * carrying a black notch at each corner.
 */
import React from 'react';

import sheet from '../assets/cards.png';
import { SUIT_GLYPH, rankLabel } from './cards';
import type { Card, Suit } from './cards';
import { cn } from './utils';

/** The order the sheet is laid out in. */
const ROWS: Suit[] = ['c', 'd', 's', 'h'];
const COLS = 13;

/** One cell, in the sheet's own pixels. */
const CELL_W = 57;
const CELL_H = 89;
export const CARD_RATIO = CELL_H / CELL_W;

export const cardHeight = (width: number): number => Math.round(width * CARD_RATIO);

export function PixelFace({
  card,
  width = 62,
  /**
   * Fill whatever box it is in rather than taking a width.
   *
   * The Sequence board is a hundred of these in a fluid grid, so their size
   * comes from the layout. Percentages address the sheet the same way pixels
   * do, as long as the position is scaled by the number of cells *minus one* —
   * a background percentage lines that point of the image up with the same
   * point of the box, so the last column sits at 100%, not at 1200%.
   */
  fill,
  /**
   * False when whatever contains this already says what it is.
   *
   * A board square is a button labelled "7 of hearts" with a picture of the
   * seven of hearts inside it; announcing both reads the card out twice.
   */
  labelled = true,
  className,
  style,
}: {
  card: Card;
  width?: number;
  fill?: boolean;
  labelled?: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const col = card.rank - 1;
  const row = ROWS.indexOf(card.suit);
  const height = cardHeight(width);

  const placement: React.CSSProperties = fill
    ? {
        width: '100%',
        height: '100%',
        backgroundSize: `${COLS * 100}% ${ROWS.length * 100}%`,
        backgroundPosition: `${(col / (COLS - 1)) * 100}% ${(row / (ROWS.length - 1)) * 100}%`,
      }
    : {
        width,
        height,
        backgroundSize: `${COLS * width}px ${ROWS.length * height}px`,
        backgroundPosition: `${-col * width}px ${-row * height}px`,
      };

  return (
    <span
      role={labelled ? 'img' : undefined}
      aria-label={labelled ? `${rankLabel(card.rank)}${SUIT_GLYPH[card.suit]}` : undefined}
      aria-hidden={labelled ? undefined : true}
      className={cn('block shrink-0', className)}
      style={{
        ...placement,
        backgroundImage: `url(${sheet})`,
        backgroundRepeat: 'no-repeat',
        // Without this the browser smooths a deliberately jagged image into
        // mush the moment it is drawn at anything but its native size.
        imageRendering: 'pixelated',
        ...style,
      }}
    />
  );
}

/**
 * The back of a card.
 *
 * Drawn rather than sampled, because the sheet is fifty-two faces and has no
 * back on it. Framed the same way so a face-down card is obviously from the
 * same deck.
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
  const height = cardHeight(width);
  const step = Math.max(3, Math.round(width / 9));

  return (
    <span
      className={cn('block shrink-0', className)}
      style={{
        width,
        height,
        borderRadius: Math.max(2, Math.round(width / 12)),
        border: `${Math.max(1, Math.round(width / 28))}px solid #A9BCC8`,
        boxShadow: 'inset 0 0 0 1px #7E96A6',
        background: '#2E4A6B',
        backgroundImage: `repeating-linear-gradient(45deg, #4C7BA8 0 ${step}px, transparent ${step}px ${step * 2}px)`,
        ...style,
      }}
    />
  );
}

/** Face up or face down, whichever the card says. */
export function PixelCard({
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
  return card.faceUp ? (
    <PixelFace card={card} width={width} className={className} style={style} />
  ) : (
    <PixelBack width={width} className={className} style={style} />
  );
}
