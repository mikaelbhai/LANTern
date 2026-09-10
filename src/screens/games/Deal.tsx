/**
 * Monopoly Deal, for two to five people on the network.
 *
 * The rules are in `lib/deal/`; this is only the table. It runs on
 * `hosted.tsx` rather than `turns.tsx` because hands are hidden: if every
 * device could replay the game it could also read everybody's cards. One
 * device deals and tells each player what they are entitled to see.
 *
 * The screen's job is to make an unfamiliar game playable without a rulebook
 * open beside it. So every card you pick up says what you can do with it, and
 * nothing is clickable unless playing it would be legal — the rules refuse bad
 * moves anyway, but a button that does nothing is a worse way to learn them.
 */
import React from 'react';
import { motion } from 'framer-motion';
import { Ban, Coins, Hand, Hourglass, ShieldQuestion, SkipForward, Users } from 'lucide-react';

import { Avatar } from '../../components/Avatar';
import { Badge, Button, Empty, Modal } from '../../components/ui';
import { COLOURS, SETS, describe, isRainbow, propertyColours } from '../../lib/deal/cards';
import type { Card, Colour } from '../../lib/deal/cards';
import { playAction, respond, rentFor } from '../../lib/deal/actions';
import type { Detail } from '../../lib/deal/actions';
import * as G from '../../lib/deal/game';
import { useStore } from '../../lib/store';
import { cn } from '../../lib/utils';
import { sfx } from '../../lib/audio';
import { DealCard, INK, PileView } from './DealCard';
import { GameShell } from './GameShell';
import { useHostedGame } from './hosted';
import { useLeaveGuard } from './LeaveGuard';
import { usePlayerNames } from './turns';
import { useResult } from './useResult';

type View = ReturnType<typeof G.view>;
type ViewPlayer = View['players'][number];

type Intent =
  | { t: 'bank'; card: number }
  | { t: 'place'; card: number; colour: Colour; pile?: number }
  | { t: 'move'; from: number; card: number; colour: Colour; pile?: number }
  | { t: 'action'; card: number; detail: Detail }
  | { t: 'respond'; refuse: boolean }
  | { t: 'pay'; cards: number[] }
  | { t: 'end'; discard: number[] };

/**
 * What the screen is waiting for you to click.
 *
 * An action card aimed at somebody needs a target, and asking for it in a
 * modal listing every property on the table would be unreadable. So the table
 * itself becomes the picker: a banner says what to click, and only the legal
 * targets respond.
 */
type Flow =
  | null
  | { t: 'steal'; card: number }
  | { t: 'swapTheirs'; card: number }
  | { t: 'swapMine'; card: number; owner: string; theirs: { pile: number; cardIndex: number } }
  | { t: 'breakSet'; card: number }
  | { t: 'build'; card: number }
  | { t: 'debt'; card: number }
  | { t: 'rentPile'; card: number; colours: Colour[] }
  | { t: 'rentHow'; card: number; colour: Colour; pile: number; wild: boolean }
  | { t: 'moveWild'; from: number; card: number; colours: Colour[] };

const card = (i: number): Card => G.CARDS[i];

/**
 * Why a card cannot be played right now, or null if it can.
 *
 * The rules refuse an impossible move anyway, but silently — a Deal Breaker
 * played into a table with no finished sets on it would just do nothing, and
 * the player would be left wondering whether they had misunderstood the card
 * or misclicked. Saying so up front is the difference between learning the
 * game and fighting it.
 *
 * Everything this reads is public: piles are on the table, and nobody's hand
 * is consulted.
 */
function blockedBecause(view: View, me: string, cardIndex: number): string | null {
  const c = card(cardIndex);
  const mine = view.players.find((p) => p.id === me);
  if (!mine) return null;
  const others = view.players.filter((p) => p.id !== me);
  const loose = (p: ViewPlayer) => p.piles.some((x) => !G.isRealSet(x) && x.cards.length > 0);

  if (c.kind === 'rent') {
    const colours = c.colours.length === COLOURS.length ? COLOURS : c.colours;
    if (!mine.piles.some((x) => colours.includes(x.colour) && x.cards.length))
      return 'You have none of these colours on the table.';
    if (!others.length) return 'Nobody to charge.';
    return null;
  }

  if (c.kind !== 'action') return null;

  switch (c.action) {
    case 'house':
      if (!mine.piles.some((x) => G.isRealSet(x) && !x.house))
        return 'Nothing to build on — a House needs a finished set.';
      return null;
    case 'hotel':
      if (!mine.piles.some((x) => G.isRealSet(x) && x.house && !x.hotel))
        return 'A Hotel needs a set with a House on it.';
      return null;
    case 'slydeal':
      if (!others.some(loose)) return 'Nothing to take — finished sets are safe.';
      return null;
    case 'forceddeal':
      if (!others.some(loose)) return 'Nobody has a loose property to swap.';
      if (!loose(mine)) return 'You have nothing loose to offer in exchange.';
      return null;
    case 'dealbreaker':
      if (!others.some((p) => p.piles.some(G.isRealSet))) return 'Nobody has a finished set yet.';
      return null;
    case 'debtcollector':
    case 'birthday':
      if (!others.length) return 'Nobody to collect from.';
      return null;
    default:
      return null;
  }
}

