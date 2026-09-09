import React from 'react';
import { motion } from 'framer-motion';
import { Badge, Segmented } from '../../components/ui';
import { GameShell, WinCelebration } from './GameShell';
import {
  type Card,
  CardFace,
  EmptySlot,
  type Suit,
  dealFrom,
} from '../../lib/cards';
import { useLocalStorage } from '../../lib/hooks';
import { sfx } from '../../lib/audio';
import { formatDuration } from '../../lib/utils';

type Difficulty = '1' | '2' | '4';

const SUIT_SETS: Record<Difficulty, Suit[]> = {
  '1': ['s'],
  '2': ['s', 'h'],
  '4': ['s', 'h', 'd', 'c'],
};

interface State {
  tableau: Card[][];
  stock: Card[][];
  completed: number;
  moves: number;
}

function deal(seed: number, difficulty: Difficulty): State {
  const suits = SUIT_SETS[difficulty];
  // Always 104 cards: eight decks of one suit, four of two, two of four.
  const decks = 8 / suits.length;
  const cards = dealFrom(seed, decks, suits);

  const tableau: Card[][] = Array.from({ length: 10 }, () => []);
  let i = 0;
  for (let col = 0; col < 10; col++) {
    const count = col < 4 ? 6 : 5;
    for (let n = 0; n < count; n++, i++) {
      tableau[col].push({ ...cards[i], faceUp: n === count - 1 });
    }
  }

  const stock: Card[][] = [];
  while (i < cards.length) {
    stock.push(cards.slice(i, i + 10).map((c) => ({ ...c, faceUp: false })));
    i += 10;
  }

  return { tableau, stock, completed: 0, moves: 0 };
}

const isDescendingSameSuit = (run: Card[]) =>
  run.every(
    (c, i) =>
      c.faceUp &&
      (i === 0 || (c.suit === run[i - 1].suit && c.rank === run[i - 1].rank - 1)),
  );

