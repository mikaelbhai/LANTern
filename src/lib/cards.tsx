import React from 'react';
import { cn, seededRandom, shuffle } from './utils';

export type Suit = 's' | 'h' | 'd' | 'c';
export type Rank = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13;

export interface Card {
  id: string;
  suit: Suit;
  rank: Rank;
  faceUp: boolean;
}

export const SUITS: Suit[] = ['s', 'h', 'd', 'c'];
export const SUIT_GLYPH: Record<Suit, string> = { s: '♠', h: '♥', d: '♦', c: '♣' };
export const RANK_LABEL: Record<number, string> = {
  1: 'A', 11: 'J', 12: 'Q', 13: 'K',
};

export const isRed = (s: Suit) => s === 'h' || s === 'd';
export const rankLabel = (r: Rank) => RANK_LABEL[r] ?? String(r);

export function makeDeck(decks = 1, suits: Suit[] = SUITS): Card[] {
  const out: Card[] = [];
  for (let d = 0; d < decks; d++) {
    for (const suit of suits) {
      for (let rank = 1; rank <= 13; rank++) {
        out.push({ id: `${suit}${rank}-${d}`, suit, rank: rank as Rank, faceUp: false });
      }
    }
  }
  return out;
}

export function dealFrom(seed: number, decks = 1, suits: Suit[] = SUITS): Card[] {
  return shuffle(makeDeck(decks, suits), seededRandom(seed));
}

/** Today's date as a stable numeric seed, for the shared daily challenge. */
export function dailySeed(d = new Date()): number {
  return d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
}

/* ------------------------------------------------------------- Themes */

export type CardThemeId = 'classic' | 'linen' | 'midnight' | 'pixel' | 'floral';

export interface CardTheme {
  id: CardThemeId;
  name: string;
  face: string;
  faceBorder: string;
  red: string;
  black: string;
  back: string;
  backPattern: 'lines' | 'weave' | 'grid' | 'pixel' | 'petals';
  slot: string;
  font: string;
}

export const CARD_THEMES: CardTheme[] = [
  {
    id: 'classic',
    name: 'Classic',
    face: '#FCFBF7',
    faceBorder: '#C7CEDA',
    red: '#C4342F',
    black: '#1B1F27',
    back: '#2C4C86',
    backPattern: 'lines',
    slot: 'rgba(255,255,255,0.07)',
    font: 'var(--font-sans)',
  },
  {
    id: 'linen',
    name: 'Linen',
    face: '#F6F0E2',
    faceBorder: '#CBBFA3',
    red: '#B14A3C',
    black: '#3B3529',
    back: '#8C7B5C',
    backPattern: 'weave',
    slot: 'rgba(246,240,226,0.08)',
    font: 'var(--font-sans)',
  },
  {
    id: 'midnight',
    name: 'Midnight',
    face: '#1C2330',
    faceBorder: '#3A465C',
    red: '#FF7A7A',
    black: '#C4CCDA',
    back: '#0F1620',
    backPattern: 'grid',
    slot: 'rgba(255,255,255,0.05)',
    font: 'var(--font-sans)',
  },
  {
    id: 'pixel',
    name: 'Pixel',
    face: '#E8E8D8',
    faceBorder: '#2B2B2B',
    red: '#D63A2F',
    black: '#2B2B2B',
    back: '#3A7D44',
    backPattern: 'pixel',
    slot: 'rgba(232,232,216,0.08)',
    font: 'var(--font-mono)',
  },
  {
    id: 'floral',
    name: 'Floral',
    face: '#FDF6F8',
    faceBorder: '#DDBECB',
    red: '#C2436B',
    black: '#4A3244',
    back: '#8E5476',
    backPattern: 'petals',
    slot: 'rgba(253,246,248,0.08)',
    font: 'var(--font-sans)',
  },
];

export const getTheme = (id: CardThemeId) =>
  CARD_THEMES.find((t) => t.id === id) ?? CARD_THEMES[0];

/* -------------------------------------------------------------- Pips */

const PIP_LAYOUTS: Record<number, [number, number][]> = {
  1: [[50, 50]],
  2: [[50, 22], [50, 78]],
  3: [[50, 22], [50, 50], [50, 78]],
  4: [[30, 22], [70, 22], [30, 78], [70, 78]],
  5: [[30, 22], [70, 22], [50, 50], [30, 78], [70, 78]],
  6: [[30, 22], [70, 22], [30, 50], [70, 50], [30, 78], [70, 78]],
  7: [[30, 22], [70, 22], [50, 36], [30, 50], [70, 50], [30, 78], [70, 78]],
  8: [[30, 22], [70, 22], [50, 36], [30, 50], [70, 50], [50, 64], [30, 78], [70, 78]],
  9: [[30, 20], [70, 20], [30, 40], [70, 40], [50, 50], [30, 60], [70, 60], [30, 80], [70, 80]],
  10: [[30, 20], [70, 20], [30, 40], [70, 40], [50, 30], [50, 70], [30, 60], [70, 60], [30, 80], [70, 80]],
};

