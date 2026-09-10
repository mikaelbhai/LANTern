/**
 * Drawing one Monopoly Deal card.
 *
 * Kept apart from the table because the table is already the biggest screen in
 * the application, and because a card has to read at three sizes: full in your
 * hand, half-covered in a set, and as a stub in somebody else's tableau across
 * the room. The same component does all three so a Railroad looks like a
 * Railroad wherever it turns up.
 *
 * The faces carry the information the printed cards carry, rather than a
 * colour and a name. A property shows its rent ladder, so you can see what
 * finishing the set would be worth without counting it out; money is coloured
 * by denomination, so a hand of it can be read at a glance rather than
 * squinted at. That is what the real deck does, and it is the difference
 * between a card you recognise and one you have to read.
 */
import React from 'react';
import {
  ArrowBigRight,
  ArrowLeftRight,
  Ban,
  Bomb,
  Building2,
  Cake,
  Gavel,
  Hand,
  Home,
  X,
} from 'lucide-react';

import { ACTION_NAME, SETS, isRainbow } from '../../lib/deal/cards';
import type { ActionKind, Card, Colour } from '../../lib/deal/cards';
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

/**
 * A colour per denomination.
 *
 * The printed deck does this and it is not decoration: a fan of money is read
 * by colour long before any of the numbers are legible.
 */
const NOTE: Record<number, { bg: string; ink: string }> = {
  1: { bg: '#3A4A3E', ink: '#A9C9B0' },
  2: { bg: '#2E4A52', ink: '#8FD3E0' },
  3: { bg: '#2F4A34', ink: '#7BD88F' },
  4: { bg: '#2C3A5C', ink: '#8FB4FF' },
  5: { bg: '#43305C', ink: '#C9A9FF' },
  10: { bg: '#5C4A1E', ink: '#F5CE5A' },
};

const ACTION_ICON: Record<ActionKind, React.ElementType> = {
  passgo: ArrowBigRight,
  slydeal: Hand,
  forceddeal: ArrowLeftRight,
  dealbreaker: Bomb,
  justsayno: Ban,
  debtcollector: Gavel,
  birthday: Cake,
  doublerent: X,
  house: Home,
  hotel: Building2,
};

/** Actions grouped by what they do to you, so a hand reads by colour too. */
const ACTION_TONE: Record<ActionKind, { bg: string; ink: string; edge: string }> = {
  passgo: { bg: '#23343F', ink: '#8FD3E0', edge: '#39566688' },
  slydeal: { bg: '#3B2430', ink: '#F09090', edge: '#6B3A4A88' },
  forceddeal: { bg: '#3B2430', ink: '#F09090', edge: '#6B3A4A88' },
  dealbreaker: { bg: '#42202A', ink: '#FF9A9A', edge: '#7A3A4288' },
  justsayno: { bg: '#2B2438', ink: '#D9C7FF', edge: '#4A3F6688' },
  debtcollector: { bg: '#3A3324', ink: '#F0D08A', edge: '#665A3A88' },
  birthday: { bg: '#3A2A3C', ink: '#F2A6E0', edge: '#664A6688' },
  doublerent: { bg: '#3A3324', ink: '#F0D08A', edge: '#665A3A88' },
  house: { bg: '#243A2E', ink: '#8FE0AA', edge: '#3A664A88' },
  hotel: { bg: '#243A2E', ink: '#8FE0AA', edge: '#3A664A88' },
};

export type CardSize = 'full' | 'small' | 'stub';

const BOX: Record<CardSize, string> = {
  full: 'w-[66px] h-[94px]',
  small: 'w-[48px] h-[68px]',
  stub: 'w-[26px] h-[38px]',
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
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      title={title}
      className={cn(
        'relative shrink-0 rounded-[6px] overflow-hidden text-left',
        'border border-black/50 shadow-[0_1px_3px_rgba(0,0,0,0.45)]',
        'transition-all duration-150',
        BOX[size],
        onClick && 'hover:-translate-y-1 hover:shadow-[0_5px_12px_rgba(0,0,0,0.5)] cursor-pointer',
        selected && 'ring-2 ring-gold -translate-y-1.5',
        dimmed && 'opacity-35 saturate-50',
        className,
      )}
    >
      <Face card={card} as={as} size={size} />
      {/* A hairline inside the border: it is what stops these reading as flat
          rectangles at small sizes, and costs one element. */}
      <span className="pointer-events-none absolute inset-0 rounded-[6px] ring-1 ring-inset ring-white/10" />
    </button>
  );
}

