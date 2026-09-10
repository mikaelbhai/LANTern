/**
 * Who has won what.
 *
 * Games on a LAN are played by the same handful of people over and over, and
 * the interesting number is not who won the last one — everybody watched that
 * — but who has been winning all evening. So results are kept.
 *
 * Kept on each device rather than on a server there isn't one of. Every device
 * watching a match sees the same result, so every device writes down the same
 * thing, and a record is only ever as complete as the games that device was
 * present for. That is the honest limit of it and the screen says so.
 */
import type { GameKind } from './types';

export interface Tally {
  played: number;
  won: number;
  /**
   * Whatever the game counts.
   *
   * Not comparable between games — sequences are not sets are not rows of a
   * road — so it is only ever shown next to the game it came from.
   */
  points: number;
}

export interface PlayerRecord extends Tally {
  /** Captured at the time, so a record outlives a peer going offline. */
  name: string;
  lastSeen: number;
}

export interface Scores {
  /** My own record, per game. */
  byGame: Record<string, Tally>;
  /** Everybody's, across all games. */
  byPlayer: Record<string, PlayerRecord>;
  /** Sessions already counted, so one match is never recorded twice. */
  counted: string[];
}

export const emptyScores = (): Scores => ({ byGame: {}, byPlayer: {}, counted: [] });

/** One finished match. */
export interface Result {
  sessionId: string;
  game: GameKind;
  /** Everyone who was in it, by peer id. */
  players: string[];
  /** Who won, or null for a draw. */
  winnerId: string | null;
  /** What each player scored, if the game counts anything. */
  points?: Record<string, number>;
  /** Names to remember them by. */
  names?: Record<string, string>;
}

const blank = (): Tally => ({ played: 0, won: 0, points: 0 });

/**
 * Folds a result into the record.
 *
 * Pure, and keyed by session, so calling it twice for the same match — which
 * happens the moment two components both notice the game is over — changes
 * nothing the second time.
 */
export function record(scores: Scores, result: Result, me: string): Scores {
  if (scores.counted.includes(result.sessionId)) return scores;

  const byGame = { ...scores.byGame };
  const byPlayer = { ...scores.byPlayer };
  const now = Date.now();

  if (result.players.includes(me)) {
    const mine = { ...(byGame[result.game] ?? blank()) };
    mine.played++;
    if (result.winnerId === me) mine.won++;
    mine.points += result.points?.[me] ?? 0;
    byGame[result.game] = mine;
  }

  for (const id of result.players) {
    const previous = byPlayer[id];
    const entry: PlayerRecord = {
      played: (previous?.played ?? 0) + 1,
      won: (previous?.won ?? 0) + (result.winnerId === id ? 1 : 0),
      points: (previous?.points ?? 0) + (result.points?.[id] ?? 0),
      name: result.names?.[id] ?? previous?.name ?? 'Someone',
      lastSeen: now,
    };
    byPlayer[id] = entry;
  }

  return {
    byGame,
    byPlayer,
    // Only the recent ones need remembering: the list exists to stop a repeat
    // arriving seconds later, not to be a history.
    counted: [...scores.counted, result.sessionId].slice(-200),
  };
}

/** Everybody, best first. */
export function standings(scores: Scores): (PlayerRecord & { id: string })[] {
  return Object.entries(scores.byPlayer)
    .map(([id, r]) => ({ ...r, id }))
    .sort((a, b) => b.won - a.won || b.points - a.points || a.name.localeCompare(b.name));
}
