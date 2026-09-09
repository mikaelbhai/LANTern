import React from 'react';
import { Lightbulb, Trophy } from 'lucide-react';
import { Badge, Button, Input, Tooltip } from '../../components/ui';
import { GameShell, WinCelebration } from './GameShell';
import {
  type Card,
  CardFace,
  EmptySlot,
  SUITS,
  SUIT_GLYPH,
  dealFrom,
  isRed,
} from '../../lib/cards';
import { useLocalStorage } from '../../lib/hooks';
import { sfx } from '../../lib/audio';
import { formatDuration } from '../../lib/utils';

interface State {
  free: (Card | null)[];
  foundations: Card[][];
  cascades: Card[][];
  moves: number;
}

type Source =
  | { zone: 'free'; cell: number }
  | { zone: 'cascade'; column: number; index: number }
  | { zone: 'foundation'; pile: number };

interface Record_ {
  wins: number;
  losses: number;
  streak: number;
  deals: number[];
}

function deal(seed: number): State {
  const deck = dealFrom(seed).map((c) => ({ ...c, faceUp: true }));
  const cascades: Card[][] = Array.from({ length: 8 }, () => []);
  deck.forEach((c, i) => cascades[i % 8].push(c));
  return { free: [null, null, null, null], foundations: [[], [], [], []], cascades, moves: 0 };
}

const canStack = (card: Card, onto: Card | undefined) =>
  onto ? isRed(card.suit) !== isRed(onto.suit) && card.rank === onto.rank - 1 : true;

const canFound = (card: Card, pile: Card[]) =>
  pile.length ? pile.at(-1)!.suit === card.suit && card.rank === pile.at(-1)!.rank + 1 : card.rank === 1;

const isOrderedRun = (run: Card[]) =>
  run.every(
    (c, i) =>
      i === 0 || (isRed(c.suit) !== isRed(run[i - 1].suit) && c.rank === run[i - 1].rank - 1),
  );

/**
 * Standard supermove capacity: (free cells + 1) × 2^(empty columns). An empty
 * destination column cannot also be used as a staging column, so it is excluded.
 */
function maxRun(state: State, destinationIsEmpty: boolean): number {
  const freeCells = state.free.filter((c) => !c).length;
  const emptyCols = state.cascades.filter((c) => !c.length).length;
  const usable = Math.max(0, emptyCols - (destinationIsEmpty ? 1 : 0));
  return (freeCells + 1) * 2 ** usable;
}

