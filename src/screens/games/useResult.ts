/**
 * Writing down how a match went, once.
 *
 * Every game notices it is over in its own way — a line of four, a third set,
 * a king with nowhere to go — but they all want the same thing done about it.
 * This is that thing, and the "once" is the whole point of it: a component
 * that re-renders while the winner is on screen would otherwise record the
 * same win on every frame.
 */
import React from 'react';

import { useStore } from '../../lib/store';
import type { GameKind } from '../../lib/types';

export function useResult({
  game,
  /** Something that identifies this particular match. Usually the session id. */
  matchId,
  over,
  players,
  winners,
  points,
}: {
  game: GameKind;
  matchId: string | null;
  over: boolean;
  players: string[];
  /** Everybody who won it. Empty for a draw; more than one for a team game. */
  winners: string[];
  /** What each player scored, where the game counts anything. */
  points?: Record<string, number>;
}) {
  const recordResult = useStore((s) => s.recordResult);

  // Held in refs rather than state: recording a result must not itself cause
  // a render, and the guard has to survive the render it would have caused.
  //
  // Written on the way *into* being over, and cleared on the way out, which is
  // what makes a second match in the same session count. Keying on the session
  // alone would silently drop every rematch, because the record refuses a
  // session it has already seen.
  const written = React.useRef(false);
  const match = React.useRef(0);

  // The payload is compared by value, so a new object each render does not
  // re-fire the effect.
  const signature = JSON.stringify({ players, winners, points });

  React.useEffect(() => {
    if (!over || !matchId) {
      written.current = false;
      return;
    }
    if (written.current) return;
    written.current = true;
    match.current++;

    const { players: p, winners: w, points: pts } = JSON.parse(signature) as {
      players: string[];
      winners: string[];
      points?: Record<string, number>;
    };
    recordResult({
      sessionId: `${matchId}#${match.current}`,
      game,
      players: p,
      winners: w,
      points: pts,
    });
  }, [over, matchId, game, signature, recordResult]);
}
