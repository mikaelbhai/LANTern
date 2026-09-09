/**
 * Sequence.
 *
 * A 10×10 board printed with playing cards, two of every card except the
 * Jacks, and a free corner at each end. Play a card from your hand, put a chip
 * on a matching space; five chips in a line wins a sequence, and two sequences
 * win the game.
 *
 * The Jacks are the whole game:
 *   * two-eyed (clubs, diamonds) are wild — a chip anywhere empty;
 *   * one-eyed (spades, hearts) remove somebody else's chip instead.
 *
 * Rules as a pure function, apart from the screen, so the board and the win
 * conditions can be tested at a terminal. The board layout in particular is
 * worth asserting: a printed board with one card in the wrong square is a bug
 * you would only notice when a card had no legal square.
 */
import type { Card, Suit } from './cards';

export const SIZE = 10;
export const SEQUENCE_LENGTH = 5;

/** A square holds a card, or is one of the four free corners. */
export type Square = { free: true } | { free: false; rank: number; suit: Suit };

/**
 * The printed board.
 *
 * Written out rather than generated: the real board is a fixed arrangement,
 * and generating "something like it" would quietly make a different game.
 *
 * The composition is asserted in the tests — 96 printed squares, all 48
 * non-Jack cards exactly twice, four free corners — because a first attempt at
 * this from memory had four hearts three times over and two clubs only once,
 * which no amount of playing would have made obvious.
 */
const LAYOUT: string[] = [
  '__ 2s 3s 4s 5s 6s 7s 8s 9s __',
  '6c 5c 4c 3c 2c Ah Kh Qh 10h 10s',
  '7c As 2d 3d 4d 5d 6d 7d 9h Qs',
  '8c Ks 6c 5c 4c 3c 2c 8d 8h Ks',
  '9c Qs 7c 6h 5h 4h Ah 9d 7h As',
  '10c 10s 8c 7h 2h 3h Kh 10d 6h 2d',
  'Qc 9s 9c 8h 9h 10h Qh Qd 5h 3d',
  'Kc 8s 10c Qc Kc Ac Ad Kd 4h 4d',
  'Ac 7s 6s 5s 4s 3s 2s 2h 3h 5d',
  '__ Ad Kd Qd 10d 9d 8d 7d 6d __',
];

const SUIT_OF: Record<string, Suit> = { s: 's', h: 'h', d: 'd', c: 'c' };

function parseSquare(token: string): Square {
  if (token === '__') return { free: true };
  const suit = SUIT_OF[token.slice(-1)];
  const face = token.slice(0, -1);
  const rank =
    face === 'A' ? 1 : face === 'K' ? 13 : face === 'Q' ? 12 : face === 'J' ? 11 : Number(face);
  return { free: false, rank, suit };
}

/** The board as 100 squares, row by row. */
export const BOARD: Square[] = LAYOUT.flatMap((row) => row.split(/\s+/).map(parseSquare));

export const isTwoEyedJack = (card: Card): boolean =>
  card.rank === 11 && (card.suit === 'c' || card.suit === 'd');
export const isOneEyedJack = (card: Card): boolean =>
  card.rank === 11 && (card.suit === 's' || card.suit === 'h');

export interface State {
  /** Which team owns the chip on each square, or -1. */
  chips: number[];
  /** Squares locked into a completed sequence and safe from one-eyed Jacks. */
  locked: boolean[];
  /** Sequences completed by each team. */
  sequences: number[];
  turn: number;
  teams: number;
  winner: number | null;
}

export function create(teams: number): State {
  const chips = new Array(SIZE * SIZE).fill(-1);
  const locked = new Array(SIZE * SIZE).fill(false);
  // The corners belong to everybody, which is why a line may run through them.
  for (let i = 0; i < BOARD.length; i++) if (BOARD[i].free) locked[i] = true;

  return {
    chips,
    locked,
    sequences: new Array(Math.max(2, teams)).fill(0),
    turn: 0,
    teams: Math.max(2, teams),
    winner: null,
  };
}

