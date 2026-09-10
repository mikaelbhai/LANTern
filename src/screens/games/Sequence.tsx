/**
 * Sequence, for two to four players.
 *
 * Uses the same deck and card faces the solitaires did — that artwork is the
 * one thing worth keeping from them.
 *
 * Hands are hidden, so this runs on `hosted.tsx`: whoever started the game
 * deals and tells each player only their own cards. The board rules live in
 * `lib/sequence.ts` and are tested there.
 */
import React from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, Play, RotateCcw, Trophy } from 'lucide-react';

import { Avatar } from '../../components/Avatar';
import { Badge, Button, IconButton, Segmented } from '../../components/ui';
import { dealFrom, isRed, rankLabel, SUIT_GLYPH } from '../../lib/cards';
import { PixelFace } from '../../lib/pixelcards';
import type { Card } from '../../lib/cards';
import {
  BOARD,
  SIZE,
  create as createBoard,
  isOneEyedJack,
  isTwoEyedJack,
  play as playCard,
  sequencesToWin,
  squaresFor,
} from '../../lib/sequence';
import type { State as BoardState } from '../../lib/sequence';
import { useStore } from '../../lib/store';
import { cn } from '../../lib/utils';
import { sfx } from '../../lib/audio';
import { GameShell } from './GameShell';
import { useLeaveGuard } from './LeaveGuard';
import { useHostedGame } from './hosted';
import { useResult } from './useResult';
import { usePlayerNames } from './turns';

const TEAM_COLOURS = ['#F5A623', '#39D9C8', '#9B8CFF', '#7BD88F'];

/** How many cards each player holds, by table size. */
const HAND_SIZE: Record<number, number> = { 2: 7, 3: 6, 4: 6 };

interface Game {
  /** True before anything is dealt, while the table is picking sides. */
  waiting: boolean;
  /** Held so the deal can wait until the wait room is done with. */
  seed: number;
  /** Two or three. */
  teams: number;
  /** Which team each seat is on, in seating order. */
  seatTeams: number[];
  board: BoardState;
  /** Whose cards are whose. Never sent whole to anybody. */
  hands: Record<string, Card[]>;
  deck: Card[];
  /** One entry per seat. Alone, that is you twice — see `seatsFor`. */
  seats: string[];
}

/**
 * The seats at the table.
 *
 * Alone it is pass-and-play with two hands, because Sequence needs an opponent
 * to have any shape at all. One seat would leave the second turn belonging to
 * a player who does not exist, and the game would stop after one card.
 */
const seatsFor = (players: string[]): string[] =>
  players.length > 1 ? players : [players[0], `${players[0]}~2`];

/** What one player is allowed to see. */
interface View {
  board: BoardState;
  hand: Card[];
  counts: Record<string, number>;
  deck: number;
  players: string[];
  waiting: boolean;
  teams: number;
  seatTeams: number[];
}

type Intent =
  | { square: number; card: Card }
  | { discard: Card }
  /* Wait-room moves, before anything is dealt. */
  | { teams: number }
  | { join: number }
  | { start: true };

/**
 * How many teams a table of this size falls into on its own.
 *
 * Two is the game most people mean. Three only makes sense once there are
 * enough people to fill it, and six is the one size where three teams of two
 * is the obvious arrangement.
 */
const defaultTeams = (players: number): number => (players === 3 || players === 6 ? 3 : 2);

/** Seats dealt round the table, so partners are never next to each other. */
const seatTeamsFor = (players: number, teams: number): number[] =>
  Array.from({ length: players }, (_, i) => i % teams);

function createGame(seed: number, players: string[]): Game {
  const seats = seatsFor(players);
  const teams = defaultTeams(seats.length);

  return {
    // Nothing is dealt until the table has agreed who is on whose side.
    // Dealing first and asking after would mean re-dealing, and a hand you
    // were shown and then had taken away is worse than a moment's wait.
    waiting: true,
    seed,
    teams,
    seatTeams: seatTeamsFor(seats.length, teams),
    board: createBoard(teams, seatTeamsFor(seats.length, teams)),
    hands: {},
    deck: [],
    seats,
  };
}

/** Deals, and starts the game proper. */
function deal(game: Game): Game {
  const deck = dealFrom(game.seed, 2);
  const size = HAND_SIZE[game.seats.length] ?? 6;
  const hands: Record<string, Card[]> = {};
  for (const seat of game.seats) hands[seat] = deck.splice(0, size);

  return {
    ...game,
    waiting: false,
    hands,
    deck,
    board: createBoard(game.teams, game.seatTeams),
  };
}