/* -------------------------------------------------------- Card faces */

export function CardFace({
  card,
  theme,
  width = 62,
  className,
  dimmed,
  selected,
  hinted,
  onClick,
  onDoubleClick,
  style,
  draggable,
  onDragStart,
}: {
  card: Card;
  theme: CardTheme;
  width?: number;
  className?: string;
  dimmed?: boolean;
  selected?: boolean;
  hinted?: boolean;
  onClick?: (e: React.MouseEvent) => void;
  onDoubleClick?: (e: React.MouseEvent) => void;
  style?: React.CSSProperties;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent) => void;
}) {
  const height = Math.round(width * 1.42);
  const color = isRed(card.suit) ? theme.red : theme.black;

  if (!card.faceUp) {
    return (
      <div
        onClick={onClick}
        className={cn('rounded-[6px] overflow-hidden shrink-0 select-none', className)}
        style={{
          width,
          height,
          background: theme.back,
          border: `1px solid ${theme.faceBorder}`,
          boxShadow: '0 1px 3px rgba(0,0,0,0.35)',
          ...style,
        }}
      >
        <CardBackPattern pattern={theme.backPattern} />
      </div>
    );
  }

  const isCourt = card.rank >= 11;
  const glyph = SUIT_GLYPH[card.suit];
  const label = rankLabel(card.rank);

  return (
    <div
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      draggable={draggable}
      onDragStart={onDragStart}
      className={cn(
        'relative rounded-[6px] overflow-hidden shrink-0 select-none transition-shadow',
        onClick && 'cursor-pointer',
        className,
      )}
      style={{
        width,
        height,
        background: theme.face,
        border: `1px solid ${selected ? '#F5A623' : theme.faceBorder}`,
        boxShadow: selected
          ? '0 0 0 2px rgba(245,166,35,0.7), 0 3px 8px rgba(0,0,0,0.4)'
          : hinted
            ? '0 0 0 2px rgba(57,217,200,0.8), 0 2px 6px rgba(0,0,0,0.35)'
            : '0 1px 3px rgba(0,0,0,0.35)',
        opacity: dimmed ? 0.55 : 1,
        fontFamily: theme.font,
        ...style,
      }}
    >
      {/* corner indices */}
      <span
        className="absolute top-[3px] left-[4px] leading-none font-bold flex flex-col items-center"
        style={{ color, fontSize: width * 0.21 }}
      >
        {label}
        <span style={{ fontSize: width * 0.19, marginTop: 1 }}>{glyph}</span>
      </span>
      <span
        className="absolute bottom-[3px] right-[4px] leading-none font-bold flex flex-col items-center rotate-180"
        style={{ color, fontSize: width * 0.21 }}
      >
        {label}
        <span style={{ fontSize: width * 0.19, marginTop: 1 }}>{glyph}</span>
      </span>

      {isCourt ? (
        <CourtArt rank={card.rank} suit={card.suit} theme={theme} width={width} />
      ) : (
        <svg
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
          className="absolute inset-0"
          style={{ padding: `${width * 0.18}px ${width * 0.2}px` }}
        >
          {(PIP_LAYOUTS[card.rank] ?? []).map(([x, y], i) => (
            <text
              key={i}
              x={x}
              y={y}
              fill={color}
              fontSize={card.rank === 1 ? 46 : 22}
              textAnchor="middle"
              dominantBaseline="central"
              transform={y > 55 && card.rank !== 1 ? `rotate(180 ${x} ${y})` : undefined}
            >
              {glyph}
            </text>
          ))}
        </svg>
      )}
    </div>
  );
}

