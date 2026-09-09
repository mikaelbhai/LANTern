import React from 'react';
import { Calendar, Trophy } from 'lucide-react';
import { Badge, Button, Segmented, Tooltip } from '../../components/ui';
import { GameShell, WinCelebration } from './GameShell';
import {
  type Card,
  CardFace,
  type CardTheme,
  EmptySlot,
  SUIT_GLYPH,
  SUITS,
  dailySeed,
  dealFrom,
  isRed,
} from '../../lib/cards';
import { useLocalStorage } from '../../lib/hooks';
import { sfx } from '../../lib/audio';
import { cn, formatDuration } from '../../lib/utils';

interface State {
  stock: Card[];
  waste: Card[];
  foundations: Card[][];
  tableau: Card[][];
  moves: number;
}

type Source =
  | { zone: 'waste' }
  | { zone: 'tableau'; column: number; index: number }
  | { zone: 'foundation'; pile: number };

interface Scores {
  fewestMoves: Record<string, number>;
  fastestMs: Record<string, number>;
}

function deal(seed: number): State {
  const deck = dealFrom(seed);
  const tableau: Card[][] = [];
  let i = 0;
  for (let col = 0; col < 7; col++) {
    const pile: Card[] = [];
    for (let n = 0; n <= col; n++) {
      pile.push({ ...deck[i++], faceUp: n === col });
    }
    tableau.push(pile);
  }
  return {
    stock: deck.slice(i).map((c) => ({ ...c, faceUp: false })),
    waste: [],
    foundations: [[], [], [], []],
    tableau,
    moves: 0,
  };
}

const canStack = (card: Card, onto: Card | undefined) =>
  onto
    ? isRed(card.suit) !== isRed(onto.suit) && card.rank === onto.rank - 1
    : card.rank === 13;

const canFound = (card: Card, pile: Card[]) =>
  pile.length ? pile.at(-1)!.suit === card.suit && card.rank === pile.at(-1)!.rank + 1 : card.rank === 1;

