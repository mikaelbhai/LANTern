/**
 * Complete chess rules engine.
 *
 * Board is a flat 64-entry array, index 0 = a8 through 63 = h1, so index
 * arithmetic matches the way the board is rendered top-down.
 */

export type Color = 'w' | 'b';
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export interface Piece {
  type: PieceType;
  color: Color;
}

export interface Move {
  from: number;
  to: number;
  piece: PieceType;
  color: Color;
  captured?: PieceType;
  promotion?: PieceType;
  castle?: 'k' | 'q';
  enPassant?: boolean;
  double?: boolean;
  san?: string;
}

export interface Castling {
  wk: boolean;
  wq: boolean;
  bk: boolean;
  bq: boolean;
}

export interface Position {
  board: (Piece | null)[];
  turn: Color;
  castling: Castling;
  ep: number | null;
  halfmove: number;
  fullmove: number;
}

export type Outcome =
  | { kind: 'ongoing' }
  | { kind: 'checkmate'; winner: Color }
  | { kind: 'stalemate' }
  | { kind: 'fifty-move' }
  | { kind: 'threefold' }
  | { kind: 'insufficient' }
  | { kind: 'resigned'; winner: Color }
  | { kind: 'agreed-draw' }
  | { kind: 'timeout'; winner: Color };

export const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

export const fileOf = (i: number) => i & 7;
export const rankOf = (i: number) => i >> 3;
export const squareName = (i: number) => `${FILES[fileOf(i)]}${8 - rankOf(i)}`;
export const squareIndex = (name: string) =>
  FILES.indexOf(name[0]) + (8 - parseInt(name[1], 10)) * 8;
export const isLightSquare = (i: number) => (fileOf(i) + rankOf(i)) % 2 === 0;

const START_ROW: PieceType[] = ['r', 'n', 'b', 'q', 'k', 'b', 'n', 'r'];

export function initialPosition(): Position {
  const board: (Piece | null)[] = Array(64).fill(null);
  for (let f = 0; f < 8; f++) {
    board[f] = { type: START_ROW[f], color: 'b' };
    board[8 + f] = { type: 'p', color: 'b' };
    board[48 + f] = { type: 'p', color: 'w' };
    board[56 + f] = { type: START_ROW[f], color: 'w' };
  }
  return {
    board,
    turn: 'w',
    castling: { wk: true, wq: true, bk: true, bq: true },
    ep: null,
    halfmove: 0,
    fullmove: 1,
  };
}

const KNIGHT_DELTAS = [
  [1, 2], [2, 1], [2, -1], [1, -2],
  [-1, -2], [-2, -1], [-2, 1], [-1, 2],
];
const KING_DELTAS = [
  [0, 1], [1, 1], [1, 0], [1, -1],
  [0, -1], [-1, -1], [-1, 0], [-1, 1],
];
const BISHOP_DIRS = [
  [1, 1], [1, -1], [-1, -1], [-1, 1],
];
const ROOK_DIRS = [
  [0, 1], [1, 0], [0, -1], [-1, 0],
];

const onBoard = (f: number, r: number) => f >= 0 && f < 8 && r >= 0 && r < 8;
const idx = (f: number, r: number) => r * 8 + f;

function slide(
  pos: Position,
  from: number,
  dirs: number[][],
  color: Color,
  out: Move[],
  type: PieceType,
) {
  const f0 = fileOf(from);
  const r0 = rankOf(from);
  for (const [df, dr] of dirs) {
    let f = f0 + df;
    let r = r0 + dr;
    while (onBoard(f, r)) {
      const to = idx(f, r);
      const target = pos.board[to];
      if (!target) {
        out.push({ from, to, piece: type, color });
      } else {
        if (target.color !== color) {
          out.push({ from, to, piece: type, color, captured: target.type });
        }
        break;
      }
      f += df;
      r += dr;
    }
  }
}

