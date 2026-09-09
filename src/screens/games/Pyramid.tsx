import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Flame } from 'lucide-react';
import { Badge } from '../../components/ui';
import { GameShell, WinCelebration } from './GameShell';
import { type Card, CardFace, EmptySlot, dealFrom } from '../../lib/cards';
import { useLocalStorage } from '../../lib/hooks';
import { sfx } from '../../lib/audio';
import { formatDuration } from '../../lib/utils';

interface Slot {
  card: Card | null;
  row: number;
  col: number;
}

interface State {
  pyramid: Slot[][];
  stock: Card[];
  waste: Card[];
  moves: number;
  cleared: number;
}

type Pick =
  | { zone: 'pyramid'; row: number; col: number }
  | { zone: 'waste' }
  | { zone: 'stock' };

function deal(seed: number): State {
  const deck = dealFrom(seed).map((c) => ({ ...c, faceUp: true }));
  const pyramid: Slot[][] = [];
  let i = 0;
  for (let row = 0; row < 7; row++) {
    const cells: Slot[] = [];
    for (let col = 0; col <= row; col++) cells.push({ card: deck[i++], row, col });
    pyramid.push(cells);
  }
  return { pyramid, stock: deck.slice(i), waste: [], moves: 0, cleared: 0 };
}

/** A pyramid card is playable only once both cards resting on it are gone. */
function isExposed(pyramid: Slot[][], row: number, col: number): boolean {
  if (row === 6) return true;
  const below = pyramid[row + 1];
  return !below[col].card && !below[col + 1].card;
}

