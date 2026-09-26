/**
 * The room before the game.
 *
 * Calling a game used to be the same as starting one. The invitations went
 * out, every seat was filled the moment it was offered, and the board opened
 * immediately on whichever devices happened to be looking — so a turn-based
 * game could sit waiting on somebody who had never answered and might be in
 * another room. There was no moment at which the person who called it could
 * see who had actually turned up.
 *
 * So there is a lobby, and it answers one question: who is here. The host
 * starts it when the answer is good enough, and whoever never answered is
 * dropped at that moment rather than left holding a seat.
 */
import React from 'react';
import { Check, Clock, Gamepad2, Play } from 'lucide-react';

import { api } from '../../lib/bridge';
import { useSeatId, useStore } from '../../lib/store';
import { Avatar } from '../../components/Avatar';
import { Badge, Button, Spinner } from '../../components/ui';

/** What each game is called, for the one sentence this has to get right. */
const NAMES: Record<string, string> = {
  chess: 'Chess',
  connect4: 'Connect Four',
  sequence: 'Sequence',
  crossy: 'Crossy Road',
  monopoly: 'Monopoly Deal',
  uno: 'Uno',
  dots: 'Dots & Boxes',
};

export function GameLobby() {
  const session = useStore((s) => s.gameSession);
  const peers = useStore((s) => s.peers);
  const me = useSeatId();
  const toast = useStore((s) => s.toast);
  const [starting, setStarting] = React.useState(false);

  // Only before it begins. Once it has, the board is what there is to show.
  if (!session || session.started) return null;

  const hosting = session.hostId === me || session.hostId === 'me';
  const joined = session.joined ?? [];
  const here = session.players.filter((p) => joined.includes(p));
  const waiting = session.players.filter((p) => !joined.includes(p));
  const name = (id: string) =>
    id === me ? 'You' : (peers[id]?.name ?? 'Someone');

  const begin = async () => {
    setStarting(true);
    try {
      await api.game.begin(session.id);
    } catch {
      toast({ kind: 'error', title: 'Could not start it' });
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="panel p-3.5 mb-4 border-gold/30 bg-gold/[0.04]">
      <div className="flex items-center gap-2 flex-wrap">
        <Gamepad2 size={14} className="text-gold shrink-0" />
        <span className="text-sm font-medium">
          {NAMES[session.game] ?? session.game}
        </span>
        <Badge tone="muted">
          {here.length} of {session.players.length} here
        </Badge>
        {!hosting && <Badge tone="gold">Waiting for the host</Badge>}
      </div>

      <p className="text-2xs text-muted leading-relaxed mt-1.5">
        {hosting
          ? 'Start when everyone is in. Anybody who has not answered by then is left out rather than holding a seat the game waits on.'
          : 'You are in. It begins when the person who called it starts it.'}
      </p>

      <div className="mt-2.5 space-y-1.5">
        {session.players.map((id) => {
          const isHere = joined.includes(id);
          return (
            <div
              key={id}
              className="flex items-center gap-2 text-2xs rounded-input border border-edge bg-raised px-2 py-1.5"
            >
              <Avatar
                name={name(id)}
                color={peers[id]?.color}
                emoji={peers[id]?.emoji}
                src={peers[id]?.avatar}
                size={18}
              />
              <span className="flex-1 truncate">{name(id)}</span>
              {id === session.hostId && <Badge tone="neutral">Called it</Badge>}
              {isHere ? (
                <span className="flex items-center gap-1 text-emerald-400">
                  <Check size={11} /> Here
                </span>
              ) : (
                <span className="flex items-center gap-1 text-muted">
                  <Clock size={11} /> Asked
                </span>
              )}
            </div>
          );
        })}
      </div>

      {hosting && (
        <div className="flex items-center gap-2 mt-3">
          <Button
            variant="primary"
            icon={starting ? <Spinner size={12} /> : <Play size={12} />}
            disabled={starting || here.length < 2}
            onClick={() => void begin()}
          >
            Start
          </Button>
          {here.length < 2 && (
            <span className="text-2xs text-muted">
              {waiting.length > 0
                ? 'Nobody else has answered yet.'
                : 'A game needs somebody to play against.'}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
