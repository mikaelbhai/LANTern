import React from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, Baby, FolderOpen } from 'lucide-react';
import { Wordmark } from './Logo';
import { Avatar } from './Avatar';
import { Button, Input, Select } from './ui';
import { AGES } from './Audience';
import { api } from '../lib/bridge';
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

  /**
   * Who you are, then what the network may watch.
   *
   * The second half was never asked. It has a default, and a default nobody
   * chose is the one that gets blamed later: too low and a peer's Theatre is
   * full of locked doors nobody explained, too high and the limit exists
   * without ever having been set. It is one question and it belongs here,
   * where the answer is cheap and there is nothing yet to go wrong.
   */
  const [step, setStep] = React.useState<'you' | 'watching'>('you');
  const [maxAge, setMaxAge] = React.useState('13');

  const canGo = name.trim().length > 0;

  const submit = () => {
    if (!canGo) return;
    // Recorded before the window opens, so the first peer to ask is answered
    // by a limit somebody chose rather than by whatever the default was.
    void api.ratings.setDefault(Number(maxAge)).catch(() => {
      /* a limit that would not save is not a reason to block setting up */
    });
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
            {/*
             * A router is usually faster than the internet connection behind
             * it, and almost nothing on a phone or a laptop is built to
             * notice — every transfer still goes out to the internet and
             * back even when the other device is in the same room, so it
             * runs at whatever the ISP's plan allows rather than at what the
             * network you already paid for can actually do. Staying on the
             * LAN is what unleashes the difference.
             */}
            Unleash your Wi-Fi's potential. Full network speed, not your ISP's — everything
            stays on this network, with no account and no cloud.
          </p>
        </div>

        <div className="panel p-5 space-y-5">
          {step === 'you' ? (
          <>
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
            onClick={() => canGo && setStep('watching')}
            icon={<ArrowRight size={15} />}
          >
            Continue
          </Button>
          </>
          ) : (
          <>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="h-7 w-7 rounded-full bg-gold/15 border border-gold/40 grid place-items-center text-gold shrink-0">
                <Baby size={13} />
              </span>
              <label className="label !mb-0">What other devices may watch</label>
            </div>
            <p className="text-2xs text-muted leading-relaxed">
              Anything you publish is checked against this before a file
              leaves — by this device, every time, not by the app doing the
              watching. Each device can be given its own limit later, and any
              one title can be let past without changing it.
            </p>
            <Select value={maxAge} onChange={setMaxAge} options={AGES} className="w-full" />
          </div>

          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="h-7 w-7 rounded-full bg-raised border border-edge grid place-items-center text-muted shrink-0">
                <FolderOpen size={13} />
              </span>
              <label className="label !mb-0">Then publish something</label>
            </div>
            <p className="text-2xs text-muted leading-relaxed">
              Nothing is shared until you say so. Point Theatre at a folder of
              videos, or Files at any folder, and it appears on every device on
              the network — and in a plain browser, with no app needed.
            </p>
          </div>

          <div className="flex gap-2">
            <Button size="lg" onClick={() => setStep('you')}>
              Back
            </Button>
            <Button
              variant="primary"
              size="lg"
              full
              onClick={submit}
              icon={<ArrowRight size={15} />}
            >
              Light the lantern
            </Button>
          </div>
          </>
          )}
        </div>

        <p className="text-2xs text-muted text-center mt-4">
          Everything stays on this device and your LAN. Nothing leaves the network.
        </p>
      </motion.div>
    </div>
  );
}
