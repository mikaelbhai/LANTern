/**
 * Monopoly Deal: the rules.
 *
 * A pure reducer over a single state object. Nothing here touches the network
 * or the screen, which is what lets the whole ruleset be tested at a terminal —
 * and this is a game with enough edge cases (payment with no change, Just Say
 * No chains, wilds moving between sets) that testing it any other way would be
 * a slow way to find out it is wrong.
 *
 * Unlike Connect Four, this cannot be replayed independently on every device:
 * hands are hidden, and a client that could derive the deck could read them.
 * One device therefore owns the state and tells each player only what they are
 * entitled to see. `view()` is that redaction.
 */
import { buildDeck, SETS, isRainbow, propertyColours } from './cards';
import type { Card, Colour } from './cards';

export const HAND_LIMIT = 7;
export const PLAYS_PER_TURN = 3;
export const SETS_TO_WIN = 3;

/** One pile of property of a single colour. */
export interface Pile {
  colour: Colour;
  /** Indices into the deck. */
  cards: number[];
  house: boolean;
  hotel: boolean;
}

export interface Player {
  id: string;
  hand: number[];
  bank: number[];
  piles: Pile[];
}

/** A charge somebody has to answer: rent, a birthday, a debt. */
export interface Charge {
  from: string;
  /** Who still owes, and how much. */
  owed: Record<string, number>;
  reason: string;
  /** Cards offered so far, per debtor. */
  paid: Record<string, number[]>;
}

export interface State {
  deck: number[];
  discard: number[];
  players: Player[];
  turn: number;
  playsLeft: number;
  /** True once the turn's draw has happened. */
  drawn: boolean;
  charge: Charge | null;
  winner: string | null;
  log: string[];
}

/** The cards themselves never change, so one built deck serves every game. */
export const CARDS: Card[] = buildDeck();
export const card = (i: number): Card => CARDS[i];

/* ------------------------------------------------------------ shuffling */

/**
 * A seeded shuffle, so every device deals the same game.
 *
 * Mulberry32: small, fast, and — the only property that matters here — exactly
 * reproducible from a seed.
 */
export function shuffled(seed: number): number[] {
  let a = seed >>> 0;
  const random = () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  const order = CARDS.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return order;
}

/* --------------------------------------------------------------- set up */

export function create(seed: number, playerIds: string[]): State {
  const deck = shuffled(seed);
  const players: Player[] = playerIds.map((id) => ({
    id,
    hand: deck.splice(0, 5),
    bank: [],
    piles: [],
  }));

  return {
    deck,
    discard: [],
    players,
    turn: 0,
    playsLeft: PLAYS_PER_TURN,
    drawn: false,
    charge: null,
    winner: null,
    log: [],
  };
}

/* -------------------------------------------------------------- helpers */

export const current = (s: State): Player => s.players[s.turn];
export const playerOf = (s: State, id: string): Player | undefined =>
  s.players.find((p) => p.id === id);

/** How much a pile is worth in rent right now, houses and hotels included. */
export function rentOf(pile: Pile): number {
  const ladder = SETS[pile.colour].rent;
  const rung = Math.min(pile.cards.length, ladder.length) - 1;
  if (rung < 0) return 0;
  let rent = ladder[rung];
  if (isComplete(pile)) {
    if (pile.house) rent += 3;
    if (pile.hotel) rent += 4;
  }
  return rent;
}

export const isComplete = (pile: Pile): boolean =>
  pile.cards.length >= SETS[pile.colour].size;

/**
 * A set of only wildcards is not a set.
 *
 * The rule exists so two rainbow wilds cannot conjure a colour nobody holds.
 */
export const isRealSet = (pile: Pile): boolean =>
  isComplete(pile) && pile.cards.some((i) => card(i).kind === 'property');

/** Complete sets, in different colours, is what wins. */
export function completedColours(player: Player): Colour[] {
  const done = new Set<Colour>();
  for (const pile of player.piles) if (isRealSet(pile)) done.add(pile.colour);
  return [...done];
}

export const totalWorth = (player: Player): number =>
  player.bank.reduce((n, i) => n + card(i).value, 0) +
  player.piles.reduce((n, p) => n + p.cards.reduce((m, i) => m + card(i).value, 0), 0);

