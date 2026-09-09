import React from 'react';
import { motion } from 'framer-motion';
import { ArrowRight } from 'lucide-react';
import { Wordmark } from './Logo';
import { Avatar } from './Avatar';
import { Button, Input } from './ui';
import { AVATAR_COLORS, useStore } from '../lib/store';
import { cn } from '../lib/utils';

const EMOJI_CHOICES = [
  '🏮', '🦊', '🎧', '🚀', '🖥', '🔧', '🌙', '⚡',
  '🐙', '🍜', '🎲', '🛰', '🌵', '🔭', '🧭', '🪐',
];

export function Onboarding() {
  const complete = useStore((s) => s.completeOnboarding);
  const [name, setName] = React.useState('');
  const [color, setColor] = React.useState(AVATAR_COLORS[0]);
  const [emoji, setEmoji] = React.useState('🏮');

  const canGo = name.trim().length > 0;

  const submit = () => {
    if (!canGo) return;
    complete({
      name: name.trim(),
      color,
      emoji,
      deviceNickname: name.trim(),
    });
  };

  return (
    <div className="h-full w-full grid place-items-center bg-base px-6 overflow-y-auto">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ type: 'spring', stiffness: 180, damping: 20 }}
        className="w-full max-w-sm py-10"
      >
        <div className="flex flex-col items-center text-center mb-8">
          <Wordmark size="lg" pulse />
          <p className="text-xs text-dim mt-3 max-w-[260px]">
            Your local network, illuminated. No account, no cloud — just the devices around you.
          </p>
        </div>

        <div className="panel p-5 space-y-5">
          <div className="flex justify-center">
            <Avatar name={name || '?'} color={color} emoji={emoji} size={64} />
          </div>

          <div className="space-y-1.5">
            <label className="label">Display name</label>
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
              placeholder="What should peers call you?"
              maxLength={24}
              className="h-9 text-sm"
            />
          </div>

          <div className="space-y-2">
            <label className="label">Avatar colour</label>
            <div className="flex flex-wrap gap-2">
              {AVATAR_COLORS.map((c) => (
                <button
                  key={c}
                  onClick={() => setColor(c)}
                  aria-label={`Colour ${c}`}
                  className={cn(
                    'h-7 w-7 rounded-full transition-transform',
                    color === c ? 'scale-110 ring-2 ring-offset-2 ring-offset-surface' : 'hover:scale-105',
                  )}
                  style={{
                    background: c,
                    ...(color === c ? ({ '--tw-ring-color': c } as React.CSSProperties) : {}),
                  }}
                />
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <label className="label">Avatar emoji</label>
            <div className="grid grid-cols-8 gap-1.5">
              {EMOJI_CHOICES.map((e) => (
                <button
                  key={e}
                  onClick={() => setEmoji(e)}
                  className={cn(
                    'h-8 rounded-input text-base grid place-items-center transition-colors border',
                    emoji === e
                      ? 'bg-gold/12 border-gold/50 shadow-glow'
                      : 'border-transparent hover:bg-raised',
                  )}
                >
                  {e}
                </button>
              ))}
            </div>
          </div>

          <Button
            variant="primary"
            size="lg"
            full
            disabled={!canGo}
            onClick={submit}
            icon={<ArrowRight size={15} />}
          >
            Light the lantern
          </Button>
        </div>

        <p className="text-2xs text-muted text-center mt-4">
          Everything stays on this device and your LAN. Nothing leaves the network.
        </p>
      </motion.div>
    </div>
  );
}
