/**
 * Crossy Road: hop forward, do not get hit.
 *
 * Multiplayer without any of the game crossing the network. The world is
 * generated from the session's seed, so every device builds the identical
 * road; traffic is a pure function of the row and the clock, so everyone sees
 * the same lorry in the same place at the same moment. All that travels is
 * where each player has got to — a few numbers, a few times a second.
 *
 * That also means a dropped packet costs somebody's little avatar a moment of
 * smoothness rather than desynchronising the game.
 *
 * The clock comes from the session's start time, which every player already
 * has, so nobody needs their clocks to agree beyond the second.
 */

export type RowKind = 'grass' | 'road' | 'river' | 'rail';

export interface Row {
  kind: RowKind;
  /** Lanes move left when negative. Cells per second. */
  speed: number;
  /** How far apart the obstacles are, in cells. */
  spacing: number;
  /** Where the pattern starts, so lanes do not line up into walls. */
  offset: number;
  /** How wide each obstacle is, in cells. Logs are wide, cars are not. */
  width: number;
}

export const LANES = 17;
/** How far ahead the world is built. Anything beyond is generated on demand. */
export const VIEW_ROWS = 14;

/** A small deterministic hash: same row, same world, on every device. */
function hash(seed: number, row: number): number {
  let h = (seed ^ (row * 374761393)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * What kind of row this is.
 *
 * The first few are always grass, so nobody is run over before they have
 * understood the game. After that it is weighted: roads most often, rivers and
 * rails to break the rhythm, and grass often enough to breathe.
 */
export function rowAt(seed: number, index: number): Row {
  if (index <= 2) {
    return { kind: 'grass', speed: 0, spacing: 0, offset: 0, width: 0 };
  }

  const r = hash(seed, index);
  const kind: RowKind = r < 0.46 ? 'road' : r < 0.62 ? 'river' : r < 0.72 ? 'rail' : 'grass';

  if (kind === 'grass') {
    return { kind, speed: 0, spacing: 0, offset: 0, width: 0 };
  }

  const direction = hash(seed, index * 7 + 1) < 0.5 ? -1 : 1;
  const fast = hash(seed, index * 13 + 3);

  if (kind === 'rail') {
    // A train is rare, wide and quick — the row you wait at.
    return {
      kind,
      speed: direction * (7 + fast * 4),
      spacing: 22 + Math.floor(fast * 10),
      offset: hash(seed, index * 5 + 9) * 30,
      width: 4,
    };
  }

  if (kind === 'river') {
    return {
      kind,
      speed: direction * (1.2 + fast * 1.6),
      spacing: 5 + Math.floor(hash(seed, index * 3 + 5) * 3),
      offset: hash(seed, index * 5 + 9) * 30,
      width: 3, // logs, and you must be on one
    };
  }

  return {
    kind,
    speed: direction * (1.8 + fast * 3.4),
    spacing: 5 + Math.floor(hash(seed, index * 3 + 5) * 5),
    offset: hash(seed, index * 5 + 9) * 30,
    width: 2,
  };
}

/**
 * Where the obstacles are on a row at a given moment.
 *
 * Returned as the left edge of each one, in cells, only for those on screen.
 */
export function obstaclesAt(row: Row, seconds: number): number[] {
  if (!row.spacing) return [];

  const drift = row.offset + row.speed * seconds;
  const out: number[] = [];
  // Start from the first multiple of the spacing that could be visible.
  const first = Math.floor((-row.width - drift) / row.spacing) - 1;
  const last = Math.ceil((LANES + row.width - drift) / row.spacing) + 1;

  for (let n = first; n <= last; n++) {
    out.push(n * row.spacing + drift);
  }
  return out;
}

/** True when the cell is inside an obstacle on this row. */
export function occupied(row: Row, seconds: number, cell: number): boolean {
  for (const left of obstaclesAt(row, seconds)) {
    if (cell + 0.999 > left && cell < left + row.width) return true;
  }
  return false;
}

export interface Player {
  /** How far forward, in rows. */
  row: number;
  /** Which cell across. Fractional while riding a log. */
  cell: number;
  alive: boolean;
  /** Furthest row reached, which is the score. */
  best: number;
}

export const start = (): Player => ({ row: 0, cell: Math.floor(LANES / 2), alive: true, best: 0 });

export type Direction = 'forward' | 'back' | 'left' | 'right';

/**
 * One hop.
 *
 * Movement is by whole cells and only when alive; the consequences — drowning,
 * being hit — are decided by `settle` on the next frame, so a hop onto a log
 * that is about to leave is judged by where things actually are.
 */
export function hop(player: Player, direction: Direction): Player {
  if (!player.alive) return player;

  let { row, cell } = player;
  if (direction === 'forward') row += 1;
  if (direction === 'back') row = Math.max(0, row - 1);
  if (direction === 'left') cell -= 1;
  if (direction === 'right') cell += 1;

  cell = Math.max(0, Math.min(LANES - 1, cell));
  return { ...player, row, cell, best: Math.max(player.best, row) };
}

/**
 * Applies the world to a player: carried by logs, hit by traffic, drowned.
 *
 * `delta` is the time since the last settle, which is what a log moves them by.
 */
export function settle(player: Player, seed: number, seconds: number, delta: number): Player {
  if (!player.alive) return player;

  const row = rowAt(seed, player.row);
  let cell = player.cell;

  if (row.kind === 'river') {
    const onLog = occupied(row, seconds, cell);
    if (!onLog) return { ...player, alive: false };
    // Carried along with it.
    cell += row.speed * delta;
    if (cell < 0 || cell > LANES - 1) return { ...player, alive: false };
  } else if (row.kind === 'road' || row.kind === 'rail') {
    if (occupied(row, seconds, cell)) return { ...player, alive: false };
  }

  return { ...player, cell };
}