/** Everything a player could hand over, since payment never comes from hand. */
export const payableCards = (player: Player): number[] => [
  ...player.bank,
  ...player.piles.flatMap((p) => p.cards),
];

/* ---------------------------------------------------------------- draws */

export function draw(state: State): State {
  const s = clone(state);
  const player = current(s);
  // An empty hand draws five, which is what stops a player being stuck with
  // nothing to do for the rest of the game.
  const want = player.hand.length === 0 ? 5 : 2;

  for (let i = 0; i < want; i++) {
    if (!s.deck.length) reshuffle(s);
    const next = s.deck.shift();
    if (next === undefined) break;
    player.hand.push(next);
  }
  s.drawn = true;
  return s;
}

/** The discard pile becomes the deck again when the deck runs out. */
function reshuffle(s: State): void {
  if (!s.discard.length) return;
  s.deck = s.discard;
  s.discard = [];
}

/* ---------------------------------------------------------------- plays */

export type Move =
  | { type: 'draw' }
  | { type: 'bank'; cardIndex: number }
  | { type: 'place'; cardIndex: number; colour: Colour; pile?: number }
  | { type: 'move'; from: number; cardIndex: number; colour: Colour; pile?: number }
  | { type: 'rent'; cardIndex: number; colour: Colour; targets: string[]; doubles: number[] }
  | { type: 'action'; cardIndex: number; target?: string; extra?: unknown }
  | { type: 'pay'; player: string; cards: number[] }
  | { type: 'endTurn'; discard: number[] };

/** Deep enough: arrays of numbers and small objects. */
const clone = (s: State): State => ({
  ...s,
  deck: [...s.deck],
  discard: [...s.discard],
  players: s.players.map((p) => ({
    ...p,
    hand: [...p.hand],
    bank: [...p.bank],
    piles: p.piles.map((pile) => ({ ...pile, cards: [...pile.cards] })),
  })),
  charge: s.charge
    ? { ...s.charge, owed: { ...s.charge.owed }, paid: { ...s.charge.paid } }
    : null,
  log: [...s.log],
});

/** Banks a card as money. Properties and wilds cannot be banked. */
export function bank(state: State, by: string, cardIndex: number): State | null {
  if (!canAct(state, by)) return null;
  const player = current(state);
  if (!player.hand.includes(cardIndex)) return null;

  const c = card(cardIndex);
  if (c.kind === 'property' || c.kind === 'wild') return null;

  const s = clone(state);
  const me = current(s);
  me.hand = me.hand.filter((i) => i !== cardIndex);
  me.bank.push(cardIndex);
  s.playsLeft--;
  return s;
}

/** Lays a property down, into an existing pile or a new one. */
export function place(
  state: State,
  by: string,
  cardIndex: number,
  colour: Colour,
  pileIndex?: number,
): State | null {
  if (!canAct(state, by)) return null;
  const player = current(state);
  if (!player.hand.includes(cardIndex)) return null;
  if (!propertyColours(card(cardIndex)).includes(colour)) return null;

  const s = clone(state);
  const me = current(s);
  me.hand = me.hand.filter((i) => i !== cardIndex);

  const pile =
    pileIndex !== undefined
      ? me.piles[pileIndex]
      : me.piles.find((p) => p.colour === colour && !isComplete(p));

  if (pile && pile.colour === colour) pile.cards.push(cardIndex);
  else me.piles.push({ colour, cards: [cardIndex], house: false, hotel: false });

  s.playsLeft--;
  return checkWin(s);
}

/**
 * Moves a property already on the table into another pile.
 *
 * Free — it costs no play — which is what makes wildcards worth holding and
 * lets a broken set be rebuilt.
 */
export function movePile(
  state: State,
  by: string,
  from: number,
  cardIndex: number,
  colour: Colour,
  pileIndex?: number,
): State | null {
  if (state.winner) return null;
  const player = playerOf(state, by);
  if (!player || state.players[state.turn].id !== by) return null;
  if (!propertyColours(card(cardIndex)).includes(colour)) return null;

  const s = clone(state);
  const me = current(s);
  const source = me.piles[from];
  if (!source || !source.cards.includes(cardIndex)) return null;

  source.cards = source.cards.filter((i) => i !== cardIndex);

  const target =
    pileIndex !== undefined ? me.piles[pileIndex] : me.piles.find((p) => p.colour === colour);
  if (target && target.colour === colour) target.cards.push(cardIndex);
  else me.piles.push({ colour, cards: [cardIndex], house: false, hotel: false });

  // A pile with nothing left in it is not a pile.
  me.piles = me.piles.filter((p) => p.cards.length > 0);
  return checkWin(s);
}

