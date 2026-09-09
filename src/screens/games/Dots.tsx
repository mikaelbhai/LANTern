/**
 * Dots and Boxes, for two to four people.
 *
 * The game that most earns its place on a LAN app: it needs no hidden
 * information, so every device can hold the whole position, and it is better
 * with four people than with two — which is the opposite of the solitaires it
 * replaces.
 *
 * Rules in `lib/dots.ts`, applied identically on every device. See
 * `turns.tsx`.
 */
import React from 'react';
import { motion } from 'framer-motion';
import { RotateCcw, Trophy } from 'lucide-react';

import { Badge, Button } from '../../components/ui';
import {
  create,
  draw,
  horizontal,
  horizontalCount,
  isOver,
  leaders,
  vertical,
} from '../../lib/dots';
import type { Position } from '../../lib/dots';
import { useStore } from '../../lib/store';
import { cn } from '../../lib/utils';
import { sfx } from '../../lib/audio';
import { GameShell } from './GameShell';
import { useTurnGame, usePlayerNames } from './turns';

const SEAT_COLOURS = ['#F5A623', '#39D9C8', '#9B8CFF', '#7BD88F'];

/** Five boxes square: long enough to have an endgame, short enough to finish. */
const SETUP = { cols: 5, rows: 5 };

type Move = { line: number } | { reset: true };

