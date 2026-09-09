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

  // Seats in an order every device agrees on. Sorting rather than trusting
  // arrival order matters: the host's list and a late joiner's could differ.
  const players = React.useMemo(() => {
    if (!session) return [myId];
    const named = session.players.map((p) => (p === 'me' ? myId : p));
    return Array.from(new Set(named)).sort();
  }, [session, myId]);

  const hostId = React.useMemo(() => {
    if (!session) return myId;
    return session.hostId === 'me' ? myId : session.hostId;
  }, [session, myId]);

  const isHost = hostId === myId;
  const seed = session?.seed ?? 1;

  // The host's copy. Nobody else has one.
  const [full, setFull] = React.useState<S | null>(() => (isHost ? create(seed, players) : null));
  const [view, setView] = React.useState<V | null>(() =>
    isHost ? redact(create(seed, players), myId, players) : null,
  );

  /** Sends each player their own view, and keeps the host's. */
  const publish = React.useCallback(
    (state: S) => {
      setFull(state);
      setView(redact(state, myId, players));
      if (!session) return;
      for (const id of players) {
        if (id === myId) continue;
        void api.game.send(id, 'state', redact(state, id, players) as unknown).catch(() => {});
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [session?.id, myId, players.join(',')],
  );

  // A new game — or a new session — deals again, on the host.
  const dealt = React.useRef('');
  React.useEffect(() => {
    const key = `${session?.id ?? 'solo'}:${seed}:${players.join(',')}`;
    if (dealt.current === key) return;
    dealt.current = key;
    if (isHost) publish(create(seed, players));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, seed, isHost, players.join(',')]);

  /** A player's request, arriving at the host. */
  React.useEffect(() => {
    if (!isHost) return;
    return on('game:intent', (msg: { intent?: I; from?: string }) => {
      if (!msg.from || msg.intent === undefined) return;
      setFull((current) => {
        if (!current) return current;
        const next = apply(current, msg.intent as I, msg.from!, players);
        // Not allowed is simply not done. There is nothing useful to say to a
        // client that asked for something illegal.
        if (!next) return current;
        publish(next);
        return next;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, players.join(',')]);

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
        setFull((current) => {
          if (!current) return current;
          const next = apply(current, intent, myId, players);
          if (!next) return current;
          publish(next);
          return next;
        });
        return;
      }
      void api.game.send(hostId, 'intent', { intent } as unknown).catch(() => {});
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [isHost, hostId, myId, players.join(',')],
  );

  const restart = React.useCallback(() => {
    if (!isHost) return;
    publish(create(seed, players));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isHost, seed, players.join(',')]);

  return { view, players, me: myId, isHost, send, restart, full };
}
