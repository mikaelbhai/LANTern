/**
 * Turn-based games across the network.
 *
 * Only moves travel. Every player starts from the same position — the session
 * carries a seed for anything that needs shuffling — applies the same moves in
 * the same order, and therefore holds the same board. A game costs a few dozen
 * bytes a turn, and a slow link delays one person's move rather than freezing
 * everybody's screen.
 *
 * There is no referee, and none is needed. Turn order is deterministic, so
 * every client can decide for itself whether the sender was entitled to move;
 * a move out of turn is dropped independently by everyone who receives it.
 * That also means nobody's game ends when the host closes their laptop.
 *
 * Seats follow the session's own order, which every device has the same copy
 * of because the host broadcasts it. They used to be sorted instead, as a
 * guard against the lists disagreeing — but sorting also meant a seat could
 * move when its occupant changed, which is exactly what must not happen when
 * somebody is substituted in.
 */
import React from 'react';

import { api, on } from '../../lib/bridge';
import { useStore } from '../../lib/store';
import type { GameSession } from '../../lib/types';

/** The local player's identifier inside a session. */
export const ME = 'me';

/** Marks the second, local seat in a pass-and-play game. */
export const SOLO = '~2';

/**
 * Everyone in the game, in a fixed order every device agrees on.
 *
 * The local player is `me` in their own session and their device id in
 * everyone else's, so both spellings collapse to one seat.
 */
export function seats(session: GameSession | null, myId: string): string[] {
  // Alone, it is pass-and-play: two seats, both of them yours. One seat would
  // be worse than useless — these games alternate turns, so the second turn
  // would belong to a player who does not exist and every move after the first
  // would be refused.
  if (!session) return [myId, `${myId}${SOLO}`];

  // "me" is spelled out when the session is stored, so the ids here are
  // already everybody's real ones — see `qualify` in the store.
  return Array.from(new Set(session.players));
}

export interface TurnGame<S, M> {
  /** The position everyone can see. */
  state: S;
  /** Seat order, shared by every device. */
  players: string[];
  /** Which seat this device holds. */
  me: string;
  /** Whose turn it is. */
  turn: string;
  myTurn: boolean;
  /** Plays a move locally and tells everyone else. Ignored when not your turn. */
  play: (move: M) => void;
  /** Starts again from the opening position, for everybody. */
  reset: () => void;
}

/**
 * Runs a game whose rules are a pure function.
 *
 * `apply` returns the next state, or null when the move is not legal — which
 * is also how a move arriving out of turn, or from a stale session, is
 * rejected without any special handling.
 */
export function useTurnGame<S, M>({
  session,
  initial,
  apply,
  turnOf,
}: {
  session: GameSession | null;
  /** The opening position. Given the seed so shuffled games can use it. */
  initial: (seed: number, players: string[]) => S;
  apply: (state: S, move: M, by: string, players: string[]) => S | null;
  /** Whose turn it is in this position. */
  turnOf: (state: S, players: string[]) => string;
}): TurnGame<S, M> {
  const myId = useStore((s) => s.profile.id);
  const players = React.useMemo(() => seats(session, myId), [session, myId]);
  const seed = session?.seed ?? 0;

  const [state, setState] = React.useState<S>(() => initial(seed, players));

  // A new session — or a new seed for the same one — is a new game.
  const dealt = React.useRef<string>('');
  React.useEffect(() => {
    const key = `${session?.id ?? 'solo'}:${seed}:${players.join(',')}`;
    if (dealt.current === key) return;
    dealt.current = key;
    setState(initial(seed, players));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, seed, players.join(',')]);

  const turn = turnOf(state, players);
  // Playing alone, every turn is yours — you are both sides.
  const solo = !session;
  const myTurn = solo || turn === myId;

  /** Applies a move that came from the network. */
  React.useEffect(() => {
    return on('game:move', (msg: { sessionId?: string; move?: M; from?: string }) => {
      if (!session || msg.sessionId !== session.id) return;
      const by = msg.from;
      if (!by || msg.move === undefined) return;

      setState((current) => {
        const next = apply(current, msg.move as M, by, players);
        // An illegal move is simply not applied. It cannot corrupt the board,
        // and there is nothing useful to say to somebody whose client sent it.
        return next ?? current;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, players.join(',')]);

  const play = React.useCallback(
    (move: M) => {
      setState((current) => {
        // Pass-and-play acts for whichever seat is to move, rather than always
        // for this device's own.
        const actor = solo ? turnOf(current, players) : myId;
        const next = apply(current, move, actor, players);
        if (!next) return current;
        // Sent only once the move is known to be legal here, so a rejected
        // move never reaches anybody else.
        if (session) void api.game.move(session.id, move).catch(() => {});
        return next;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session?.id, myId, solo, players.join(',')],
  );

  const reset = React.useCallback(() => {
    setState(initial(seed, players));
    // Everyone else is told by way of a move the games agree means "restart".
    if (session) void api.game.move(session.id, { reset: true }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, seed, players.join(',')]);

  return { state, players, me: myId, turn, myTurn, play, reset };
}

/** A player's display name, whichever side of the link they are on. */
export function usePlayerNames(players: string[]): Record<string, string> {
  const peers = useStore((s) => s.peers);
  const profile = useStore((s) => s.profile);

  return React.useMemo(() => {
    const out: Record<string, string> = {};
    for (const id of players) {
      if (id.endsWith(SOLO)) {
        out[id] = 'You (2)';
      } else {
        out[id] =
          id === profile.id || id === ME
            ? profile.name || 'You'
            : (peers[id]?.name ?? 'Player');
      }
    }
    return out;
  }, [players, peers, profile]);
}
