import React from 'react';
import { motion } from 'framer-motion';
import {
  Banknote,
  Layers,
  Circle,
  Crown,
  Eye,
  Footprints,
  Gamepad2,
  Grid3x3,
  Spade,
  Users,
} from 'lucide-react';
import { Avatar } from '../components/Avatar';
import { Badge, Button, Empty, Modal, SectionTitle, Select } from '../components/ui';
import { Chess } from './games/Chess';
import { ConnectFour } from './games/ConnectFour';
import { Dots } from './games/Dots';
import { Sequence } from './games/Sequence';
import { Crossy } from './games/Crossy';
import { Deal } from './games/Deal';
import { Uno } from './games/Uno';
import { api } from '../lib/bridge';
import { useStore } from '../lib/store';
import { cn } from '../lib/utils';
import { GAME_NAMES } from '../lib/games';
import { standings } from '../lib/scores';
import type { GameKind, Peer } from '../lib/types';

/**
 * What is on offer.
 *
 * Every one of these is played against other people. The four solitaires that
 * used to be here have gone: a LAN application is a strange place to put a
 * game you play by yourself while everyone else watches, and turning them into
 * races only papered over that — you were still playing alone, just with a
 * scoreboard.
 *
 * What replaced them needs no hidden information, so every device can hold the
 * whole position and no referee is needed. See `screens/games/turns.tsx`.
 */
const GAMES: {
  id: GameKind;
  name: string;
  blurb: string;
  icon: React.ElementType;
  /** Two only, or anyone in the room — which decides how it is started. */
  seats: '2' | 'party';
  /** How many can play, written out. Not every party game seats the same. */
  seatsLabel: string;
  /**
   * Whether it is worth playing on your own.
   *
   * Only Crossy Road is: it is a race against a road, and racing it alone is
   * the same game with fewer people in it. Everything else needs an opponent.
   * A board you play both sides of is not chess, and a card game against
   * nobody is one you have already won.
   */
  solo?: boolean;
  /**
   * A hard limit, where one exists.
   *
   * Most of these stretch to however many turn up. Monopoly Deal does not:
   * six hands deal thirty of its hundred and six cards before the first turn,
   * and the deck can run dry with everything locked up in property.
   */
  maxPlayers?: number;
  accent: string;
}[] = [
  {
    id: 'chess',
    name: GAME_NAMES.chess,
    blurb: 'Full rules, five board themes, three piece sets. Challenge anyone on the network.',
    icon: Crown,
    seats: '2',
    seatsLabel: 'Two players',
    accent: '#F5A623',
  },
  {
    id: 'connect4',
    name: GAME_NAMES.connect4,
    blurb: 'Drop a disc, get four in a row. Two to four players, and the turn goes round.',
    icon: Circle,
    seats: 'party',
    seatsLabel: 'Two to four',
    accent: '#39D9C8',
  },
  {
    id: 'sequence',
    name: GAME_NAMES.sequence,
    blurb:
      'Play a card, place a chip, get five in a line. Jacks are wild or take a chip off. Two to four.',
    icon: Spade,
    seats: 'party',
    seatsLabel: 'Two to four',
    accent: '#7BD88F',
  },
  {
    id: 'crossy',
    name: GAME_NAMES.crossy,
    blurb:
      'Hop across the traffic and ride the logs. Everyone races the same road at the same time.',
    icon: Footprints,
    seats: 'party',
    seatsLabel: 'Two to four',
    solo: true,
    accent: '#F7E14A',
  },
  {
    id: 'deal',
    name: GAME_NAMES.deal,
    blurb:
      'Collect three sets before anyone else. Rent, Sly Deals, and a Just Say No when it counts.',
    icon: Banknote,
    seats: 'party',
    seatsLabel: 'Two to five',
    maxPlayers: 5,
    accent: '#E86FB0',
  },
  {
    id: 'uno',
    name: GAME_NAMES.uno,
    blurb:
      'Match the colour or the number, and say it when you are down to one — somebody is watching.',
    icon: Layers,
    seats: 'party',
    seatsLabel: 'Two to eight',
    maxPlayers: 8,
    accent: '#B08628',
  },
  {
    id: 'dots',
    name: GAME_NAMES.dots,
    blurb: 'Draw a line, close a box, go again. Better with four people than with two.',
    icon: Grid3x3,
    seats: 'party',
    seatsLabel: 'Two to four',
    accent: '#9B8CFF',
  },
];

