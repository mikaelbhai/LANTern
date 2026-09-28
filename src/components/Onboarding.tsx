import React from 'react';
import { motion } from 'framer-motion';
import { ArrowRight, Baby, BatteryCharging, Bell, Check, FolderOpen, Video } from 'lucide-react';
import { Wordmark } from './Logo';
import { Avatar } from './Avatar';
import { Button, Input, Select } from './ui';
import { AGES } from './Audience';
import { api, isTauri } from '../lib/bridge';
import { openPrivacySettings, readMediaError } from '../lib/mediaerror';
import { prepareCallAlerts } from '../lib/ringer';
import { AVATAR_COLORS, useStore } from '../lib/store';
import { cn } from '../lib/utils';

type Grant = 'idle' | 'checking' | 'granted' | 'denied';

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
  const [step, setStep] = React.useState<'you' | 'watching' | 'permissions'>('you');
  const [maxAge, setMaxAge] = React.useState('13');

  const canGo = name.trim().length > 0;

  /**
   * Everything the app will otherwise ask for piecemeal, mid-use: the camera
   * prompt interrupting the first call, the notification dialog racing an
   * incoming one, a phone quietly dozed the whole time because nobody was
   * ever asked to exempt it. Asked here instead, together, while there is
   * nothing yet in progress for an interruption to break.
   */
  const [os, setOs] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (step === 'permissions') void api.profile.os().then(setOs).catch(() => {});
  }, [step]);

  const [camera, setCamera] = React.useState<Grant>('idle');
  const [cameraError, setCameraError] = React.useState<string | null>(null);
  const requestCamera = async () => {
    setCamera('checking');
    setCameraError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
      stream.getTracks().forEach((t) => t.stop());
      setCamera('granted');
    } catch (err) {
      setCamera('denied');
      setCameraError(readMediaError(err, 'camera').body);
    }
  };

  const [notifications, setNotifications] = React.useState<Grant>('idle');
  const requestNotifications = async () => {
    setNotifications('checking');
    const granted = await prepareCallAlerts().catch(() => false);
    setNotifications(granted ? 'granted' : 'denied');
  };

  const [battery, setBattery] = React.useState<Grant>('idle');
  const requestBattery = async () => {
    setBattery('checking');
    if (await api.battery.unrestricted().catch(() => true)) {
      setBattery('granted');
      return;
    }
    // The grant is a system dialogue this app is handed no answer from -
    // re-checked once the window has focus again rather than assumed.
    const recheck = () => {
      if (document.visibilityState !== 'visible') return;
      document.removeEventListener('visibilitychange', recheck);
      void api.battery
        .unrestricted()
        .then((granted) => setBattery(granted ? 'granted' : 'denied'))
        .catch(() => setBattery('denied'));
    };
    document.addEventListener('visibilitychange', recheck);
    await api.battery.requestUnrestricted().catch(() => {});
  };

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
          ) : step === 'watching' ? (
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
              onClick={() => setStep('permissions')}
              icon={<ArrowRight size={15} />}
            >
              Continue
            </Button>
          </div>
          </>
          ) : (
          <>
          <p className="text-2xs text-muted leading-relaxed -mt-1">
            Asked once, together, rather than one at a time mid-call. Every one
            of these can be changed later in Settings — none of them block
            lighting the lantern.
          </p>

          <PermissionRow
            icon={<Video size={13} />}
            label="Camera & microphone"
            body="For voice and video calls. Skip this and it is asked the first time you actually call someone."
            grant={camera}
            onRequest={requestCamera}
          />
          {camera === 'denied' && (
            <p className="text-2xs text-danger -mt-3 leading-relaxed">
              {cameraError}
              {isTauri() && (
                <button
                  onClick={() => void openPrivacySettings('camera')}
                  className="text-cyan hover:underline ml-1"
                >
                  Open settings
                </button>
              )}
            </p>
          )}

          <PermissionRow
            icon={<Bell size={13} />}
            label="Notifications"
            body="So a call or a message reaches you while the app is out of sight."
            grant={notifications}
            onRequest={requestNotifications}
          />

          {os === 'android' && (
            <PermissionRow
              icon={<BatteryCharging size={13} />}
              label="Stay reachable in the background"
              body="Android's battery saver can doze LANTern between wakeups even while it is meant to be listening. Exempting it is what keeps calls and messages arriving while the screen is off."
              grant={battery}
              onRequest={requestBattery}
            />
          )}

          <div className="flex gap-2">
            <Button size="lg" onClick={() => setStep('watching')}>
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

function PermissionRow({
  icon,
  label,
  body,
  grant,
  onRequest,
}: {
  icon: React.ReactNode;
  label: string;
  body: string;
  grant: Grant;
  onRequest: () => void;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span
          className={cn(
            'h-7 w-7 rounded-full grid place-items-center shrink-0 border',
            grant === 'granted'
              ? 'bg-cyan/15 border-cyan/40 text-cyan'
              : 'bg-raised border-edge text-muted',
          )}
        >
          {grant === 'granted' ? <Check size={13} /> : icon}
        </span>
        <label className="label !mb-0 flex-1">{label}</label>
        <Button
          size="xs"
          variant={grant === 'granted' ? 'subtle' : 'outline'}
          disabled={grant === 'checking' || grant === 'granted'}
          onClick={onRequest}
        >
          {grant === 'granted' ? 'Allowed' : grant === 'denied' ? 'Try again' : 'Allow'}
        </Button>
      </div>
      <p className="text-2xs text-muted leading-relaxed">{body}</p>
    </div>
  );
}
