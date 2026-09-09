import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { ArrowLeft, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Flag, Handshake, RotateCcw, Settings2 } from 'lucide-react';
import { Avatar } from '../../components/Avatar';
import { Badge, Button, IconButton, Modal, Segmented, Select, Toggle, Tooltip } from '../../components/ui';
import { BOARD_THEMES, ChessPiece, PIECE_SET_NAMES, type PieceSetId } from '../../lib/chessArt';
import {
  type Color,
  type Move,
  type Outcome,
  type PieceType,
  type Position,
  applyMove,
  capturedPieces,
  evaluateOutcome,
  fileOf,
  findKing,
  inCheck,
  initialPosition,
  isLightSquare,
  legalMoves,
  materialBalance,
  opposite,
  positionKey,
  rankOf,
  squareName,
  toSan,
} from '../../lib/chess';
import { useStore } from '../../lib/store';
import { useLocalStorage } from '../../lib/hooks';
import { sfx } from '../../lib/audio';
import { cn, formatDuration } from '../../lib/utils';

type TimeControlId = 'untimed' | 'rapid' | 'blitz' | 'bullet' | 'custom';

const TIME_CONTROLS: Record<TimeControlId, { label: string; base: number; inc: number }> = {
  untimed: { label: 'Untimed', base: 0, inc: 0 },
  rapid: { label: 'Rapid 10+0', base: 600, inc: 0 },
  blitz: { label: 'Blitz 5+3', base: 300, inc: 3 },
  bullet: { label: 'Bullet 2+1', base: 120, inc: 1 },
  custom: { label: 'Custom', base: 900, inc: 10 },
};

interface Ply {
  move: Move;
  san: string;
  positionAfter: Position;
}

