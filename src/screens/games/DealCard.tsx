/**
 * Drawing one Monopoly Deal card.
 *
 * Kept apart from the table because the table is already the biggest screen in
 * the application, and because a card has to read at three sizes: full in your
 * hand, half-covered in a set, and as a stub in somebody else's tableau across
 * the room. The same component does all three so a Railroad looks like a
 * Railroad wherever it turns up.
 */
import React from 'react';

import { ACTION_NAME, SETS, isRainbow } from '../../lib/deal/cards';
import type { Card, Colour } from '../../lib/deal/cards';
import { cn } from '../../lib/utils';

/** The board colours. Close to the printed deck, dark enough to read on. */
export const INK: Record<Colour, string> = {
  brown: '#8B5E3C',
  lightblue: '#8FD3F4',
  pink: '#E86FB0',
  orange: '#F09030',
  red: '#E05C5C',
  yellow: '#F2D14A',
  green: '#4CAF7A',
  blue: '#4C7BE0',
  railroad: '#C9C9D4',
  utility: '#9BD44C',
};

/** Black text on the pale colours, white on the dark ones. */
const DARK_ON: Colour[] = ['lightblue', 'yellow', 'railroad', 'utility'];
export const inkText = (c: Colour): string => (DARK_ON.includes(c) ? '#12131A' : '#FFFFFF');

export type CardSize = 'full' | 'small' | 'stub';

const BOX: Record<CardSize, string> = {
  full: 'w-[62px] h-[88px] text-[9px]',
  small: 'w-[46px] h-[66px] text-[8px]',
  stub: 'w-[26px] h-[38px] text-[7px]',
};

export function DealCard({
  card,
  /** For a wild, which colour it is currently standing in as. */
  as,
  size = 'full',
  selected,
  dimmed,
  onClick,
  title,
  className,
}: {
  card: Card;
  as?: Colour;
  size?: CardSize;
  selected?: boolean;
  dimmed?: boolean;
  onClick?: () => void;
  title?: string;
  className?: string;
}) {
  const body = <Face card={card} as={as} size={size} />;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      title={title}
      className={cn(
        'relative shrink-0 rounded-[5px] border overflow-hidden text-left',
        'bg-raised border-edge transition-all',
        BOX[size],
        onClick && 'hover:-translate-y-1 hover:border-edge-strong cursor-pointer',
        selected && 'ring-2 ring-gold -translate-y-1.5 border-gold/60',
        dimmed && 'opacity-35 saturate-50',
        className,
      )}
    >
      {body}
    </button>
  );
}

function Face({ card, as, size }: { card: Card; as?: Colour; size: CardSize }) {
  const stub = size === 'stub';

  if (card.kind === 'money') {
    return (
      <div className="h-full w-full grid place-items-center bg-[#2A3B2E] text-[#9BE0A8]">
        <span className={cn('font-semibold', stub ? 'text-[11px]' : 'text-base')}>
          {card.value}M
        </span>
      </div>
    );
  }

  if (card.kind === 'property' || card.kind === 'wild') {
    // A wild laid down shows the colour it is standing in as; one still in
    // hand shows the colours it could become.
    const colours =
      card.kind === 'property' ? [card.colour] : as ? [as] : card.colours.slice(0, 10);
    const rainbow = card.kind === 'wild' && isRainbow(card);

    return (
      <div className="h-full w-full flex flex-col">
        <div className="flex h-[34%] w-full">
          {colours.map((c, i) => (
            <span key={`${c}-${i}`} className="flex-1" style={{ background: INK[c] }} />
          ))}
        </div>
        <div className="flex-1 p-1 flex flex-col justify-between min-h-0">
          <span className="leading-tight line-clamp-3 text-dim">
            {stub ? '' : rainbow ? 'Any colour' : as ? SETS[as].name : label(card)}
          </span>
          {!stub && <span className="text-muted">{card.value}M</span>}
        </div>
      </div>
    );
  }

  if (card.kind === 'rent') {
    const colours = card.colours.length === 10 ? (Object.keys(SETS) as Colour[]) : card.colours;
    return (
      <div className="h-full w-full flex flex-col bg-[#1B2430]">
        <div className="flex h-[38%] w-full">
          {colours.map((c) => (
            <span key={c} className="flex-1" style={{ background: INK[c] }} />
          ))}
        </div>
        <div className="flex-1 p-1 flex flex-col justify-between min-h-0">
          <span className="leading-tight font-semibold text-cyan">RENT</span>
          {!stub && <span className="text-muted">{card.value}M</span>}
        </div>
      </div>
    );
  }

  return (
    <div className="h-full w-full p-1 flex flex-col justify-between bg-[#2B2438]">
      <span className="leading-tight line-clamp-4 text-[#D9C7FF] font-medium">
        {stub ? initials(ACTION_NAME[card.action]) : ACTION_NAME[card.action]}
      </span>
      {!stub && <span className="text-muted">{card.value}M</span>}
    </div>
  );
}

const label = (card: Card): string =>
  card.kind === 'property'
    ? SETS[card.colour].name
    : card.kind === 'wild'
      ? card.colours.map((c) => SETS[c].name).join(' / ')
      : '';

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join('')
    .slice(0, 3);

/**
 * A set on the table: the cards fanned, with its progress and buildings.
 *
 * The fan is what makes a nearly-finished set legible from across a room —
 * three cards of a colour look different from one, without having to read a
 * number.
 */
export function PileView({
  colour,
  cards,
  house,
  hotel,
  size = 'small',
  onCard,
  highlight,
  cardOf,
  label: heading,
}: {
  colour: Colour;
  cards: number[];
  house: boolean;
  hotel: boolean;
  size?: CardSize;
  onCard?: (cardIndex: number) => void;
  highlight?: boolean;
  cardOf: (i: number) => Card;
  label?: React.ReactNode;
}) {
  const need = SETS[colour].size;
  const done = cards.length >= need;

  return (
    <div
      className={cn(
        'rounded-card border p-1.5 transition-colors',
        highlight ? 'border-gold/70 bg-gold/10' : done ? 'border-edge-strong bg-raised/60' : 'border-edge',
      )}
    >
      <div className="flex items-center gap-1 mb-1">
        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: INK[colour] }} />
        <span className="text-[9px] text-dim truncate flex-1">{SETS[colour].name}</span>
        <span className={cn('text-[9px] font-mono', done ? 'text-gold' : 'text-muted')}>
          {cards.length}/{need}
        </span>
      </div>

      <div className="flex">
        {cards.map((i, n) => (
          <DealCard
            key={i}
            card={cardOf(i)}
            as={colour}
            size={size}
            onClick={onCard ? () => onCard(i) : undefined}
            className={n > 0 ? '-ml-[55%]' : ''}
          />
        ))}
      </div>

      {(house || hotel) && (
        <div className="flex gap-1 mt-1">
          {house && <span className="text-[8px] px-1 rounded bg-[#4CAF7A]/20 text-[#7BD88F]">House</span>}
          {hotel && <span className="text-[8px] px-1 rounded bg-[#E05C5C]/20 text-[#F09090]">Hotel</span>}
        </div>
      )}
      {heading}
    </div>
  );
}