/** Pseudo-legal moves — may leave the mover's own king in check. */
function pseudoMoves(pos: Position, color: Color, forAttack = false): Move[] {
  const out: Move[] = [];

  for (let from = 0; from < 64; from++) {
    const p = pos.board[from];
    if (!p || p.color !== color) continue;
    const f0 = fileOf(from);
    const r0 = rankOf(from);

    switch (p.type) {
      case 'p': {
        const dir = color === 'w' ? -1 : 1;
        const startRank = color === 'w' ? 6 : 1;
        const promoRank = color === 'w' ? 0 : 7;

        // Captures (and, when probing attacks, the squares a pawn covers).
        for (const df of [-1, 1]) {
          const f = f0 + df;
          const r = r0 + dir;
          if (!onBoard(f, r)) continue;
          const to = idx(f, r);
          const target = pos.board[to];
          if (forAttack) {
            out.push({ from, to, piece: 'p', color });
            continue;
          }
          if (target && target.color !== color) {
            pushPawn(out, { from, to, piece: 'p', color, captured: target.type }, r === promoRank);
          } else if (!target && pos.ep === to) {
            out.push({ from, to, piece: 'p', color, captured: 'p', enPassant: true });
          }
        }
        if (forAttack) break;

        // Pushes.
        const one = idx(f0, r0 + dir);
        if (onBoard(f0, r0 + dir) && !pos.board[one]) {
          pushPawn(out, { from, to: one, piece: 'p', color }, rankOf(one) === promoRank);
          if (r0 === startRank) {
            const two = idx(f0, r0 + dir * 2);
            if (!pos.board[two]) {
              out.push({ from, to: two, piece: 'p', color, double: true });
            }
          }
        }
        break;
      }

      case 'n':
        for (const [df, dr] of KNIGHT_DELTAS) {
          const f = f0 + df;
          const r = r0 + dr;
          if (!onBoard(f, r)) continue;
          const to = idx(f, r);
          const target = pos.board[to];
          if (!target || target.color !== color) {
            out.push({ from, to, piece: 'n', color, captured: target?.type });
          }
        }
        break;

      case 'b':
        slide(pos, from, BISHOP_DIRS, color, out, 'b');
        break;
      case 'r':
        slide(pos, from, ROOK_DIRS, color, out, 'r');
        break;
      case 'q':
        slide(pos, from, [...BISHOP_DIRS, ...ROOK_DIRS], color, out, 'q');
        break;

      case 'k': {
        for (const [df, dr] of KING_DELTAS) {
          const f = f0 + df;
          const r = r0 + dr;
          if (!onBoard(f, r)) continue;
          const to = idx(f, r);
          const target = pos.board[to];
          if (!target || target.color !== color) {
            out.push({ from, to, piece: 'k', color, captured: target?.type });
          }
        }
        if (forAttack) break;

        // Castling: king and rook unmoved, path clear, king never crosses check.
        const rights = pos.castling;
        const homeRank = color === 'w' ? 7 : 0;
        if (from === idx(4, homeRank) && !isSquareAttacked(pos, from, opposite(color))) {
          const kingSide = color === 'w' ? rights.wk : rights.bk;
          const queenSide = color === 'w' ? rights.wq : rights.bq;

          if (
            kingSide &&
            !pos.board[idx(5, homeRank)] &&
            !pos.board[idx(6, homeRank)] &&
            pos.board[idx(7, homeRank)]?.type === 'r' &&
            pos.board[idx(7, homeRank)]?.color === color &&
            !isSquareAttacked(pos, idx(5, homeRank), opposite(color)) &&
            !isSquareAttacked(pos, idx(6, homeRank), opposite(color))
          ) {
            out.push({ from, to: idx(6, homeRank), piece: 'k', color, castle: 'k' });
          }

          if (
            queenSide &&
            !pos.board[idx(3, homeRank)] &&
            !pos.board[idx(2, homeRank)] &&
            !pos.board[idx(1, homeRank)] &&
            pos.board[idx(0, homeRank)]?.type === 'r' &&
            pos.board[idx(0, homeRank)]?.color === color &&
            !isSquareAttacked(pos, idx(3, homeRank), opposite(color)) &&
            !isSquareAttacked(pos, idx(2, homeRank), opposite(color))
          ) {
            out.push({ from, to: idx(2, homeRank), piece: 'k', color, castle: 'q' });
          }
        }
        break;
      }
    }
  }

  return out;
}

