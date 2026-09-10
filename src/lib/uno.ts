/**
 * Uno.
 *
 * A pure reducer, like the other rulesets here, so the awkward parts can be
 * asserted at a terminal rather than discovered halfway through a game with
 * five people watching. Uno has more of those awkward parts than it looks:
 * Reverse with two players is a Skip, a Draw Two makes the next player lose
 * their turn as well as draw, a Wild Draw Four is only legal when you are out
 * of the current colour, and the draw pile has to be rebuilt from the discards
 * without disturbing the card on top.
 *
 * Hands are hidden, so this is host-authoritative like Monopoly Deal: one
 * device runs it and tells each player only what they may see. `view()` is
 * that redaction.
 */

export type UnoColour = 'red' | 'yellow' | 'green' | 'blue';
export const COLOURS: UnoColour[] = ['red', 'yellow', 'green', 'blue'];

export type UnoKind =
  | { kind: 'number'; colour: UnoColour; n: number }
  | { kind: 'skip'; colour: UnoColour }
  | { kind: 'reverse'; colour: UnoColour }
  | { kind: 'draw2'; colour: UnoColour }
  | { kind: 'wild' }
  | { kind: 'wild4' };

export type UnoCard = UnoKind;

/**
 * The deck: 108 cards.
 *
 * One zero per colour and two of everything else, which is the composition
 * that makes the maths of the game work — asserted in the tests, because a
 * deck with the wrong number of anything is a bug you would only notice as a
 * game that felt slightly wrong an hour in.
 */
export function buildDeck(): UnoCard[] {
  const deck: UnoCard[] = [];
  for (const colour of COLOURS) {
    deck.push({ kind: 'number', colour, n: 0 });
    for (let n = 1; n <= 9; n++) {
      deck.push({ kind: 'number', colour, n });
      deck.push({ kind: 'number', colour, n });
    }
    for (const kind of ['skip', 'reverse', 'draw2'] as const) {
      deck.push({ kind, colour });
      deck.push({ kind, colour });
    }
  }
  for (let i = 0; i < 4; i++) {
    deck.push({ kind: 'wild' });
    deck.push({ kind: 'wild4' });
  }
  return deck;
}

/** The cards themselves never change, so one built deck serves every game. */
export const CARDS: UnoCard[] = buildDeck();
export const card = (i: number): UnoCard => CARDS[i];

export const isWild = (c: UnoCard): boolean => c.kind === 'wild' || c.kind === 'wild4';
export const colourOf = (c: UnoCard): UnoColour | null => (isWild(c) ? null : (c as { colour: UnoColour }).colour);

/** What a card is worth at the end of a hand. */
export function value(c: UnoCard): number {
  if (c.kind === 'number') return c.n;
  if (c.kind === 'wild' || c.kind === 'wild4') return 50;
  return 20;
}

export interface UnoPlayer {
  id: string;
  hand: number[];
  /** True once they have said it, cleared whenever their hand grows again. */
  saidUno: boolean;
}

export interface UnoState {
  deck: number[];
  /** Most recently played last. */
  discard: number[];
  players: UnoPlayer[];
  turn: number;
  /** 1 clockwise, -1 after a Reverse. */
  direction: 1 | -1;
  /**
   * The colour in force.
   *
   * Usually the top card's own colour, but a Wild sets it to whatever was
   * chosen, and the top card has no colour of its own.
   */
  colour: UnoColour;
  /**
   * Cards the next player must draw before they may do anything else.
   *
   * Held rather than applied immediately so the screen can show what is
   * coming, and so stacking could be added without moving the rule.
   */
  pending: number;
  /** True when the player to move has already drawn and may pass. */
  drawn: boolean;
  winner: string | null;
  log: string[];
}

/* ------------------------------------------------------------ shuffling */

/** A seeded shuffle, so every device deals the same game. */
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

export const HAND_SIZE = 7;

export function create(seed: number, playerIds: string[]): UnoState {
  const deck = shuffled(seed);
  const players: UnoPlayer[] = playerIds.map((id) => ({
    id,
    hand: deck.splice(0, HAND_SIZE),
    saidUno: false,
  }));

  /*
   * The starting card cannot be a Wild Draw Four.
   *
   * Turning one up would mean the first player is penalised before anybody
   * has done anything, so it goes back in and another is turned. The printed
   * rules say to bury it and try again, which is what this does.
   */
  let first = deck.shift()!;
  let guard = 0;
  while (card(first).kind === 'wild4' && guard++ < 20) {
    deck.push(first);
    first = deck.shift()!;
  }

  const opener = card(first);
  const state: UnoState = {
    deck,
    discard: [first],
    players,
    turn: 0,
    direction: 1,
    // A Wild turned up has no colour of its own. Red stands in, and the
    // first player may put anything on it that they like.
    colour: colourOf(opener) ?? 'red',
    pending: 0,
    drawn: false,
    winner: null,
    log: [],
  };

  // An opener that does something does it to the first player, as printed.
  if (opener.kind === 'skip') state.turn = step(state, 1);
  else if (opener.kind === 'reverse') {
    state.direction = -1;
    state.turn = step(state, 1);
  } else if (opener.kind === 'draw2') state.pending = 2;

  return state;
}