export function Pyramid({ onExit }: { onExit: () => void }) {
  const [best, setBest] = useLocalStorage<{ streak: number; wins: number }>(
    'lantern.pyramid.best',
    { streak: 0, wins: 0 },
  );

  const [seed, setSeed] = React.useState(() => Math.floor(Math.random() * 1_000_000));
  const [state, setState] = React.useState<State>(() => deal(seed));
  const [past, setPast] = React.useState<State[]>([]);
  const [picked, setPicked] = React.useState<Pick | null>(null);
  const [removing, setRemoving] = React.useState<string[]>([]);
  const [startedAt, setStartedAt] = React.useState(Date.now());
  const [won, setWon] = React.useState(false);

  const cardWidth = 54;

  const push = (next: State) => {
    setPast((p) => [...p, state].slice(-50));
    setState({ ...next, moves: state.moves + 1 });
    setPicked(null);
  };

  const newGame = () => {
    const s = Math.floor(Math.random() * 1_000_000);
    setSeed(s);
    setState(deal(s));
    setPast([]);
    setPicked(null);
    setWon(false);
    setStartedAt(Date.now());
  };

  React.useEffect(() => {
    if (won) return;
    const empty = state.pyramid.every((row) => row.every((s) => !s.card));
    if (empty) {
      setWon(true);
      sfx.gameWin();
      setBest((b) => ({ streak: b.streak + 1, wins: b.wins + 1 }));
    }
  }, [state.pyramid, won, setBest]);

  const cardAt = (p: Pick): Card | null => {
    if (p.zone === 'pyramid') return state.pyramid[p.row][p.col].card;
    if (p.zone === 'waste') return state.waste.at(-1) ?? null;
    return state.stock.at(-1) ?? null;
  };

  const removeAt = (s: State, p: Pick): State => {
    if (p.zone === 'pyramid') {
      return {
        ...s,
        pyramid: s.pyramid.map((row, r) =>
          r === p.row ? row.map((cell, c) => (c === p.col ? { ...cell, card: null } : cell)) : row,
        ),
        cleared: s.cleared + 1,
      };
    }
    if (p.zone === 'waste') return { ...s, waste: s.waste.slice(0, -1) };
    return { ...s, stock: s.stock.slice(0, -1) };
  };

  const playable = (p: Pick): boolean => {
    if (p.zone === 'pyramid') return isExposed(state.pyramid, p.row, p.col) && !!cardAt(p);
    return !!cardAt(p);
  };

  const select = (p: Pick) => {
    const card = cardAt(p);
    if (!card || !playable(p)) {
      sfx.cardInvalid();
      return;
    }

    // Kings clear on their own.
    if (card.rank === 13) {
      setRemoving([card.id]);
      setTimeout(() => setRemoving([]), 260);
      push(removeAt(state, p));
      sfx.cardFoundation();
      return;
    }

    if (!picked) {
      setPicked(p);
      return;
    }

    const first = cardAt(picked);
    if (!first) {
      setPicked(p);
      return;
    }
    if (
      picked.zone === p.zone &&
      (picked as any).row === (p as any).row &&
      (picked as any).col === (p as any).col
    ) {
      setPicked(null);
      return;
    }

    if (first.rank + card.rank === 13) {
      setRemoving([first.id, card.id]);
      setTimeout(() => setRemoving([]), 260);
      push(removeAt(removeAt(state, picked), p));
      sfx.cardFoundation();
    } else {
      sfx.cardInvalid();
      setPicked(null);
    }
  };

  const drawStock = () => {
    if (!state.stock.length) {
      if (!state.waste.length) return;
      push({ ...state, stock: [...state.waste].reverse(), waste: [] });
      sfx.cardDeal();
      return;
    }
    push({
      ...state,
      stock: state.stock.slice(0, -1),
      waste: [...state.waste, state.stock.at(-1)!],
    });
    sfx.cardDeal();
  };

  const remaining = state.pyramid.flat().filter((s) => s.card).length;

  return (
    <GameShell
      title="Pyramid"
      themeKey="lantern.pyramid.theme"
      onExit={onExit}
      onUndo={() => {
        const prev = past.at(-1);
        if (!prev) return;
        setPast((p) => p.slice(0, -1));
        setState(prev);
        setPicked(null);
        sfx.cardPlace();
      }}
      canUndo={past.length > 0}
      onRestart={newGame}
      moves={state.moves}
      running={!won}
      status={
        <>
          <Badge tone="gold">{remaining} left</Badge>
          <Badge tone="cyan">
            <Flame size={9} />
            {best.streak} streak
          </Badge>
        </>
      }
    >
      {(theme) => (
        <>
          <div className="p-4 flex flex-col items-center min-w-[560px]">
            <p className="text-2xs text-muted mb-3">
              Pair cards that add to 13 · J = 11, Q = 12 · Kings clear alone
            </p>

            <div className="relative mb-6" style={{ height: 7 * 34 + cardWidth * 1.42 - 34 }}>
              {state.pyramid.map((row, r) =>
                row.map((cell, c) => {
                  const exposed = isExposed(state.pyramid, r, c);
                  const left = (c - r / 2) * (cardWidth + 6);
                  const top = r * 34;
                  const isPicked =
                    picked?.zone === 'pyramid' && picked.row === r && picked.col === c;

                  return (
                    <AnimatePresence key={`${r}-${c}`}>
                      {cell.card && (
                        <motion.div
                          initial={{ opacity: 0, scale: 0.9 }}
                          animate={{
                            opacity: removing.includes(cell.card.id) ? 0 : 1,
                            scale: removing.includes(cell.card.id) ? 0.7 : 1,
                          }}
                          exit={{ opacity: 0, scale: 0.6 }}
                          className="absolute"
                          style={{
                            left: `calc(50% + ${left}px - ${cardWidth / 2}px)`,
                            top,
                            zIndex: r,
                          }}
                        >
                          <CardFace
                            card={cell.card}
                            theme={theme}
                            width={cardWidth}
                            dimmed={!exposed}
                            selected={isPicked}
                            onClick={() => select({ zone: 'pyramid', row: r, col: c })}
                          />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  );
                }),
              )}
            </div>

            <div className="flex items-center gap-4">
              <div onClick={drawStock} className="cursor-pointer">
                {state.stock.length ? (
                  <CardFace
                    card={{ ...state.stock.at(-1)!, faceUp: false }}
                    theme={theme}
                    width={cardWidth}
                  />
                ) : (
                  <EmptySlot theme={theme} width={cardWidth} label="↻" />
                )}
              </div>
              <span className="text-2xs text-muted font-mono w-8">{state.stock.length}</span>

              {state.waste.length ? (
                <CardFace
                  card={state.waste.at(-1)!}
                  theme={theme}
                  width={cardWidth}
                  selected={picked?.zone === 'waste'}
                  onClick={() => select({ zone: 'waste' })}
                />
              ) : (
                <EmptySlot theme={theme} width={cardWidth} />
              )}
            </div>
          </div>

          <WinCelebration
            open={won}
            title="Pyramid cleared"
            detail={`${state.moves} moves in ${formatDuration(Date.now() - startedAt)} · deal #${seed}`}
            onNewGame={newGame}
            onExit={onExit}
            theme={theme}
          />
        </>
      )}
    </GameShell>
  );
}