function pushPawn(out: Move[], move: Move, promoting: boolean) {
  if (!promoting) {
    out.push(move);
    return;
  }
  for (const promotion of ['q', 'r', 'b', 'n'] as PieceType[]) {
    out.push({ ...move, promotion });
  }
}

export const opposite = (c: Color): Color => (c === 'w' ? 'b' : 'w');

export function findKing(pos: Position, color: Color): number {
  for (let i = 0; i < 64; i++) {
    const p = pos.board[i];
    if (p && p.type === 'k' && p.color === color) return i;
  }
  return -1;
}

export function isSquareAttacked(pos: Position, square: number, by: Color): boolean {
  return pseudoMoves(pos, by, true).some((m) => m.to === square);
}

export function inCheck(pos: Position, color: Color): boolean {
  const k = findKing(pos, color);
  return k >= 0 && isSquareAttacked(pos, k, opposite(color));
}

export function applyMove(pos: Position, move: Move): Position {
  const board = pos.board.slice();
  const piece = board[move.from]!;

  board[move.from] = null;
  board[move.to] = move.promotion
    ? { type: move.promotion, color: piece.color }
    : piece;

  if (move.enPassant) {
    const capturedSquare = move.color === 'w' ? move.to + 8 : move.to - 8;
    board[capturedSquare] = null;
  }

  if (move.castle) {
    const homeRank = move.color === 'w' ? 7 : 0;
    if (move.castle === 'k') {
      board[idx(5, homeRank)] = board[idx(7, homeRank)];
      board[idx(7, homeRank)] = null;
    } else {
      board[idx(3, homeRank)] = board[idx(0, homeRank)];
      board[idx(0, homeRank)] = null;
    }
  }

  const castling = { ...pos.castling };
  if (piece.type === 'k') {
    if (move.color === 'w') {
      castling.wk = castling.wq = false;
    } else {
      castling.bk = castling.bq = false;
    }
  }
  // Any move from or to a rook's home square kills that right.
  const clearRight = (square: number) => {
    if (square === 63) castling.wk = false;
    if (square === 56) castling.wq = false;
    if (square === 7) castling.bk = false;
    if (square === 0) castling.bq = false;
  };
  clearRight(move.from);
  clearRight(move.to);

  return {
    board,
    turn: opposite(pos.turn),
    castling,
    ep: move.double ? (move.from + move.to) / 2 : null,
    halfmove: move.captured || move.piece === 'p' ? 0 : pos.halfmove + 1,
    fullmove: pos.turn === 'b' ? pos.fullmove + 1 : pos.fullmove,
  };
}

export function legalMoves(pos: Position, from?: number): Move[] {
  const candidates = pseudoMoves(pos, pos.turn);
  const filtered = from === undefined ? candidates : candidates.filter((m) => m.from === from);
  return filtered.filter((m) => !inCheck(applyMove(pos, m), pos.turn));
}

