import React from 'react';
import { Lock, LockOpen } from 'lucide-react';

import { setNoUpsideDown, setOrientationLocked, useOrientation } from '../lib/orientation';
import { cn } from '../lib/utils';

/**
 * The app's own rotation lock, drawn so it cannot be mistaken for the
 * controls lock beside it (a bare padlock in both places had people pressing
 * the wrong one): this one sits in a ring.
 *
 * One tap locks or unlocks, freezing whichever way up the screen is now. Two
 * taps turn upside-down off while the sensor is still in charge - a phone laid
 * on its back and picked up the other way round stops flipping the film - and
 * a dot in the middle says that is on.
 */
export function RotationLock({ className }: { className?: string }) {
  const locked = useOrientation((s) => s.locked);
  const noFlip = useOrientation((s) => s.noFlip);
  const pending = React.useRef<number>();

  React.useEffect(() => () => window.clearTimeout(pending.current), []);

  const onClick = () => {
    // The first tap waits a moment in case it is half of a double: acting on it
    // at once would lock the screen, and the second tap would then unlock it.
    if (pending.current !== undefined) {
      window.clearTimeout(pending.current);
      pending.current = undefined;
      setNoUpsideDown(!noFlip);
      return;
    }
    pending.current = window.setTimeout(() => {
      pending.current = undefined;
      setOrientationLocked(!locked);
    }, 260);
  };

  const label = locked
    ? 'Rotation locked. Tap to unlock'
    : noFlip
      ? 'Upside-down blocked. Tap to lock rotation, double-tap to allow it again'
      : 'Tap to lock rotation, double-tap to block upside-down';

  return (
    <button
      onClick={onClick}
      aria-label={label}
      aria-pressed={locked || noFlip}
      title={label}
      className={cn(
        'relative h-9 w-9 rounded-full grid place-items-center border transition-colors',
        locked ? 'border-gold text-gold' : noFlip ? 'border-gold/70 text-white/90' : 'border-current/40',
        className,
      )}
    >
      {locked ? <Lock size={15} /> : <LockOpen size={15} />}
      {noFlip && (
        <span
          className="absolute h-1.5 w-1.5 rounded-full bg-gold"
          // Over the body of the padlock, where the keyhole is.
          style={{ top: '55%', left: '50%', transform: 'translate(-50%, -50%)' }}
          aria-hidden
        />
      )}
    </button>
  );
}