export function FreeCell({ onExit }: { onExit: () => void }) {
  const [record, setRecord] = useLocalStorage<Record_>('lantern.freecell.record', {
    wins: 0,
    losses: 0,
    streak: 0,
    deals: [],
  });

  const [seed, setSeed] = React.useState(() => 1 + Math.floor(Math.random() * 1_000_000));
  const [seedInput, setSeedInput] = React.useState('');
  const [state, setState] = React.useState<State>(() => deal(seed));
  const [past, setPast] = React.useState<State[]>([]);
  const [selected, setSelected] = React.useState<Source | null>(null);
  const [hint, setHint] = React.useState<string | null>(null);
  const [startedAt, setStartedAt] = React.useState(Date.now());
  const [won, setWon] = React.useState(false);

  const cardWidth = 60;

  const push = (next: State) => {
    setPast((p) => [...p, state]);
    setState({ ...next, moves: state.moves + 1 });
    setSelected(null);
    setHint(null);
  };

  const newGame = (n?: number) => {
    const s = n ?? 1 + Math.floor(Math.random() * 1_000_000);
    setSeed(s);
    setState(deal(s));
    setPast([]);
    setSelected(null);
    setHint(null);
    setWon(false);
    setStartedAt(Date.now());
  };

  React.useEffect(() => {
    if (won) return;
    if (state.foundations.every((f) => f.length === 13)) {
      setWon(true);
      sfx.gameWin();
      setRecord((r) => ({
        wins: r.wins + 1,
        losses: r.losses,
        streak: r.streak + 1,
        deals: [seed, ...r.deals].slice(0, 30),
      }));
    }
  }, [state.foundations, won, seed, setRecord]);

  const takeFrom = (src: Source): Card[] => {
    if (src.zone === 'free') return state.free[src.cell] ? [state.free[src.cell]!] : [];
    if (src.zone === 'foundation') return state.foundations[src.pile].slice(-1);
    return state.cascades[src.column].slice(src.index);
  };

  const removeFrom = (s: State, src: Source): State => {
    if (src.zone === 'free') {
      return { ...s, free: s.free.map((c, i) => (i === src.cell ? null : c)) };
    }
    if (src.zone === 'foundation') {
      return {
        ...s,
        foundations: s.foundations.map((f, i) => (i === src.pile ? f.slice(0, -1) : f)),
      };
    }
    return {
      ...s,
      cascades: s.cascades.map((c, i) => (i === src.column ? c.slice(0, src.index) : c)),
    };
  };

  const moveToCascade = (src: Source, column: number) => {
    const cards = takeFrom(src);
    if (!cards.length || !isOrderedRun(cards)) return false;
    const target = state.cascades[column].at(-1);
    if (!canStack(cards[0], target)) return false;
    if (cards.length > maxRun(state, !target)) {
      setHint(
        `That run needs ${cards.length} slots but only ${maxRun(state, !target)} are available. Free a cell or a column.`,
      );
      sfx.cardInvalid();
      return false;
    }
    const removed = removeFrom(state, src);
    push({
      ...removed,
      cascades: removed.cascades.map((c, i) => (i === column ? [...c, ...cards] : c)),
    });
    sfx.cardPlace();
    return true;
  };

  const moveToFree = (src: Source, cell: number) => {
    if (state.free[cell]) return false;
    const cards = takeFrom(src);
    if (cards.length !== 1) return false;
    const removed = removeFrom(state, src);
    push({ ...removed, free: removed.free.map((c, i) => (i === cell ? cards[0] : c)) });
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

  const onCardClick = (src: Source) => {
    if (!selected) {
      if (src.zone === 'cascade') {
        const run = state.cascades[src.column].slice(src.index);
        if (!isOrderedRun(run)) {
          sfx.cardInvalid();
          return;
        }
      }
      setSelected(src);
      return;
    }
    if (src.zone === 'cascade' && moveToCascade(selected, src.column)) return;
    if (src.zone === 'foundation' && moveToFoundation(selected, src.pile)) return;
    if (src.zone === 'free' && moveToFree(selected, src.cell)) return;
    setSelected(null);
  };

  const findHint = () => {
    // Foundation moves first, then any legal single-card cascade move.
    for (let i = 0; i < state.cascades.length; i++) {
      const top = state.cascades[i].at(-1);
      if (top && state.foundations.some((f) => canFound(top, f))) {
        setHint(`Send ${top.rank === 1 ? 'A' : top.rank}${SUIT_GLYPH[top.suit]} from column ${i + 1} to a foundation.`);
        return;
      }
    }
    for (let i = 0; i < state.cascades.length; i++) {
      const top = state.cascades[i].at(-1);
      if (!top) continue;
      for (let j = 0; j < state.cascades.length; j++) {
        if (i === j) continue;
        if (canStack(top, state.cascades[j].at(-1)) && state.cascades[j].length) {
          setHint(`Move ${top.rank === 1 ? 'A' : top.rank}${SUIT_GLYPH[top.suit]} from column ${i + 1} onto column ${j + 1}.`);
          return;
        }
      }
    }
    if (state.free.some((c) => !c)) {
      setHint('No stacking move — park a card in a free cell to open up the board.');
      return;
    }
    setHint('No legal move found. Undo a few moves, or start a new deal.');
  };

  return (
    <GameShell
      title="FreeCell"
      themeKey="lantern.freecell.theme"
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
          <Badge tone="muted">Deal #{seed}</Badge>
          <Tooltip content={`${record.wins}W / ${record.losses}L`}>
            <Badge tone="cyan">
              <Trophy size={9} />
              {record.streak} streak
            </Badge>
          </Tooltip>
        </>
      }
      extraControls={
        <>
          <Input
            value={seedInput}
            onChange={(e) => setSeedInput(e.target.value.replace(/\D/g, '').slice(0, 7))}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && seedInput) {
                newGame(Math.min(1_000_000, Math.max(1, +seedInput)));
                setSeedInput('');
              }
            }}
            placeholder="Deal #"
            className="w-20 font-mono"
          />
          <Button size="xs" icon={<Lightbulb size={11} />} onClick={findHint}>
            Hint
          </Button>
          <Button size="xs" onClick={() => newGame(seed)}>
            Restart deal
          </Button>
        </>
      }
    >
      {(theme) => (
        <>
          <div className="p-4 min-w-[620px]">
            <div className="flex gap-2 mb-6">
              {state.free.map((c, i) => (
                <div key={i}>
                  {c ? (
                    <CardFace
                      card={c}
                      theme={theme}
                      width={cardWidth}
                      selected={selected?.zone === 'free' && selected.cell === i}
                      onClick={() => onCardClick({ zone: 'free', cell: i })}
                      onDoubleClick={() => moveToFoundation({ zone: 'free', cell: i })}
                    />
                  ) : (
                    <EmptySlot
                      theme={theme}
                      width={cardWidth}
                      highlight={!!selected}
                      onClick={() => selected && moveToFree(selected, i)}
                    />
                  )}
                </div>
              ))}

              <div className="flex gap-2 ml-auto">
                {state.foundations.map((pile, i) => (
                  <div key={i}>
                    {pile.length ? (
                      <CardFace
                        card={pile.at(-1)!}
                        theme={theme}
                        width={cardWidth}
                        onClick={() => onCardClick({ zone: 'foundation', pile: i })}
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

            {hint && (
              <div className="mb-3 px-3 py-2 rounded-input bg-cyan/10 border border-cyan/40 text-xs text-cyan">
                {hint}
              </div>
            )}

            <div className="flex gap-2">
              {state.cascades.map((col, ci) => (
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
                      onClick={() => selected && moveToCascade(selected, ci)}
                    />
                  ) : (
                    <>
                      {col.map((c, i) => (
                        <div
                          key={c.id}
                          className="absolute left-0"
                          style={{ top: i * 22, zIndex: i }}
                        >
                          <CardFace
                            card={c}
                            theme={theme}
                            width={cardWidth}
                            selected={
                              selected?.zone === 'cascade' &&
                              selected.column === ci &&
                              i >= selected.index
                            }
                            onClick={() => onCardClick({ zone: 'cascade', column: ci, index: i })}
                            onDoubleClick={() =>
                              i === col.length - 1 &&
                              moveToFoundation({ zone: 'cascade', column: ci, index: i })
                            }
                          />
                        </div>
                      ))}
                      {selected && (
                        <button
                          onClick={() => moveToCascade(selected, ci)}
                          className="absolute left-0 right-0 h-10"
                          style={{
                            top: (col.length - 1) * 22 + Math.round(cardWidth * 1.42) - 6,
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
            title="FreeCell solved"
            detail={`Deal #${seed} · ${state.moves} moves in ${formatDuration(Date.now() - startedAt)}`}
            onNewGame={() => newGame()}
            onExit={onExit}
            theme={theme}
          />
        </>
      )}
    </GameShell>
  );
}