/** Standard algebraic notation, disambiguated against the position it was made in. */
export function toSan(pos: Position, move: Move): string {
  if (move.castle) {
    const base = move.castle === 'k' ? 'O-O' : 'O-O-O';
    return base + suffix(applyMove(pos, move), opposite(move.color));
  }

  const target = squareName(move.to);
  let san = '';

  if (move.piece === 'p') {
    san = move.captured ? `${FILES[fileOf(move.from)]}x${target}` : target;
    if (move.promotion) san += `=${move.promotion.toUpperCase()}`;
  } else {
    const sameTargets = legalMoves(pos).filter(
      (m) => m.piece === move.piece && m.to === move.to && m.from !== move.from,
    );
    let disambiguator = '';
    if (sameTargets.length) {
      const sameFile = sameTargets.some((m) => fileOf(m.from) === fileOf(move.from));
      const sameRank = sameTargets.some((m) => rankOf(m.from) === rankOf(move.from));
      if (!sameFile) disambiguator = FILES[fileOf(move.from)];
      else if (!sameRank) disambiguator = String(8 - rankOf(move.from));
      else disambiguator = squareName(move.from);
    }
    san = `${move.piece.toUpperCase()}${disambiguator}${move.captured ? 'x' : ''}${target}`;
  }

  return san + suffix(applyMove(pos, move), opposite(move.color));
}

function suffix(after: Position, defender: Color): string {
  if (!inCheck(after, defender)) return '';
  return legalMoves(after).length === 0 ? '#' : '+';
}

/** Key for repetition detection — position, side to move, rights, en passant. */
export function positionKey(pos: Position): string {
  let s = '';
  for (const p of pos.board) s += p ? (p.color === 'w' ? p.type.toUpperCase() : p.type) : '.';
  const c = pos.castling;
  return `${s}|${pos.turn}|${c.wk ? 'K' : ''}${c.wq ? 'Q' : ''}${c.bk ? 'k' : ''}${c.bq ? 'q' : ''}|${pos.ep ?? '-'}`;
}

export function hasInsufficientMaterial(pos: Position): boolean {
  const pieces: { type: PieceType; color: Color; square: number }[] = [];
  pos.board.forEach((p, i) => p && pieces.push({ ...p, square: i }));

  const nonKings = pieces.filter((p) => p.type !== 'k');
  if (nonKings.length === 0) return true;
  if (nonKings.length === 1) return nonKings[0].type === 'b' || nonKings[0].type === 'n';
  if (nonKings.length === 2) {
    const [a, b] = nonKings;
    if (a.type === 'b' && b.type === 'b' && a.color !== b.color) {
      return isLightSquare(a.square) === isLightSquare(b.square);
    }
  }
  return false;
}

export function evaluateOutcome(pos: Position, history: string[]): Outcome {
  if (legalMoves(pos).length === 0) {
    return inCheck(pos, pos.turn)
      ? { kind: 'checkmate', winner: opposite(pos.turn) }
      : { kind: 'stalemate' };
  }
  if (pos.halfmove >= 100) return { kind: 'fifty-move' };
  if (hasInsufficientMaterial(pos)) return { kind: 'insufficient' };

  const key = positionKey(pos);
  if (history.filter((k) => k === key).length >= 3) return { kind: 'threefold' };

  return { kind: 'ongoing' };
}

export const PIECE_VALUE: Record<PieceType, number> = {
  p: 1,
  n: 3,
  b: 3,
  r: 5,
  q: 9,
  k: 0,
};

export function materialBalance(pos: Position): number {
  let score = 0;
  for (const p of pos.board) {
    if (!p) continue;
    score += (p.color === 'w' ? 1 : -1) * PIECE_VALUE[p.type];
  }
  return score;
}

export function capturedPieces(pos: Position): Record<Color, PieceType[]> {
  const full: Record<PieceType, number> = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };
  const remaining: Record<Color, Record<PieceType, number>> = {
    w: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
    b: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
  };
  for (const p of pos.board) if (p) remaining[p.color][p.type]++;

  const out: Record<Color, PieceType[]> = { w: [], b: [] };
  for (const color of ['w', 'b'] as Color[]) {
    for (const type of ['q', 'r', 'b', 'n', 'p'] as PieceType[]) {
      // Promotions can push a count above its starting value; clamp at zero.
      const lost = Math.max(0, full[type] - remaining[color][type]);
      for (let i = 0; i < lost; i++) out[color].push(type);
    }
  }
  return out;
}
