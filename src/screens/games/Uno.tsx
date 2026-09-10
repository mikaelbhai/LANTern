/**
 * Uno, for two to eight people on the network.
 *
 * The rules are in `lib/uno.ts`; this is the table. Like Monopoly Deal it runs
 * on `hosted.tsx` rather than `turns.tsx`, because hands are hidden and a game
 * every device could replay is a game every device could read.
 *
 * The two things that make Uno awkward on a screen rather than at a table are
 * both handled here: a Wild has to ask for a colour *before* it is played, not
 * after, or the card lands and the turn moves on with nothing chosen; and
 * saying it has to be possible in the same motion as playing your
 * second-to-last card, because a button you press afterwards is a button you
 * press too late.
 */
import React from 'react';
import { motion } from 'framer-motion';
import { Ban, Hand, Layers, Megaphone, SkipForward } from 'lucide-react';

import { Avatar } from '../../components/Avatar';
import { Badge, Button, Empty, Modal } from '../../components/ui';
import * as U from '../../lib/uno';
import type { UnoCard, UnoColour, UnoState } from '../../lib/uno';
import { UnoBack, UnoFace } from '../../lib/unocards';
import { useStore } from '../../lib/store';
import { cn } from '../../lib/utils';
import { sfx } from '../../lib/audio';
import { GameShell } from './GameShell';
import { useHostedGame } from './hosted';
import { useLeaveGuard } from './LeaveGuard';
import { usePlayerNames } from './turns';
import { useResult } from './useResult';

type View = ReturnType<typeof U.view>;

type Intent =
  | { t: 'play'; card: number; colour?: UnoColour; uno?: boolean }
  | { t: 'draw' }
  | { t: 'pass' }
  | { t: 'callout'; on: string };

/** The four colours, for the chooser and the little markers. */
const INK: Record<UnoColour, string> = {
  red: '#962C30',
  yellow: '#B08628',
  green: '#4A744E',
  blue: '#283460',
};

