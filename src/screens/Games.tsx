import React from 'react';
import { motion } from 'framer-motion';
import { Crown, Eye, Gamepad2, Layers, Spade, Swords, Triangle } from 'lucide-react';
import { Avatar } from '../components/Avatar';
import { Badge, Button, Empty, Modal, SectionTitle } from '../components/ui';
import { Chess } from './games/Chess';
import { Klondike } from './games/Klondike';
import { FreeCell } from './games/FreeCell';
import { Spider } from './games/Spider';
import { Pyramid } from './games/Pyramid';
import { useStore } from '../lib/store';
import { cn } from '../lib/utils';
import type { GameKind, Peer } from '../lib/types';

const GAMES: {
  id: GameKind;
  name: string;
  blurb: string;
  icon: React.ElementType;
  multiplayer: boolean;
  accent: string;
}[] = [
  {
    id: 'chess',
    name: 'Chess',
    blurb: 'Full rules, five board themes, three piece sets. Pass-and-play or challenge a peer.',
    icon: Crown,
    multiplayer: true,
    accent: '#F5A623',
  },
  {
    id: 'klondike',
    name: 'Klondike',
    blurb: 'The classic. Draw one or three, unlimited undo, and a daily deal shared by every LANTern.',
    icon: Spade,
    multiplayer: false,
    accent: '#39D9C8',
  },
  {
    id: 'freecell',
    name: 'FreeCell',
    blurb: 'Numbered deals from 1 to a million. Supermoves enforced, hints when you are stuck.',
    icon: Layers,
    multiplayer: false,
    accent: '#9B8CFF',
  },
  {
    id: 'spider',
    name: 'Spider',
    blurb: 'One, two or four suits. Completed runs fly home on their own.',
    icon: Swords,
    multiplayer: false,
    accent: '#7BD88F',
  },
  {
    id: 'pyramid',
    name: 'Pyramid',
    blurb: 'Clear the pyramid by pairing to thirteen. Kings go on their own.',
    icon: Triangle,
    multiplayer: false,
    accent: '#E05C5C',
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
      case 'klondike':
        return <Klondike onExit={exit} />;
      case 'freecell':
        return <FreeCell onExit={exit} />;
      case 'spider':
        return <Spider onExit={exit} />;
      case 'pyramid':
        return <Pyramid onExit={exit} />;
    }
  }

  return <GamesHub />;
}

function GamesHub() {
  const setActiveGame = useStore((s) => s.setActiveGame);
  const [challenge, setChallenge] = React.useState<GameKind | null>(null);

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
                      {g.multiplayer && <Badge tone="cyan">LAN multiplayer</Badge>}
                    </div>
                  </div>

                  <p className="text-2xs text-muted leading-relaxed flex-1 mb-3">{g.blurb}</p>

                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      full
                      onClick={() => setActiveGame({ kind: g.id })}
                    >
                      Play
                    </Button>
                    {g.multiplayer && (
                      <Button size="sm" full onClick={() => setChallenge(g.id)}>
                        Challenge
                      </Button>
                    )}
                  </div>
                </motion.div>
              );
            })}
          </div>
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
