/** All app sound is synthesised — no audio files ship in the bundle. */

let ctx: AudioContext | null = null;
let enabled = true;

function ac(): AudioContext {
  if (!ctx) ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
  if (ctx.state === 'suspended') void ctx.resume();
  return ctx;
}

export function setSoundEnabled(on: boolean) {
  enabled = on;
}

type ToneOpts = {
  freq: number;
  dur: number;
  type?: OscillatorType;
  gain?: number;
  delay?: number;
  sweepTo?: number;
  /** Play even when UI sound is muted. Reserved for call alerting. */
  force?: boolean;
};

function tone({ freq, dur, type = 'sine', gain = 0.15, delay = 0, sweepTo, force }: ToneOpts) {
  if (!enabled && !force) return;
  const a = ac();
  const t0 = a.currentTime + delay;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (sweepTo) osc.frequency.exponentialRampToValueAtTime(sweepTo, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g).connect(a.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise(dur: number, gain = 0.08, delay = 0, hp = 900) {
  if (!enabled) return;
  const a = ac();
  const t0 = a.currentTime + delay;
  const frames = Math.floor(a.sampleRate * dur);
  const buf = a.createBuffer(1, frames, a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < frames; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / frames);
  const src = a.createBufferSource();
  src.buffer = buf;
  const filter = a.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = hp;
  const g = a.createGain();
  g.gain.setValueAtTime(gain, t0);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  src.connect(filter).connect(g).connect(a.destination);
  src.start(t0);
}

export const sfx = {
  messageIn: () => {
    tone({ freq: 660, dur: 0.09, gain: 0.1 });
    tone({ freq: 880, dur: 0.12, gain: 0.09, delay: 0.07 });
  },
  messageOut: () => tone({ freq: 520, dur: 0.07, gain: 0.07 }),
  mention: () => {
    tone({ freq: 784, dur: 0.1, gain: 0.12 });
    tone({ freq: 1046, dur: 0.14, gain: 0.11, delay: 0.09 });
  },
  peerJoin: () => {
    tone({ freq: 523, dur: 0.1, gain: 0.09 });
    tone({ freq: 659, dur: 0.1, gain: 0.09, delay: 0.08 });
    tone({ freq: 784, dur: 0.16, gain: 0.09, delay: 0.16 });
  },
  peerLeave: () => {
    tone({ freq: 494, dur: 0.11, gain: 0.08 });
    tone({ freq: 370, dur: 0.18, gain: 0.08, delay: 0.09 });
  },
  transferDone: () => {
    tone({ freq: 880, dur: 0.08, gain: 0.1 });
    tone({ freq: 1174, dur: 0.18, gain: 0.1, delay: 0.07 });
  },
  error: () => tone({ freq: 220, dur: 0.22, type: 'square', gain: 0.07, sweepTo: 140 }),
  click: () => tone({ freq: 1200, dur: 0.03, gain: 0.04 }),
  callConnect: () => {
    tone({ freq: 600, dur: 0.09, gain: 0.09 });
    tone({ freq: 900, dur: 0.13, gain: 0.09, delay: 0.08 });
  },
  callEnd: () => {
    tone({ freq: 500, dur: 0.1, gain: 0.09 });
    tone({ freq: 320, dur: 0.2, gain: 0.09, delay: 0.09 });
  },
  // Chess
  move: () => noise(0.06, 0.05, 0, 1400),
  capture: () => {
    noise(0.09, 0.09, 0, 700);
    tone({ freq: 180, dur: 0.08, type: 'triangle', gain: 0.06 });
  },
  check: () => {
    tone({ freq: 988, dur: 0.1, type: 'triangle', gain: 0.11 });
    tone({ freq: 1319, dur: 0.16, type: 'triangle', gain: 0.1, delay: 0.09 });
  },
  castle: () => {
    noise(0.05, 0.05, 0, 1400);
    noise(0.05, 0.05, 0.08, 1400);
  },
  promote: () => {
    [523, 659, 784, 1046].forEach((f, i) =>
      tone({ freq: f, dur: 0.12, gain: 0.09, delay: i * 0.06 }),
    );
  },
  gameWin: () => {
    [523, 659, 784, 1046, 1318].forEach((f, i) =>
      tone({ freq: f, dur: 0.2, gain: 0.1, delay: i * 0.08 }),
    );
  },
  gameLose: () => {
    [523, 466, 415, 349].forEach((f, i) =>
      tone({ freq: f, dur: 0.22, gain: 0.09, delay: i * 0.1 }),
    );
  },
  // Cards
  cardDeal: () => noise(0.045, 0.045, 0, 2000),
  cardPlace: () => noise(0.05, 0.05, 0, 1200),
  cardInvalid: () => tone({ freq: 160, dur: 0.12, type: 'square', gain: 0.05 }),
  cardFoundation: () => {
    tone({ freq: 784, dur: 0.08, gain: 0.08 });
    tone({ freq: 1046, dur: 0.1, gain: 0.08, delay: 0.06 });
  },
};

/**
 * Repeating two-burst ring, styled after a classic telephone cadence.
 *
 * `force` plays it even when UI sound is muted. That switch governs interface
 * chirps — a keystroke, a card landing — and silencing those should not also
 * mean missing a call. Do-not-disturb is a separate decision, made by the
 * ringer, and does silence this.
 */
export function startRingtone(force = false): () => void {
  if (!enabled && !force) return () => {};
  let stopped = false;
  const burst = () => {
    if (stopped) return;
    for (let i = 0; i < 2; i++) {
      tone({ freq: 660, dur: 0.38, type: 'triangle', gain: 0.1, delay: i * 0.5, force });
      tone({ freq: 880, dur: 0.38, type: 'triangle', gain: 0.07, delay: i * 0.5, force });
    }
    timer = window.setTimeout(burst, 3000);
  };
  let timer = window.setTimeout(burst, 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/**
 * The tone the *caller* hears while the far end rings.
 *
 * Deliberately not the ringtone: a caller hearing their own ringtone cannot
 * tell whether the call went out or came in. This is quieter, single-burst and
 * lower, the way a telephone ringback has always been distinguishable from a
 * ring.
 */
export function startRingback(): () => void {
  let stopped = false;
  const burst = () => {
    if (stopped) return;
    tone({ freq: 420, dur: 0.9, type: 'sine', gain: 0.05, force: true });
    timer = window.setTimeout(burst, 3400);
  };
  let timer = window.setTimeout(burst, 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

/** Low periodic beep played to the far side while a call is on hold. */
export function startHoldTone(): () => void {
  if (!enabled) return () => {};
  let stopped = false;
  const beep = () => {
    if (stopped) return;
    tone({ freq: 440, dur: 0.25, type: 'sine', gain: 0.05 });
    timer = window.setTimeout(beep, 2200);
  };
  let timer = window.setTimeout(beep, 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
