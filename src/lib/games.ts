/**
 * What each game is called.
 *
 * Separate from the hub's catalogue because a name is needed in places that
 * have no business importing a screen — the invitation toast, for one, which
 * until now announced that somebody had "started deal".
 */
import type { GameKind } from './types';

export const GAME_NAMES: Record<GameKind, string> = {
  chess: 'Chess',
  connect4: 'Connect Four',
  sequence: 'Sequence',
  crossy: 'Crossy Road',
  dots: 'Dots & Boxes',
  deal: 'Monopoly Deal',
  klondike: 'Klondike',
  freecell: 'FreeCell',
  spider: 'Spider',
  pyramid: 'Pyramid',
};

/** The name, or the raw kind if a peer is running a build we do not know. */
export const gameName = (kind: GameKind | string): string =>
  GAME_NAMES[kind as GameKind] ?? String(kind);
