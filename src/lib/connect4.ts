/**
 * Connect Four.
 *
 * Kept apart from the screen that draws it so the rules can be tested without
 * a browser, and so the same function decides a move whether it was made here
 * or arrived from another device. Both ends applying identical logic is what
 * lets the board stay in step without any of it crossing the network.
 */

export const COLUMNS = 7;
export const ROWS = 6;

/** A cell holds the index of the player who filled it, or -1. */
export type Board = number[];

export interface Position {
  board: Board;
  /** Index into the seat list. */
  turn: number;
  /** Set once somebody has four in a row. */
  winner: number | null;
  /** The four cells that won it, for the board to highlight. */
  line: number[] | null;
  /** How many discs have been played, so a full board is a draw. */
  played: number;
}

export const empty = (): Position => ({
  board: new Array(COLUMNS * ROWS).fill(-1),
  turn: 0,
  winner: null,
  line: null,
  played: 0,
});

export const at = (board: Board, col: number, row: number): number =>
  board[row * COLUMNS + col];

/** The row a disc dropped into this column would land in, or -1 if it is full. */
export function landing(board: Board, col: number): number {
  if (col < 0 || col >= COLUMNS) return -1;
  for (let row = ROWS - 1; row >= 0; row--) {
    if (at(board, col, row) === -1) return row;
  }
  return -1;
}

/**
 * The four-in-a-row through this cell, if there is one.
 *
 * Checked outward from the disc just played rather than by scanning the whole
 * board: the only line that can be new is one through it.
 */
export function winningLine(board: Board, col: number, row: number): number[] | null {
  const player = at(board, col, row);
  if (player === -1) return null;

  const directions = [
    [1, 0], // horizontal
    [0, 1], // vertical
    [1, 1], // diagonal
    [1, -1], // the other diagonal
  ];

  for (const [dx, dy] of directions) {
    const line = [row * COLUMNS + col];

    for (const sign of [1, -1]) {
      let c = col + dx * sign;
      let r = row + dy * sign;
      while (
        c >= 0 &&
        c < COLUMNS &&
        r >= 0 &&
        r < ROWS &&
        at(board, c, r) === player
      ) {
        line.push(r * COLUMNS + c);
        c += dx * sign;
        r += dy * sign;
      }
    }

    if (line.length >= 4) return line.sort((a, b) => a - b).slice(0, 4);
  }

  return null;
}

/**
 * Drops a disc, or returns null if the move is not legal.
 *
 * Rejects a move by anyone other than the player to act, which is what stops a
 * move arriving out of turn from a lagging device — every recipient makes the
 * same judgement independently.
 */
export function drop(
  position: Position,
  col: number,
  seat: number,
  players = 2,
): Position | null {
  if (position.winner !== null) return null;
  if (seat !== position.turn) return null;

  const row = landing(position.board, col);
  if (row === -1) return null;

  const board = position.board.slice();
  board[row * COLUMNS + col] = seat;

  const line = winningLine(board, col, row);
  const played = position.played + 1;

  return {
    board,
    // Turn only advances when the game is still going, so the loser's seat is
    // not left "to move" on a finished board.
    turn: line ? position.turn : (position.turn + 1) % Math.max(2, players),
    winner: line ? seat : null,
    line,
    played,
  };
}

/** True when the board is full and nobody won. */
export const isDraw = (position: Position): boolean =>
  position.winner === null && position.played >= COLUMNS * ROWS;