export function Games() {
  const activeGame = useStore((s) => s.activeGame);
  const setActiveGame = useStore((s) => s.setActiveGame);

  if (activeGame) {
    const exit = () => setActiveGame(null);
    switch (activeGame.kind) {
      case 'chess':
        return <Chess opponentId={activeGame.opponentId} onExit={exit} />;
      case 'connect4':
        return <ConnectFour onExit={exit} />;
      case 'sequence':
        return <Sequence onExit={exit} />;
      case 'crossy':
        return <Crossy onExit={exit} />;
      case 'dots':
        return <Dots onExit={exit} />;
      case 'deal':
        return <Deal onExit={exit} />;
      case 'uno':
        return <Uno onExit={exit} />;
      default:
        // A session for a game this build no longer has — someone on an older
        // version started a solitaire. Better to land in the hub than to
        // render nothing at all.
        return <GamesHub />;
    }
  }

  return <GamesHub />;
}

function GamesHub() {
  const setActiveGame = useStore((s) => s.setActiveGame);
  const [challenge, setChallenge] = React.useState<GameKind | null>(null);

  const peers = useStore((s) => s.peers);
  const call = useStore((s) => s.call);
  const setGameSession = useStore((s) => s.setGameSession);
  const toast = useStore((s) => s.toast);

  // In a call, the people in it. Otherwise everyone online.
  //
  // The call is the better answer whenever there is one: those are the people
  // you are already playing with, and pulling in a peer who is not part of the
  // conversation would be an interruption rather than an invitation.
  const inCall = !!call && call.state === 'active';
  const playable = React.useMemo(() => {
    const online = Object.values(peers).filter((p) => p.status !== 'offline');
    if (!inCall) return online;
    const members = new Set((call?.participants ?? []).map((p) => p.peerId));
    return online.filter((p) => members.has(p.id));
  }, [peers, inCall, call]);

  /**
   * Deals one hand to everybody and starts it.
   *
   * The seed is minted here and travels with the session, so every player
   * deals the identical board. Nothing else about the game crosses the wire —
   * only how far along each person is.
   */
  const playTogether = async (kind: GameKind) => {
    const seed = Math.floor(Math.random() * 1_000_000);
    // A game with a seat limit takes the first few rather than everybody, and
    // says so — quietly dropping somebody who is sitting in the call waiting
    // to be dealt in would be the worse half of the two.
    const limit = GAMES.find((g) => g.id === kind)?.maxPlayers;
    const invited = limit ? playable.slice(0, limit - 1) : playable;
    if (invited.length < playable.length) {
      toast({
        kind: 'info',
        title: `${GAME_NAMES[kind]} seats ${limit}`,
        body: `${playable.length - invited.length} more will have to sit this one out.`,
      });
    }

    try {
      const session = await api.game.start(
        kind,
        invited.map((p) => p.id),
        seed,
      );
      setGameSession(session);
    } catch {
      // Playing alone is still better than not playing.
      toast({ kind: 'error', title: 'Could not reach the others', body: 'Starting on your own.' });
    }
    setActiveGame({ kind });
  };

  return (
    <div className="h-full flex flex-col">
      <header className="h-11 shrink-0 border-b border-edge bg-surface flex items-center px-4 gap-2">
        <Gamepad2 size={15} className="text-gold" />
        <span className="text-sm font-semibold">Games</span>
        <span className="text-2xs text-muted hidden sm:block">
          All offline · nothing downloaded, nothing phoned home
        </span>
      </header>

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 scroll-y p-4">
          <NextMatch />
          <SectionTitle>Choose a game</SectionTitle>
          <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(260px,1fr))]">
            {GAMES.map((g, i) => {
              const Icon = g.icon;
              return (
                <motion.div
                  key={g.id}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: i * 0.04 }}
                  className="panel p-4 flex flex-col hover:border-edge-strong transition-colors"
                >
                  <div className="flex items-center gap-2.5 mb-2">
                    <span
                      className="h-9 w-9 rounded-card grid place-items-center border shrink-0"
                      style={{
                        background: `${g.accent}1A`,
                        borderColor: `${g.accent}55`,
                        color: g.accent,
                      }}
                    >
                      <Icon size={17} />
                    </span>
                    <div>
                      <div className="text-sm font-medium">{g.name}</div>
                      <Badge tone={g.seats === 'party' ? 'cyan' : 'muted'}>
                        {g.seatsLabel}
                      </Badge>
                    </div>
                  </div>

                  <p className="text-2xs text-muted leading-relaxed flex-1 mb-3">{g.blurb}</p>

                  <div className="flex gap-2">
                    {/* Only where playing alone is actually a game. */}
                    {g.solo && (
                      <Button size="sm" full onClick={() => setActiveGame({ kind: g.id })}>
                        On your own
                      </Button>
                    )}
                    {/*
                      Chess is a game against one person; the rest are races
                      against everyone. So chess asks who, and the others just
                      start — asking a room of four which three to include is
                      a dialog that earns nothing.
                    */}
                    {g.id === 'chess' ? (
                      <Button
                        size="sm"
                        variant="primary"
                        full
                        disabled={playable.length === 0}
                        onClick={() => setChallenge(g.id)}
                      >
                        Challenge
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="primary"
                        full
                        icon={<Users size={13} />}
                        onClick={() => void playTogether(g.id)}
                        disabled={playable.length === 0}
                      >
                        {inCall ? 'Play with the call' : 'Play together'}
                      </Button>
                    )}
                  </div>

                  {playable.length === 0 && (
                    <p className="text-2xs text-muted mt-1.5">
                      {g.solo
                        ? 'Nobody else is around — you can still race the road.'
                        : 'Nobody else is on the network yet.'}
                    </p>
                  )}
                </motion.div>
              );
            })}
          </div>

          <Records />
        </div>

        <Lobby onChallenge={(peerId) => setActiveGame({ kind: 'chess', opponentId: peerId })} />
      </div>

      <ChallengeModal
        game={challenge}
        onClose={() => setChallenge(null)}
        onPick={(peerId) => {
          setActiveGame({ kind: challenge!, opponentId: peerId });
          setChallenge(null);
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------- Records */

/**
 * Who has been winning.
 *
 * The interesting number is never who won the last one — everybody watched
 * that — but who has been winning all evening. Kept on this device, from the
 * games this device saw, which is said out loud rather than presented as a
 * league table it cannot actually be.
 */
function Records() {
  const scores = useStore((s) => s.scores);
  const me = useStore((s) => s.profile.id);
  const table = standings(scores);

  if (!table.length) return null;

  return (
    <div className="mt-5">
      <SectionTitle>Records</SectionTitle>
      <div className="panel p-3">
        <ul className="space-y-1">
          {table.slice(0, 8).map((row, i) => (
            <li
              key={row.id}
              className={cn(
                'flex items-center gap-2 px-2 h-9 rounded-input',
                row.id === me && 'bg-gold/10 border border-gold/25',
              )}
            >
              <span className="text-2xs font-mono text-muted w-4 shrink-0">{i + 1}</span>
              <Avatar name={row.name} size={20} />
              <span className="text-xs truncate flex-1">{row.id === me ? 'You' : row.name}</span>
              <span className="text-2xs text-muted">{row.played} played</span>
              <Badge tone={row.won > 0 ? 'gold' : 'muted'}>
                {row.won} {row.won === 1 ? 'win' : 'wins'}
              </Badge>
            </li>
          ))}
        </ul>

        <MyGames />

        <p className="text-2xs text-muted leading-relaxed mt-2.5">
          Counted on this device, from the games it was here for.
        </p>
      </div>
    </div>
  );
}

/** My own record broken down by game, where points mean something. */
function MyGames() {
  const byGame = useStore((s) => s.scores.byGame);
  const rows = Object.entries(byGame).filter(([, t]) => t.played > 0);
  if (!rows.length) return null;

  return (
    <div className="mt-3 pt-3 border-t border-edge">
      <span className="label">Yours, by game</span>
      <div className="grid gap-1 mt-1.5 [grid-template-columns:repeat(auto-fill,minmax(150px,1fr))]">
        {rows.map(([kind, t]) => (
          <div key={kind} className="flex items-center gap-1.5 text-2xs">
            <span className="truncate flex-1 text-dim">{GAME_NAMES[kind as GameKind] ?? kind}</span>
            <span className="font-mono text-muted">
              {t.won}/{t.played}
            </span>
            {t.points > 0 && <Badge tone="muted">{t.points}</Badge>}
          </div>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------- Next match */

/**
 * What to do when a game is already going.
 *
 * A match that has started cannot take anybody new - hands are dealt, turns
 * are in order, a board is half full - and dropping somebody into one is worse
 * than telling them to wait. So the answer to arriving late is a place in the
 * next match rather than a door that does nothing.
 *
 * It doubles as the only place the next game can be changed. Nobody wants to
 * play the same thing four times because the person hosting has the only vote.
 */
function NextMatch() {
  const nearby = useStore((s) => s.nearbyGame);
  const session = useStore((s) => s.gameSession);
  const peers = useStore((s) => s.peers);
  const me = useStore((s) => s.profile.id);
  const join = useStore((s) => s.joinNextMatch);
  const leave = useStore((s) => s.leaveNextMatch);
  const propose = useStore((s) => s.proposeNextGame);
  const startNext = useStore((s) => s.startNextMatch);

  const hosting = !!session && (session.hostId === 'me' || session.hostId === me);
  const live = nearby ?? (hosting ? session : null);
  if (!live) return null;

  const waiting = live.waiting ?? [];
  const queued = waiting.includes(me);
  const nextGame = live.nextGame ?? live.game;
  const named = (id: string) => peers[id]?.name ?? 'Someone';

  return (
    <div className="panel p-3.5 mb-4 border-gold/30 bg-gold/[0.04]">
      <div className="flex items-center gap-2 flex-wrap">
        <Users size={14} className="text-gold shrink-0" />
        <span className="text-sm font-medium">
          {GAME_NAMES[live.game]} is running
        </span>
        <Badge tone="muted">{live.players.length} playing</Badge>
        {waiting.length > 0 && (
          <Badge tone="gold">
            {waiting.length} waiting
          </Badge>
        )}
      </div>

      <p className="text-2xs text-muted leading-relaxed mt-1.5">
        {nearby
          ? 'You cannot join one that has already started — the cards are dealt and the turns are in order. Take a place in the next one instead.'
          : 'People who arrive while this is running queue here. They are dealt in when you start the next match.'}
      </p>

      {waiting.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2.5">
          {waiting.map((id) => (
            <span
              key={id}
              className="flex items-center gap-1.5 text-2xs rounded-input border border-edge bg-raised px-1.5 py-1"
            >
              <Avatar name={named(id)} color={peers[id]?.color} emoji={peers[id]?.emoji} size={16} />
              {id === me ? 'You' : named(id)}
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-3">
        {nearby &&
          (queued ? (
            <Button size="sm" onClick={leave}>
              Leave the queue
            </Button>
          ) : (
            <Button size="sm" variant="primary" icon={<Users size={13} />} onClick={join}>
              Play the next match
            </Button>
          ))}

        {hosting && (
          <Button size="sm" variant="primary" onClick={() => void startNext()}>
            Start next match
          </Button>
        )}

        <div className="flex items-center gap-1.5 ml-auto">
          <span className="text-2xs text-muted">Next up</span>
          <Select
            value={nextGame}
            onChange={(v) => propose(v as GameKind)}
            options={GAMES.map((g) => ({ value: g.id, label: g.name }))}
          />
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- Lobby */

function Lobby({ onChallenge }: { onChallenge: (peerId: string) => void }) {
  const peers = useStore((s) => s.peers);
  const list = Object.values(peers);

  // A peer's game status reflects what LANTern reports about them.
  const statusOf = (p: Peer) =>
    p.status === 'in-game'
      ? { label: 'In game', tone: 'gold' as const }
      : p.status === 'busy' || p.status === 'dnd'
        ? { label: 'Busy', tone: 'muted' as const }
        : { label: 'Available', tone: 'cyan' as const };

  const inGame = list.filter((p) => p.status === 'in-game');

  return (
    <aside className="w-[268px] shrink-0 border-l border-edge bg-surface/50 hidden lg:flex flex-col">
      <div className="h-11 px-4 flex items-center border-b border-edge shrink-0">
        <span className="label">Lobby</span>
        <Badge tone="muted" className="ml-auto">
          {list.length}
        </Badge>
      </div>

      <div className="flex-1 scroll-y p-2 space-y-4">
        <div>
          <div className="label mb-1.5 px-1">Peers</div>
          {list.length === 0 ? (
            <Empty title="Nobody around" hint="Peers on the network appear here." />
          ) : (
            <ul className="space-y-1">
              {list.map((p) => {
                const st = statusOf(p);
                const free = st.label === 'Available';
                return (
                  <li
                    key={p.id}
                    className="flex items-center gap-2 px-2 h-11 rounded-input hover:bg-raised/60 group"
                  >
                    <Avatar
                      name={p.name}
                      color={p.color}
                      emoji={p.emoji}
                      size={26}
                      status={p.status}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-xs truncate">{p.name}</div>
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </div>
                    <Button
                      size="xs"
                      variant={free ? 'primary' : 'outline'}
                      disabled={!free}
                      className="opacity-0 group-hover:opacity-100 transition-opacity"
                      onClick={() => onChallenge(p.id)}
                    >
                      Challenge
                    </Button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div>
          <div className="label mb-1.5 px-1">Spectate</div>
          {inGame.length === 0 ? (
            <p className="text-2xs text-muted px-1">No games in progress.</p>
          ) : (
            <ul className="space-y-1">
              {inGame.map((p) => (
                <li
                  key={p.id}
                  className="flex items-center gap-2 px-2 h-9 rounded-input bg-raised/50"
                >
                  <Eye size={12} className="text-muted shrink-0" />
                  <span className="text-2xs truncate flex-1">{p.name}'s game</span>
                  <Button size="xs" variant="ghost">
                    Watch
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[10px] text-muted mt-2 px-1 leading-relaxed">
            Spectators see the board only — chat stays private to the players.
          </p>
        </div>
      </div>
    </aside>
  );
}

function ChallengeModal({
  game,
  onClose,
  onPick,
}: {
  game: GameKind | null;
  onClose: () => void;
  onPick: (peerId: string) => void;
}) {
  const peers = useStore((s) => s.peers);
  const list = Object.values(peers);

  return (
    <Modal open={!!game} onClose={onClose} title={`Challenge to ${game ?? ''}`}>
      {list.length === 0 ? (
        <Empty title="No peers online" hint="Someone else needs to be on the network to play." />
      ) : (
        <div className="space-y-1.5">
          <p className="text-xs text-dim mb-2">
            They get an invite they can accept, decline or counter.
          </p>
          {list.map((p) => (
            <button
              key={p.id}
              onClick={() => onPick(p.id)}
              className={cn(
                'w-full flex items-center gap-2.5 px-2.5 h-12 rounded-card border transition-colors',
                'border-edge bg-raised hover:border-gold/50 hover:bg-gold/5',
              )}
            >
              <Avatar name={p.name} color={p.color} emoji={p.emoji} size={30} status={p.status} />
              <div className="min-w-0 flex-1 text-left">
                <div className="text-xs font-medium truncate">{p.name}</div>
                <div className="text-2xs text-muted">
                  {p.latencyMs.toFixed(1)} ms · {p.layer}
                </div>
              </div>
              <Badge tone="cyan">Invite</Badge>
            </button>
          ))}
        </div>
      )}
    </Modal>
  );
}