/** Deep enough: arrays of numbers and small objects. */
export const clone = (s: UnoState): UnoState => ({
  ...s,
  deck: [...s.deck],
  discard: [...s.discard],
  players: s.players.map((p) => ({ ...p, hand: [...p.hand] })),
  log: [...s.log],
});

/* --------------------------------------------------------------- turns */

/** The seat `n` places along, in the direction of play. */
export function step(s: UnoState, n: number): number {
  const count = s.players.length;
  return (((s.turn + n * s.direction) % count) + count) % count;
}

export const current = (s: UnoState): UnoPlayer => s.players[s.turn];
export const top = (s: UnoState): UnoCard => card(s.discard[s.discard.length - 1]);

/* ---------------------------------------------------------------- draws */

/**
 * Puts the discards back under the deck when it runs out.
 *
 * The card on top stays where it is — it is the card in play, and shuffling
 * it away would change what may be played next.
 */
function replenish(s: UnoState): void {
  if (s.deck.length > 0 || s.discard.length <= 1) return;
  const inPlay = s.discard.pop()!;
  // Deterministic, because both ends have to agree: reversed rather than
  // randomised, since a seeded shuffle here would need a counter nobody else
  // can see and two devices would part company.
  s.deck = s.discard.slice().reverse();
  s.discard = [inPlay];
}

function take(s: UnoState, player: UnoPlayer, n: number): number {
  let taken = 0;
  for (let i = 0; i < n; i++) {
    replenish(s);
    const next = s.deck.shift();
    if (next === undefined) break;
    player.hand.push(next);
    taken++;
  }
  // A hand that has grown is not a hand of one.
  if (taken > 0) player.saidUno = false;
  return taken;
}

/* ---------------------------------------------------------------- plays */

/** Whether a card may be played on the current top. */
export function canPlay(s: UnoState, index: number): boolean {
  const c = card(index);

  // Owing cards, nothing may be played: they are drawn first.
  if (s.pending > 0) return false;

  if (c.kind === 'wild') return true;
  if (c.kind === 'wild4') {
    // Only when you are genuinely out of the colour in force. The honest
    // version of the rule, rather than the one everybody argues about.
    return !current(s).hand.some((i) => colourOf(card(i)) === s.colour);
  }

  const t = top(s);
  if (colourOf(c) === s.colour) return true;
  if (c.kind === 'number' && t.kind === 'number' && c.n === t.n) return true;
  if (c.kind !== 'number' && c.kind === t.kind) return true;
  return false;
}

/** Every card in the player's hand that could be played. */
export const playable = (s: UnoState): number[] =>
  current(s).hand.filter((i) => canPlay(s, i));

export interface PlayMove {
  card: number;
  /** Required for a Wild, ignored otherwise. */
  colour?: UnoColour;
  /** Whether they said it as they played their second-to-last card. */
  uno?: boolean;
}

/** Plays one card. Returns null when the move is not allowed. */
export function play(state: UnoState, by: string, move: PlayMove): UnoState | null {
  if (state.winner) return null;
  if (current(state).id !== by) return null;
  if (!current(state).hand.includes(move.card)) return null;
  if (!canPlay(state, move.card)) return null;

  const c = card(move.card);
  if (isWild(c) && !move.colour) return null;

  const s = clone(state);
  const me = current(s);
  me.hand = me.hand.filter((i) => i !== move.card);
  s.discard.push(move.card);
  s.drawn = false;

  s.colour = isWild(c) ? move.colour! : colourOf(c)!;
  me.saidUno = me.hand.length === 1 ? !!move.uno : false;

  if (me.hand.length === 0) {
    s.winner = me.id;
    s.log.push(`${by} went out`);
    return s;
  }

  switch (c.kind) {
    case 'skip':
      s.turn = step(s, 2);
      s.log.push(`${by} skipped ${s.players[step(s, -1)].id}`);
      break;
    case 'reverse':
      // With two players there is nobody to reverse past, so it plays as a
      // Skip — which is the printed rule and not a special case anybody
      // remembers until it comes up.
      if (s.players.length === 2) {
        s.log.push(`${by} played Reverse`);
        // Direction is still flipped, but the turn comes straight back.
        s.direction = s.direction === 1 ? -1 : 1;
        s.turn = step(s, 2);
      } else {
        s.direction = s.direction === 1 ? -1 : 1;
        s.turn = step(s, 1);
        s.log.push(`${by} reversed the direction`);
      }
      break;
    case 'draw2':
      s.pending = 2;
      s.turn = step(s, 1);
      s.log.push(`${by} played Draw Two`);
      break;
    case 'wild4':
      s.pending = 4;
      s.turn = step(s, 1);
      s.log.push(`${by} played Wild Draw Four (${s.colour})`);
      break;
    default:
      s.turn = step(s, 1);
      s.log.push(`${by} played ${describe(c)}`);
      break;
  }

  return s;
}

