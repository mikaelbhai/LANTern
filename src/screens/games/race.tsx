import React from 'react';
import { motion } from 'framer-motion';
import { Flag, Trophy } from 'lucide-react';
import { Avatar } from '../../components/Avatar';
import { Badge } from '../../components/ui';
import { api, on } from '../../lib/bridge';
import { useStore } from '../../lib/store';
import { sfx } from '../../lib/audio';
import { cn, formatDuration } from '../../lib/utils';
import type { GameSession } from '../../lib/types';

/**
 * Turns a single-player game into a LAN race.
 *
 * Everyone is dealt the identical hand from the session's seed, so the only
 * variable is play. Each client reports its own completion and the rest is
 * presentation — no game state crosses the wire, which keeps a slow link from
 * ever stalling someone's board.
 */
export function useRace({
  session,
  completion,
  moves,
  elapsedMs,
  finished,
}: {
  session: GameSession | null;
  /** 0–1, however this game measures progress. */
  completion: number;
  moves: number;
  elapsedMs: number;
  finished: boolean;
}) {
  const [live, setLive] = React.useState<GameSession | null>(session);

  React.useEffect(() => setLive(session), [session?.id]);

  React.useEffect(
    () => on('game:session', (s: GameSession | null) => setLive(s)),
    [],
  );

  // Report on a timer rather than on every move: a fast player generates
  // moves far quicker than anyone needs to watch them.
  React.useEffect(() => {
    if (!session) return;
    const report = () => {
      void api.game.report(session.id, completion, moves, elapsedMs, finished);
    };
    report();
    const id = setInterval(report, 1500);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.id, completion, finished]);

  // Announce a result once.
  const announced = React.useRef<string | null>(null);
  React.useEffect(() => {
    const winner = live?.winnerId;
    if (!winner || announced.current === winner) return;
    announced.current = winner;
    if (winner === 'me') sfx.gameWin();
    else sfx.gameLose();
  }, [live?.winnerId]);

  return live;
}

/** Live standings beside the board. */
export function RacePanel({
  session,
  myCompletion,
  myMoves,
  myElapsedMs,
  onLeave,
}: {
  session: GameSession;
  myCompletion: number;
  myMoves: number;
  myElapsedMs: number;
  onLeave: () => void;
}) {
  const peers = useStore((s) => s.peers);
  const profile = useStore((s) => s.profile);

  const rows = session.players.map((id) => {
    const mine = id === 'me' || id === profile.id;
    const reported = session.progress[id];
    return {
      id,
      name: mine ? (profile.name || 'You') : (peers[id]?.name ?? 'Peer'),
      color: mine ? profile.color : peers[id]?.color,
      emoji: mine ? profile.emoji : peers[id]?.emoji,
      mine,
      completion: mine ? myCompletion : (reported?.completion ?? 0),
      moves: mine ? myMoves : (reported?.moves ?? 0),
      elapsedMs: mine ? myElapsedMs : (reported?.elapsedMs ?? 0),
      finished: mine ? myCompletion >= 1 : !!reported?.finished,
    };
  });

  rows.sort((a, b) => b.completion - a.completion);
  const winner = session.winnerId;

  return (
    <div className="panel p-3 w-full lg:w-[240px] shrink-0">
      <div className="flex items-center justify-between mb-2.5">
        <span className="label">Race</span>
        <Badge tone="muted">Deal #{session.seed}</Badge>
      </div>

      <div className="space-y-2.5">
        {rows.map((row, i) => (
          <div key={row.id}>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-2xs text-muted w-3 shrink-0">{i + 1}</span>
              <Avatar name={row.name} color={row.color} emoji={row.emoji} size={20} />
              <span
                className={cn(
                  'text-xs truncate flex-1',
                  row.mine ? 'text-txt font-medium' : 'text-dim',
                )}
              >
                {row.name}
              </span>
              {row.finished && (
                <Trophy
                  size={11}
                  className={winner === row.id ? 'text-gold' : 'text-muted'}
                />
              )}
            </div>

            <div className="h-1.5 rounded-full bg-edge overflow-hidden">
              <motion.div
                className={cn('h-full rounded-full', row.mine ? 'bg-gold' : 'bg-cyan/70')}
                animate={{ width: `${Math.round(row.completion * 100)}%` }}
                transition={{ duration: 0.4, ease: 'easeOut' }}
              />
            </div>

            <div className="flex items-center gap-2 mt-1 text-[10px] text-muted font-mono">
              <span>{Math.round(row.completion * 100)}%</span>
              <span>{row.moves} moves</span>
              <span className="ml-auto">{formatDuration(row.elapsedMs)}</span>
            </div>
          </div>
        ))}
      </div>

      {winner && (
        <div
          className={cn(
            'mt-3 p-2 rounded-input border text-center',
            winner === 'me'
              ? 'border-gold/50 bg-gold/10 text-gold'
              : 'border-edge bg-raised text-dim',
          )}
        >
          <div className="text-xs font-medium">
            {winner === 'me'
              ? 'You won'
              : `${peers[winner]?.name ?? 'Your opponent'} won`}
          </div>
        </div>
      )}

      <button
        onClick={onLeave}
        className="mt-3 w-full h-7 rounded-input border border-edge text-2xs text-dim hover:text-txt hover:border-edge-strong flex items-center justify-center gap-1.5"
      >
        <Flag size={11} />
        Leave the race
      </button>
    </div>
  );
}
