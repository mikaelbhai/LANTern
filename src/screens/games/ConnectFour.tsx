/**
 * Connect Four, for two to four people on the network.
 *
 * The rules live in `lib/connect4.ts` so both ends run the same function on
 * the same move and cannot disagree about the board — see `turns.tsx` for why
 * that removes the need for a referee.
 *
 * More than two players is not the traditional game, but it is the one worth
 * having here: a call with four people in it should not have to nominate two.
 * Each seat gets a colour and the turn goes round.
 */
import React from 'react';
import { motion } from 'framer-motion';
import { RotateCcw, Trophy } from 'lucide-react';

import { Avatar } from '../../components/Avatar';
import { Badge, Button } from '../../components/ui';
import { COLUMNS, ROWS, at, drop, empty, isDraw, landing } from '../../lib/connect4';
import type { Position } from '../../lib/connect4';
import { useStore } from '../../lib/store';
import { cn } from '../../lib/utils';
import { sfx } from '../../lib/audio';
import { GameShell } from './GameShell';
import { useLeaveGuard } from './LeaveGuard';
import { useResult } from './useResult';
import { useTurnGame, usePlayerNames } from './turns';

/** One colour per seat, in seat order. */
const SEAT_COLOURS = ['#F5A623', '#39D9C8', '#9B8CFF', '#E05C5C'];

type Move = { col: number } | { reset: true };

export function ConnectFour({ onExit }: { onExit: () => void }) {
  const session = useStore((s) => s.gameSession);
  const active = session && session.game === 'connect4' ? session : null;

  const game = useTurnGame<Position, Move>({
    session: active,
    initial: () => empty(),
    apply: (position, move, by, players) => {
      if ('reset' in move) return empty();
      const seat = players.indexOf(by);
      if (seat === -1) return null;
      return drop(position, move.col, seat, players.length);
    },
    turnOf: (position, players) => players[position.turn % players.length],
  });

  const { state, players, me, turn, myTurn, play, reset } = game;
  const names = usePlayerNames(players);
  const mySeat = players.indexOf(me);

  // Leaving a live game asks first, and holds the seat for a minute.
  const leave = useLeaveGuard(onExit, players.length);

  const finished = state.winner !== null || isDraw(state);

  useResult({
    game: 'connect4',
    matchId: active?.id ?? null,
    over: finished,
    players,
    winnerId: state.winner !== null ? (players[state.winner] ?? null) : null,
  });

  // A result is worth hearing, once.
  const announced = React.useRef(false);
  React.useEffect(() => {
    if (!finished) {
      announced.current = false;
      return;
    }
    if (announced.current) return;
    announced.current = true;
    if (state.winner === mySeat) sfx.gameWin();
    else if (state.winner !== null) sfx.gameLose();
  }, [finished, state.winner, mySeat]);

  const drops = (col: number) => {
    if (!myTurn || finished) return;
    if (landing(state.board, col) === -1) return;
    sfx.cardPlace();
    play({ col });
  };

  const status = state.winner !== null
    ? `${names[players[state.winner]] ?? 'Someone'} wins`
    : isDraw(state)
      ? 'A draw'
      : myTurn
        ? 'Your turn'
        : `${names[turn] ?? 'Waiting'}…`;

  return (
    <>
    <GameShell
      title="Connect Four"
      themeKey="lantern.connect4.theme"
      onExit={leave.requestExit}
      onRestart={reset}
      moves={state.played}
      running={!finished}
      status={
        <>
          <Badge tone={finished ? 'gold' : myTurn ? 'cyan' : 'muted'}>{status}</Badge>
          {active && <Badge tone="muted">{players.length} playing</Badge>}
        </>
      }
    >
      {() => (
        <div className="h-full flex flex-col lg:flex-row gap-4 p-4 items-start justify-center">
          {/* who is in, and whose turn */}
          <div className="panel p-3 w-full lg:w-[210px] shrink-0 order-2 lg:order-1">
            <span className="label">Players</span>
            <div className="space-y-2 mt-2">
              {players.map((id, seat) => (
                <div
                  key={id}
                  className={cn(
                    'flex items-center gap-2 rounded-input px-2 py-1.5 border transition-colors',
                    turn === id && !finished
                      ? 'border-gold/40 bg-gold/10'
                      : 'border-transparent',
                  )}
                >
                  <span
                    className="h-4 w-4 rounded-full shrink-0 border border-black/40"
                    style={{ background: SEAT_COLOURS[seat % SEAT_COLOURS.length] }}
                  />
                  <span className="text-xs truncate flex-1">{names[id]}</span>
                  {state.winner === seat && <Trophy size={12} className="text-gold" />}
                </div>
              ))}
            </div>

            {finished && (
              <Button size="sm" full icon={<RotateCcw size={13} />} onClick={reset} className="mt-3">
                Play again
              </Button>
            )}

            {!active && (
              <p className="text-2xs text-muted leading-relaxed mt-3">
                Nobody else is in this one. Start it from Games with “Play together”, or from
                a call, and everyone joins the same board.
              </p>
            )}
          </div>

          {/* the board */}
          <div className="order-1 lg:order-2">
            <div className="rounded-card border border-edge bg-surface p-2.5">
              <div
                className="grid gap-1.5"
                style={{ gridTemplateColumns: `repeat(${COLUMNS}, minmax(0, 1fr))` }}
              >
                {Array.from({ length: ROWS * COLUMNS }, (_, i) => {
                  const col = i % COLUMNS;
                  const row = Math.floor(i / COLUMNS);
                  const seat = at(state.board, col, row);
                  const won = state.line?.includes(i);

                  return (
                    <button
                      key={i}
                      onClick={() => drops(col)}
                      disabled={!myTurn || finished}
                      aria-label={`Column ${col + 1}`}
                      className={cn(
                        'relative rounded-full transition-colors',
                        'h-[clamp(30px,7vw,52px)] w-[clamp(30px,7vw,52px)]',
                        'bg-base border border-edge',
                        myTurn && !finished && 'hover:border-gold/50 cursor-pointer',
                        won && 'ring-2 ring-gold',
                      )}
                    >
                      {seat !== -1 && (
                        <motion.span
                          layoutId={`disc-${i}`}
                          initial={{ y: -40, opacity: 0 }}
                          animate={{ y: 0, opacity: 1 }}
                          transition={{ type: 'spring', stiffness: 400, damping: 26 }}
                          className="absolute inset-[3px] rounded-full border border-black/40"
                          style={{ background: SEAT_COLOURS[seat % SEAT_COLOURS.length] }}
                        />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            <p className="text-2xs text-muted mt-2 text-center">
              {finished
                ? status
                : myTurn
                  ? 'Drop a disc in any column'
                  : `Waiting for ${names[turn] ?? 'the other player'}`}
            </p>
          </div>
        </div>
      )}
    </GameShell>
      {leave.dialog}
    </>
  );
}
