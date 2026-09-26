import React from 'react';
import { Camera } from 'lucide-react';
import { Avatar } from '../components/Avatar';
import { pickAvatar } from '../lib/avatar';
import { Button, Input, Modal } from '../components/ui';
import { AVATAR_COLORS, useStore } from '../lib/store';
import { cn } from '../lib/utils';

const EMOJI_CHOICES = [
  '🏮', '🦊', '🎧', '🚀', '🖥', '🔧', '🌙', '⚡',
  '🐙', '🍜', '🎲', '🛰', '🌵', '🔭', '🧭', '🪐',
];

export function ProfileModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const profile = useStore((s) => s.profile);
  const setProfile = useStore((s) => s.setProfile);

  const [draft, setDraft] = React.useState(profile);
  React.useEffect(() => {
    if (open) setDraft(profile);
  }, [open, profile]);

  const [busy, setBusy] = React.useState(false);

  const choose = async () => {
    setBusy(true);
    try {
      const avatar = await pickAvatar();
      // `null` is a cancelled picker, which is a decision and not a failure -
      // it must not clear a picture that is already there.
      if (avatar) setDraft((d) => ({ ...d, avatar }));
    } finally {
      setBusy(false);
    }
  };

  const save = () => {
    setProfile(draft);
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Your profile"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={save} disabled={!draft.name.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {/*
          The picture, and the two things you can do to it.

          A photo beats a letter and an emoji at telling one Mikael from
          another, which on a home network is the whole job of this circle.
          It is scaled to a 128px square before it is stored, because it is
          sent to peers over the same socket as chat - see lib/avatar.ts.
        */}
        <div className="flex flex-col items-center gap-3">
          <button
            onClick={() => void choose()}
            aria-label="Choose a picture"
            className="relative group rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gold/60"
          >
            <Avatar
              name={draft.name}
              color={draft.color}
              emoji={draft.emoji}
              src={draft.avatar}
              size={84}
            />
            <span className="absolute inset-0 rounded-full bg-black/45 opacity-0 group-hover:opacity-100 transition-opacity grid place-items-center text-white">
              <Camera size={20} />
            </span>
          </button>

          <div className="flex items-center gap-2">
            <Button size="xs" icon={<Camera size={12} />} onClick={() => void choose()}>
              {draft.avatar ? 'Change picture' : 'Add a picture'}
            </Button>
            {draft.avatar && (
              <Button size="xs" variant="ghost" onClick={() => setDraft({ ...draft, avatar: undefined })}>
                Remove
              </Button>
            )}
          </div>

          {busy && <span className="text-2xs text-muted">Scaling it down…</span>}
        </div>

        <div className="space-y-1.5">
          <label className="label">Display name</label>
          <Input
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            maxLength={24}
          />
        </div>

        <div className="space-y-1.5">
          <label className="label">Status message</label>
          <Input
            value={draft.statusMessage}
            onChange={(e) => setDraft({ ...draft, statusMessage: e.target.value })}
            placeholder="Optional — shown on your peer card"
            maxLength={48}
          />
        </div>

        <div className="space-y-1.5">
          <label className="label">Device nickname</label>
          <Input
            value={draft.deviceNickname}
            onChange={(e) => setDraft({ ...draft, deviceNickname: e.target.value })}
            placeholder="How this machine appears over mDNS"
            maxLength={32}
          />
        </div>

        <div className="space-y-2">
          <label className="label">Avatar colour</label>
          <div className="flex flex-wrap gap-2">
            {AVATAR_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setDraft({ ...draft, color: c })}
                aria-label={`Colour ${c}`}
                className={cn(
                  'h-7 w-7 rounded-full transition-transform',
                  draft.color === c
                    ? 'scale-110 ring-2 ring-offset-2 ring-offset-surface'
                    : 'hover:scale-105',
                )}
                style={{
                  background: c,
                  ...(draft.color === c ? ({ '--tw-ring-color': c } as React.CSSProperties) : {}),
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
                onClick={() => setDraft({ ...draft, emoji: e })}
                className={cn(
                  'h-8 rounded-input text-base grid place-items-center transition-colors border',
                  draft.emoji === e
                    ? 'bg-gold/12 border-gold/50 shadow-glow'
                    : 'border-transparent hover:bg-raised',
                )}
              >
                {e}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}