export function Chess({ opponentId, onExit }: { opponentId?: string; onExit: () => void }) {
  const peers = useStore((s) => s.peers);
  const profile = useStore((s) => s.profile);
  const opponent = opponentId ? peers[opponentId] : null;
  const lan = !!opponent;

  const [position, setPosition] = React.useState<Position>(initialPosition);
  const [history, setHistory] = React.useState<Ply[]>([]);
  const [keys, setKeys] = React.useState<string[]>([positionKey(initialPosition())]);
  const [viewIndex, setViewIndex] = React.useState<number | null>(null);
  const [selected, setSelected] = React.useState<number | null>(null);
  const [promotion, setPromotion] = React.useState<Move | null>(null);
  const [premove, setPremove] = React.useState<{ from: number; to: number } | null>(null);
  const [outcome, setOutcome] = React.useState<Outcome>({ kind: 'ongoing' });
  const [drawOffer, setDrawOffer] = React.useState<Color | null>(null);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [confirmResign, setConfirmResign] = React.useState(false);

  // The board derives its size from available height, so the player strips
  // above and below have to be measured against it to stay aligned.
  const boardRef = React.useRef<HTMLDivElement>(null);
  const [boardWidth, setBoardWidth] = React.useState<number | null>(null);
  React.useEffect(() => {
    const el = boardRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) =>
      setBoardWidth(entry.contentRect.width),
    );
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const [themeId, setThemeId] = useLocalStorage('lantern.chess.theme', 'oak');
  const [setId, setSetId] = useLocalStorage<PieceSetId>('lantern.chess.set', 'staunton');
  const [showCoords, setShowCoords] = useLocalStorage('lantern.chess.coords', true);
  const [tcId, setTcId] = useLocalStorage<TimeControlId>('lantern.chess.tc', 'untimed');
  const [customBase, setCustomBase] = useLocalStorage('lantern.chess.customBase', 900);
  const [customInc, setCustomInc] = useLocalStorage('lantern.chess.customInc', 10);

  // In a LAN game you always play your own colour; pass-and-play flips freely.
  const myColor: Color = 'w';
  const [flipped, setFlipped] = React.useState(false);

  const tc =
    tcId === 'custom'
      ? { label: 'Custom', base: customBase, inc: customInc }
      : TIME_CONTROLS[tcId];
  const timed = tc.base > 0;

  const [clocks, setClocks] = React.useState<Record<Color, number>>({
    w: tc.base * 1000,
    b: tc.base * 1000,
  });

  React.useEffect(() => {
    setClocks({ w: tc.base * 1000, b: tc.base * 1000 });
  }, [tc.base]);

  const gameOver = outcome.kind !== 'ongoing';

  // Clock ticks only once both sides have moved, matching normal chess practice.
  React.useEffect(() => {
    if (!timed || gameOver || history.length < 2) return;
    const id = setInterval(() => {
      setClocks((c) => {
        const next = { ...c, [position.turn]: Math.max(0, c[position.turn] - 100) };
        if (next[position.turn] === 0) {
          setOutcome({ kind: 'timeout', winner: opposite(position.turn) });
        }
        return next;
      });
    }, 100);
    return () => clearInterval(id);
  }, [timed, gameOver, position.turn, history.length]);

  const viewing = viewIndex !== null;
  const shownPosition = viewing
    ? viewIndex === -1
      ? initialPosition()
      : history[viewIndex].positionAfter
    : position;
  const lastMove = viewing
    ? viewIndex >= 0
      ? history[viewIndex].move
      : null
    : (history.at(-1)?.move ?? null);

  const moves = React.useMemo(
    () => (gameOver || viewing ? [] : legalMoves(position)),
    [position, gameOver, viewing],
  );
  const movesFrom = React.useMemo(
    () => (selected === null ? [] : moves.filter((m) => m.from === selected)),
    [moves, selected],
  );

  const checkedKing = inCheck(shownPosition, shownPosition.turn)
    ? findKing(shownPosition, shownPosition.turn)
    : -1;

  const commit = React.useCallback(
    (move: Move) => {
      const san = toSan(position, move);
      const after = applyMove(position, move);
      const nextKeys = [...keys, positionKey(after)];
      const nextHistory = [...history, { move, san, positionAfter: after }];

      setPosition(after);
      setHistory(nextHistory);
      setKeys(nextKeys);
      setSelected(null);
      setViewIndex(null);
      setDrawOffer(null);

      if (timed) {
        setClocks((c) => ({ ...c, [move.color]: c[move.color] + tc.inc * 1000 }));
      }

      if (move.castle) sfx.castle();
      else if (move.promotion) sfx.promote();
      else if (move.captured) sfx.capture();
      else sfx.move();

      const result = evaluateOutcome(after, nextKeys);
      if (result.kind !== 'ongoing') {
        setOutcome(result);
        if (result.kind === 'checkmate') {
          result.winner === myColor ? sfx.gameWin() : sfx.gameLose();
        }
      } else if (inCheck(after, after.turn)) {
        sfx.check();
      }
    },
    [position, history, keys, timed, tc.inc, myColor],
  );

  // A queued premove fires as soon as it becomes legal.
  React.useEffect(() => {
    if (!premove || gameOver || (lan && position.turn !== myColor)) return;
    const match = legalMoves(position).find(
      (m) => m.from === premove.from && m.to === premove.to,
    );
    setPremove(null);
    if (match) {
      if (match.promotion) setPromotion(match);
      else commit(match);
    }
  }, [premove, position, gameOver, lan, myColor, commit]);

  const onSquare = (square: number) => {
    if (gameOver) return;
    if (viewing) {
      setViewIndex(null);
      return;
    }

    const piece = position.board[square];
    const myTurn = !lan || position.turn === myColor;

    if (!myTurn) {
      // Queue a premove while the opponent thinks.
      if (selected !== null) {
        setPremove({ from: selected, to: square });
        setSelected(null);
      } else if (piece?.color === myColor) {
        setSelected(square);
      }
      return;
    }

    if (selected !== null) {
      const candidates = movesFrom.filter((m) => m.to === square);
      if (candidates.length) {
        if (candidates[0].promotion) setPromotion(candidates[0]);
        else commit(candidates[0]);
        return;
      }
    }

    if (piece && piece.color === position.turn) {
      setSelected(square === selected ? null : square);
    } else {
      setSelected(null);
    }
  };

  const reset = () => {
    const fresh = initialPosition();
    setPosition(fresh);
    setHistory([]);
    setKeys([positionKey(fresh)]);
    setViewIndex(null);
    setSelected(null);
    setOutcome({ kind: 'ongoing' });
    setPremove(null);
    setDrawOffer(null);
    setClocks({ w: tc.base * 1000, b: tc.base * 1000 });
  };

  const theme = BOARD_THEMES.find((t) => t.id === themeId) ?? BOARD_THEMES[0];
  const captured = capturedPieces(shownPosition);
  const balance = materialBalance(shownPosition);

  const order = React.useMemo(() => {
    const squares = Array.from({ length: 64 }, (_, i) => i);
    return flipped ? squares.reverse() : squares;
  }, [flipped]);

  return (
    <div className="h-full flex flex-col min-h-0">
      {/*
        The same header every other game has.

        Chess keeps its own layout — it has more to show than the others — but
        the way out of it should not be different. "Leave game" was buried at
        the bottom of the right-hand sidebar, which is a long way for a thumb
        and further for a D-pad, and it was called something else besides.
      */}
      <header className="h-11 shrink-0 border-b border-edge bg-surface flex items-center px-3 gap-2">
        <IconButton label="Back to games" size="sm" onClick={onExit}>
          <ArrowLeft size={15} />
        </IconButton>
        <span className="text-sm font-semibold shrink-0">Chess</span>
        {lan && opponent && (
          <Badge tone="cyan">vs {opponent.name}</Badge>
        )}
      </header>

    <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-3 p-3">
      {/* board column */}
      <div className="flex-1 min-w-0 flex flex-col items-center justify-center gap-2">
        <PlayerStrip
          name={flipped ? profile.name || 'You' : (opponent?.name ?? 'Black')}
          color={flipped ? profile.color : opponent?.color}
          emoji={flipped ? profile.emoji : opponent?.emoji}
          clock={timed ? clocks[flipped ? 'w' : 'b'] : null}
          active={position.turn === (flipped ? 'w' : 'b') && !gameOver}
          captured={captured[flipped ? 'b' : 'w']}
          capturedColor={flipped ? 'b' : 'w'}
          advantage={flipped ? balance : -balance}
          set={setId}
          width={boardWidth}
        />

        {/*
          The board is sized from the space actually left over after the player
          strips, not from a viewport unit — a vh-based width overflows on short
          windows and the flex parent then squashes it out of square. Height
          drives the box and `aspect-ratio` derives the width, with max-width
          pulling it back in when the column is the narrower constraint.
        */}
        <div className="flex-1 min-h-0 w-full flex items-center justify-center">
          <div
            ref={boardRef}
            className="relative rounded-card overflow-hidden shadow-2xl"
            style={{
              border: `3px solid ${theme.border}`,
              height: '100%',
              maxHeight: '560px',
              maxWidth: '100%',
              aspectRatio: '1',
            }}
          >
            <div
              className="grid h-full w-full"
              style={{
                gridTemplateColumns: 'repeat(8, 1fr)',
                gridTemplateRows: 'repeat(8, 1fr)',
              }}
            >
            {order.map((square) => {
              const piece = shownPosition.board[square];
              const light = isLightSquare(square);
              const isTarget = movesFrom.some((m) => m.to === square);
              const isCapture = movesFrom.some((m) => m.to === square && m.captured);
              const isSelected = selected === square;
              const isLast = lastMove && (lastMove.from === square || lastMove.to === square);
              const isCheck = checkedKing === square;
              const isPremove = premove && (premove.from === square || premove.to === square);
              const f = fileOf(square);
              const r = rankOf(square);
              const showFile = showCoords && (flipped ? r === 0 : r === 7);
              const showRank = showCoords && (flipped ? f === 7 : f === 0);

              return (
                <button
                  key={square}
                  onClick={() => onSquare(square)}
                  className="relative grid place-items-center"
                  style={{ background: light ? theme.light : theme.dark }}
                >
                  {isLast && (
                    <span className="absolute inset-0" style={{ background: theme.lastMove }} />
                  )}
                  {isCheck && (
                    <span
                      className="absolute inset-0"
                      style={{
                        background: `radial-gradient(circle, ${theme.check} 20%, transparent 72%)`,
                      }}
                    />
                  )}
                  {isSelected && (
                    <span className="absolute inset-0" style={{ background: theme.highlight }} />
                  )}
                  {isPremove && (
                    <span className="absolute inset-0 bg-[#9B8CFF]/35" />
                  )}

                  {piece && (
                    <motion.span
                      layoutId={`piece-${square}-${piece.color}${piece.type}`}
                      className="relative z-10 pointer-events-none w-[86%] h-[86%] grid place-items-center"
                    >
                      <ChessPiece type={piece.type} color={piece.color} set={setId} size="100%" />
                    </motion.span>
                  )}

                  {isTarget && !isCapture && (
                    <span
                      className="absolute h-[22%] w-[22%] rounded-full z-20 pointer-events-none"
                      style={{ background: theme.highlight }}
                    />
                  )}
                  {isTarget && isCapture && (
                    <span
                      className="absolute inset-[6%] rounded-full border-[3px] z-20 pointer-events-none"
                      style={{ borderColor: theme.highlight }}
                    />
                  )}

                  {showFile && (
                    <span
                      className="absolute bottom-0 right-[3px] text-[9px] font-semibold pointer-events-none"
                      style={{ color: light ? theme.coordLight : theme.coordDark }}
                    >
                      {'abcdefgh'[f]}
                    </span>
                  )}
                  {showRank && (
                    <span
                      className="absolute top-0 left-[3px] text-[9px] font-semibold pointer-events-none"
                      style={{ color: light ? theme.coordLight : theme.coordDark }}
                    >
                      {8 - r}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          <AnimatePresence>
            {viewing && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute top-2 left-1/2 -translate-x-1/2"
              >
                <Badge tone="gold">Reviewing move {viewIndex! + 1}</Badge>
              </motion.div>
            )}
            </AnimatePresence>
          </div>
        </div>

        <PlayerStrip
          name={flipped ? (opponent?.name ?? 'Black') : profile.name || 'You'}
          color={flipped ? opponent?.color : profile.color}
          emoji={flipped ? opponent?.emoji : profile.emoji}
          clock={timed ? clocks[flipped ? 'b' : 'w'] : null}
          active={position.turn === (flipped ? 'b' : 'w') && !gameOver}
          captured={captured[flipped ? 'w' : 'b']}
          capturedColor={flipped ? 'w' : 'b'}
          advantage={flipped ? -balance : balance}
          set={setId}
          width={boardWidth}
        />
      </div>

      {/* side panel */}
      <aside className="w-full lg:w-[290px] shrink-0 flex flex-col gap-3 min-h-0">
        <div className="panel p-3 shrink-0">
          <div className="flex items-center justify-between mb-2">
            <span className="label">{lan ? 'LAN match' : 'Pass and play'}</span>
            <div className="flex gap-1">
              <IconButton label="Flip board" size="sm" onClick={() => setFlipped(!flipped)}>
                <RotateCcw size={13} />
              </IconButton>
              <IconButton label="Game settings" size="sm" onClick={() => setSettingsOpen(true)}>
                <Settings2 size={13} />
              </IconButton>
            </div>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Badge tone={position.turn === 'w' ? 'gold' : 'neutral'}>
              {gameOver ? 'Game over' : `${position.turn === 'w' ? 'White' : 'Black'} to move`}
            </Badge>
            {timed && <Badge tone="cyan">{tc.label}</Badge>}
            {premove && <Badge tone="muted">Premove queued</Badge>}
          </div>
        </div>

        <MoveHistory
          history={history}
          viewIndex={viewIndex}
          onSelect={setViewIndex}
        />

        <div className="panel p-2.5 shrink-0 space-y-2">
          {drawOffer && drawOffer !== position.turn && (
            <div className="p-2 rounded-input bg-gold/10 border border-gold/40">
              <p className="text-2xs text-gold mb-1.5">
                {drawOffer === 'w' ? 'White' : 'Black'} offers a draw.
              </p>
              <div className="flex gap-1.5">
                <Button
                  size="xs"
                  variant="primary"
                  onClick={() => setOutcome({ kind: 'agreed-draw' })}
                >
                  Accept
                </Button>
                <Button size="xs" onClick={() => setDrawOffer(null)}>
                  Decline
                </Button>
              </div>
            </div>
          )}

          <div className="flex gap-1.5">
            <Button
              size="xs"
              full
              icon={<Handshake size={11} />}
              disabled={gameOver}
              onClick={() => setDrawOffer(position.turn)}
            >
              Offer draw
            </Button>
            <Button
              size="xs"
              full
              variant="danger"
              icon={<Flag size={11} />}
              disabled={gameOver}
              onClick={() => setConfirmResign(true)}
            >
              Resign
            </Button>
          </div>

          {(position.halfmove >= 100 || keys.filter((k) => k === positionKey(position)).length >= 3) &&
            !gameOver && (
              <Button
                size="xs"
                full
                variant="primary"
                onClick={() =>
                  setOutcome(
                    position.halfmove >= 100 ? { kind: 'fifty-move' } : { kind: 'threefold' },
                  )
                }
              >
                Claim draw
              </Button>
            )}

          <Button size="xs" full onClick={onExit}>
            Leave game
          </Button>
        </div>
      </aside>

      <PromotionModal
        move={promotion}
        set={setId}
        onPick={(type) => {
          if (promotion) commit({ ...promotion, promotion: type });
          setPromotion(null);
        }}
        onCancel={() => setPromotion(null)}
      />

      <Modal
        open={confirmResign}
        onClose={() => setConfirmResign(false)}
        title="Resign the game?"
        footer={
          <>
            <Button onClick={() => setConfirmResign(false)}>Keep playing</Button>
            <Button
              variant="danger"
              onClick={() => {
                setOutcome({ kind: 'resigned', winner: opposite(position.turn) });
                setConfirmResign(false);
                sfx.gameLose();
              }}
            >
              Resign
            </Button>
          </>
        }
      >
        <p className="text-xs text-dim">
          {position.turn === 'w' ? 'White' : 'Black'} resigns and the game ends immediately.
        </p>
      </Modal>

      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        themeId={themeId}
        setThemeId={setThemeId}
        setId={setId}
        setSetId={setSetId}
        showCoords={showCoords}
        setShowCoords={setShowCoords}
        tcId={tcId}
        setTcId={setTcId}
        customBase={customBase}
        setCustomBase={setCustomBase}
        customInc={customInc}
        setCustomInc={setCustomInc}
        started={history.length > 0}
      />

      <EndScreen
        outcome={outcome}
        history={history}
        onRematch={reset}
        onReview={() => setViewIndex(history.length - 1)}
        onExit={onExit}
      />
    </div>
    </div>
  );
}

/* -------------------------------------------------------- Player strip */

function PlayerStrip({
  name,
  color,
  emoji,
  clock,
  active,
  captured,
  capturedColor,
  advantage,
  set,
  width,
}: {
  name: string;
  color?: string;
  emoji?: string;
  clock: number | null;
  active: boolean;
  captured: PieceType[];
  capturedColor: Color;
  advantage: number;
  set: PieceSetId;
  /** Matches the board's measured width so the strips line up with it. */
  width: number | null;
}) {
  const low = clock !== null && clock < 30_000;
  return (
    <div
      className={cn(
        'w-full flex items-center gap-2.5 px-3 h-11 rounded-card border transition-colors',
        active ? 'border-gold/50 bg-gold/[0.07] shadow-glow' : 'border-edge bg-surface',
      )}
      style={width ? { width } : { maxWidth: '100%' }}
    >
      <Avatar name={name} color={color} emoji={emoji} size={26} />
      <span className="text-xs font-medium truncate">{name}</span>

      <div className="flex items-center -space-x-1.5 ml-1 min-w-0">
        {captured.map((t, i) => (
          <span key={i} className="opacity-70 shrink-0">
            <ChessPiece type={t} color={capturedColor} set={set} size={16} />
          </span>
        ))}
      </div>

      {advantage > 0 && (
        <span className="text-2xs font-mono text-cyan shrink-0">+{advantage}</span>
      )}

      {clock !== null && (
        <span
          className={cn(
            'ml-auto px-2 h-7 grid place-items-center rounded-input font-mono text-sm tabular-nums shrink-0 border',
            active
              ? low
                ? 'bg-danger/15 border-danger/50 text-danger'
                : 'bg-gold/15 border-gold/40 text-gold'
              : 'bg-raised border-edge text-dim',
          )}
        >
          {formatDuration(clock)}
        </span>
      )}
    </div>
  );
}

/* -------------------------------------------------------- Move history */

function MoveHistory({
  history,
  viewIndex,
  onSelect,
}: {
  history: Ply[];
  viewIndex: number | null;
  onSelect: (i: number | null) => void;
}) {
  const scroller = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (viewIndex === null) scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [history.length, viewIndex]);

  const pairs: [Ply | null, Ply | null][] = [];
  for (let i = 0; i < history.length; i += 2) {
    pairs.push([history[i] ?? null, history[i + 1] ?? null]);
  }

  return (
    <div className="panel flex-1 min-h-0 flex flex-col">
      <div className="h-8 px-3 flex items-center justify-between border-b border-edge shrink-0">
        <span className="label">Moves</span>
        <div className="flex gap-0.5">
          <IconButton
            label="First move"
            size="xs"
            disabled={!history.length}
            onClick={() => onSelect(-1)}
          >
            <ChevronsLeft size={12} />
          </IconButton>
          <IconButton
            label="Previous"
            size="xs"
            disabled={!history.length}
            onClick={() =>
              onSelect(Math.max(-1, (viewIndex ?? history.length - 1) - 1))
            }
          >
            <ChevronLeft size={12} />
          </IconButton>
          <IconButton
            label="Next"
            size="xs"
            disabled={viewIndex === null}
            onClick={() => {
              const next = (viewIndex ?? -1) + 1;
              onSelect(next >= history.length - 1 ? null : next);
            }}
          >
            <ChevronRight size={12} />
          </IconButton>
          <IconButton
            label="Latest"
            size="xs"
            disabled={viewIndex === null}
            onClick={() => onSelect(null)}
          >
            <ChevronsRight size={12} />
          </IconButton>
        </div>
      </div>

      <div ref={scroller} className="flex-1 scroll-y p-1.5 min-h-[120px]">
        {history.length === 0 ? (
          <p className="text-2xs text-muted text-center py-6">No moves yet.</p>
        ) : (
          <ol className="text-xs font-mono">
            {pairs.map(([white, black], i) => (
              <li key={i} className="flex items-center gap-1 h-6">
                <span className="w-6 text-muted text-2xs shrink-0">{i + 1}.</span>
                {[white, black].map((ply, j) => {
                  if (!ply) return <span key={j} className="flex-1" />;
                  const index = i * 2 + j;
                  const on = viewIndex === index;
                  return (
                    <button
                      key={j}
                      onClick={() => onSelect(index === history.length - 1 ? null : index)}
                      className={cn(
                        'flex-1 text-left px-1.5 h-5 rounded-[4px] transition-colors',
                        on ? 'bg-gold/20 text-gold' : 'hover:bg-raised text-dim',
                      )}
                    >
                      {ply.san}
                    </button>
                  );
                })}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------- Modals */

function PromotionModal({
  move,
  set,
  onPick,
  onCancel,
}: {
  move: Move | null;
  set: PieceSetId;
  onPick: (t: PieceType) => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={!!move} onClose={onCancel} title="Promote to" width="max-w-xs">
      <div className="grid grid-cols-4 gap-2">
        {(['q', 'r', 'b', 'n'] as PieceType[]).map((t) => (
          <button
            key={t}
            onClick={() => onPick(t)}
            className="aspect-square rounded-card border border-edge bg-raised hover:border-gold/60 hover:shadow-glow grid place-items-center transition-all"
          >
            <ChessPiece type={t} color={move?.color ?? 'w'} set={set} size={44} />
          </button>
        ))}
      </div>
      <p className="text-2xs text-muted text-center mt-3">
        Promoting on {move ? squareName(move.to) : ''}
      </p>
    </Modal>
  );
}

function SettingsModal(props: {
  open: boolean;
  onClose: () => void;
  themeId: string;
  setThemeId: (v: string) => void;
  setId: PieceSetId;
  setSetId: (v: PieceSetId) => void;
  showCoords: boolean;
  setShowCoords: (v: boolean) => void;
  tcId: TimeControlId;
  setTcId: (v: TimeControlId) => void;
  customBase: number;
  setCustomBase: (v: number) => void;
  customInc: number;
  setCustomInc: (v: number) => void;
  started: boolean;
}) {
  return (
    <Modal open={props.open} onClose={props.onClose} title="Board settings">
      <div className="space-y-4">
        <div className="space-y-2">
          <span className="label">Board theme</span>
          <div className="grid grid-cols-5 gap-2">
            {BOARD_THEMES.map((t) => (
              <button
                key={t.id}
                onClick={() => props.setThemeId(t.id)}
                title={t.name}
                className={cn(
                  'aspect-square rounded-input overflow-hidden border-2 transition-transform',
                  props.themeId === t.id
                    ? 'border-gold scale-105 shadow-glow'
                    : 'border-edge hover:border-edge-strong',
                )}
              >
                <span className="grid grid-cols-2 h-full w-full">
                  <span style={{ background: t.light }} />
                  <span style={{ background: t.dark }} />
                  <span style={{ background: t.dark }} />
                  <span style={{ background: t.light }} />
                </span>
              </button>
            ))}
          </div>
          <p className="text-2xs text-muted">
            {BOARD_THEMES.find((t) => t.id === props.themeId)?.name}
          </p>
        </div>

        <div className="space-y-2">
          <span className="label">Piece set</span>
          <div className="grid grid-cols-3 gap-2">
            {PIECE_SET_NAMES.map((s) => (
              <button
                key={s.id}
                onClick={() => props.setSetId(s.id)}
                className={cn(
                  'p-2 rounded-card border transition-all',
                  props.setId === s.id
                    ? 'border-gold/60 bg-gold/10 shadow-glow'
                    : 'border-edge bg-raised hover:border-edge-strong',
                )}
              >
                <div className="flex justify-center gap-0.5 mb-1">
                  <ChessPiece type="k" color="w" set={s.id} size={26} />
                  <ChessPiece type="n" color="b" set={s.id} size={26} />
                </div>
                <span className="text-[10px] text-dim block text-center leading-tight">
                  {s.name}
                </span>
              </button>
            ))}
          </div>
        </div>

        <Toggle
          checked={props.showCoords}
          onChange={props.setShowCoords}
          label="Show coordinates"
          hint="File letters and rank numbers on the board edge"
        />

        <div className="space-y-2">
          <span className="label">Time control</span>
          <Select
            value={props.tcId}
            onChange={props.setTcId}
            options={(Object.keys(TIME_CONTROLS) as TimeControlId[]).map((k) => ({
              value: k,
              label: TIME_CONTROLS[k].label,
            }))}
          />
          {props.tcId === 'custom' && (
            <div className="flex gap-2">
              <label className="flex-1 space-y-1">
                <span className="text-2xs text-muted">Base (minutes)</span>
                <input
                  type="number"
                  min={1}
                  value={Math.round(props.customBase / 60)}
                  onChange={(e) => props.setCustomBase(Math.max(1, +e.target.value) * 60)}
                  className="w-full h-8 bg-raised border border-edge rounded-input px-2 text-xs"
                />
              </label>
              <label className="flex-1 space-y-1">
                <span className="text-2xs text-muted">Increment (s)</span>
                <input
                  type="number"
                  min={0}
                  value={props.customInc}
                  onChange={(e) => props.setCustomInc(Math.max(0, +e.target.value))}
                  className="w-full h-8 bg-raised border border-edge rounded-input px-2 text-xs"
                />
              </label>
            </div>
          )}
          {props.started && (
            <p className="text-2xs text-gold">
              Changing the time control takes effect on the next game.
            </p>
          )}
        </div>
      </div>
    </Modal>
  );
}

function EndScreen({
  outcome,
  history,
  onRematch,
  onReview,
  onExit,
}: {
  outcome: Outcome;
  history: Ply[];
  onRematch: () => void;
  onReview: () => void;
  onExit: () => void;
}) {
  const [dismissed, setDismissed] = React.useState(false);
  React.useEffect(() => {
    if (outcome.kind === 'ongoing') setDismissed(false);
  }, [outcome.kind]);

  if (outcome.kind === 'ongoing' || dismissed) return null;

  const title = {
    checkmate: 'Checkmate',
    stalemate: 'Stalemate',
    'fifty-move': 'Draw — fifty-move rule',
    threefold: 'Draw — threefold repetition',
    insufficient: 'Draw — insufficient material',
    resigned: 'Resignation',
    'agreed-draw': 'Draw agreed',
    timeout: 'Flag fell',
  }[outcome.kind];

  const winner =
    'winner' in outcome ? (outcome.winner === 'w' ? 'White' : 'Black') : null;

  return (
    <Modal
      open
      onClose={() => setDismissed(true)}
      title={title}
      footer={
        <>
          <Button onClick={onExit}>Leave</Button>
          <Button
            onClick={() => {
              onReview();
              setDismissed(true);
            }}
          >
            Analyse
          </Button>
          <Button variant="primary" onClick={onRematch}>
            Rematch
          </Button>
        </>
      }
    >
      <div className="text-center py-3">
        <div className="text-lg font-semibold mb-1">
          {winner ? `${winner} wins` : 'Draw'}
        </div>
        <p className="text-xs text-dim">
          {history.length} half-move{history.length === 1 ? '' : 's'} played
        </p>
      </div>

      {history.length > 0 && (
        <div className="mt-2 p-2.5 rounded-card bg-raised border border-edge max-h-32 scroll-y">
          <p className="text-2xs font-mono text-dim leading-relaxed">
            {history.map((p, i) => (
              <React.Fragment key={i}>
                {i % 2 === 0 && <span className="text-muted">{i / 2 + 1}. </span>}
                {p.san}{' '}
              </React.Fragment>
            ))}
          </p>
        </div>
      )}
    </Modal>
  );
}
