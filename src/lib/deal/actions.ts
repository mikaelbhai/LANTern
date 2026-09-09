/**
 * Monopoly Deal: the action cards.
 *
 * Kept apart from `game.ts` because these are where the rules get sharp, and
 * where a mistake is least visible: a Deal Breaker that quietly duplicates a
 * card, a Just Say No that answers the wrong charge, a rent that forgets the
 * Hotel. All of it is a pure function over the state so every case can be
 * asserted at a terminal.
 *
 * Anything played *at* somebody does not take effect at once. It becomes a
 * pending action that the target may answer with Just Say No, which the first
 * player may answer in turn, and so on until one of them runs out. Only then
 * does the effect land. That chain is the reason this is a state machine
 * rather than a set of functions that mutate and return.
 *
 * A birthday and a two-colour rent hit everybody, and each of them gets their
 * own chance to refuse: one player's Just Say No does not excuse the table.
 * So the pending action holds a queue of targets and works through it, and
 * whoever refuses successfully is simply left out when the effect lands.
 */
import { ACTION_NAME, COLOURS, SETS, propertyColours } from './cards';
import type { ActionKind, Colour } from './cards';
import {
  card,
  charge,
  clone,
  completedColours,
  current,
  isComplete,
  isRealSet,
  playerOf,
  rentOf,
} from './game';
import type { Pile, Player, State } from './game';

/** What one action is trying to do, while it waits to be answered. */
export interface Pending {
  action: ActionKind | 'rent';
  from: string;
  /** Everybody it is aimed at, in the order they will be asked. */
  targets: string[];
  /** Which of them is being asked now. */
  index: number;
  /** The card being played, so it can be discarded once resolved. */
  cardIndex: number;
  /** Any Double the Rent cards played with it, discarded alongside. */
  spent: number[];
  /** Which property, set or amount, depending on the action. */
  detail: Detail;
  /**
   * Who has said "just say no" to the *current* target's share of it, in order.
   *
   * An even number of refusals means it still stands against them; an odd
   * number means they have shaken it off. Cleared when the queue moves on.
   */
  refusals: string[];
  /** Targets who successfully refused, and are left out when it lands. */
  cancelled: string[];
  /** Whose response is awaited. Derived, but stored so the UI can read it. */
  awaiting: string;
}

export type Detail =
  | { kind: 'property'; owner: string; pile: number; cardIndex: number }
  | {
      kind: 'swap';
      owner: string;
      theirs: { pile: number; cardIndex: number };
      mine: { pile: number; cardIndex: number };
    }
  | { kind: 'set'; owner: string; pile: number }
  /** Debt collector: a flat demand from one player. */
  | { kind: 'money'; owner: string; amount: number }
  /**
   * Rent charged off one of your own sets.
   *
   * `only` is set for the wild rent card, which names any colour but charges
   * a single player; the two-colour rents charge everybody and leave it out.
   */
  | {
      kind: 'rent';
      colour: Colour;
      pile: number;
      amount: number;
      doubles: number[];
      only?: string;
    }
  /** A birthday, which needs no detail because it hits everyone. */
  | { kind: 'none' };

/** Whose answer a pending action is waiting on. */
const awaitingOf = (p: Pending): string =>
  p.refusals.length % 2 === 1 ? p.from : (p.targets[p.index] ?? '');