function Face({ card, as, size }: { card: Card; as?: Colour; size: CardSize }) {
  const stub = size === 'stub';
  const small = size === 'small';

  if (card.kind === 'money') {
    const note = NOTE[card.value] ?? NOTE[1];
    return (
      <div
        className="h-full w-full grid place-items-center relative"
        style={{ background: `linear-gradient(160deg, ${note.bg} 0%, #12131A 160%)` }}
      >
        {/* Banknote ruling. Faint enough to be texture rather than pattern. */}
        {!stub && (
          <span
            className="absolute inset-0 opacity-[0.16]"
            style={{
              backgroundImage: `repeating-linear-gradient(-38deg, ${note.ink} 0 1px, transparent 1px 5px)`,
            }}
          />
        )}
        <span
          className={cn('relative font-semibold tracking-tight', stub ? 'text-[11px]' : 'text-lg')}
          style={{ color: note.ink }}
        >
          {card.value}
          <span className={stub ? 'text-[7px]' : 'text-[10px]'}>M</span>
        </span>
        {!stub && <Corner size={size}>{card.value}M</Corner>}
      </div>
    );
  }

  if (card.kind === 'property' || card.kind === 'wild') {
    // A wild laid down shows the colour it is standing in as; one still in
    // hand shows the colours it could become.
    const colours: Colour[] =
      card.kind === 'property' ? [card.colour] : as ? [as] : card.colours;
    const rainbow = card.kind === 'wild' && isRainbow(card) && !as;
    const shown = as ?? (card.kind === 'property' ? card.colour : undefined);

    return (
      <div className="h-full w-full flex flex-col bg-[#F0EBE0]">
        {/*
          The value rides in the colour band rather than the bottom corner,
          because the bottom corner belongs to the rent ladder. Both are
          amounts in M, and the two of them stacked in one corner read as one
          number that keeps changing.
        */}
        <div className={cn('relative flex w-full shrink-0', stub ? 'h-[40%]' : 'h-[30%]')}>
          {colours.map((c, i) => (
            <span key={`${c}-${i}`} className="flex-1" style={{ background: INK[c] }} />
          ))}
          {!stub && (
            <span
              className="absolute top-0 right-0.5 text-[7px] font-mono leading-none pt-[2px]"
              style={{ color: shown ? inkText(shown) : '#12131A', opacity: 0.75 }}
            >
              {card.value}M
            </span>
          )}
        </div>

        {!stub && (
          <div className="flex-1 min-h-0 px-1 pt-0.5 pb-1 flex flex-col text-[#1B1D26]">
            <span
              className={cn(
                'text-[7px] font-semibold leading-[1.1] uppercase tracking-wide',
                // A four-rung ladder (railroads) needs the vertical space that
                // a second line of name would take.
                shown && SETS[shown].rent.length > 3 ? 'line-clamp-1' : 'line-clamp-2',
              )}
            >
              {rainbow ? 'Wild' : shown ? SETS[shown].name : shortest(card)}
            </span>

            {/* The rent ladder, which is the number you actually want: what
                the set charges at each size, and therefore what finishing it
                is worth. */}
            {shown && !small && <Ladder colour={shown} />}
            {shown && small && (
              <span className="mt-auto text-[7px] font-mono text-[#5A5F70]">
                {SETS[shown].rent.join('/')}M
              </span>
            )}
            {!shown && (
              <span className="mt-auto text-[6px] leading-tight text-[#5A5F70] line-clamp-2">
                {rainbow ? 'Any colour' : 'Either colour'}
              </span>
            )}

          </div>
        )}
      </div>
    );
  }

  if (card.kind === 'rent') {
    const colours = card.colours;
    return (
      <div className="h-full w-full flex flex-col bg-[#151A22] relative">
        <div className="flex flex-wrap w-full h-[34%] shrink-0">
          {colours.map((c) => (
            <span
              key={c}
              style={{ background: INK[c], flex: `1 0 ${colours.length > 4 ? '20%' : 'auto'}` }}
            />
          ))}
        </div>
        <div className="flex-1 min-h-0 p-1 flex flex-col">
          <span className={cn('font-bold tracking-widest text-cyan', stub ? 'text-[6px]' : 'text-[9px]')}>
            RENT
          </span>
          {!stub && (
            <span className="text-[6px] leading-tight text-muted mt-0.5">
              {colours.length === 10 ? 'Any colour, one player' : 'From everyone'}
            </span>
          )}
          {!stub && <Corner size={size}>{card.value}M</Corner>}
        </div>
      </div>
    );
  }

  const tone = ACTION_TONE[card.action];
  const Icon = ACTION_ICON[card.action];
  return (
    <div
      className="h-full w-full flex flex-col items-center justify-center gap-1 px-1 relative"
      style={{
        background: `linear-gradient(160deg, ${tone.bg} 0%, #12131A 150%)`,
        boxShadow: `inset 0 0 0 1px ${tone.edge}`,
      }}
    >
      <Icon size={stub ? 11 : small ? 15 : 18} style={{ color: tone.ink }} strokeWidth={2} />
      {!stub && (
        <span
          className={cn(
            'text-center leading-[1.05] font-medium',
            small ? 'text-[6px]' : 'text-[7px]',
          )}
          style={{ color: tone.ink }}
        >
          {ACTION_NAME[card.action]}
        </span>
      )}
      {!stub && <Corner size={size}>{card.value}M</Corner>}
    </div>
  );
}

