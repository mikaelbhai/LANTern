/**
 * The Monopoly Deal deck: 106 cards.
 *
 * Kept apart from the rules and the screen so the composition can be asserted
 * on its own — a deck with the wrong number of Greens is a bug that would
 * otherwise only show up as an unwinnable game an hour in.
 *
 * Card identity is an index into the built deck, so a card is one number on
 * the wire and two devices can never disagree about which card is which.
 */

export type Colour =
  | 'brown'
  | 'lightblue'
  | 'pink'
  | 'orange'
  | 'red'
  | 'yellow'
  | 'green'
  | 'blue'
  | 'railroad'
  | 'utility';

export type ActionKind =
  | 'passgo'
  | 'slydeal'
  | 'forceddeal'
  | 'dealbreaker'
  | 'justsayno'
  | 'debtcollector'
  | 'birthday'
  | 'doublerent'
  | 'house'
  | 'hotel';

export type Card =
  | { kind: 'money'; value: number }
  /** A property of exactly one colour. */
  | { kind: 'property'; colour: Colour; value: number }
  /**
   * A property that counts as any of `colours`, and can be moved between them.
   * The ten-colour one is the rainbow wild, which is worth nothing banked and
   * cannot form a set on its own.
   */
  | { kind: 'wild'; colours: Colour[]; value: number }
  /** Charges rent on one of two colours, or any colour for the wild rent. */
  | { kind: 'rent'; colours: Colour[]; value: number }
  | { kind: 'action'; action: ActionKind; value: number };

/** How many cards make a complete set, and what each rung of rent pays. */
export const SETS: Record<Colour, { size: number; rent: number[]; name: string }> = {
  brown: { size: 2, rent: [1, 2], name: 'Brown' },
  lightblue: { size: 3, rent: [1, 2, 3], name: 'Light Blue' },
  pink: { size: 3, rent: [1, 2, 4], name: 'Pink' },
  orange: { size: 3, rent: [1, 3, 5], name: 'Orange' },
  red: { size: 3, rent: [2, 3, 6], name: 'Red' },
  yellow: { size: 3, rent: [2, 4, 6], name: 'Yellow' },
  green: { size: 3, rent: [2, 4, 7], name: 'Green' },
  blue: { size: 2, rent: [3, 8], name: 'Dark Blue' },
  railroad: { size: 4, rent: [1, 2, 3, 4], name: 'Railroad' },
  utility: { size: 2, rent: [1, 2], name: 'Utility' },
};

export const COLOURS = Object.keys(SETS) as Colour[];

/** What each action card is worth when banked instead of played. */
export const ACTION_VALUE: Record<ActionKind, number> = {
  passgo: 1,
  slydeal: 3,
  forceddeal: 3,
  dealbreaker: 5,
  justsayno: 4,
  debtcollector: 3,
  birthday: 2,
  doublerent: 1,
  house: 3,
  hotel: 4,
};

export const ACTION_NAME: Record<ActionKind, string> = {
  passgo: 'Pass Go',
  slydeal: 'Sly Deal',
  forceddeal: 'Forced Deal',
  dealbreaker: 'Deal Breaker',
  justsayno: 'Just Say No',
  debtcollector: 'Debt Collector',
  birthday: "It's My Birthday",
  doublerent: 'Double the Rent',
  house: 'House',
  hotel: 'Hotel',
};

/** Property values, by colour — what the card is worth as payment. */
const PROPERTY_VALUE: Record<Colour, number> = {
  brown: 1,
  lightblue: 1,
  pink: 2,
  orange: 2,
  red: 3,
  yellow: 3,
  green: 4,
  blue: 4,
  railroad: 2,
  utility: 2,
};

/**
 * Builds the deck, in a fixed order.
 *
 * Order matters only in that it must be the same everywhere: the shuffle is
 * seeded, so an identical starting list on every device produces an identical
 * game.
 */
export function buildDeck(): Card[] {
  const deck: Card[] = [];
  const push = (card: Card, times: number) => {
    for (let i = 0; i < times; i++) deck.push(card);
  };

  // Money: 20 cards.
  push({ kind: 'money', value: 1 }, 6);
  push({ kind: 'money', value: 2 }, 5);
  push({ kind: 'money', value: 3 }, 3);
  push({ kind: 'money', value: 4 }, 3);
  push({ kind: 'money', value: 5 }, 2);
  push({ kind: 'money', value: 10 }, 1);

  // Properties: 28, one per space on the board.
  for (const colour of COLOURS) {
    push({ kind: 'property', colour, value: PROPERTY_VALUE[colour] }, SETS[colour].size);
  }

  // Property wildcards: 11.
  const wilds: [Colour[], number, number][] = [
    [COLOURS, 0, 2], // rainbow: any colour, worth nothing banked
    [['blue', 'green'], 4, 1],
    [['green', 'railroad'], 4, 1],
    [['brown', 'lightblue'], 1, 1],
    [['lightblue', 'railroad'], 4, 1],
    [['orange', 'pink'], 2, 2],
    [['railroad', 'utility'], 2, 1],
    [['red', 'yellow'], 3, 2],
  ];
  for (const [colours, value, count] of wilds) {
    push({ kind: 'wild', colours, value }, count);
  }

  // Rent: 13.
  const rents: [Colour[], number, number][] = [
    [['pink', 'orange'], 1, 2],
    [['railroad', 'utility'], 1, 2],
    [['green', 'blue'], 1, 2],
    [['brown', 'lightblue'], 1, 2],
    [['red', 'yellow'], 1, 2],
    [COLOURS, 3, 3], // wild rent: name any colour, one player
  ];
  for (const [colours, value, count] of rents) {
    push({ kind: 'rent', colours, value }, count);
  }

  // Actions: 34.
  const actions: [ActionKind, number][] = [
    ['passgo', 10],
    ['slydeal', 3],
    ['forceddeal', 3],
    ['dealbreaker', 2],
    ['justsayno', 3],
    ['debtcollector', 3],
    ['birthday', 3],
    ['doublerent', 2],
    ['house', 3],
    ['hotel', 2],
  ];
  for (const [action, count] of actions) {
    push({ kind: 'action', action, value: ACTION_VALUE[action] }, count);
  }

  return deck;
}

/** True for a wild that can stand in for any colour at all. */
export const isRainbow = (card: Card): boolean =>
  card.kind === 'wild' && card.colours.length === COLOURS.length;

/** The colours a card could be laid down as, or an empty list. */
export function propertyColours(card: Card): Colour[] {
  if (card.kind === 'property') return [card.colour];
  if (card.kind === 'wild') return card.colours;
  return [];
}

/** A short label, for the log and for anything too small to draw a card. */
export function describe(card: Card): string {
  switch (card.kind) {
    case 'money':
      return `${card.value}M`;
    case 'property':
      return SETS[card.colour].name;
    case 'wild':
      return isRainbow(card)
        ? 'Wild (any colour)'
        : card.colours.map((c) => SETS[c].name).join('/');
    case 'rent':
      return card.colours.length === COLOURS.length
        ? 'Rent (any colour)'
        : `Rent ${card.colours.map((c) => SETS[c].name).join('/')}`;
    case 'action':
      return ACTION_NAME[card.action];
  }
}