export function Klondike({ onExit }: { onExit: () => void }) {
  const [drawCount, setDrawCount] = useLocalStorage<1 | 3>('lantern.klondike.draw', 1);
  const [scores, setScores] = useLocalStorage<Scores>('lantern.klondike.scores', {
    fewestMoves: {},
    fastestMs: {},
  });

  const [seed, setSeed] = React.useState(() => Math.floor(Math.random() * 1_000_000));
  const [isDaily, setIsDaily] = React.useState(false);
  const [state, setState] = React.useState<State>(() => deal(seed));
  const [past, setPast] = React.useState<State[]>([]);
  const [selected, setSelected] = React.useState<Source | null>(null);
  const [startedAt, setStartedAt] = React.useState(Date.now());
  const [won, setWon] = React.useState(false);

  const cardWidth = 62;

  const push = (next: State) => {
    setPast((p) => [...p, state].slice(-200));
    setState({ ...next, moves: state.moves + 1 });
    setSelected(null);
  };

  const newGame = (nextSeed?: number, daily = false) => {
    const s = nextSeed ?? Math.floor(Math.random() * 1_000_000);
    setSeed(s);
    setIsDaily(daily);
    setState(deal(s));
    setPast([]);
    setSelected(null);
    setWon(false);
    setStartedAt(Date.now());
  };

  const undo = () => {
    const prev = past.at(-1);
    if (!prev) return;
    setPast((p) => p.slice(0, -1));
    setState(prev);
    setSelected(null);
    sfx.cardPlace();
  };

  React.useEffect(() => {
    if (won) return;
    if (state.foundations.every((f) => f.length === 13)) {
      setWon(true);
      sfx.gameWin();
      const key = `draw${drawCount}`;
      const ms = Date.now() - startedAt;
      setScores((s) => ({
        fewestMoves: {
          ...s.fewestMoves,
          [key]: Math.min(s.fewestMoves[key] ?? Infinity, state.moves),
        },
        fastestMs: {
          ...s.fastestMs,
          [key]: Math.min(s.fastestMs[key] ?? Infinity, ms),
        },
      }));
    }
  }, [state.foundations, won, drawCount, startedAt, state.moves, setScores]);

  /* ------------------------------------------------------------ actions */

  const drawStock = () => {
    if (!state.stock.length) {
      if (!state.waste.length) return;
      push({
        ...state,
        stock: [...state.waste].reverse().map((c) => ({ ...c, faceUp: false })),
        waste: [],
      });
      sfx.cardDeal();
      return;
    }
    const n = Math.min(drawCount, state.stock.length);
    const drawn = state.stock.slice(-n).reverse().map((c) => ({ ...c, faceUp: true }));
    push({
      ...state,
      stock: state.stock.slice(0, -n),
      waste: [...state.waste, ...drawn],
    });
    sfx.cardDeal();
  };

  const takeFrom = (src: Source): Card[] => {
    if (src.zone === 'waste') return state.waste.slice(-1);
    if (src.zone === 'foundation') return state.foundations[src.pile].slice(-1);
    return state.tableau[src.column].slice(src.index);
  };

  const removeFrom = (s: State, src: Source): State => {
    if (src.zone === 'waste') return { ...s, waste: s.waste.slice(0, -1) };
    if (src.zone === 'foundation') {
      const foundations = s.foundations.map((f, i) => (i === src.pile ? f.slice(0, -1) : f));
      return { ...s, foundations };
    }
    const tableau = s.tableau.map((col, i) => {
      if (i !== src.column) return col;
      const rest = col.slice(0, src.index);
      if (rest.length && !rest.at(-1)!.faceUp) {
        rest[rest.length - 1] = { ...rest.at(-1)!, faceUp: true };
      }
      return rest;
    });
    return { ...s, tableau };
  };

  const moveToTableau = (src: Source, column: number) => {
    const cards = takeFrom(src);
    if (!cards.length) return false;
    const target = state.tableau[column].at(-1);
    if (!canStack(cards[0], target)) return false;
    const removed = removeFrom(state, src);
    push({
      ...removed,
      tableau: removed.tableau.map((col, i) => (i === column ? [...col, ...cards] : col)),
    });
    sfx.cardPlace();
    return true;
  };

  const moveToFoundation = (src: Source, pile?: number) => {
    const cards = takeFrom(src);
    if (cards.length !== 1) return false;
    const card = cards[0];
    const target =
      pile !== undefined
        ? canFound(card, state.foundations[pile])
          ? pile
          : -1
        : state.foundations.findIndex((f) => canFound(card, f));
    if (target < 0) return false;
    const removed = removeFrom(state, src);
    push({
      ...removed,
      foundations: removed.foundations.map((f, i) => (i === target ? [...f, card] : f)),
    });
    sfx.cardFoundation();
    return true;
  };

  const onCardClick = (src: Source, card: Card) => {
    if (!card.faceUp) return;

    if (selected) {
      if (
        selected.zone === src.zone &&
        (selected as any).column === (src as any).column &&
        (selected as any).index === (src as any).index
      ) {
        setSelected(null);
        return;
      }
      if (src.zone === 'tableau' && moveToTableau(selected, src.column)) return;
      if (src.zone === 'foundation' && moveToFoundation(selected, src.pile)) return;
      sfx.cardInvalid();
      setSelected(null);
      return;
    }

    // Only the top of a tableau run, or a properly ordered sequence, can move.
    if (src.zone === 'tableau') {
      const run = state.tableau[src.column].slice(src.index);
      const ordered = run.every(
        (c, i) =>
          c.faceUp &&
          (i === 0 || (isRed(c.suit) !== isRed(run[i - 1].suit) && c.rank === run[i - 1].rank - 1)),
      );
      if (!ordered) {
        sfx.cardInvalid();
        return;
      }
    }
    setSelected(src);
  };

  const onCardDouble = (src: Source, card: Card) => {
    if (!card.faceUp) return;
    if (src.zone === 'tableau' && src.index !== state.tableau[src.column].length - 1) return;
    if (!moveToFoundation(src)) sfx.cardInvalid();
  };

  const key = `draw${drawCount}`;
  const bestMoves = scores.fewestMoves[key];
  const bestTime = scores.fastestMs[key];

  return (
    <GameShell
      title="Klondike"
      themeKey="lantern.klondike.theme"
      onExit={onExit}
      onUndo={undo}
      canUndo={past.length > 0}
      onRestart={() => newGame()}
      moves={state.moves}
      running={!won}
      status={
        <>
          {isDaily && (
            <Badge tone="gold">
              <Calendar size={9} />
              Daily #{seed}
            </Badge>
          )}
          {!isDaily && <Badge tone="muted">Deal #{seed}</Badge>}
          {bestMoves !== undefined && Number.isFinite(bestMoves) && (
            <Tooltip content={`Best: ${bestMoves} moves · ${formatDuration(bestTime ?? 0)}`}>
              <Badge tone="cyan">
                <Trophy size={9} />
                {bestMoves}
              </Badge>
            </Tooltip>
          )}
        </>
      }
      extraControls={
        <>
          <Segmented
            value={String(drawCount)}
            onChange={(v) => {
              setDrawCount(v === '3' ? 3 : 1);
              newGame();
            }}
            size="xs"
            options={[
              { value: '1', label: 'Draw 1' },
              { value: '3', label: 'Draw 3' },
            ]}
          />
          <Button size="xs" onClick={() => newGame(dailySeed(), true)}>
            Daily
          </Button>
          <Button size="xs" onClick={() => newGame(seed)}>
            Replay deal
          </Button>
        </>
      }
    >
      {(theme) => (
        <>
          <div className="p-4 min-w-[620px]">
            {/* stock, waste, foundations */}
            <div className="flex gap-2 mb-6">
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

              <div className="relative" style={{ width: cardWidth + (drawCount === 3 ? 30 : 0) }}>
                {state.waste.length === 0 ? (
                  <EmptySlot theme={theme} width={cardWidth} />
                ) : (
                  state.waste.slice(-drawCount).map((c, i, arr) => {
                    const top = i === arr.length - 1;
                    return (
                      <div
                        key={c.id}
                        className="absolute top-0"
                        style={{ left: i * 15, zIndex: i }}
                      >
                        <CardFace
                          card={c}
                          theme={theme}
                          width={cardWidth}
                          selected={top && selected?.zone === 'waste'}
                          onClick={() => top && onCardClick({ zone: 'waste' }, c)}
                          onDoubleClick={() => top && onCardDouble({ zone: 'waste' }, c)}
                        />
                      </div>
                    );
                  })
                )}
              </div>

              <div className="flex gap-2 ml-auto">
                {state.foundations.map((pile, i) => (
                  <div key={i}>
                    {pile.length ? (
                      <CardFace
                        card={pile.at(-1)!}
                        theme={theme}
                        width={cardWidth}
                        onClick={() => onCardClick({ zone: 'foundation', pile: i }, pile.at(-1)!)}
                      />
                    ) : (
                      <EmptySlot
                        theme={theme}
                        width={cardWidth}
                        label={SUIT_GLYPH[SUITS[i]]}
                        highlight={!!selected}
                        onClick={() => selected && moveToFoundation(selected, i)}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* tableau */}
            <div className="flex gap-2">
              {state.tableau.map((col, ci) => (
                <div
                  key={ci}
                  className="relative"
                  style={{
                    width: cardWidth,
                    minHeight: Math.round(cardWidth * 1.42),
                  }}
                >
                  {col.length === 0 ? (
                    <EmptySlot
                      theme={theme}
                      width={cardWidth}
                      highlight={!!selected}
                      onClick={() => selected && moveToTableau(selected, ci)}
                    />
                  ) : (
                    col.map((c, i) => (
                      <div
                        key={c.id}
                        className="absolute left-0"
                        style={{
                          top: i * (c.faceUp ? 22 : 11),
                          zIndex: i,
                        }}
                      >
                        <CardFace
                          card={c}
                          theme={theme}
                          width={cardWidth}
                          selected={
                            selected?.zone === 'tableau' &&
                            selected.column === ci &&
                            i >= selected.index
                          }
                          onClick={() => onCardClick({ zone: 'tableau', column: ci, index: i }, c)}
                          onDoubleClick={() =>
                            onCardDouble({ zone: 'tableau', column: ci, index: i }, c)
                          }
                        />
                      </div>
                    ))
                  )}
                  {/* click target below the pile for dropping onto the column */}
                  {col.length > 0 && selected && (
                    <button
                      onClick={() => moveToTableau(selected, ci)}
                      className="absolute left-0 right-0 h-10"
                      style={{
                        top:
                          (col.length - 1) * 22 + Math.round(cardWidth * 1.42) - 6,
                        zIndex: col.length + 1,
                      }}
                      aria-label={`Move to column ${ci + 1}`}
                    />
                  )}
                </div>
              ))}
            </div>
          </div>

          <WinCelebration
            open={won}
            title="Cleared!"
            detail={
              <>
                {state.moves} moves in {formatDuration(Date.now() - startedAt)}
                {isDaily ? ` · Daily #${seed}` : ` · Deal #${seed}`}
              </>
            }
            onNewGame={() => newGame()}
            onExit={onExit}
            theme={theme}
          />
        </>
      )}
    </GameShell>
  );
}