/** Plays an action or rent card. Returns null when the move is not allowed. */
export function playAction(
  state: State,
  by: string,
  cardIndex: number,
  detail: Detail,
): State | null {
  if (state.winner || state.pending || state.charge) return null;
  if (state.players[state.turn].id !== by) return null;
  if (!state.drawn || state.playsLeft <= 0) return null;

  const me = current(state);
  if (!me.hand.includes(cardIndex)) return null;

  const c = card(cardIndex);
  if (c.kind !== 'action' && c.kind !== 'rent') return null;
  // Just Say No is never played on its own — it only ever answers something.
  if (c.kind === 'action' && c.action === 'justsayno') return null;
  // Nor is Double the Rent: it rides along with a rent card.
  if (c.kind === 'action' && c.action === 'doublerent') return null;

  // Pass Go asks nobody's permission and hits no one, so it simply happens.
  if (c.kind === 'action' && c.action === 'passgo') {
    const s = clone(state);
    const player = current(s);
    player.hand = player.hand.filter((i) => i !== cardIndex);
    s.discard.push(cardIndex);
    for (let n = 0; n < 2; n++) {
      const next = s.deck.shift();
      if (next !== undefined) player.hand.push(next);
    }
    s.playsLeft--;
    s.log.push(`${by} played Pass Go`);
    return s;
  }

  // House and Hotel are built, not aimed at anybody.
  if (c.kind === 'action' && (c.action === 'house' || c.action === 'hotel')) {
    if (detail.kind !== 'set') return null;
    const s = clone(state);
    const player = current(s);
    const pile = player.piles[detail.pile];
    // Only a finished set earns a building, and a Hotel needs a House first.
    if (!pile || !isRealSet(pile)) return null;
    if (c.action === 'house' && pile.house) return null;
    if (c.action === 'hotel' && (!pile.house || pile.hotel)) return null;

    if (c.action === 'house') pile.house = true;
    else pile.hotel = true;

    player.hand = player.hand.filter((i) => i !== cardIndex);
    s.discard.push(cardIndex);
    s.playsLeft--;
    s.log.push(`${by} built a ${ACTION_NAME[c.action]}`);
    return s;
  }

  // Everything left is aimed at somebody and can be refused.
  const targets = targetsOf(state, by, detail);
  if (!targets.length) return null;
  if (targets.includes(by)) return null;

  // Rent is charged off one of your own sets, and Double the Rent costs a
  // play of its own — which is why two of them is the most anyone can afford.
  let spent: number[] = [];
  let amount = 0;
  if (detail.kind === 'rent') {
    if (c.kind !== 'rent') return null;
    if (!c.colours.includes(detail.colour)) return null;
    // The wild rent names any colour but charges one player; the rest hit all.
    const wild = c.colours.length === COLOURS.length;
    if (wild !== !!detail.only) return null;
    const pile = me.piles[detail.pile];
    if (!pile || pile.colour !== detail.colour || !pile.cards.length) return null;

    spent = detail.doubles;
    if (new Set(spent).size !== spent.length) return null;
    for (const i of spent) {
      const d = card(i);
      if (d.kind !== 'action' || d.action !== 'doublerent') return null;
      if (!me.hand.includes(i)) return null;
    }
    if (state.playsLeft < 1 + spent.length) return null;
    amount = rentFor(pile, spent.length);
    if (amount <= 0) return null;
  }

  const s = clone(state);
  const player = current(s);
  player.hand = player.hand.filter((i) => i !== cardIndex && !spent.includes(i));
  s.playsLeft -= 1 + spent.length;

  s.pending = {
    action: c.kind === 'rent' ? 'rent' : c.action,
    from: by,
    targets,
    index: 0,
    cardIndex,
    spent,
    detail: detail.kind === 'rent' ? { ...detail, amount } : detail,
    refusals: [],
    cancelled: [],
    awaiting: targets[0],
  };
  s.log.push(`${by} played ${c.kind === 'rent' ? 'Rent' : ACTION_NAME[c.action]}`);
  return s;
}

/** Everybody an action is aimed at, in seat order after the player. */
function targetsOf(state: State, by: string, detail: Detail): string[] {
  switch (detail.kind) {
    case 'property':
    case 'set':
    case 'swap':
    case 'money':
      return playerOf(state, detail.owner) ? [detail.owner] : [];
    // The wild rent names one player; the two-colour rents hit everybody.
    case 'rent':
      if (detail.only) return playerOf(state, detail.only) ? [detail.only] : [];
      return everyoneElse(state, by);
    case 'none':
      return everyoneElse(state, by);
    default:
      return [];
  }
}

/**
 * Everybody but the player, starting with whoever is next.
 *
 * Round the table from whoever is playing, so the order people are asked in
 * is the same one they are already watching.
 */
const everyoneElse = (state: State, by: string): string[] =>
  state.players
    .map((_, i) => state.players[(state.turn + 1 + i) % state.players.length].id)
    .filter((id) => id !== by);

/**
 * Answers a pending action.
 *
 * `refuse` is a Just Say No. Everybody is asked whether they want to, even
 * when they hold none — the pause is the point. If the table could tell who
 * was holding one by how quickly they answered, the card would be worth much
 * less than it is.
 */
export function respond(state: State, by: string, refuse: boolean): State | null {
  const pending = state.pending;
  if (!pending) return null;
  if (awaitingOf(pending) !== by) return null;

  const s = clone(state);
  const p = s.pending!;

  if (refuse) {
    const player = playerOf(s, by);
    const jsn = player?.hand.find((i) => {
      const c = card(i);
      return c.kind === 'action' && c.action === 'justsayno';
    });
    // Saying no without one is not a refusal, whatever the client claims.
    if (!player || jsn === undefined) return null;

    player.hand = player.hand.filter((i) => i !== jsn);
    s.discard.push(jsn);
    p.refusals.push(by);
    // Back to the other side, who may have one of their own.
    p.awaiting = awaitingOf(p);
    s.log.push(`${by} said Just Say No`);
    return s;
  }

  // Nobody is refusing further, so this target's share of it settles.
  const target = p.targets[p.index];
  if (p.refusals.length % 2 === 1) {
    p.cancelled.push(target);
    s.log.push(`${target} shook off ${nameOf(p)}`);
  }

  p.index++;
  p.refusals = [];

  // Somebody left to ask.
  if (p.index < p.targets.length) {
    p.awaiting = awaitingOf(p);
    return s;
  }

  s.discard.push(p.cardIndex, ...p.spent);
  s.pending = null;

  if (p.cancelled.length === p.targets.length) {
    s.log.push(`${nameOf(p)} came to nothing`);
    return s;
  }
  return resolve(s, p);
}

