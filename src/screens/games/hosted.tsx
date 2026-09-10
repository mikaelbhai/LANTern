/**
 * Games with hidden hands.
 *
 * `turns.tsx` works by every device replaying the same moves and arriving at
 * the same position. That is exactly wrong for a card game: if every client
 * can derive the whole game, every client can read every hand.
 *
 * So one device — the one that started the game — runs it. Players send it
 * what they want to do; it decides, and tells each player privately what they
 * are allowed to see. Nothing else changes: the same links carry it, and the
 * host is a peer like any other rather than a server anybody has to run.
 *
 * The cost is that the game ends if the host leaves. That is the right trade
 * for a game played by people who are in a call together; the alternative is
 * dealing cards nobody can keep secret.
 */
import React from 'react';

import { api, on } from '../../lib/bridge';
import { useStore } from '../../lib/store';
import type { GameSession } from '../../lib/types';

export interface Hosted<S, V, I> {
  /** What this player can see. Null until the host has said. */
  view: V | null;
  /** Everyone playing, in an order every device agrees on. */
  players: string[];
  me: string;
  isHost: boolean;
  /** Asks the host to do something. On the host, applied directly. */
  send: (intent: I) => void;
  /** Starts the game again. Host only; ignored elsewhere. */
  restart: () => void;
  /** The full state, on the host only — for anything the view omits. */
  full: S | null;
}

export function useHostedGame<S, V, I>({
  session,
  create,
  apply,
  redact,
}: {
  session: GameSession | null;
  /** The opening position. */
  create: (seed: number, players: string[]) => S;
  /** Applies an intent from `by`, or returns null if it is not allowed. */
  apply: (state: S, intent: I, by: string, players: string[]) => S | null;
  /** What `forPlayer` is allowed to see. */
  redact: (state: S, forPlayer: string, players: string[]) => V;
}): Hosted<S, V, I> {
  const myId = useStore((s) => s.profile.id);

  // Seats in the session's own order, which every device has the same copy of.
  // Not sorted: a sorted seat can move when its occupant changes, and a
  // substitution has to leave the seat exactly where it was.
  const players = React.useMemo(() => {
    if (!session) return [myId];
    return Array.from(new Set(session.players));
  }, [session, myId]);

  const hostId = React.useMemo(() => session?.hostId ?? myId, [session, myId]);

  const isHost = hostId === myId;
  const seed = session?.seed ?? 1;

  // The rules arrive as props and are rebuilt on every render, so they are
  // held in refs: a callback that closed over the first render's copy would
  // still work, but only by accident.
  const rules = React.useRef({ create, apply, redact });
  rules.current = { create, apply, redact };

  const [full, setFull] = React.useState<S | null>(null);
  const [view, setView] = React.useState<V | null>(null);

  /**
   * The host's copy, mirrored outside React.
   *
   * Applying a move inside a `setState` updater would be the obvious way to
   * write this and is wrong twice over: the updater has to send messages over
   * the network, which is not something React may do twice, and StrictMode
   * does exactly that — every move applied and published two times.
   */
  const fullRef = React.useRef<S | null>(null);

  /** Sends each player their own view, and keeps the host's. */
  const publish = React.useCallback(
    (state: S) => {
      fullRef.current = state;
      setFull(state);
      setView(rules.current.redact(state, myId, players));
      if (!session) return;
      for (const id of players) {
        if (id === myId) continue;
        void api.game.send(id, 'state', rules.current.redact(state, id, players) as unknown)
          .catch(() => {});
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session?.id, myId, players.join(',')],
  );

  /** Applies one player's move, on the host. */
  const applyHere = React.useCallback(
    (intent: I, by: string) => {
      const current = fullRef.current;
      if (!current) return;
      const next = rules.current.apply(current, intent, by, players);
      // Not allowed is simply not done. There is nothing useful to say to a
      // client that asked for something illegal.
      if (!next) return;
      publish(next);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [publish, players.join(',')],
  );

  // A new game — or a new session — deals again, on the host.
  const dealt = React.useRef('');
  React.useEffect(() => {
    const key = `${session?.id ?? 'solo'}:${seed}:${players.join(',')}`;
    if (dealt.current === key) return;
    dealt.current = key;
    if (isHost) publish(rules.current.create(seed, players));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, seed, isHost, players.join(',')]);

  /** A player's request, arriving at the host. */
  React.useEffect(() => {
    if (!isHost) return;
    return on('game:intent', (msg: { intent?: I; from?: string }) => {
      if (!msg.from || msg.intent === undefined) return;
      applyHere(msg.intent as I, msg.from);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, applyHere]);

  /** The host's account of the game, arriving at a player. */
  React.useEffect(() => {
    if (isHost) return;
    return on('game:state', (msg: { from?: string } & Record<string, unknown>) => {
      // Only from the host: another player cannot rewrite your board.
      if (msg.from && msg.from !== hostId && msg.from !== session?.hostId) return;
      setView(msg as unknown as V);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, hostId, session?.hostId]);

  const send = React.useCallback(
    (intent: I) => {
      if (isHost) {
        applyHere(intent, myId);
        return;
      }
      void api.game.send(hostId, 'intent', { intent } as unknown).catch(() => {});
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isHost, hostId, myId, applyHere],
  );

  const restart = React.useCallback(() => {
    if (!isHost) return;
    publish(rules.current.create(seed, players));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, seed, players.join(',')]);

  return { view, players, me: myId, isHost, send, restart, full };
}
