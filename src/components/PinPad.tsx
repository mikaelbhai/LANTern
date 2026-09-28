/**
 * A numeric PIN, entered the way a lock screen takes one.
 *
 * The rating gate's pass phrase was a plain text field, on both ends — set
 * it on a desktop with a keyboard and it worked fine; typed on a phone it
 * meant hunting across the full software keyboard for whatever character
 * came next, and free text meant nothing stopped a phrase heavy with
 * exactly the punctuation autocorrect likes to mangle. A PIN pad has ten
 * keys, all the same size, and there is nothing on it that a swipe-typing
 * keyboard can get wrong.
 *
 * `Delete` is honest about it: it only ever removes the room this control
 * looks at — the parent decides what a PIN of any given length is allowed
 * to do with it.
 */
import React from 'react';
import { Delete } from 'lucide-react';
import { cn } from '../lib/utils';
import { sfx } from '../lib/audio';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'back'];

export function PinPad({
  value,
  onChange,
  maxLength = 8,
}: {
  value: string;
  onChange: (next: string) => void;
  maxLength?: number;
}) {
  const press = (key: string) => {
    sfx.click();
    if (key === 'back') {
      onChange(value.slice(0, -1));
      return;
    }
    if (value.length >= maxLength) return;
    onChange(value + key);
  };

  return (
    <div className="space-y-4">
      {/* Entered digits as dots, never as themselves - the one place in this
          screen a shoulder-surfed glance should learn nothing. */}
      <div className="flex items-center justify-center gap-2 h-6" aria-hidden="true">
        {Array.from({ length: Math.max(value.length, 4) }).map((_, i) => (
          <span
            key={i}
            className={cn(
              'h-2.5 w-2.5 rounded-full border transition-colors',
              i < value.length ? 'bg-gold border-gold' : 'border-edge-strong',
            )}
          />
        ))}
      </div>

      <div className="grid grid-cols-3 gap-2.5 w-[220px] mx-auto">
        {KEYS.map((key, i) =>
          key === '' ? (
            <span key={i} />
          ) : (
            <button
              key={i}
              type="button"
              onClick={() => press(key)}
              aria-label={key === 'back' ? 'Delete' : key}
              className={cn(
                'h-14 rounded-full grid place-items-center text-lg font-medium',
                'bg-raised border border-edge hover:border-edge-strong active:scale-95 transition-transform',
                key === 'back' && 'text-dim',
              )}
            >
              {key === 'back' ? <Delete size={18} /> : key}
            </button>
          ),
        )}
      </div>
    </div>
  );
}

/** Digits only, and nothing longer than what the pad above can hold. */
export function sanitizePin(raw: string, maxLength = 8): string {
  return raw.replace(/\D/g, '').slice(0, maxLength);
}