const nameOf = (p: Pending): string => (p.action === 'rent' ? 'Rent' : ACTION_NAME[p.action]);

/** Applies an action that nobody stopped. */
function resolve(state: State, pending: Pending): State {
  const s = clone(state);
  const from = playerOf(s, pending.from);
  if (!from) return s;

  // Whoever refused successfully is simply not there as far as this is
  // concerned — for a single-target action that means nothing happens.
  const hit = pending.targets.filter((id) => !pending.cancelled.includes(id));
  if (!hit.length) return s;

  // Bound locally so the discriminant narrows: reading `pending.detail.pile`
  // inside the switch leaves the compiler unable to tell which shape it is.
  const detail = pending.detail;

  switch (pending.action) {
    case 'slydeal': {
      if (detail.kind !== 'property') break;
      const victim = playerOf(s, detail.owner);
      const pile = victim?.piles[detail.pile];
      // A finished set is safe from everything but a Deal Breaker.
      if (!victim || !pile || isRealSet(pile)) break;
      if (!pile.cards.includes(detail.cardIndex)) break;

      pile.cards = pile.cards.filter((i) => i !== detail.cardIndex);
      victim.piles = victim.piles.filter((p) => p.cards.length > 0);
      give(from, detail.cardIndex);
      s.log.push(`${pending.from} took a property from ${detail.owner}`);
      break;
    }

    case 'forceddeal': {
      if (detail.kind !== 'swap') break;
      const victim = playerOf(s, detail.owner);
      if (!victim) break;
      const theirPile = victim.piles[detail.theirs.pile];
      const myPile = from.piles[detail.mine.pile];
      if (!theirPile || !myPile) break;
      if (isRealSet(theirPile) || isRealSet(myPile)) break;
      if (!theirPile.cards.includes(detail.theirs.cardIndex)) break;
      if (!myPile.cards.includes(detail.mine.cardIndex)) break;

      theirPile.cards = theirPile.cards.filter((i) => i !== detail.theirs.cardIndex);
      myPile.cards = myPile.cards.filter((i) => i !== detail.mine.cardIndex);
      give(from, detail.theirs.cardIndex);
      give(victim, detail.mine.cardIndex);

      victim.piles = victim.piles.filter((p) => p.cards.length > 0);
      from.piles = from.piles.filter((p) => p.cards.length > 0);
      s.log.push(`${pending.from} swapped a property with ${detail.owner}`);
      break;
    }

    case 'dealbreaker': {
      if (detail.kind !== 'set') break;
      const victim = playerOf(s, detail.owner);
      const pile = victim?.piles[detail.pile];
      if (!victim || !pile || !isRealSet(pile)) break;

      // The whole set, and whatever is built on it.
      victim.piles = victim.piles.filter((_, i) => i !== detail.pile);
      from.piles.push({ ...pile, cards: [...pile.cards] });
      s.log.push(`${pending.from} took a whole ${SETS[pile.colour].name} set`);
      break;
    }

    case 'debtcollector': {
      if (detail.kind !== 'money') break;
      return charge(
        s,
        pending.from,
        { [detail.owner]: detail.amount },
        `${pending.from} demanded ${detail.amount}M from ${detail.owner}`,
      );
    }

    case 'birthday': {
      const owed: Record<string, number> = {};
      for (const id of hit) owed[id] = 2;
      return charge(s, pending.from, owed, `It is ${pending.from}'s birthday`);
    }

    case 'rent': {
      if (detail.kind !== 'rent') break;
      const owed: Record<string, number> = {};
      for (const id of hit) owed[id] = detail.amount;
      return charge(s, pending.from, owed, `${pending.from} charged ${detail.amount}M rent`);
    }

    default:
      break;
  }

  return check(s);
}

/** Puts a property into a player's tableau, in a pile of its colour. */
function give(player: Player, cardIndex: number): void {
  const colour = propertyColours(card(cardIndex))[0];
  if (!colour) {
    player.bank.push(cardIndex);
    return;
  }
  const pile = player.piles.find((p) => p.colour === colour && !isComplete(p));
  if (pile) pile.cards.push(cardIndex);
  else player.piles.push({ colour, cards: [cardIndex], house: false, hotel: false });
}

function check(s: State): State {
  for (const player of s.players) {
    if (completedColours(player).length >= 3) {
      s.winner = player.id;
      break;
    }
  }
  return s;
}

/**
 * What a set would charge right now.
 *
 * `doubles` is how many Double the Rent cards are being played with it: one
 * doubles, two quadruple. Anything more is still only ×4, because there are
 * only two in the deck.
 */
export function rentFor(pile: Pile, doubles: number): number {
  return rentOf(pile) * Math.pow(2, Math.min(2, Math.max(0, doubles)));
}