/** Two teams need two sequences; with three, one is enough. */
export const sequencesToWin = (teams: number): number => (teams >= 3 ? 1 : 2);

/** The squares a card may be played on, given the board and the chips down. */
export function squaresFor(state: State, card: Card): number[] {
  if (isTwoEyedJack(card)) {
    // Anywhere empty.
    return BOARD.map((sq, i) => (!sq.free && state.chips[i] === -1 ? i : -1)).filter((i) => i >= 0);
  }
  if (isOneEyedJack(card)) {
    // Any opposing chip that is not part of a finished sequence.
    return state.chips
      .map((owner, i) => (owner !== -1 && owner !== state.turn && !state.locked[i] ? i : -1))
      .filter((i) => i >= 0);
  }
  return BOARD.map((sq, i) =>
    !sq.free && sq.rank === card.rank && sq.suit === card.suit && state.chips[i] === -1 ? i : -1,
  ).filter((i) => i >= 0);
}

/** True when a card has nowhere to go and may be swapped for a new one. */
export const isDead = (state: State, card: Card): boolean =>
  !isOneEyedJack(card) && squaresFor(state, card).length === 0;

const DIRECTIONS = [
  [1, 0],
  [0, 1],
  [1, 1],
  [1, -1],
];

/**
 * Finds a new run of five through a square.
 *
 * A square already inside a finished sequence may be reused, but only one of
 * them — the rule that stops a single line being counted twice.
 */
export function runThrough(state: State, index: number, team: number): number[] | null {
  const col = index % SIZE;
  const row = Math.floor(index / SIZE);

  const ownedBy = (c: number, r: number): boolean => {
    if (c < 0 || c >= SIZE || r < 0 || r >= SIZE) return false;
    const i = r * SIZE + c;
    return BOARD[i].free || state.chips[i] === team;
  };

  for (const [dx, dy] of DIRECTIONS) {
    const line: number[] = [index];
    for (const sign of [1, -1]) {
      let c = col + dx * sign;
      let r = row + dy * sign;
      while (ownedBy(c, r)) {
        line.push(r * SIZE + c);
        c += dx * sign;
        r += dy * sign;
      }
    }
    if (line.length < SEQUENCE_LENGTH) continue;

    line.sort((a, b) => a - b);
    // Slide a window of five along the line and take the first that uses at
    // most one square already locked into another sequence.
    for (let start = 0; start + SEQUENCE_LENGTH <= line.length; start++) {
      const window = line.slice(start, start + SEQUENCE_LENGTH);
      if (!window.includes(index)) continue;
      const reused = window.filter((i) => state.locked[i] && !BOARD[i].free).length;
      if (reused <= 1) return window;
    }
  }
  return null;
}

export type Move =
  | { type: 'place'; square: number; card: Card }
  | { type: 'remove'; square: number; card: Card };

/**
 * Plays one card.
 *
 * Returns null when the move is not legal, which is also how a move arriving
 * out of turn is refused.
 */
export function play(state: State, move: Move, team: number): State | null {
  if (state.winner !== null) return null;
  if (team !== state.turn) return null;

  const legal = squaresFor(state, move.card);
  if (!legal.includes(move.square)) return null;

  const chips = state.chips.slice();
  const locked = state.locked.slice();
  const sequences = state.sequences.slice();

  if (move.type === 'remove') {
    if (!isOneEyedJack(move.card)) return null;
    chips[move.square] = -1;
  } else {
    if (isOneEyedJack(move.card)) return null;
    chips[move.square] = team;
  }

  let winner: number | null = null;

  if (move.type === 'place') {
    const run = runThrough({ ...state, chips, locked }, move.square, team);
    if (run) {
      for (const i of run) locked[i] = true;
      sequences[team] = (sequences[team] ?? 0) + 1;
      if (sequences[team] >= sequencesToWin(state.teams)) winner = team;
    }
  }

  return {
    ...state,
    chips,
    locked,
    sequences,
    winner,
    turn: winner !== null ? state.turn : (state.turn + 1) % state.teams,
  };
}