export function Uno({ onExit }: { onExit: () => void }) {
  const session = useStore((s) => s.gameSession);
  const active = session && session.game === 'uno' ? session : null;

  const hosted = useHostedGame<UnoState, View, Intent>({
    session: active,
    create: (seed, players) => U.create(seed, players),
    apply: (state, intent, by) => {
      switch (intent.t) {
        case 'play':
          return U.play(state, by, { card: intent.card, colour: intent.colour, uno: intent.uno });
        case 'draw':
          return U.draw(state, by);
        case 'pass':
          return U.pass(state, by);
        case 'callout':
          return U.callOut(state, by, intent.on);
        default:
          return null;
      }
    },
    redact: (state, forPlayer) => U.view(state, forPlayer),
    // The seat keeps its cards; only the name on it changes.
    rename: U.rename,
  });

  const { view, players, me, send, restart, isHost } = hosted;
  const names = usePlayerNames(players);
  const leave = useLeaveGuard(onExit, players.length);

  /** A Wild waiting for a colour before it goes down. */
  const [choosing, setChoosing] = React.useState<number | null>(null);

  const mine = view?.players.find((p) => p.id === me) ?? null;
  const turnId = view ? view.players[view.turn]?.id : '';
  const myTurn = !!view && turnId === me && !view.winner;
  const top = view && view.discard.length ? U.card(view.discard[view.discard.length - 1]) : null;

  // Down to one card and about to be down to none.
  const nearlyOut = (mine?.hand.length ?? 0) === 2;

  const announced = React.useRef<string | null>(null);
  React.useEffect(() => {
    const w = view?.winner ?? null;
    if (!w) {
      announced.current = null;
      return;
    }
    if (announced.current === w) return;
    announced.current = w;
    if (w === me) sfx.gameWin();
    else sfx.gameLose();
  }, [view?.winner, me]);

  useResult({
    game: 'uno',
    matchId: active?.id ?? null,
    over: !!view?.winner,
    players,
    winners: view?.winner ? [view.winner] : [],
    // What the winner took off everybody else, which is how Uno is scored.
    points:
      view?.winner && view
        ? { [view.winner]: scoreFrom(view, view.winner) }
        : undefined,
  });

  if (!view || !mine) {
    return (
      <div className="h-full grid place-items-center">
        <Empty title="Dealing…" hint="Waiting for the host to deal." />
      </div>
    );
  }

  /** Whether a card in my hand could be played right now. */
  const canPlay = (index: number): boolean => {
    if (!myTurn || view.pending > 0) return false;
    const c = U.card(index);
    if (c.kind === 'wild') return true;
    if (c.kind === 'wild4') {
      return !mine.hand.some((i) => U.colourOf(U.card(i)) === view.colour);
    }
    if (!top) return false;
    if (U.colourOf(c) === view.colour) return true;
    if (c.kind === 'number' && top.kind === 'number' && c.n === top.n) return true;
    if (c.kind !== 'number' && c.kind === top.kind) return true;
    return false;
  };

  const put = (index: number, colour?: UnoColour) => {
    sfx.cardPlace();
    send({ t: 'play', card: index, colour, uno: nearlyOut });
    setChoosing(null);
  };

  const pick = (index: number) => {
    if (!canPlay(index)) return;
    // A Wild needs its colour named first: played and then asked, the card is
    // already down and the turn has already moved on.
    if (U.isWild(U.card(index))) {
      setChoosing(index);
      return;
    }
    put(index);
  };

  const others = view.players.filter((p) => p.id !== me);
  const playable = mine.hand.some(canPlay);

  const status = view.winner
    ? `${names[view.winner] ?? 'Someone'} went out`
    : view.pending > 0 && turnId === me
      ? `Draw ${view.pending}`
      : myTurn
        ? 'Your turn'
        : `${names[turnId] ?? 'Waiting'}…`;

  return (
    <>
      <GameShell
        title="Uno"
        themeKey="lantern.uno.theme"
        onExit={leave.requestExit}
        onRestart={isHost ? restart : undefined}
        moves={view.log.length}
        running={!view.winner}
        status={
          <>
            <Badge tone={view.winner ? 'gold' : myTurn ? 'cyan' : 'muted'}>{status}</Badge>
            <Badge tone="muted">{view.deck} in deck</Badge>
            {view.direction === -1 && <Badge tone="muted">Reversed</Badge>}
          </>
        }
      >
        {() => (
          <div className="h-full flex flex-col min-h-0">
            {/* everybody else */}
            <div className="shrink-0 flex flex-wrap gap-2 p-3 border-b border-edge">
              {others.map((p) => (
                <button
                  key={p.id}
                  // Catching somebody sitting on one card is the only thing
                  // you may do out of turn, so it lives on their card count.
                  onClick={() =>
                    p.handCount === 1 && !p.saidUno ? send({ t: 'callout', on: p.id }) : undefined
                  }
                  disabled={p.handCount !== 1 || p.saidUno}
                  className={cn(
                    'flex items-center gap-2 rounded-input border px-2 py-1.5 transition-colors',
                    p.id === turnId ? 'border-gold/50 bg-gold/10' : 'border-edge',
                    p.handCount === 1 && !p.saidUno && 'border-danger/50 hover:bg-danger/10',
                  )}
                  title={
                    p.handCount === 1 && !p.saidUno ? 'They never said it — catch them' : undefined
                  }
                >
                  <Avatar name={names[p.id] ?? 'Player'} size={22} />
                  <span className="text-xs">{names[p.id]}</span>
                  <Badge tone={p.handCount === 1 ? 'gold' : 'muted'}>
                    <Hand size={9} className="inline mr-0.5" />
                    {p.handCount}
                  </Badge>
                  {p.handCount === 1 && p.saidUno && <Megaphone size={11} className="text-gold" />}
                </button>
              ))}
            </div>

            {/* the pile */}
            <div className="flex-1 min-h-0 grid place-items-center p-4">
              <div className="flex items-center gap-6">
                <button
                  onClick={() => (myTurn ? send({ t: 'draw' }) : undefined)}
                  disabled={!myTurn || (view.drawn && view.pending === 0)}
                  className={cn(
                    'relative transition-transform',
                    myTurn && 'hover:-translate-y-1 cursor-pointer',
                  )}
                  title="Draw"
                >
                  <UnoBack width={74} />
                  <span className="absolute -bottom-5 inset-x-0 text-2xs text-muted text-center">
                    {view.pending > 0 ? `Take ${view.pending}` : 'Draw'}
                  </span>
                </button>

                <div className="relative">
                  {top && <UnoFace card={top} width={86} />}
                  {/* A Wild leaves the colour on the table rather than on the
                      card, so it is drawn beside it. */}
                  <span
                    className="absolute -right-2 -top-2 h-5 w-5 rounded-full border-2 border-black/50"
                    style={{ background: INK[view.colour] }}
                    title={`${view.colour} is in play`}
                  />
                </div>
              </div>
            </div>

            {/* my hand */}
            <div className="shrink-0 border-t border-edge p-3">
              <div className="flex items-center gap-2 mb-2">
                <Layers size={13} className="text-gold" />
                <span className="label flex-1">Your hand · {mine.hand.length}</span>

                {myTurn && view.drawn && view.pending === 0 && (
                  <Button size="xs" icon={<SkipForward size={11} />} onClick={() => send({ t: 'pass' })}>
                    Pass
                  </Button>
                )}
              </div>

              {myTurn && view.pending > 0 && (
                <p className="text-2xs text-muted mb-2">
                  You owe {view.pending}. Take them from the deck before anything else.
                </p>
              )}
              {myTurn && !playable && view.pending === 0 && !view.drawn && (
                <p className="text-2xs text-muted mb-2">Nothing you hold will go. Draw one.</p>
              )}
              {nearlyOut && myTurn && (
                <p className="text-2xs text-gold mb-2">
                  Playing one of these leaves you on one — it is said for you as it goes down.
                </p>
              )}

              <div className="flex flex-wrap gap-1.5">
                {mine.hand.map((i) => {
                  const ok = canPlay(i);
                  return (
                    <motion.button
                      key={i}
                      layout
                      onClick={() => pick(i)}
                      disabled={!ok}
                      className={cn(
                        'rounded-[4px] transition-transform',
                        ok && 'hover:-translate-y-1.5 cursor-pointer',
                        !ok && 'opacity-40 saturate-50',
                        choosing === i && '-translate-y-2 ring-2 ring-gold',
                      )}
                    >
                      <UnoFace card={U.card(i)} width={56} />
                    </motion.button>
                  );
                })}
                {mine.hand.length === 0 && (
                  <span className="text-2xs text-muted py-3">Nothing left.</span>
                )}
              </div>
            </div>
          </div>
        )}
      </GameShell>

      {/* A Wild, waiting on a colour. */}
      <Modal
        open={choosing !== null}
        onClose={() => setChoosing(null)}
        title="Name a colour"
        width="max-w-xs"
      >
        <div className="grid grid-cols-2 gap-2">
          {U.COLOURS.map((c) => (
            <button
              key={c}
              onClick={() => choosing !== null && put(choosing, c)}
              className="h-14 rounded-card border border-black/40 text-xs font-medium capitalize text-white/90 hover:brightness-125 transition-[filter]"
              style={{ background: INK[c] }}
            >
              {c}
            </button>
          ))}
        </div>
      </Modal>

      {leave.dialog}

      {view.winner && (
        <div className="fixed inset-0 z-[90] grid place-items-center bg-black/60 backdrop-blur-sm">
          <motion.div
            initial={{ scale: 0.92, opacity: 0, y: 12 }}
            animate={{ scale: 1, opacity: 1, y: 0 }}
            className="panel p-6 text-center max-w-xs glass"
          >
            <div className="text-xl font-semibold text-gold mb-1">
              {view.winner === me ? 'Out — you win' : `${names[view.winner]} went out`}
            </div>
            <div className="text-xs text-dim mb-4">
              {scoreFrom(view, view.winner)} points off everybody else.
            </div>
            <div className="flex gap-2 justify-center">
              <Button onClick={onExit}>Leave</Button>
              {isHost && (
                <Button variant="primary" onClick={restart}>
                  Deal again
                </Button>
              )}
            </div>
          </motion.div>
        </div>
      )}
    </>
  );
}

/**
 * What the winner took, from what this device can see.
 *
 * A view knows how many cards everybody holds but not which, so the exact
 * total is only available to the host. Everyone else gets the count-based
 * estimate the printed game would call close enough to read out.
 */
function scoreFrom(view: View, winner: string): number {
  let total = 0;
  for (const p of view.players) {
    if (p.id === winner) continue;
    if (p.hand.length) total += p.hand.reduce((n, i) => n + U.value(U.card(i)), 0);
    else total += p.handCount * 10;
  }
  return total;
}

export type { UnoCard };