export function Dots({ onExit }: { onExit: () => void }) {
  const session = useStore((s) => s.gameSession);
  const active = session && session.game === 'dots' ? session : null;

  const game = useTurnGame<Position, Move>({
    session: active,
    initial: (_seed, players) => create(SETUP, players.length),
    apply: (position, move, by, players) => {
      if ('reset' in move) return create(SETUP, players.length);
      const seat = players.indexOf(by);
      if (seat === -1) return null;
      return draw(position, move.line, seat);
    },
    turnOf: (position, players) => players[position.turn % players.length],
  });

  const { state, players, me, turn, myTurn, play, reset } = game;
  const names = usePlayerNames(players);
  const mySeat = players.indexOf(me);
  const over = isOver(state);

  const announced = React.useRef(false);
  React.useEffect(() => {
    if (!over) {
      announced.current = false;
      return;
    }
    if (announced.current) return;
    announced.current = true;
    leaders(state).includes(mySeat) ? sfx.gameWin() : sfx.gameLose();
  }, [over, state, mySeat]);

  const take = (line: number) => {
    if (!myTurn || over || state.lines[line] !== -1) return;
    sfx.cardPlace();
    play({ line });
  };

  const winners = over ? leaders(state) : [];
  const status = over
    ? winners.length > 1
      ? 'A tie'
      : `${names[players[winners[0]]] ?? 'Someone'} wins`
    : myTurn
      ? 'Your turn'
      : `${names[turn] ?? 'Waiting'}…`;

  // Laid out on a grid of alternating dot and line tracks: a dot, then the
  // gap a horizontal line sits in, and so on.
  const cell = 'clamp(26px, 6vw, 46px)';
  const gap = '10px';

  return (
    <GameShell
      title="Dots & Boxes"
      themeKey="lantern.dots.theme"
      onExit={onExit}
      onRestart={reset}
      moves={state.lines.filter((l) => l !== -1).length}
      running={!over}
      status={
        <>
          <Badge tone={over ? 'gold' : myTurn ? 'cyan' : 'muted'}>{status}</Badge>
          {active && <Badge tone="muted">{players.length} playing</Badge>}
        </>
      }
    >
      {() => (
        <div className="h-full flex flex-col lg:flex-row gap-4 p-4 items-start justify-center">
          <div className="panel p-3 w-full lg:w-[210px] shrink-0 order-2 lg:order-1">
            <span className="label">Scores</span>
            <div className="space-y-2 mt-2">
              {players.map((id, seat) => (
                <div
                  key={id}
                  className={cn(
                    'flex items-center gap-2 rounded-input px-2 py-1.5 border transition-colors',
                    turn === id && !over ? 'border-gold/40 bg-gold/10' : 'border-transparent',
                  )}
                >
                  <span
                    className="h-4 w-4 rounded-sm shrink-0 border border-black/40"
                    style={{ background: SEAT_COLOURS[seat % SEAT_COLOURS.length] }}
                  />
                  <span className="text-xs truncate flex-1">{names[id]}</span>
                  <span className="text-xs font-mono tabular-nums">{state.scores[seat] ?? 0}</span>
                  {over && winners.includes(seat) && <Trophy size={12} className="text-gold" />}
                </div>
              ))}
            </div>

            {over && (
              <Button size="sm" full icon={<RotateCcw size={13} />} onClick={reset} className="mt-3">
                Play again
              </Button>
            )}

            <p className="text-2xs text-muted leading-relaxed mt-3">
              Close a box and you go again. {!active && 'Start this from Games or a call and everyone plays the same board.'}
            </p>
          </div>

          <div className="order-1 lg:order-2 overflow-auto">
            <div
              className="grid"
              style={{
                gridTemplateColumns: `repeat(${SETUP.cols}, ${gap} ${cell}) ${gap}`,
                gridTemplateRows: `repeat(${SETUP.rows}, ${gap} ${cell}) ${gap}`,
              }}
            >
              {Array.from({ length: (SETUP.rows * 2 + 1) * (SETUP.cols * 2 + 1) }, (_, i) => {
                const width = SETUP.cols * 2 + 1;
                const gx = i % width;
                const gy = Math.floor(i / width);
                const onDotX = gx % 2 === 0;
                const onDotY = gy % 2 === 0;

                // A dot.
                if (onDotX && onDotY) {
                  return (
                    <span
                      key={i}
                      className="rounded-full bg-dim/70 place-self-center"
                      style={{ height: 5, width: 5 }}
                    />
                  );
                }

                // A horizontal line: between two dots on a dot row.
                if (onDotY && !onDotX) {
                  const line = horizontal(SETUP, (gx - 1) / 2, gy / 2);
                  return <Segment key={i} horizontal line={line} state={state} onTake={take} myTurn={myTurn && !over} />;
                }

                // A vertical line.
                if (!onDotY && onDotX) {
                  const line = vertical(SETUP, gx / 2, (gy - 1) / 2);
                  return <Segment key={i} line={line} state={state} onTake={take} myTurn={myTurn && !over} />;
                }

                // The middle of a box.
                const box = ((gy - 1) / 2) * SETUP.cols + (gx - 1) / 2;
                const owner = state.boxes[box];
                return (
                  <span key={i} className="grid place-items-center">
                    {owner !== -1 && (
                      <motion.span
                        initial={{ scale: 0.4, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        className="h-full w-full rounded-[3px]"
                        style={{
                          background: `${SEAT_COLOURS[owner % SEAT_COLOURS.length]}44`,
                          border: `1px solid ${SEAT_COLOURS[owner % SEAT_COLOURS.length]}`,
                        }}
                      />
                    )}
                  </span>
                );
              })}
            </div>

            <p className="text-2xs text-muted mt-2 text-center">
              {over ? status : myTurn ? 'Draw a line between two dots' : `Waiting for ${names[turn] ?? 'the others'}`}
            </p>
          </div>
        </div>
      )}
    </GameShell>
  );
}

/** One drawable line. */
function Segment({
  line,
  state,
  onTake,
  myTurn,
  horizontal: isHorizontal,
}: {
  line: number;
  state: Position;
  onTake: (line: number) => void;
  myTurn: boolean;
  horizontal?: boolean;
}) {
  const owner = state.lines[line];
  const taken = owner !== -1;

  return (
    <button
      onClick={() => onTake(line)}
      disabled={taken || !myTurn}
      aria-label={`Line ${line}`}
      className={cn(
        'place-self-stretch rounded-full transition-colors m-[3px]',
        taken ? '' : myTurn ? 'bg-edge hover:bg-gold/60 cursor-pointer' : 'bg-edge/50',
      )}
      style={
        taken
          ? { background: SEAT_COLOURS[owner % SEAT_COLOURS.length] }
          : undefined
      }
    />
  );
}
