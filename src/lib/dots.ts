/**
 * Dots and Boxes.
 *
 * Chosen to replace a solitaire because it is genuinely better with more
 * people: two is fine, four is a party, and it needs no hidden information —
 * which means every device can hold the whole position and no referee is
 * needed to keep a secret.
 *
 * Rules as a pure function, apart from the screen, so both ends apply the same
 * move and cannot disagree. See `screens/games/turns.tsx`.
 *
 * Lines are indexed rather than stored as coordinates: horizontal lines first,
 * then vertical, so a move is one number.
 */

export interface Setup {
  /** Boxes across and down. Lines and dots are one more in each direction. */
  cols: number;
  rows: number;
}

export interface Position {
  cols: number;
  rows: number;
  /** Which player drew each line, or -1. */
  lines: number[];
  /** Which player closed each box, or -1. */
  boxes: number[];
  turn: number;
  /** Boxes each player has closed. */
  scores: number[];
}

export const horizontalCount = ({ cols, rows }: Setup) => cols * (rows + 1);
export const verticalCount = ({ cols, rows }: Setup) => (cols + 1) * rows;
export const lineCount = (s: Setup) => horizontalCount(s) + verticalCount(s);

export function create(setup: Setup, players: number): Position {
  return {
    cols: setup.cols,
    rows: setup.rows,
    lines: new Array(lineCount(setup)).fill(-1),
    boxes: new Array(setup.cols * setup.rows).fill(-1),
    turn: 0,
    scores: new Array(Math.max(2, players)).fill(0),
  };
}

/** The line index of the horizontal segment above box row `r`, column `c`. */
export const horizontal = (p: Setup, c: number, r: number) => r * p.cols + c;

/** The line index of the vertical segment left of box row `r`, column `c`. */
export const vertical = (p: Setup, c: number, r: number) =>
  horizontalCount(p) + r * (p.cols + 1) + c;

/** The four lines that enclose one box. */
export function sidesOf(p: Setup, box: number): number[] {
  const c = box % p.cols;
  const r = Math.floor(box / p.cols);
  return [
    horizontal(p, c, r), // top
    horizontal(p, c, r + 1), // bottom
    vertical(p, c, r), // left
    vertical(p, c + 1, r), // right
  ];
}

/**
 * Draws a line.
 *
 * Closing a box earns another turn — the rule that makes the endgame worth
 * playing — so the turn only passes when nothing was closed.
 *
 * Returns null when the move is not legal, including when it is not this
 * player's turn. Every device makes that judgement identically, which is what
 * lets a move be broadcast without a referee.
 */
export function draw(position: Position, line: number, seat: number): Position | null {
  if (seat !== position.turn) return null;
  if (line < 0 || line >= position.lines.length) return null;
  if (position.lines[line] !== -1) return null;

  const lines = position.lines.slice();
  lines[line] = seat;

  const boxes = position.boxes.slice();
  const scores = position.scores.slice();
  const setup = { cols: position.cols, rows: position.rows };

  let closed = 0;
  for (let box = 0; box < boxes.length; box++) {
    if (boxes[box] !== -1) continue;
    if (sidesOf(setup, box).every((side) => lines[side] !== -1)) {
      boxes[box] = seat;
      scores[seat] = (scores[seat] ?? 0) + 1;
      closed++;
    }
  }

  return {
    ...position,
    lines,
    boxes,
    scores,
    // Another go for closing a box; otherwise round it goes.
    turn: closed > 0 ? seat : (seat + 1) % scores.length,
  };
}

export const isOver = (position: Position): boolean =>
  position.boxes.every((b) => b !== -1);

/** Everyone on the top score — a tie is a real outcome here. */
export function leaders(position: Position): number[] {
  const best = Math.max(...position.scores);
  return position.scores
    .map((score, seat) => ({ score, seat }))
    .filter((s) => s.score === best)
    .map((s) => s.seat);
}
