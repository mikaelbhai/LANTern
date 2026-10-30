import React from 'react';

import { pushLayer } from '../lib/backstack';
import { intentOf } from './remote';
import { u } from './units';

/**
 * The bottom of the back stack: what Back does when there is nothing left to
 * go back from.
 *
 * Without it that was the system's answer - leave the app, from the shelf, on
 * the first press, with no warning - which on a television is how somebody
 * watching with a remote in one hand ends up on the home screen when they only
 * meant to leave the film.
 *
 * Armed once, and let go of a moment after unmounting rather than at once, and
 * put back each time it is used: the player does the same, for the same
 * reason (React mounts, unmounts and mounts again in development, and
 * releasing the entry in between rewinds history past the page).
 */
export function useRootBack(onBack: () => void): void {
  useArmedBack(onBack, true);
}

/**
 * One back layer, armed once and released a moment after it is gone.
 *
 * `rearm` stands up another the moment one is used, for a layer that is meant
 * to be there for every press (the bottom of the stack); without it the layer
 * is used up by the first press (the prompt itself).
 *
 * Not `useBackDismiss`, which releases its history entry the instant its effect
 * is cleaned up: in development React mounts, cleans up and mounts again, and
 * that release rewinds history past the entry the second mount then pushed -
 * the stack says there is a layer and the browser is one entry below it, so the
 * next Back leaves the page.
 */
function useArmedBack(onBack: () => void, rearm: boolean): void {
  const handler = React.useRef(onBack);
  handler.current = onBack;
  const layer = React.useRef<(() => void) | null>(null);
  const alive = React.useRef(false);

  React.useEffect(() => {
    alive.current = true;
    const arm = () => {
      layer.current = pushLayer(() => {
        // The entry this press consumed is already gone.
        layer.current = null;
        handler.current();
        if (rearm) arm();
      });
    };
    if (!layer.current) arm();
    return () => {
      alive.current = false;
      window.setTimeout(() => {
        if (!alive.current && layer.current) {
          layer.current();
          layer.current = null;
        }
      }, 0);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * "Leave LANTV?" - asked whenever Back runs out, and whenever Back is held.
 *
 * Stay is where focus starts, so a second, impatient press of Back (which also
 * means Stay) and a press of OK both leave the viewer where they were. Leaving
 * is always a deliberate move across to the other button.
 */
export function TvExitPrompt({ onStay, onLeave }: { onStay: () => void; onLeave: () => void }) {
  const [at, setAt] = React.useState<0 | 1>(0);

  // The system's Back, which arrives as history rather than as a key.
  useArmedBack(onStay, false);

  const stay = React.useRef(onStay);
  const leave = React.useRef(onLeave);
  stay.current = onStay;
  leave.current = onLeave;
  const focus = React.useRef(at);
  focus.current = at;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const intent = intentOf(e);
      if (!intent) return;
      // Nothing behind the prompt may hear the key; the library and the player
      // are told to stand down (`suspended`) and this makes sure of it.
      e.preventDefault();
      e.stopPropagation();
      if (intent === 'left' || intent === 'up') setAt(0);
      else if (intent === 'right' || intent === 'down') setAt(1);
      else if (intent === 'ok') (focus.current === 1 ? leave : stay).current();
      else if (intent === 'back') stay.current();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const button = (label: string, index: 0 | 1) => (
    <div
      className={
        at === index
          ? 'rounded-2xl font-bold bg-white text-black ring-4 ring-white/40'
          : 'rounded-2xl font-bold bg-white/10 text-white/80'
      }
      style={{ fontSize: u(2.4), padding: `${u(1.4)} ${u(5)}`, minWidth: u(16), textAlign: 'center' }}
    >
      {label}
    </div>
  );

  return (
    <div
      className="absolute inset-0 z-50 grid place-items-center bg-black/85"
      role="alertdialog"
      aria-label="Leave LANTV?"
    >
      <div className="text-center" style={{ maxWidth: u(70) }}>
        <div className="font-bold" style={{ fontSize: u(4.4) }}>
          Leave LANTV?
        </div>
        <div className="text-white/60" style={{ fontSize: u(2), marginTop: u(1.2) }}>
          Anything that is playing will stop.
        </div>
        <div className="flex justify-center" style={{ gap: u(3), marginTop: u(4) }}>
          {button('Stay', 0)}
          {button('Leave', 1)}
        </div>
        <div className="text-white/40" style={{ fontSize: u(1.5), marginTop: u(3) }}>
          OK chooses · Back stays
        </div>
      </div>
    </div>
  );
}