function CourtArt({
  rank,
  suit,
  theme,
  width,
}: {
  rank: Rank;
  suit: Suit;
  theme: CardTheme;
  width: number;
}) {
  const color = isRed(suit) ? theme.red : theme.black;
  const soft = `${color}22`;

  return (
    <svg
      viewBox="0 0 60 84"
      className="absolute"
      style={{
        left: '17%',
        top: '13%',
        width: '66%',
        height: '74%',
      }}
    >
      <rect x="2" y="2" width="56" height="80" rx="4" fill={soft} stroke={color} strokeWidth="1" />

      {rank === 13 && (
        <>
          <path d="M18 26l4-12 8 8 8-8 4 12Z" fill={color} />
          <circle cx="30" cy="40" r="9" fill="none" stroke={color} strokeWidth="1.6" />
          <path d="M18 58c0-8 5-12 12-12s12 4 12 12v16H18Z" fill="none" stroke={color} strokeWidth="1.6" />
          <path d="M26 38h2m4 0h2" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
        </>
      )}

      {rank === 12 && (
        <>
          <path d="M20 26l3-10 7 6 7-6 3 10Z" fill={color} />
          <circle cx="30" cy="40" r="9" fill="none" stroke={color} strokeWidth="1.6" />
          <path d="M16 74c0-14 6-22 14-22s14 8 14 22Z" fill="none" stroke={color} strokeWidth="1.6" />
          <circle cx="27" cy="38" r="1.2" fill={color} />
          <circle cx="33" cy="38" r="1.2" fill={color} />
        </>
      )}

      {rank === 11 && (
        <>
          <path d="M20 24h20l-3 7H23Z" fill={color} />
          <circle cx="30" cy="42" r="8.5" fill="none" stroke={color} strokeWidth="1.6" />
          <path d="M19 74c0-12 5-18 11-18s11 6 11 18Z" fill="none" stroke={color} strokeWidth="1.6" />
          <path d="M42 34l6-10" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
          <circle cx="27" cy="41" r="1.2" fill={color} />
          <circle cx="33" cy="41" r="1.2" fill={color} />
        </>
      )}

      <text x="30" y="80" fill={color} fontSize="9" textAnchor="middle" fontWeight="bold">
        {SUIT_GLYPH[suit]}
      </text>
    </svg>
  );
}

function CardBackPattern({ pattern }: { pattern: CardTheme['backPattern'] }) {
  const stroke = 'rgba(255,255,255,0.22)';
  return (
    <svg width="100%" height="100%" viewBox="0 0 40 56" preserveAspectRatio="none">
      {pattern === 'lines' &&
        Array.from({ length: 14 }, (_, i) => (
          <path key={i} d={`M${-10 + i * 5} 56 L${20 + i * 5} 0`} stroke={stroke} strokeWidth="1" />
        ))}
      {pattern === 'weave' && (
        <>
          {Array.from({ length: 8 }, (_, i) => (
            <line key={`h${i}`} x1="0" y1={i * 7 + 3} x2="40" y2={i * 7 + 3} stroke={stroke} strokeWidth="1.4" />
          ))}
          {Array.from({ length: 6 }, (_, i) => (
            <line key={`v${i}`} x1={i * 7 + 3} y1="0" x2={i * 7 + 3} y2="56" stroke={stroke} strokeWidth="0.8" />
          ))}
        </>
      )}
      {pattern === 'grid' && (
        <>
          {Array.from({ length: 8 }, (_, i) => (
            <line key={`h${i}`} x1="0" y1={i * 7 + 4} x2="40" y2={i * 7 + 4} stroke={stroke} strokeWidth="0.6" />
          ))}
          {Array.from({ length: 6 }, (_, i) => (
            <line key={`v${i}`} x1={i * 7 + 2} y1="0" x2={i * 7 + 2} y2="56" stroke={stroke} strokeWidth="0.6" />
          ))}
          <circle cx="20" cy="28" r="6" fill="none" stroke="rgba(57,217,200,0.5)" strokeWidth="1" />
        </>
      )}
      {pattern === 'pixel' &&
        Array.from({ length: 48 }, (_, i) => {
          const x = (i % 6) * 7 + 1;
          const y = Math.floor(i / 6) * 7 + 1;
          return (i + Math.floor(i / 6)) % 2 === 0 ? (
            <rect key={i} x={x} y={y} width="5" height="5" fill={stroke} />
          ) : null;
        })}
      {pattern === 'petals' &&
        Array.from({ length: 12 }, (_, i) => {
          const x = (i % 3) * 13 + 7;
          const y = Math.floor(i / 3) * 14 + 7;
          return (
            <g key={i} transform={`translate(${x} ${y})`}>
              {[0, 60, 120, 180, 240, 300].map((a) => (
                <ellipse
                  key={a}
                  cx="0"
                  cy="-3"
                  rx="1.6"
                  ry="3"
                  fill={stroke}
                  transform={`rotate(${a})`}
                />
              ))}
            </g>
          );
        })}
    </svg>
  );
}

export function EmptySlot({
  width = 62,
  label,
  theme,
  onClick,
  highlight,
  className,
}: {
  width?: number;
  label?: React.ReactNode;
  theme: CardTheme;
  onClick?: () => void;
  highlight?: boolean;
  className?: string;
}) {
  return (
    <div
      onClick={onClick}
      className={cn('rounded-[6px] grid place-items-center shrink-0', onClick && 'cursor-pointer', className)}
      style={{
        width,
        height: Math.round(width * 1.42),
        border: `1px dashed ${highlight ? '#F5A623' : 'rgba(255,255,255,0.2)'}`,
        background: theme.slot,
      }}
    >
      {label && (
        <span className="text-[13px] opacity-40" style={{ color: theme.face }}>
          {label}
        </span>
      )}
    </div>
  );
}