/* -------------------------------------------------------------- charges */

/** Starts a charge against one or more players. */
export function charge(
  state: State,
  from: string,
  amounts: Record<string, number>,
  reason: string,
): State {
  const s = clone(state);
  // Somebody with nothing on the table pays nothing, and should not be asked.
  const owed: Record<string, number> = {};
  for (const [id, amount] of Object.entries(amounts)) {
    const player = playerOf(s, id);
    if (!player) continue;
    if (payableCards(player).length === 0) continue;
    owed[id] = amount;
  }

  s.charge = Object.keys(owed).length ? { from, owed, reason, paid: {} } : null;
  s.log.push(reason);
  return s;
}

/**
 * Hands cards over in payment.
 *
 * There is no change: overpaying is allowed and the difference stays with the
 * player being paid. A debtor who cannot cover it gives up everything they
 * have, which is the rule that stops a game stalling on somebody who is broke.
 */
export function pay(state: State, by: string, cards: number[]): State | null {
  if (!state.charge) return null;
  const owed = state.charge.owed[by];
  if (owed === undefined) return null;

  const debtor = playerOf(state, by);
  const creditor = playerOf(state, state.charge.from);
  if (!debtor || !creditor) return null;

  const available = payableCards(debtor);
  if (!cards.every((i) => available.includes(i))) return null;

  const offered = cards.reduce((n, i) => n + card(i).value, 0);
  const everything = available.reduce((n, i) => n + card(i).value, 0);
  // Enough, or everything they have.
  if (offered < owed && offered < everything) return null;

  const s = clone(state);
  const from = playerOf(s, by)!;
  const to = playerOf(s, s.charge!.from)!;

  for (const i of cards) {
    from.bank = from.bank.filter((x) => x !== i);
    for (const pile of from.piles) pile.cards = pile.cards.filter((x) => x !== i);

    // Property handed over joins the recipient's property, not their bank.
    const c = card(i);
    if (c.kind === 'property' || c.kind === 'wild') {
      const colour = propertyColours(c)[0];
      const target = to.piles.find((p) => p.colour === colour && !isComplete(p));
      if (target) target.cards.push(i);
      else to.piles.push({ colour, cards: [i], house: false, hotel: false });
    } else {
      to.bank.push(i);
    }
  }

  from.piles = from.piles.filter((p) => p.cards.length > 0);

  delete s.charge!.owed[by];
  s.charge!.paid[by] = cards;
  if (!Object.keys(s.charge!.owed).length) s.charge = null;

  return checkWin(s);
}

/* ----------------------------------------------------------------- turn */

export function endTurn(state: State, by: string, discard: number[]): State | null {
  if (state.players[state.turn].id !== by) return null;
  if (state.charge) return null;

  const player = current(state);
  const over = player.hand.length - discard.length;
  if (over > HAND_LIMIT) return null;
  if (!discard.every((i) => player.hand.includes(i))) return null;

  const s = clone(state);
  const me = current(s);
  me.hand = me.hand.filter((i) => !discard.includes(i));
  s.discard.push(...discard);

  s.turn = (s.turn + 1) % s.players.length;
  s.playsLeft = PLAYS_PER_TURN;
  s.drawn = false;
  return s;
}

const canAct = (state: State, by: string): boolean =>
  !state.winner &&
  !state.charge &&
  state.players[state.turn].id === by &&
  state.drawn &&
  state.playsLeft > 0;

function checkWin(s: State): State {
  for (const player of s.players) {
    if (completedColours(player).length >= SETS_TO_WIN) {
      s.winner = player.id;
      break;
    }
  }
  return s;
}

/* ------------------------------------------------------------ redaction */

/** What one player is allowed to see: their own hand, and nobody else's. */
export function view(state: State, forPlayer: string) {
  return {
    ...state,
    deck: state.deck.length,
    players: state.players.map((p) => ({
      ...p,
      hand: p.id === forPlayer ? p.hand : [],
      handCount: p.hand.length,
    })),
  };
}
