/**
 * Asking before a game starts.
 *
 * Being dealt into a match produced a toast, which fades whether or not it was
 * read, and a session sitting in a screen you might not be looking at. The
 * invitation was real — the seat was genuinely held — and there was nowhere to
 * say yes. On a phone, where the toast is the only thing that appears at all,
 * that made every invitation look like it had not arrived.
 *
 * Mid-call this does not appear: being dealt in while already talking is the
 * whole point of playing together, and a dialogue in the middle of it asking
 * whether you would like to join the thing your friend just announced out loud
 * is a step nobody wants. Outside a call, being pulled into a game by somebody
 * you are not talking to is another matter entirely.
 */
import React from 'react';
import { Gamepad2, X } from 'lucide-react';

import { useStore } from '../lib/store';
import { Avatar } from './Avatar';
import { Button, Modal } from './ui';

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

export function IncomingGame() {
  const invite = useStore((s) => s.gameInvite);
  const accept = useStore((s) => s.acceptGameInvite);
  const decline = useStore((s) => s.declineGameInvite);
  const peers = useStore((s) => s.peers);

  if (!invite) return null;

  const peer = peers[invite.from];
  const who = peer?.name ?? 'Someone';
  const game = NAMES[invite.session.game] ?? invite.session.game;
  const others = invite.session.players.length - 2;

  return (
    <Modal open onClose={decline} title="Game invitation" width="max-w-sm">
      <div className="flex items-center gap-3">
        {peer ? (
          <Avatar name={who} color={peer.color} emoji={peer.emoji} size={40} />
        ) : (
          <span className="h-10 w-10 rounded-full bg-gold/15 border border-gold/40 grid place-items-center text-gold">
            <Gamepad2 size={18} />
          </span>
        )}
        <div className="min-w-0">
          <div className="text-sm">
            <span className="font-medium">{who}</span> wants to play{' '}
            <span className="font-medium">{game}</span>
          </div>
          <div className="text-2xs text-muted mt-0.5">
            {others > 0
              ? `You and ${others + 1} others are at the table.`
              : 'Just the two of you.'}
          </div>
        </div>
      </div>

      <div className="flex gap-2 mt-4">
        <Button variant="primary" className="flex-1" onClick={accept}>
          Play
        </Button>
        <Button icon={<X size={13} />} onClick={decline}>
          No thanks
        </Button>
      </div>
    </Modal>
  );
}