export function Deal({ onExit }: { onExit: () => void }) {
  const session = useStore((s) => s.gameSession);
  const active = session && session.game === 'deal' ? session : null;

  const hosted = useHostedGame<G.State, View, Intent>({
    session: active,
    create: (seed, players) => G.draw(G.create(seed, players)),
    apply: (state, intent, by) => {
      switch (intent.t) {
        case 'bank':
          return G.bank(state, by, intent.card);
        case 'place':
          return G.place(state, by, intent.card, intent.colour, intent.pile);
        case 'move':
          return G.movePile(state, by, intent.from, intent.card, intent.colour, intent.pile);
        case 'action':
          return playAction(state, by, intent.card, intent.detail);
        case 'respond':
          return respond(state, by, intent.refuse);
        case 'pay':
          return G.pay(state, by, intent.cards);
        case 'end': {
          // The next player's draw is part of ending the turn. It is the only
          // legal move they could make, and a button with one option on it is
          // a click that teaches nobody anything.
          const next = G.endTurn(state, by, intent.discard);
          return next ? G.draw(next) : null;
        }
        default:
          return null;
      }
    },
    redact: (state, forPlayer) => G.view(state, forPlayer),
    // A substitute inherits the seat, and everything sitting in it.
    rename: G.rename,
  });

  const { view, players, me, send, restart, isHost } = hosted;
  const names = usePlayerNames(players);
  const leave = useLeaveGuard(onExit, players.length);

  const [flow, setFlow] = React.useState<Flow>(null);
  const [picked, setPicked] = React.useState<number | null>(null);
  const [paying, setPaying] = React.useState<number[]>([]);
  const [ending, setEnding] = React.useState(false);
  const [discarding, setDiscarding] = React.useState<number[]>([]);
  const [doubles, setDoubles] = React.useState<number[]>([]);
  const [rentTarget, setRentTarget] = React.useState<string>('');

  const mine = view?.players.find((p) => p.id === me) ?? null;
  const others = view?.players.filter((p) => p.id !== me) ?? [];
  const turnId = view ? view.players[view.turn]?.id : '';
  const myTurn = !!view && turnId === me && !view.winner;
  const charge = view?.charge ?? null;
  const owed = charge && charge.owed[me] !== undefined ? charge.owed[me] : null;
  const pending = view?.pending ?? null;
  const asked = pending && pending.awaiting === me;

  // Any of these interrupts whatever you were in the middle of.
  React.useEffect(() => {
    if (charge || pending) {
      setFlow(null);
      setPicked(null);
    }
  }, [charge, pending]);

  React.useEffect(() => {
    setPaying([]);
  }, [charge?.reason]);

  // A result is worth hearing, once.
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

  /*
   * Recorded before the early return below, so the hook count does not change
   * between the "dealing" render and the table.
   */
  useResult({
    game: 'deal',
    matchId: active?.id ?? null,
    over: !!view?.winner,
    players,
    winners: view?.winner ? [view.winner] : [],
    // Complete sets: the thing the whole game is counted in.
    points: Object.fromEntries(
      (view?.players ?? []).map((p) => [p.id, G.completedColours(p).length]),
    ),
  });

  if (!view || !mine) {
    return (
      <div className="h-full grid place-items-center">
        <Empty title="Dealing…" hint="Waiting for the host to deal the first hand." />
      </div>
    );
  }

  const clear = () => {
    setFlow(null);
    setPicked(null);
    setDoubles([]);
    setRentTarget('');
  };

  const play = (intent: Intent) => {
    sfx.cardPlace();
    send(intent);
    clear();
  };

  /* ------------------------------------------------------- playing a card */

  /** Starts whatever the picked card needs, or plays it outright. */
  const begin = (i: number) => {
    const c = card(i);
    if (c.kind !== 'action' && c.kind !== 'rent') return;

    if (c.kind === 'rent') {
      const wild = c.colours.length === COLOURS.length;
      setFlow({ t: 'rentPile', card: i, colours: wild ? COLOURS : c.colours });
      return;
    }

    switch (c.action) {
      case 'passgo':
        play({ t: 'action', card: i, detail: { kind: 'none' } });
        return;
      case 'birthday':
        play({ t: 'action', card: i, detail: { kind: 'none' } });
        return;
      case 'house':
      case 'hotel':
        setFlow({ t: 'build', card: i });
        return;
      case 'slydeal':
        setFlow({ t: 'steal', card: i });
        return;
      case 'forceddeal':
        setFlow({ t: 'swapTheirs', card: i });
        return;
      case 'dealbreaker':
        setFlow({ t: 'breakSet', card: i });
        return;
      case 'debtcollector':
        setFlow({ t: 'debt', card: i });
        return;
      default:
        // Just Say No and Double the Rent are never played on their own.
        return;
    }
  };

  /** A click on somebody else's card, while a flow is looking for one. */
  const onTheirCard = (owner: ViewPlayer, pileIndex: number, cardIndex: number) => {
    const pile = owner.piles[pileIndex];
    if (!flow || !pile) return;

    if (flow.t === 'steal') {
      if (G.isRealSet(pile)) return;
      play({
        t: 'action',
        card: flow.card,
        detail: { kind: 'property', owner: owner.id, pile: pileIndex, cardIndex },
      });
      return;
    }

    if (flow.t === 'swapTheirs') {
      if (G.isRealSet(pile)) return;
      setFlow({
        t: 'swapMine',
        card: flow.card,
        owner: owner.id,
        theirs: { pile: pileIndex, cardIndex },
      });
      return;
    }

    if (flow.t === 'breakSet') {
      if (!G.isRealSet(pile)) return;
      play({ t: 'action', card: flow.card, detail: { kind: 'set', owner: owner.id, pile: pileIndex } });
    }
  };

  /** A click on one of your own cards on the table. */
  const onMyCard = (pileIndex: number, cardIndex: number) => {
    const pile = mine.piles[pileIndex];
    if (!pile) return;

    if (flow?.t === 'swapMine') {
      if (G.isRealSet(pile)) return;
      play({
        t: 'action',
        card: flow.card,
        detail: {
          kind: 'swap',
          owner: flow.owner,
          theirs: flow.theirs,
          mine: { pile: pileIndex, cardIndex },
        },
      });
      return;
    }

    if (flow) return;

    // Otherwise: a wild can be moved between the sets it belongs to, free.
    const c = card(cardIndex);
    const colours = propertyColours(c).filter((x) => x !== pile.colour);
    if (c.kind !== 'wild' || !colours.length || !myTurn) return;
    setFlow({ t: 'moveWild', from: pileIndex, card: cardIndex, colours });
  };

  /** A click on one of your own sets, while building or charging rent. */
  const onMyPile = (pileIndex: number) => {
    const pile = mine.piles[pileIndex];
    if (!flow || !pile) return;

    if (flow.t === 'build') {
      if (!G.isRealSet(pile)) return;
      play({ t: 'action', card: flow.card, detail: { kind: 'set', owner: me, pile: pileIndex } });
      return;
    }

    if (flow.t === 'rentPile') {
      if (!flow.colours.includes(pile.colour) || !pile.cards.length) return;
      const c = card(flow.card);
      setDoubles([]);
      setRentTarget(others[0]?.id ?? '');
      setFlow({
        t: 'rentHow',
        card: flow.card,
        colour: pile.colour,
        pile: pileIndex,
        wild: c.kind === 'rent' && c.colours.length === COLOURS.length,
      });
    }
  };

  /* --------------------------------------------------------------- render */

  const heldDoubles = mine.hand.filter((i) => {
    const c = card(i);
    return c.kind === 'action' && c.action === 'doublerent';
  });
  const hasJustSayNo = mine.hand.some((i) => {
    const c = card(i);
    return c.kind === 'action' && c.action === 'justsayno';
  });

  const over = mine.hand.length - discarding.length - G.HAND_LIMIT;

  // Whoever the table is actually waiting for, which is not always whoever
  // has the turn: an action played at somebody stops everything until they
  // answer it, and a charge stops everything until it is paid.
  const waitingOn = pending
    ? (names[pending.awaiting] ?? 'someone')
    : charge && Object.keys(charge.owed).length
      ? Object.keys(charge.owed).map((id) => names[id] ?? 'someone').join(' and ')
      : null;


  const status = view.winner
    ? `${names[view.winner] ?? 'Someone'} wins`
    : owed !== null
      ? `You owe ${owed}M`
      : asked
        ? 'Answer it'
        : waitingOn
          ? `Waiting for ${waitingOn}…`
          : myTurn
            ? `Your turn · ${view.playsLeft} play${view.playsLeft === 1 ? '' : 's'} left`
            : `${names[turnId] ?? 'Waiting'}…`;

  return (
    <>
      <GameShell
        title="Monopoly Deal"
        themeKey="lantern.deal.theme"
        onExit={leave.requestExit}
        onRestart={isHost ? restart : undefined}
        moves={view.log.length}
        running={!view.winner}
        status={
          <>
            <Badge tone={view.winner ? 'gold' : myTurn ? 'cyan' : 'muted'}>{status}</Badge>
            <Badge tone="muted">{view.deck} in deck</Badge>
          </>
        }
      >
        {() => (
          <div className="h-full flex flex-col min-h-0">
            {flow && <FlowBanner flow={flow} onCancel={clear} names={names} />}

            {/*
              While an action is unanswered or a debt unpaid, nothing anybody
              clicks does anything. Saying whose move it is beats leaving the
              table looking playable and quietly refusing every click.
            */}
            {!flow && !asked && owed === null && waitingOn && (
              <div className="shrink-0 border-b border-edge bg-raised/60 px-3 py-2 flex items-center gap-2">
                <Hourglass size={14} className="text-dim shrink-0" />
                <span className="text-xs text-dim">
                  {pending
                    ? `Waiting for ${waitingOn} to answer the ${nameOfPending(pending)}.`
                    : `Waiting for ${waitingOn} to pay.`}
                </span>
              </div>
            )}

            <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-3 p-3 overflow-auto">
              {/* everybody else */}
              <div className="flex-1 min-w-0 space-y-3">
                {others.length === 0 ? (
                  <div className="panel p-4">
                    <p className="text-2xs text-muted leading-relaxed">
                      Nobody else is in this one. Start it from Games with “Play together”, or
                      from a call, and everyone is dealt in.
                    </p>
                  </div>
                ) : (
                  others.map((p) => (
                    <Tableau
                      key={p.id}
                      player={p}
                      name={names[p.id] ?? 'Player'}
                      theirTurn={p.id === turnId}
                      flow={flow}
                      onCard={(pileIndex, cardIndex) => onTheirCard(p, pileIndex, cardIndex)}
                    />
                  ))
                )}

                <Log lines={view.log} names={names} />
              </div>

              {/* you */}
              <div className="w-full lg:w-[400px] shrink-0 space-y-3">
                <Tableau
                  player={mine}
                  name="You"
                  theirTurn={myTurn}
                  flow={flow}
                  mine
                  onCard={onMyCard}
                  onPile={onMyPile}
                />

                <div className="panel p-3">
                  <div className="flex items-center gap-2 mb-2">
                    <Hand size={13} className="text-gold" />
                    <span className="label flex-1">
                      Your hand · {mine.hand.length}
                      {mine.hand.length > G.HAND_LIMIT && (
                        <span className="text-[#F09090]"> (limit {G.HAND_LIMIT})</span>
                      )}
                    </span>
                    {myTurn && !ending && !charge && !pending && (
                      <Button size="xs" icon={<SkipForward size={11} />} onClick={() => setEnding(true)}>
                        End turn
                      </Button>
                    )}
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {mine.hand.map((i) => (
                      <DealCard
                        key={i}
                        card={card(i)}
                        selected={ending ? discarding.includes(i) : picked === i}
                        dimmed={
                          ending ? !discarding.includes(i) : !myTurn || !!charge || !!pending
                        }
                        title={describe(card(i))}
                        onClick={() => {
                          if (ending) {
                            setDiscarding((d) =>
                              d.includes(i) ? d.filter((x) => x !== i) : [...d, i],
                            );
                            return;
                          }
                          if (!myTurn || charge || pending) return;
                          setFlow(null);
                          setPicked(picked === i ? null : i);
                        }}
                      />
                    ))}
                    {mine.hand.length === 0 && (
                      <span className="text-2xs text-muted py-3">
                        Empty. You draw five instead of two next turn.
                      </span>
                    )}
                  </div>

                  {ending ? (
                    <div className="mt-2.5 pt-2.5 border-t border-edge">
                      <p className="text-2xs text-muted mb-2">
                        {over > 0
                          ? `Pick ${over} more card${over === 1 ? '' : 's'} to discard.`
                          : 'Ready. Anything selected goes to the discard pile.'}
                      </p>
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          variant="primary"
                          disabled={over > 0}
                          onClick={() => {
                            send({ t: 'end', discard: discarding });
                            setEnding(false);
                            setDiscarding([]);
                          }}
                        >
                          End turn
                        </Button>
                        <Button
                          size="sm"
                          onClick={() => {
                            setEnding(false);
                            setDiscarding([]);
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    picked !== null && (
                      <PickedActions
                        cardIndex={picked}
                        playsLeft={view.playsLeft}
                        blocked={blockedBecause(view, me, picked)}
                        onBank={() => play({ t: 'bank', card: picked })}
                        onPlace={(colour) => play({ t: 'place', card: picked, colour })}
                        onPlay={() => begin(picked)}
                      />
                    )
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </GameShell>

      {/* Somebody has played something at you. */}
      <Modal
        open={!!asked}
        onClose={() => {}}
        title={pending ? `${names[pending.from] ?? 'Someone'} played ${nameOfPending(pending)}` : ''}
        width="max-w-sm"
      >
        {pending && (
          <>
            <p className="text-xs text-dim leading-relaxed">
              {explain(pending, names, me)}
            </p>
            <div className="flex gap-2 mt-4">
              <Button
                variant="primary"
                icon={<Ban size={13} />}
                disabled={!hasJustSayNo}
                onClick={() => send({ t: 'respond', refuse: true })}
              >
                Just Say No
              </Button>
              <Button onClick={() => send({ t: 'respond', refuse: false })}>
                {pending.from === me ? 'Let it stand' : 'Allow it'}
              </Button>
            </div>
            {!hasJustSayNo && (
              <p className="text-2xs text-muted mt-2">You have no Just Say No in hand.</p>
            )}
          </>
        )}
      </Modal>

      {/* You owe somebody. */}
      <PayModal
        open={owed !== null}
        owed={owed ?? 0}
        reason={charge?.reason ?? ''}
        names={names}
        player={mine}
        chosen={paying}
        onToggle={(i) =>
          setPaying((p) => (p.includes(i) ? p.filter((x) => x !== i) : [...p, i]))
        }
        onPay={() => {
          send({ t: 'pay', cards: paying });
          setPaying([]);
        }}
      />

      {/* Rent: how hard, and at whom. */}
      <Modal open={flow?.t === 'rentHow'} onClose={clear} title="Charge rent" width="max-w-sm">
        {flow?.t === 'rentHow' && (
          <RentOptions
            colour={flow.colour}
            amount={rentFor(mine.piles[flow.pile], doubles.length)}
            wild={flow.wild}
            others={others}
            names={names}
            heldDoubles={heldDoubles}
            playsLeft={view.playsLeft}
            doubles={doubles}
            onToggleDouble={(i) =>
              setDoubles((d) => (d.includes(i) ? d.filter((x) => x !== i) : [...d, i]))
            }
            target={rentTarget}
            onTarget={setRentTarget}
            onCharge={() =>
              play({
                t: 'action',
                card: flow.card,
                detail: {
                  kind: 'rent',
                  colour: flow.colour,
                  pile: flow.pile,
                  amount: 0,
                  doubles,
                  ...(flow.wild ? { only: rentTarget } : {}),
                },
              })
            }
          />
        )}
      </Modal>

      {/* Moving a wild between sets. */}
      <Modal open={flow?.t === 'moveWild'} onClose={clear} title="Move it where?" width="max-w-xs">
        {flow?.t === 'moveWild' && (
          <div className="flex flex-wrap gap-2">
            {flow.colours.map((c) => (
              <ColourChip
                key={c}
                colour={c}
                onClick={() =>
                  play({ t: 'move', from: flow.from, card: flow.card, colour: c })
                }
              />
            ))}
          </div>
        )}
      </Modal>

      {/* Who to collect from. */}
      <Modal open={flow?.t === 'debt'} onClose={clear} title="Collect 5M from" width="max-w-xs">
        {flow?.t === 'debt' && (
          <div className="space-y-1.5">
            {others.map((p) => (
              <button
                key={p.id}
                onClick={() =>
                  play({
                    t: 'action',
                    card: flow.card,
                    detail: { kind: 'money', owner: p.id, amount: 5 },
                  })
                }
                className="w-full flex items-center gap-2 px-2 h-11 rounded-input border border-edge hover:border-edge-strong hover:bg-raised/60"
              >
                <Avatar name={names[p.id] ?? 'Player'} size={24} />
                <span className="text-xs flex-1 text-left truncate">{names[p.id]}</span>
                <Badge tone="muted">{G.totalWorth(p)}M on the table</Badge>
              </button>
            ))}
            {others.length === 0 && <Empty title="Nobody to collect from" />}
          </div>
        )}
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
              {view.winner === me ? 'Three sets — you win' : `${names[view.winner]} wins`}
            </div>
            <div className="text-xs text-dim mb-4">
              {view.winner === me
                ? 'Brown, Utility, whatever it took.'
                : 'Three complete sets on the table.'}
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

/* ------------------------------------------------------------- one player */

function Tableau({
  player,
  name,
  theirTurn,
  flow,
  mine,
  onCard,
  onPile,
}: {
  player: ViewPlayer;
  name: string;
  theirTurn: boolean;
  flow: Flow;
  mine?: boolean;
  onCard: (pileIndex: number, cardIndex: number) => void;
  onPile?: (pileIndex: number) => void;
}) {
  const sets = G.completedColours(player).length;
  const bank = player.bank.reduce((n, i) => n + card(i).value, 0);

  /** Whether this flow is hunting for something in this tableau. */
  const wants = (pileIndex: number): boolean => {
    const pile = player.piles[pileIndex];
    if (!flow || !pile) return false;
    switch (flow.t) {
      case 'steal':
      case 'swapTheirs':
        return !mine && !G.isRealSet(pile);
      case 'swapMine':
        return !!mine && !G.isRealSet(pile);
      case 'breakSet':
        return !mine && G.isRealSet(pile);
      case 'build':
        return !!mine && G.isRealSet(pile);
      case 'rentPile':
        return !!mine && flow.colours.includes(pile.colour) && pile.cards.length > 0;
      default:
        return false;
    }
  };

  return (
    <div
      className={cn(
        'panel p-3 transition-colors',
        theirTurn && 'border-gold/40 bg-gold/[0.04]',
      )}
    >
      <div className="flex items-center gap-2 mb-2">
        <Avatar name={name} size={24} />
        <span className="text-xs font-medium truncate flex-1">{name}</span>
        <Badge tone={sets >= 2 ? 'gold' : 'muted'}>
          {sets}/{G.SETS_TO_WIN} sets
        </Badge>
        <Badge tone="muted">
          <Coins size={9} className="inline mr-0.5" />
          {bank}M
        </Badge>
        {!mine && (
          <Badge tone="muted">
            <Hand size={9} className="inline mr-0.5" />
            {player.handCount}
          </Badge>
        )}
      </div>

      {player.piles.length === 0 ? (
        <p className="text-2xs text-muted py-2">Nothing on the table yet.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {player.piles.map((pile, n) => (
            <div
              key={`${pile.colour}-${n}`}
              onClick={() => onPile?.(n)}
              className={onPile && wants(n) ? 'cursor-pointer' : undefined}
            >
              <PileView
                colour={pile.colour}
                cards={pile.cards}
                house={pile.house}
                hotel={pile.hotel}
                highlight={wants(n)}
                cardOf={card}
                onCard={wants(n) || mine ? (i) => onCard(n, i) : undefined}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* -------------------------------------------------------- what you can do */

function PickedActions({
  cardIndex,
  playsLeft,
  blocked,
  onBank,
  onPlace,
  onPlay,
}: {
  cardIndex: number;
  playsLeft: number;
  /** Why it cannot be played, if it cannot. */
  blocked: string | null;
  onBank: () => void;
  onPlace: (colour: Colour) => void;
  onPlay: () => void;
}) {
  const c = card(cardIndex);
  const colours = propertyColours(c);
  const playable = c.kind === 'action' || c.kind === 'rent';
  const alone =
    c.kind === 'action' && (c.action === 'justsayno' || c.action === 'doublerent');

  return (
    <div className="mt-2.5 pt-2.5 border-t border-edge">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-2xs text-dim flex-1">{describe(c)}</span>
        <Badge tone="muted">{playsLeft} left</Badge>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {/* Properties go down as a colour; a wild picks which. */}
        {colours.length > 0 &&
          (isRainbow(c) ? COLOURS : colours).map((col) => (
            <ColourChip key={col} colour={col} onClick={() => onPlace(col)} />
          ))}

        {playable && !alone && (
          <Button size="sm" variant="primary" disabled={!!blocked} onClick={onPlay}>
            Play it
          </Button>
        )}

        {/* Anything but a property can be banked instead of played. */}
        {c.kind !== 'property' && c.kind !== 'wild' && (
          <Button size="sm" icon={<Coins size={12} />} onClick={onBank}>
            Bank as {c.value}M
          </Button>
        )}
      </div>

      {/* Why the button is greyed out, rather than leaving it a mystery. */}
      {!alone && blocked && <p className="text-2xs text-muted mt-2">{blocked}</p>}

      {alone && (
        <p className="text-2xs text-muted mt-2">
          {c.kind === 'action' && c.action === 'justsayno'
            ? 'Kept in hand. It offers itself when somebody plays something at you.'
            : 'Played alongside a rent card, not on its own.'}
        </p>
      )}
    </div>
  );
}

function ColourChip({ colour, onClick }: { colour: Colour; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex items-center gap-1.5 px-2 py-1 rounded-input border border-edge hover:border-edge-strong text-2xs"
    >
      <span className="h-3 w-3 rounded-sm" style={{ background: INK[colour] }} />
      {SETS[colour].name}
    </button>
  );
}

/* ------------------------------------------------------------- the banner */

function FlowBanner({
  flow,
  onCancel,
  names,
}: {
  flow: NonNullable<Flow>;
  onCancel: () => void;
  names: Record<string, string>;
}) {
  const text: Record<NonNullable<Flow>['t'], string> = {
    steal: 'Pick one property from somebody’s unfinished set. Finished sets are safe.',
    swapTheirs: 'Pick the property you want, from somebody’s unfinished set.',
    swapMine: 'Now pick one of your own to give up.',
    breakSet: 'Pick a finished set to take — buildings and all.',
    build: 'Pick one of your finished sets to build on.',
    debt: 'Choose who owes you.',
    rentPile: 'Pick which of your sets to charge rent on.',
    rentHow: 'Charging rent…',
    moveWild: 'Moving a wildcard…',
  };

  return (
    <div className="shrink-0 border-b border-gold/30 bg-gold/10 px-3 py-2 flex items-center gap-2">
      <ShieldQuestion size={14} className="text-gold shrink-0" />
      <span className="text-xs flex-1">
        {flow.t === 'swapMine'
          ? `Taking from ${names[flow.owner] ?? 'them'}. ${text.swapMine}`
          : text[flow.t]}
      </span>
      <Button size="xs" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

/* ---------------------------------------------------------------- paying */

function PayModal({
  open,
  owed,
  reason,
  names,
  player,
  chosen,
  onToggle,
  onPay,
}: {
  open: boolean;
  owed: number;
  reason: string;
  names: Record<string, string>;
  player: ViewPlayer;
  chosen: number[];
  onToggle: (i: number) => void;
  onPay: () => void;
}) {
  const available = G.payableCards(player);
  const offered = chosen.reduce((n, i) => n + card(i).value, 0);
  const everything = available.reduce((n, i) => n + card(i).value, 0);
  // Enough, or everything you have — which is the rule that stops the game
  // stalling on somebody who is broke.
  const enough = offered >= owed || offered >= everything;

  return (
    <Modal open={open} onClose={() => {}} title={`You owe ${owed}M`} width="max-w-md">
      <p className="text-xs text-dim leading-relaxed mb-3">
        {humanise(reason, names)}
        {everything < owed && ' You cannot cover it, so everything you have goes over.'}
      </p>

      <div className="space-y-3 max-h-[46vh] overflow-auto">
        <div>
          <span className="label">Bank</span>
          <div className="flex flex-wrap gap-1.5 mt-1.5">
            {player.bank.length === 0 && <span className="text-2xs text-muted">Empty.</span>}
            {player.bank.map((i) => (
              <DealCard
                key={i}
                card={card(i)}
                size="small"
                selected={chosen.includes(i)}
                onClick={() => onToggle(i)}
              />
            ))}
          </div>
        </div>

        <div>
          <span className="label">Property</span>
          <p className="text-2xs text-muted mt-0.5 mb-1.5">
            Handing over property breaks the set it was in.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {player.piles.length === 0 && <span className="text-2xs text-muted">Nothing.</span>}
            {player.piles.flatMap((pile) =>
              pile.cards.map((i) => (
                <DealCard
                  key={i}
                  card={card(i)}
                  as={pile.colour}
                  size="small"
                  selected={chosen.includes(i)}
                  onClick={() => onToggle(i)}
                />
              )),
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 mt-4">
        <span className={cn('text-xs font-mono', enough ? 'text-gold' : 'text-muted')}>
          {offered}M of {owed}M
        </span>
        <Button variant="primary" className="ml-auto" disabled={!enough} onClick={onPay}>
          Pay
        </Button>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ rent */

function RentOptions({
  colour,
  amount,
  wild,
  others,
  names,
  heldDoubles,
  playsLeft,
  doubles,
  onToggleDouble,
  target,
  onTarget,
  onCharge,
}: {
  colour: Colour;
  amount: number;
  wild: boolean;
  others: ViewPlayer[];
  names: Record<string, string>;
  heldDoubles: number[];
  playsLeft: number;
  doubles: number[];
  onToggleDouble: (i: number) => void;
  target: string;
  onTarget: (id: string) => void;
  onCharge: () => void;
}) {
  return (
    <>
      <div className="flex items-center gap-2 mb-3">
        <span className="h-4 w-4 rounded-sm" style={{ background: INK[colour] }} />
        <span className="text-xs flex-1">{SETS[colour].name}</span>
        <span className="text-lg font-semibold text-gold">{amount}M</span>
      </div>

      {heldDoubles.length > 0 && (
        <div className="mb-3">
          <span className="label">Double the Rent</span>
          <p className="text-2xs text-muted mt-0.5 mb-1.5">
            Each one costs a play of its own — you have {playsLeft}.
          </p>
          <div className="flex gap-1.5">
            {heldDoubles.map((i, n) => (
              <DealCard
                key={i}
                card={card(i)}
                size="small"
                selected={doubles.includes(i)}
                dimmed={!doubles.includes(i) && playsLeft < 2 + n}
                onClick={
                  doubles.includes(i) || playsLeft >= 2 + doubles.length
                    ? () => onToggleDouble(i)
                    : undefined
                }
              />
            ))}
          </div>
        </div>
      )}

      {wild ? (
        <div className="mb-3">
          <span className="label">Charge who</span>
          <p className="text-2xs text-muted mt-0.5 mb-1.5">
            This one names any colour, but only one player pays.
          </p>
          <div className="space-y-1">
            {others.map((p) => (
              <button
                key={p.id}
                onClick={() => onTarget(p.id)}
                className={cn(
                  'w-full flex items-center gap-2 px-2 h-10 rounded-input border transition-colors',
                  target === p.id ? 'border-gold/60 bg-gold/10' : 'border-edge hover:bg-raised/60',
                )}
              >
                <Avatar name={names[p.id] ?? 'Player'} size={22} />
                <span className="text-xs flex-1 text-left truncate">{names[p.id]}</span>
                <Badge tone="muted">{G.totalWorth(p)}M</Badge>
              </button>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-2xs text-muted mb-3">
          <Users size={11} className="inline mr-1" />
          Everybody pays this one.
        </p>
      )}

      <Button variant="primary" full disabled={wild && !target} onClick={onCharge}>
        Charge {amount}M
      </Button>
    </>
  );
}

/* ------------------------------------------------------------------- log */

function Log({ lines, names }: { lines: string[]; names: Record<string, string> }) {
  const recent = lines.slice(-9).reverse();
  if (!recent.length) return null;

  return (
    <div className="panel p-3">
      <span className="label">What happened</span>
      <ul className="mt-1.5 space-y-1">
        {recent.map((line, i) => (
          <li
            key={`${i}-${line}`}
            className={cn('text-2xs leading-relaxed', i === 0 ? 'text-dim' : 'text-muted')}
          >
            {humanise(line, names)}
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The rules write player ids into the log, because they do not know names.
 *
 * Swapping them in here rather than there keeps `game.ts` free of anything
 * that has to be looked up on a device.
 */
function humanise(line: string, names: Record<string, string>): string {
  let out = line;
  for (const [id, name] of Object.entries(names)) out = out.split(id).join(name);
  return out;
}

const nameOfPending = (p: NonNullable<View['pending']>): string =>
  p.action === 'rent' ? 'Rent' : (describe({ kind: 'action', action: p.action, value: 0 }) as string);

/** What a pending action would do to you, in a sentence. */
function explain(
  p: NonNullable<View['pending']>,
  names: Record<string, string>,
  me: string,
): string {
  const who = names[p.from] ?? 'Someone';
  const refused = p.refusals.length;

  if (refused > 0 && p.from === me) {
    return `${names[p.targets[p.index]] ?? 'They'} said Just Say No. Answer it with one of your own, or let it go.`;
  }

  switch (p.action) {
    case 'slydeal':
      return `${who} is taking one of your properties.`;
    case 'forceddeal':
      return `${who} wants to swap a property with you.`;
    case 'dealbreaker':
      return `${who} is taking a whole set off you — buildings included.`;
    case 'debtcollector':
      return `${who} is demanding 5M from you.`;
    case 'birthday':
      return `It is ${who}'s birthday. Everybody owes 2M.`;
    case 'rent':
      return `${who} is charging you rent${
        p.detail.kind === 'rent' ? ` of ${p.detail.amount}M` : ''
      }.`;
    default:
      return `${who} played something at you.`;
  }
}