/** The rent at each set size, the way the printed card prints it. */
function Ladder({ colour }: { colour: Colour }) {
  const { rent } = SETS[colour];
  return (
    <div className="mt-auto w-full">
      {rent.map((amount, i) => (
        <div
          key={i}
          className={cn(
            'flex items-center gap-0.5 leading-none',
            i === rent.length - 1 ? 'text-[#1B1D26]' : 'text-[#6B7080]',
          )}
        >
          <span className="flex gap-[1px]">
            {Array.from({ length: i + 1 }, (_, n) => (
              <span
                key={n}
                className="h-[3px] w-[3px] rounded-[1px]"
                style={{ background: INK[colour], opacity: i === rent.length - 1 ? 1 : 0.55 }}
              />
            ))}
          </span>
          <span className="ml-auto text-[6px] font-mono font-semibold">{amount}M</span>
        </div>
      ))}
    </div>
  );
}

/** The value, bottom-right, where the printed deck puts it. */
function Corner({
  children,
  size,
  light,
}: {
  children: React.ReactNode;
  size: CardSize;
  light?: boolean;
}) {
  return (
    <span
      className={cn(
        'absolute bottom-0.5 right-1 font-mono leading-none',
        size === 'small' ? 'text-[6px]' : 'text-[7px]',
        light ? 'text-[#8A8F9E]' : 'text-white/40',
      )}
    >
      {children}
    </span>
  );
}

/** The shortest honest name for a two-colour wild. */
const shortest = (card: Card): string =>
  card.kind === 'wild' ? card.colours.map((c) => SETS[c].name).join(' / ') : '';

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
        highlight
          ? 'border-gold/70 bg-gold/10'
          : done
            ? 'border-edge-strong bg-raised/60'
            : 'border-edge',
      )}
    >
      <div className="flex items-center gap-1 mb-1">
        <span className="h-2 w-2 rounded-full shrink-0" style={{ background: INK[colour] }} />
        <span className="text-[9px] text-dim truncate flex-1">{SETS[colour].name}</span>
        {/* How close it is, as pips: countable without reading. */}
        <span className="flex gap-[2px] items-center">
          {Array.from({ length: need }, (_, i) => (
            <span
              key={i}
              className="h-[5px] w-[5px] rounded-full border"
              style={{
                background: i < cards.length ? INK[colour] : 'transparent',
                borderColor: i < cards.length ? INK[colour] : '#3A3F4A',
              }}
            />
          ))}
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
          {house && (
            <span className="text-[8px] px-1 rounded bg-[#4CAF7A]/20 text-[#7BD88F] flex items-center gap-0.5">
              <Home size={7} /> House
            </span>
          )}
          {hotel && (
            <span className="text-[8px] px-1 rounded bg-[#E05C5C]/20 text-[#F09090] flex items-center gap-0.5">
              <Building2 size={7} /> Hotel
            </span>
          )}
        </div>
      )}
      {heading}
    </div>
  );
}