/**
 * Draws.
 *
 * One card ordinarily, and then the turn may be ended or that card played.
 * When something is owed it is all of it, and the turn ends immediately —
 * that is what a Draw Two costs you.
 */
export function draw(state: UnoState, by: string): UnoState | null {
  if (state.winner) return null;
  if (current(state).id !== by) return null;
  // One card a turn, then either play it or pass.
  if (state.drawn && state.pending === 0) return null;

  const s = clone(state);
  const me = current(s);

  if (s.pending > 0) {
    const owed = s.pending;
    take(s, me, owed);
    s.pending = 0;
    s.turn = step(s, 1);
    s.log.push(`${by} drew ${owed}`);
    return s;
  }

  take(s, me, 1);
  s.drawn = true;
  s.log.push(`${by} drew a card`);
  return s;
}

/** Ends the turn after drawing, having decided not to play. */
export function pass(state: UnoState, by: string): UnoState | null {
  if (state.winner) return null;
  if (current(state).id !== by) return null;
  // Passing without drawing is not a move; you have to try first.
  if (!state.drawn) return null;

  const s = clone(state);
  s.drawn = false;
  s.turn = step(s, 1);
  s.log.push(`${by} passed`);
  return s;
}

/**
 * Catching somebody who did not say it.
 *
 * Anybody may call it, and only while the offender is still sitting on one
 * card. Two cards is the printed penalty.
 */
export function callOut(state: UnoState, by: string, on: string): UnoState | null {
  if (state.winner) return null;
  if (by === on) return null;
  const target = state.players.find((p) => p.id === on);
  if (!target || target.hand.length !== 1 || target.saidUno) return null;

  const s = clone(state);
  const caught = s.players.find((p) => p.id === on)!;
  take(s, caught, 2);
  s.log.push(`${on} was caught with one card`);
  return s;
}

/** Says it, before or as the second-to-last card goes down. */
export function sayUno(state: UnoState, by: string): UnoState | null {
  const player = state.players.find((p) => p.id === by);
  if (!player || player.hand.length > 2) return null;
  const s = clone(state);
  s.players.find((p) => p.id === by)!.saidUno = true;
  return s;
}

/* -------------------------------------------------------------- scoring */

/** What the winner takes: everything left in everybody else's hands. */
export function scoreFor(s: UnoState, winner: string): number {
  return s.players
    .filter((p) => p.id !== winner)
    .reduce((n, p) => n + p.hand.reduce((m, i) => m + value(card(i)), 0), 0);
}

/* --------------------------------------------------------- substitution */

/**
 * Hands one player's seat to somebody else.
 *
 * A substitute inherits the hand, because they inherit the seat — the cards
 * belong to the chair, not to the person who was in it. Everything else that
 * names a player moves with it.
 *
 * Lives here rather than on the screen because it is a rule about the state,
 * and a rename that misses a field is a game that quietly stops working for
 * one person.
 */
export function rename(state: UnoState, from: string, to: string): UnoState {
  if (from === to) return state;
  const s = clone(state);
  for (const p of s.players) if (p.id === from) p.id = to;
  if (s.winner === from) s.winner = to;
  return s;
}

/* ------------------------------------------------------------ redaction */

/** What one player is allowed to see: their own hand, and nobody else's. */
export function view(state: UnoState, forPlayer: string) {
  return {
    ...state,
    deck: state.deck.length,
    // Only the card in play matters to anybody, and the pile underneath it is
    // information nobody is entitled to.
    discard: state.discard.slice(-1),
    players: state.players.map((p) => ({
      ...p,
      hand: p.id === forPlayer ? p.hand : [],
      handCount: p.hand.length,
    })),
  };
}

/* --------------------------------------------------------------- naming */

const NAMES: Record<string, string> = {
  skip: 'Skip',
  reverse: 'Reverse',
  draw2: 'Draw Two',
  wild: 'Wild',
  wild4: 'Wild Draw Four',
};

export function describe(c: UnoCard): string {
  if (c.kind === 'number') return `${c.colour} ${c.n}`;
  if (isWild(c)) return NAMES[c.kind];
  return `${(c as { colour: UnoColour }).colour} ${NAMES[c.kind]}`;
}