function applyIntent(game: Game, intent: Intent, by: string, players: string[]): Game | null {
  // The wait room. Anybody at the table can move themselves or change how many
  // teams there are — it is a game among people who can see each other, and a
  // lobby only one person may touch is a lobby everybody waits on.
  if ('teams' in intent) {
    if (!game.waiting) return null;
    const teams = Math.min(3, Math.max(2, Math.round(intent.teams)));
    if (teams > game.seats.length) return null;
    return {
      ...game,
      teams,
      seatTeams: seatTeamsFor(game.seats.length, teams),
      board: createBoard(teams, seatTeamsFor(game.seats.length, teams)),
    };
  }

  if ('join' in intent) {
    if (!game.waiting) return null;
    const seat = game.seats.indexOf(by);
    if (seat === -1) return null;
    const team = Math.min(game.teams - 1, Math.max(0, Math.round(intent.join)));
    const seatTeams = game.seatTeams.slice();
    seatTeams[seat] = team;
    return { ...game, seatTeams, board: createBoard(game.teams, seatTeams) };
  }

  if ('start' in intent) {
    if (!game.waiting) return null;
    // A team with nobody on it cannot take a turn, and the game would stall
    // the moment it came round to them.
    const filled = new Set(game.seatTeams);
    if (filled.size < game.teams) return null;
    return deal(game);
  }

  if (game.waiting) return null;

  // Playing alone, you act for whichever seat is to move; otherwise for your
  // own, and only your own.
  const solo = players.length <= 1;
  const seat = solo ? game.board.turn : game.seats.indexOf(by);
  if (seat === -1) return null;

  const holder = game.seats[seat];
  const hand = game.hands[holder] ?? [];

  // A card that has nowhere to go may be swapped rather than wasting a turn.
  if ('discard' in intent) {
    const held = hand.findIndex((c) => c.id === intent.discard.id);
    if (held === -1) return null;
    if (squaresFor(game.board, intent.discard).length > 0) return null;

    const hands = { ...game.hands, [holder]: hand.filter((_, i) => i !== held) };
    const deck = [...game.deck];
    const drawn = deck.shift();
    if (drawn) hands[holder] = [...hands[holder], drawn];
    return { ...game, hands, deck };
  }

  const held = hand.findIndex((c) => c.id === intent.card.id);
  if (held === -1) return null;

  const type = isOneEyedJack(intent.card) ? 'remove' : 'place';
  const board = playCard(game.board, { type, square: intent.square, card: intent.card }, seat);
  if (!board) return null;

  const hands = { ...game.hands, [holder]: hand.filter((_, i) => i !== held) };
  const deck = [...game.deck];
  const drawn = deck.shift();
  if (drawn) hands[holder] = [...hands[holder], drawn];

  return { ...game, board, hands, deck };
}

function redact(game: Game, forPlayer: string, players: string[]): View {
  const counts: Record<string, number> = {};
  for (const seat of game.seats) counts[seat] = (game.hands[seat] ?? []).length;

  // Alone, you hold whichever hand is to play — the device is passed round.
  const solo = players.length <= 1;
  const mine = solo ? game.seats[game.board.turn] : forPlayer;

  return {
    board: game.board,
    hand: game.hands[mine] ?? [],
    counts,
    deck: game.deck.length,
    players: game.seats,
    waiting: game.waiting,
    teams: game.teams,
    seatTeams: game.seatTeams,
  };
}