export function Spider({ onExit }: { onExit: () => void }) {
  const [difficulty, setDifficulty] = useLocalStorage<Difficulty>('lantern.spider.difficulty', '1');
  const [seed, setSeed] = React.useState(() => Math.floor(Math.random() * 1_000_000));
  const [state, setState] = React.useState<State>(() => deal(seed, difficulty));
  const [past, setPast] = React.useState<State[]>([]);
  const [selected, setSelected] = React.useState<{ column: number; index: number } | null>(null);
  const [flying, setFlying] = React.useState<string | null>(null);
  const [startedAt, setStartedAt] = React.useState(Date.now());
  const [won, setWon] = React.useState(false);

  const cardWidth = 56;

  const push = (next: State) => {
    setPast((p) => [...p, state].slice(-10));
    setState({ ...next, moves: state.moves + 1 });
    setSelected(null);
  };

  const newGame = (d: Difficulty = difficulty) => {
    const s = Math.floor(Math.random() * 1_000_000);
    setSeed(s);
    setState(deal(s, d));
    setPast([]);
    setSelected(null);
    setWon(false);
    setStartedAt(Date.now());
  };

  /** Removes any completed A–K run and reveals the card beneath it. */
  const collectRuns = (s: State): State => {
    let next = s;
    for (let ci = 0; ci < next.tableau.length; ci++) {
      const col = next.tableau[ci];
      if (col.length < 13) continue;
      const tail = col.slice(-13);
      if (tail[0].rank === 13 && isDescendingSameSuit(tail)) {
        const rest = col.slice(0, -13);
        if (rest.length && !rest.at(-1)!.faceUp) {
          rest[rest.length - 1] = { ...rest.at(-1)!, faceUp: true };
        }
        next = {
          ...next,
          tableau: next.tableau.map((c, i) => (i === ci ? rest : c)),
          completed: next.completed + 1,
        };
        setFlying(tail[0].id);
        setTimeout(() => setFlying(null), 700);
        sfx.cardFoundation();
      }
    }
    return next;
  };

  React.useEffect(() => {
    if (!won && state.completed === 8) {
      setWon(true);
      sfx.gameWin();
    }
  }, [state.completed, won]);

  const dealRow = () => {
    if (!state.stock.length) return;
    if (state.tableau.some((c) => c.length === 0)) {
      sfx.cardInvalid();
      return;
    }
    const row = state.stock[0];
    const tableau = state.tableau.map((col, i) => [...col, { ...row[i], faceUp: true }]);
    push(collectRuns({ ...state, tableau, stock: state.stock.slice(1) }));
    sfx.cardDeal();
  };

  const moveTo = (column: number) => {
    if (!selected) return;
    const run = state.tableau[selected.column].slice(selected.index);
    if (!isDescendingSameSuit(run)) {
      sfx.cardInvalid();
      setSelected(null);
      return;
    }
    const target = state.tableau[column].at(-1);
    if (target && (!target.faceUp || target.rank !== run[0].rank + 1)) {
      sfx.cardInvalid();
      setSelected(null);
      return;
    }

    const tableau = state.tableau.map((col, i) => {
      if (i === selected.column) {
        const rest = col.slice(0, selected.index);
        if (rest.length && !rest.at(-1)!.faceUp) {
          rest[rest.length - 1] = { ...rest.at(-1)!, faceUp: true };
        }
        return rest;
      }
      if (i === column) return [...col, ...run];
      return col;
    });

    push(collectRuns({ ...state, tableau }));
    sfx.cardPlace();
  };

  const onCardClick = (column: number, index: number) => {
    const card = state.tableau[column][index];
    if (!card.faceUp) return;

    if (selected) {
      if (selected.column === column && selected.index === index) {
        setSelected(null);
        return;
      }
      moveTo(column);
      return;
    }

    const run = state.tableau[column].slice(index);
    if (!isDescendingSameSuit(run)) {
      sfx.cardInvalid();
      return;
    }
    setSelected({ column, index });
  };

  return (
    <GameShell
      title="Spider"
      themeKey="lantern.spider.theme"
      onExit={onExit}
      onUndo={() => {
        const prev = past.at(-1);
        if (!prev) return;
        setPast((p) => p.slice(0, -1));
        setState(prev);
        setSelected(null);
        sfx.cardPlace();
      }}
      canUndo={past.length > 0}
      onRestart={() => newGame()}
      moves={state.moves}
      running={!won}
      status={
        <>
          <Badge tone="gold">{state.completed}/8 suits</Badge>
          <Badge tone="muted">{state.stock.length} deals left</Badge>
        </>
      }
      extraControls={
        <Segmented
          value={difficulty}
          onChange={(v) => {
            setDifficulty(v);
            newGame(v);
          }}
          size="xs"
          options={[
            { value: '1', label: '1 suit' },
            { value: '2', label: '2 suits' },
            { value: '4', label: '4 suits' },
          ]}
        />
      }
    >
      {(theme) => (
        <>
          <div className="p-4 min-w-[680px]">
            <div className="flex items-start gap-2 mb-4">
              <div className="flex -space-x-8">
                {state.stock.map((_, i) => (
                  <button key={i} onClick={dealRow} aria-label="Deal a row">
                    <CardFace
                      card={{ id: `stock${i}`, suit: 's', rank: 1, faceUp: false }}
                      theme={theme}
                      width={cardWidth}
                    />
                  </button>
                ))}
                {state.stock.length === 0 && (
                  <EmptySlot theme={theme} width={cardWidth} label="—" />
                )}
              </div>

              <div className="flex gap-1.5 ml-auto">
                {Array.from({ length: 8 }, (_, i) => (
                  <div
                    key={i}
                    className="rounded-[6px] grid place-items-center"
                    style={{
                      width: cardWidth * 0.6,
                      height: cardWidth * 0.85,
                      border: `1px solid ${i < state.completed ? '#F5A623' : 'rgba(255,255,255,0.15)'}`,
                      background: i < state.completed ? 'rgba(245,166,35,0.18)' : 'transparent',
                    }}
                  >
                    <span className="text-2xs" style={{ color: i < state.completed ? '#F5A623' : '#4B566A' }}>
                      K
                    </span>
                  </div>
                ))}
              </div>
            </div>

            <div className="flex gap-1.5">
              {state.tableau.map((col, ci) => (
                <div
                  key={ci}
                  className="relative"
                  style={{ width: cardWidth, minHeight: Math.round(cardWidth * 1.42) }}
                >
                  {col.length === 0 ? (
                    <EmptySlot
                      theme={theme}
                      width={cardWidth}
                      highlight={!!selected}
                      onClick={() => selected && moveTo(ci)}
                    />
                  ) : (
                    <>
                      {col.map((c, i) => (
                        <motion.div
                          key={c.id}
                          layout
                          animate={
                            flying === c.id
                              ? { y: -200, opacity: 0, scale: 0.8 }
                              : { y: 0, opacity: 1, scale: 1 }
                          }
                          className="absolute left-0"
                          style={{ top: i * (c.faceUp ? 20 : 9), zIndex: i }}
                        >
                          <CardFace
                            card={c}
                            theme={theme}
                            width={cardWidth}
                            selected={
                              selected?.column === ci && i >= selected.index
                            }
                            onClick={() => onCardClick(ci, i)}
                          />
                        </motion.div>
                      ))}
                      {selected && (
                        <button
                          onClick={() => moveTo(ci)}
                          className="absolute left-0 right-0 h-10"
                          style={{
                            top:
                              (col.length - 1) * 20 + Math.round(cardWidth * 1.42) - 6,
                            zIndex: col.length + 1,
                          }}
                          aria-label={`Move to column ${ci + 1}`}
                        />
                      )}
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>

          <WinCelebration
            open={won}
            title="All eight suits home"
            detail={`${state.moves} moves in ${formatDuration(Date.now() - startedAt)} · ${difficulty} suit${difficulty === '1' ? '' : 's'}`}
            onNewGame={() => newGame()}
            onExit={onExit}
            theme={theme}
          />
        </>
      )}
    </GameShell>
  );
}
