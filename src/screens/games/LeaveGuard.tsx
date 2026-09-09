/**
 * Not leaving a live game by accident, and getting back into one.
 *
 * The exit sits in the top-left corner of every game, one press away from
 * whatever else you were doing, and until now it left instantly. In a game
 * against other people that is not a small mistake: the others are still
 * sitting there waiting for a turn that is never coming.
 *
 * So leaving a game that is actually running asks first, and the seat is held
 * for a minute afterwards. A minute is long enough to answer a door and short
 * enough that nobody is left staring at an empty chair.
 */
import React from 'react';
import { LogOut, Undo2 } from 'lucide-react';

import { Button, Modal } from '../../components/ui';
import { useStore } from '../../lib/store';

/**
 * Wraps an exit so it asks when a game is live.
 *
 * Returns the handler to give `GameShell`, plus the dialog to render. A game
 * with nobody else in it — practice on your own — leaves without ceremony,
 * because there is nobody to leave waiting.
 */
export function useLeaveGuard(onExit: () => void, opponents: number) {
  const session = useStore((s) => s.gameSession);
  const holdGame = useStore((s) => s.holdGame);
  const [asking, setAsking] = React.useState(false);

  const live = !!session && opponents > 1;

  const requestExit = React.useCallback(() => {
    if (!live) {
      onExit();
      return;
    }
    setAsking(true);
  }, [live, onExit]);

  const confirm = () => {
    setAsking(false);
    if (session) holdGame(session);
    onExit();
  };

  const dialog = (
    <Modal open={asking} onClose={() => setAsking(false)} title="Leave this game?" width="max-w-sm">
      <p className="text-xs text-dim leading-relaxed">
        The others are still playing. Your seat is kept for a minute — a banner will offer to
        put you back — and after that the game carries on without you.
      </p>
      <div className="flex gap-2 mt-4">
        <Button variant="primary" icon={<Undo2 size={13} />} onClick={() => setAsking(false)}>
          Keep playing
        </Button>
        <Button icon={<LogOut size={13} />} onClick={confirm}>
          Leave
        </Button>
      </div>
    </Modal>
  );

  return { requestExit, dialog };
}

/**
 * The way back in.
 *
 * Rendered at app level so it follows you: the point is that it is there
 * wherever you ended up after leaving.
 */
export function RejoinBanner() {
  const held = useStore((s) => s.heldGame);
  const rejoin = useStore((s) => s.rejoinGame);
  const drop = useStore((s) => s.dropHeldGame);

  const [left, setLeft] = React.useState(0);

  React.useEffect(() => {
    if (!held) return;
    const tick = () => {
      const remaining = Math.max(0, held.until - Date.now());
      setLeft(Math.ceil(remaining / 1000));
      // The offer expires on its own rather than lingering as a dead button.
      if (remaining <= 0) drop();
    };
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [held, drop]);

  if (!held) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 rounded-card border border-gold/40 bg-surface/95 backdrop-blur px-3 py-2 shadow-lg">
      <span className="text-xs">
        Your game is still going — <span className="text-gold font-mono">{left}s</span> to rejoin
      </span>
      <Button size="sm" variant="primary" onClick={rejoin}>
        Rejoin
      </Button>
      <Button size="sm" onClick={drop}>
        Forfeit
      </Button>
    </div>
  );
}