export function Sequence({ onExit }: { onExit: () => void }) {
  const session = useStore((s) => s.gameSession);
  const active = session && session.game === 'sequence' ? session : null;

  const game = useHostedGame<Game, View, Intent>({
    session: active,
    create: createGame,
    apply: applyIntent,
    redact,
  });

  const { view, players: joined, me, isHost, send, restart } = game;
  // The view carries the seats, which is two of you when playing alone.
  const players = view?.players ?? joined;
  const solo = joined.length <= 1;
  const names = usePlayerNames(players);
  const [picked, setPicked] = React.useState<Card | null>(null);

  // Leaving a live game asks first, and holds the seat for a minute.
  const leave = useLeaveGuard(onExit, players.length);

  const board = view?.board;
  const mySeat = players.indexOf(me);
  const myTeam = view?.seatTeams[mySeat] ?? mySeat;
  const myTurn = !!board && board.winner === null && (solo || board.turn === mySeat);

  const legal = React.useMemo(
    () => (board && picked && myTurn ? squaresFor(board, picked) : []),
    [board, picked, myTurn],
  );

  const announced = React.useRef(false);
  React.useEffect(() => {
    if (board?.winner === null || board?.winner === undefined) {
      announced.current = false;
      return;
    }
    if (announced.current) return;
    announced.current = true;
    board.winner === myTeam ? sfx.gameWin() : sfx.gameLose();
  }, [board?.winner, myTeam]);

  // Before anything is dealt, the table picks sides.
  /*
   * Recorded before any early return.
   *
   * Hooks have to run in the same order on every render, and this component
   * returns early twice — once for the wait room and once while the host has
   * not sent a board yet. A hook below either of those is called on some
   * renders and not others, which React counts and then throws over.
   */
  const wonBy = board?.winner ?? null;
  useResult({
    game: 'sequence',
    matchId: active?.id ?? null,
    over: wonBy !== null,
    players,
    // A team wins it, so everybody on that team won it.
    winners:
      wonBy === null ? [] : players.filter((_, seat) => (view?.seatTeams[seat] ?? seat) === wonBy),
    points: Object.fromEntries(
      players.map((id, seat) => [id, board?.sequences[view?.seatTeams[seat] ?? seat] ?? 0]),
    ),
  });

  if (view?.waiting) {
    return (
      <>
        <WaitRoom
          players={players}
          names={names}
          me={me}
          teams={view.teams}
          seatTeams={view.seatTeams}
          isHost={isHost}
          onTeams={(n) => send({ teams: n })}
          onJoin={(team) => send({ join: team })}
          onStart={() => send({ start: true })}
          onExit={leave.requestExit}
        />
        {leave.dialog}
      </>
    );
  }

  if (!view || !board) {
    return (
      <GameShell title="Sequence" themeKey="lantern.sequence.theme" onExit={leave.requestExit} moves={0} running>
        {() => (
          <div className="h-full grid place-items-center">
            <p className="text-xs text-muted">Waiting for the deal…</p>
            {leave.dialog}
          </div>
        )}
      </GameShell>
    );
  }

  const take = (square: number) => {
    if (!picked || !legal.includes(square)) return;
    sfx.cardPlace();
    send({ square, card: picked });
    setPicked(null);
  };


  const status =
    board.winner !== null
      ? `${
          players
            .filter((_, seat) => (view?.seatTeams[seat] ?? seat) === board.winner)
            .map((id) => names[id] ?? 'Someone')
            .join(' and ') || 'Someone'
        } wins`
      : myTurn
        ? picked
          ? isOneEyedJack(picked)
            ? 'Take an opposing chip'
            : 'Choose a square'
          : 'Your turn — pick a card'
        : `${names[players[board.turn]] ?? 'Waiting'}…`;

  return (
    <>
    <GameShell
      title="Sequence"
      themeKey="lantern.sequence.theme"
      onExit={leave.requestExit}
      onRestart={isHost ? restart : undefined}
      moves={board.chips.filter((c) => c !== -1).length}
      running={board.winner === null}
      status={
        <>
          <Badge tone={board.winner !== null ? 'gold' : myTurn ? 'cyan' : 'muted'}>{status}</Badge>
          <Badge tone="muted">
            {sequencesToWin(board.teams)} to win · {view.deck} left
          </Badge>
        </>
      }
    >
      {() => (
        <div className="h-full flex flex-col lg:flex-row gap-3 p-3">
          {/* players */}
          <div className="panel p-3 w-full lg:w-[190px] shrink-0 order-2 lg:order-1">
            <span className="label">Players</span>
            <div className="space-y-2 mt-2">
              {players.map((id, seat) => {
                const team = view.seatTeams[seat] ?? seat;
                return (
                  <div
                    key={id}
                    className={cn(
                      'flex items-center gap-2 rounded-input px-2 py-1.5 border',
                      board.turn === seat && board.winner === null
                        ? 'border-gold/40 bg-gold/10'
                        : 'border-transparent',
                    )}
                  >
                    <span
                      className="h-3.5 w-3.5 rounded-full shrink-0 border border-black/40"
                      style={{ background: TEAM_COLOURS[team % TEAM_COLOURS.length] }}
                    />
                    <span className="text-xs truncate flex-1">{names[id]}</span>
                    {/* Sequences belong to the team, so partners show the same
                        number — which is the point of being partners. */}
                    <span className="text-2xs text-muted">{board.sequences[team] ?? 0}</span>
                    {board.winner === team && <Trophy size={12} className="text-gold" />}
                  </div>
                );
              })}
            </div>

            {board.winner !== null && isHost && (
              <Button size="sm" full icon={<RotateCcw size={13} />} onClick={restart} className="mt-3">
                Play again
              </Button>
            )}

            <p className="text-2xs text-muted leading-relaxed mt-3">
              Five in a line is a sequence. Corners are free. A two-eyed Jack goes anywhere; a
              one-eyed Jack takes a chip off.
            </p>
          </div>

          {/* the board */}
          <div className="order-1 lg:order-2 flex-1 min-w-0 overflow-auto grid place-items-center">
            <div
              className="grid gap-[2px]"
              style={{ gridTemplateColumns: `repeat(${SIZE}, minmax(0, 1fr))` }}
            >
              {BOARD.map((square, i) => {
                const owner = board.chips[i];
                const playable = legal.includes(i);

                return (
                  <button
                    key={i}
                    onClick={() => take(i)}
                    disabled={!playable}
                    aria-label={square.free ? 'Free corner' : `${rankLabel(square.rank as never)}${square.suit}`}
                    className={cn(
                      'relative rounded-[3px] leading-none transition-shadow',
                      // Card-shaped, because the squares are cards: the real
                      // board has the deck printed on it twice over.
                      'w-[clamp(24px,3vw,40px)] h-[clamp(37px,4.7vw,62px)]',
                      square.free && 'bg-gold/15 border border-gold/40',
                      playable && 'ring-2 ring-gold cursor-pointer',
                      board.locked[i] && !square.free && 'ring-1 ring-gold/50',
                    )}
                  >
                    {!square.free && (
                      <PixelFace
                        fill
                        labelled={false}
                        card={{
                          id: `sq-${i}`,
                          rank: square.rank as never,
                          suit: square.suit,
                          faceUp: true,
                        }}
                        className="absolute inset-0 rounded-[3px] overflow-hidden"
                      />
                    )}
                    {square.free && (
                      <span className="absolute inset-0 grid place-items-center text-gold">★</span>
                    )}
                    {owner !== -1 && (
                      <motion.span
                        initial={{ scale: 0.3 }}
                        animate={{ scale: 1 }}
                        className="absolute inset-[3px] rounded-full border-2 border-black/40"
                        style={{ background: TEAM_COLOURS[owner % TEAM_COLOURS.length] }}
                      />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          {/* hand */}
          <div className="order-3 w-full lg:w-[150px] shrink-0">
            <span className="label">Your hand</span>
            <div className="flex lg:flex-col gap-1.5 mt-2 flex-wrap">
              {view.hand.map((card) => {
                const dead = squaresFor(board, card).length === 0 && !isOneEyedJack(card);
                return (
                  <button
                    key={card.id}
                    onClick={() => (myTurn ? setPicked(picked?.id === card.id ? null : card) : undefined)}
                    disabled={!myTurn}
                    aria-label={`${rankLabel(card.rank)}${SUIT_GLYPH[card.suit]}`}
                    className={cn(
                      'relative rounded-[3px] transition-transform',
                      myTurn && 'hover:-translate-y-1 cursor-pointer',
                      picked?.id === card.id && '-translate-y-1.5',
                      dead && 'opacity-45 saturate-50',
                    )}
                    style={{
                      boxShadow:
                        picked?.id === card.id
                          ? '0 0 0 2px rgba(245,166,35,0.95), 0 4px 10px rgba(0,0,0,0.45)'
                          : '0 1px 3px rgba(0,0,0,0.4)',
                    }}
                  >
                    <PixelFace card={card} width={44} labelled={false} />
                    {/* What a Jack does, on the card, because the two kinds
                        look identical and do opposite things. */}
                    {(isTwoEyedJack(card) || isOneEyedJack(card)) && (
                      <span
                        className={cn(
                          'absolute bottom-0 inset-x-0 text-[7px] text-center font-semibold py-[1px]',
                          isTwoEyedJack(card)
                            ? 'bg-[#282C4C]/85 text-[#8FD3E0]'
                            : 'bg-[#C7315A]/85 text-white',
                        )}
                      >
                        {isTwoEyedJack(card) ? 'WILD' : 'REMOVE'}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>

            {picked && squaresFor(board, picked).length === 0 && myTurn && (
              <Button
                size="sm"
                full
                className="mt-2"
                onClick={() => {
                  send({ discard: picked });
                  setPicked(null);
                }}
              >
                Swap this dead card
              </Button>
            )}
          </div>
        </div>
      )}
    </GameShell>
      {leave.dialog}
    </>
  );
}

/* ----------------------------------------------------------- wait room */

/**
 * Picking sides before the cards come out.
 *
 * Sequence is a team game and the teams are the interesting decision in it —
 * who you are with decides how the whole hand is played. Dealing first and
 * asking afterwards would mean re-dealing, and a hand you were shown and then
 * had taken away is worse than a moment spent choosing.
 *
 * Anybody can move themselves and anybody can change the number of teams. It
 * is a game among people who can see each other; a lobby only one person may
 * touch is a lobby everybody else waits on.
 */
function WaitRoom({
  players,
  names,
  me,
  teams,
  seatTeams,
  isHost,
  onTeams,
  onJoin,
  onStart,
  onExit,
}: {
  players: string[];
  names: Record<string, string>;
  me: string;
  teams: number;
  seatTeams: number[];
  isHost: boolean;
  onTeams: (n: number) => void;
  onJoin: (team: number) => void;
  onStart: () => void;
  onExit: () => void;
}) {
  const sides = Array.from({ length: teams }, (_, t) => t);
  const empty = sides.filter((t) => !seatTeams.includes(t));
  const canBeThree = players.length >= 3;

  return (
    <div className="h-full flex flex-col min-h-0">
      <header className="h-11 shrink-0 border-b border-edge bg-surface flex items-center px-3 gap-2">
        <IconButton label="Back to games" size="sm" onClick={onExit}>
          <ArrowLeft size={15} />
        </IconButton>
        <span className="text-sm font-semibold">Sequence</span>
        <Badge tone="cyan">Picking sides</Badge>
      </header>

      <div className="flex-1 min-h-0 scroll-y p-4">
        <div className="max-w-lg mx-auto">
          <div className="flex items-center gap-2 mb-3">
            <span className="label flex-1">How many teams</span>
            <Segmented
              value={String(teams)}
              onChange={(v) => onTeams(Number(v))}
              options={[
                { value: '2', label: 'Two' },
                ...(canBeThree ? [{ value: '3', label: 'Three' }] : []),
              ]}
            />
          </div>
          <p className="text-2xs text-muted leading-relaxed mb-4">
            Two teams need two sequences to win; three teams need only one.
            {!canBeThree && ' Three teams needs at least three players.'}
          </p>

          <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
            {sides.map((team) => {
              const colour = TEAM_COLOURS[team % TEAM_COLOURS.length];
              const members = players.filter((_, seat) => seatTeams[seat] === team);
              const mine = seatTeams[players.indexOf(me)] === team;

              return (
                <div
                  key={team}
                  className="panel p-3"
                  style={{ borderColor: `${colour}55`, background: `${colour}0F` }}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span
                      className="h-3.5 w-3.5 rounded-full border border-black/40"
                      style={{ background: colour }}
                    />
                    <span className="text-xs font-medium flex-1">Team {team + 1}</span>
                    <Badge tone="muted">{members.length}</Badge>
                  </div>

                  <div className="space-y-1 min-h-[52px]">
                    {members.map((id) => (
                      <div key={id} className="flex items-center gap-1.5">
                        <Avatar name={names[id] ?? 'Player'} size={18} />
                        <span className="text-2xs truncate">
                          {id === me ? 'You' : (names[id] ?? 'Player')}
                        </span>
                      </div>
                    ))}
                    {members.length === 0 && (
                      <span className="text-2xs text-muted">Nobody yet.</span>
                    )}
                  </div>

                  <Button
                    size="xs"
                    full
                    className="mt-2"
                    variant={mine ? 'outline' : 'primary'}
                    disabled={mine}
                    onClick={() => onJoin(team)}
                  >
                    {mine ? 'You are here' : 'Join'}
                  </Button>
                </div>
              );
            })}
          </div>

          <div className="mt-5 flex items-center gap-2">
            <Button
              variant="primary"
              disabled={empty.length > 0}
              onClick={onStart}
              icon={<Play size={13} />}
            >
              Deal
            </Button>
            <span className="text-2xs text-muted">
              {empty.length > 0
                ? `Team ${empty[0] + 1} has nobody on it.`
                : isHost
                  ? 'Everyone is on a side.'
                  : 'Anybody can start it.'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
