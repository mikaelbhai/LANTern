import React from 'react';

/**
 * Bundled sticker and motion packs.
 *
 * Both are drawn as SVG rather than shipped as raster assets — the whole set
 * costs a few kilobytes instead of megabytes, stays sharp at any size, and
 * inherits the theme's accent colour. Motion clips animate with SMIL, which
 * every WebView LANTern targets supports without a runtime.
 */

export interface StickerDef {
  id: string;
  name: string;
  render: (size: number) => React.ReactNode;
}

const FACES: Record<string, (c: string) => React.ReactNode> = {
  happy: (c) => (
    <>
      <circle cx="40" cy="46" r="3.4" fill={c} />
      <circle cx="60" cy="46" r="3.4" fill={c} />
      <path d="M38 58q12 11 24 0" stroke={c} strokeWidth="3.4" fill="none" strokeLinecap="round" />
    </>
  ),
  wink: (c) => (
    <>
      <path d="M35 46q5-5 10 0" stroke={c} strokeWidth="3.4" fill="none" strokeLinecap="round" />
      <circle cx="60" cy="46" r="3.4" fill={c} />
      <path d="M38 58q12 9 24 0" stroke={c} strokeWidth="3.4" fill="none" strokeLinecap="round" />
    </>
  ),
  love: (c) => (
    <>
      <path d="M35 44c3-4 8-1 5 3l-5 5-5-5c-3-4 2-7 5-3Z" fill={c} />
      <path d="M65 44c3-4 8-1 5 3l-5 5-5-5c-3-4 2-7 5-3Z" fill={c} />
      <path d="M38 60q12 10 24 0" stroke={c} strokeWidth="3.4" fill="none" strokeLinecap="round" />
    </>
  ),
  surprised: (c) => (
    <>
      <circle cx="40" cy="45" r="4" fill={c} />
      <circle cx="60" cy="45" r="4" fill={c} />
      <ellipse cx="50" cy="62" rx="6" ry="8" fill={c} />
    </>
  ),
  cool: (c) => (
    <>
      <rect x="31" y="41" width="17" height="10" rx="3" fill={c} />
      <rect x="52" y="41" width="17" height="10" rx="3" fill={c} />
      <path d="M48 46h4" stroke={c} strokeWidth="2.4" />
      <path d="M40 62q10 7 20 0" stroke={c} strokeWidth="3.4" fill="none" strokeLinecap="round" />
    </>
  ),
  sleepy: (c) => (
    <>
      <path d="M34 47q6-4 12 0" stroke={c} strokeWidth="3" fill="none" strokeLinecap="round" />
      <path d="M54 47q6-4 12 0" stroke={c} strokeWidth="3" fill="none" strokeLinecap="round" />
      <ellipse cx="50" cy="62" rx="4" ry="5" fill={c} />
    </>
  ),
  sad: (c) => (
    <>
      <circle cx="40" cy="46" r="3.4" fill={c} />
      <circle cx="60" cy="46" r="3.4" fill={c} />
      <path d="M38 64q12-10 24 0" stroke={c} strokeWidth="3.4" fill="none" strokeLinecap="round" />
    </>
  ),
  smirk: (c) => (
    <>
      <circle cx="40" cy="46" r="3.4" fill={c} />
      <circle cx="60" cy="46" r="3.4" fill={c} />
      <path d="M40 60q10 7 20 -2" stroke={c} strokeWidth="3.4" fill="none" strokeLinecap="round" />
    </>
  ),
  determined: (c) => (
    <>
      <path d="M34 42l12 5" stroke={c} strokeWidth="3.2" strokeLinecap="round" />
      <path d="M66 42l-12 5" stroke={c} strokeWidth="3.2" strokeLinecap="round" />
      <circle cx="40" cy="50" r="3" fill={c} />
      <circle cx="60" cy="50" r="3" fill={c} />
      <path d="M40 62h20" stroke={c} strokeWidth="3.4" strokeLinecap="round" />
    </>
  ),
  laugh: (c) => (
    <>
      <path d="M34 47q6-6 12 0" stroke={c} strokeWidth="3.2" fill="none" strokeLinecap="round" />
      <path d="M54 47q6-6 12 0" stroke={c} strokeWidth="3.2" fill="none" strokeLinecap="round" />
      <path d="M36 57q14 16 28 0Z" fill={c} />
    </>
  ),
};

const BODIES: Record<string, (fill: string, stroke: string) => React.ReactNode> = {
  lantern: (fill, stroke) => (
    <>
      <path d="M36 20h28" stroke={stroke} strokeWidth="4" strokeLinecap="round" />
      <path d="M36 20 26 34v40l10 14h28l10-14V34L64 20H36Z" fill={fill} stroke={stroke} strokeWidth="3" strokeLinejoin="round" />
      <path d="M34 82h32" stroke={stroke} strokeWidth="4" strokeLinecap="round" />
    </>
  ),
  blob: (fill, stroke) => (
    <path
      d="M50 16c20 0 32 14 32 32s-12 36-32 36-32-16-32-36 12-32 32-32Z"
      fill={fill}
      stroke={stroke}
      strokeWidth="3"
    />
  ),
  square: (fill, stroke) => (
    <rect x="20" y="20" width="60" height="60" rx="14" fill={fill} stroke={stroke} strokeWidth="3" />
  ),
  ghost: (fill, stroke) => (
    <path
      d="M22 50a28 28 0 0 1 56 0v30l-9-7-9 7-9-7-9 7-9-7-11 7V50Z"
      fill={fill}
      stroke={stroke}
      strokeWidth="3"
      strokeLinejoin="round"
    />
  ),
  star: (fill, stroke) => (
    <path
      d="M50 14l10 22 24 3-17 17 4 24-21-11-21 11 4-24-17-17 24-3Z"
      fill={fill}
      stroke={stroke}
      strokeWidth="3"
      strokeLinejoin="round"
    />
  ),
  cat: (fill, stroke) => (
    <>
      <path d="M28 34 24 16l16 8" fill={fill} stroke={stroke} strokeWidth="3" strokeLinejoin="round" />
      <path d="M72 34 76 16l-16 8" fill={fill} stroke={stroke} strokeWidth="3" strokeLinejoin="round" />
      <circle cx="50" cy="52" r="32" fill={fill} stroke={stroke} strokeWidth="3" />
    </>
  ),
};

const PALETTE = [
  ['#F5A623', '#7A4E05'],
  ['#39D9C8', '#0B4E48'],
  ['#9B8CFF', '#33296E'],
  ['#E05C5C', '#5E1E1E'],
  ['#7BD88F', '#1D5229'],
];

const COMBOS: Array<[keyof typeof BODIES, keyof typeof FACES, number, string]> = [
  ['lantern', 'happy', 0, 'Glow'],
  ['lantern', 'wink', 1, 'Signal'],
  ['lantern', 'love', 3, 'Warm'],
  ['lantern', 'cool', 2, 'Night shift'],
  ['lantern', 'sleepy', 4, 'Low power'],
  ['lantern', 'determined', 0, 'Uplink'],
  ['blob', 'happy', 1, 'Packet'],
  ['blob', 'laugh', 0, 'Broadcast'],
  ['blob', 'surprised', 2, 'Collision'],
  ['blob', 'sad', 3, 'Dropped'],
  ['blob', 'smirk', 4, 'Cached'],
  ['blob', 'sleepy', 1, 'Idle'],
  ['square', 'cool', 2, 'Subnet'],
  ['square', 'happy', 4, 'Handshake'],
  ['square', 'determined', 3, 'Firewall'],
  ['square', 'surprised', 0, 'Timeout'],
  ['square', 'wink', 1, 'Port open'],
  ['ghost', 'happy', 2, 'Ghost peer'],
  ['ghost', 'sad', 3, 'Left the LAN'],
  ['ghost', 'surprised', 1, 'Stale entry'],
  ['ghost', 'sleepy', 4, 'Sleeping host'],
  ['star', 'happy', 0, 'Latency star'],
  ['star', 'love', 3, 'Favourite'],
  ['star', 'cool', 2, 'Top peer'],
  ['star', 'laugh', 1, 'Zero ping'],
  ['cat', 'happy', 0, 'Router cat'],
  ['cat', 'wink', 1, 'Sneaky'],
  ['cat', 'smirk', 2, 'Knows the password'],
  ['cat', 'love', 3, 'Purrfect link'],
  ['cat', 'sleepy', 4, 'Nap on the switch'],
];

export const STICKERS: StickerDef[] = COMBOS.map(([body, face, paletteIndex, name], i) => {
  const [fill, stroke] = PALETTE[paletteIndex];
  return {
    id: `st-${i}`,
    name,
    render: (size: number) => (
      <svg width={size} height={size} viewBox="0 0 100 100" aria-label={name}>
        {BODIES[body](`${fill}33`, fill)}
        {FACES[face](stroke === '#7A4E05' ? fill : fill)}
      </svg>
    ),
  };
});

export function Sticker({ id, size = 96 }: { id: string; size?: number }) {
  const s = STICKERS.find((x) => x.id === id);
  if (!s) return null;
  return <>{s.render(size)}</>;
}

/* ------------------------------------------------------------ Motion pack */

export interface MotionDef {
  id: string;
  name: string;
  render: (size: number) => React.ReactNode;
}

const loop = (attr: string, values: string, dur: string, extra: Record<string, string> = {}) => (
  <animate attributeName={attr} values={values} dur={dur} repeatCount="indefinite" {...extra} />
);

export const MOTION_CLIPS: MotionDef[] = [
  {
    id: 'mo-0',
    name: 'Thumbs up',
    render: (s) => (
      <Frame size={s} bg="#F5A62322">
        <g>
          <animateTransform
            attributeName="transform"
            type="rotate"
            values="-12 50 70; 8 50 70; -12 50 70"
            dur="1.1s"
            repeatCount="indefinite"
          />
          <path
            d="M42 78V52l12-22c4-6 12-2 9 5l-5 12h16c5 0 8 4 6 9l-7 19c-1 4-4 6-8 6H42Z"
            fill="#F5A623"
          />
          <rect x="26" y="50" width="14" height="30" rx="3" fill="#FFD17A" />
        </g>
      </Frame>
    ),
  },
  {
    id: 'mo-1',
    name: 'Applause',
    render: (s) => (
      <Frame size={s} bg="#39D9C822">
        <g>
          <animateTransform
            attributeName="transform"
            type="translate"
            values="-6 0; 6 0; -6 0"
            dur="0.5s"
            repeatCount="indefinite"
          />
          <path d="M22 40l20 18-8 16-18-18Z" fill="#39D9C8" />
        </g>
        <g>
          <animateTransform
            attributeName="transform"
            type="translate"
            values="6 0; -6 0; 6 0"
            dur="0.5s"
            repeatCount="indefinite"
          />
          <path d="M78 40L58 58l8 16 18-18Z" fill="#7BD88F" />
        </g>
      </Frame>
    ),
  },
  {
    id: 'mo-2',
    name: 'Heartbeat',
    render: (s) => (
      <Frame size={s} bg="#E05C5C22">
        <path
          d="M50 78S20 60 20 42a16 16 0 0 1 30-8 16 16 0 0 1 30 8c0 18-30 36-30 36Z"
          fill="#E05C5C"
        >
          <animateTransform
            attributeName="transform"
            type="scale"
            values="1;1.12;1;1.06;1"
            dur="1.2s"
            additive="sum"
            repeatCount="indefinite"
          />
          <animateTransform
            attributeName="transform"
            type="translate"
            values="0 0"
            dur="1.2s"
            repeatCount="indefinite"
          />
        </path>
      </Frame>
    ),
  },
  {
    id: 'mo-3',
    name: 'Party',
    render: (s) => (
      <Frame size={s} bg="#9B8CFF22">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <rect
            key={i}
            x={16 + i * 12}
            y="10"
            width="7"
            height="12"
            rx="2"
            fill={PALETTE[i % 5][0]}
          >
            <animate
              attributeName="y"
              values="10;80"
              dur={`${1.1 + i * 0.19}s`}
              repeatCount="indefinite"
            />
            <animate
              attributeName="opacity"
              values="1;1;0"
              dur={`${1.1 + i * 0.19}s`}
              repeatCount="indefinite"
            />
          </rect>
        ))}
      </Frame>
    ),
  },
  {
    id: 'mo-4',
    name: 'Loading',
    render: (s) => (
      <Frame size={s} bg="#F5A62318">
        {[0, 1, 2].map((i) => (
          <circle key={i} cx={30 + i * 20} cy="50" r="7" fill="#F5A623">
            <animate
              attributeName="cy"
              values="50;36;50"
              dur="0.9s"
              begin={`${i * 0.15}s`}
              repeatCount="indefinite"
            />
          </circle>
        ))}
      </Frame>
    ),
  },
  {
    id: 'mo-5',
    name: 'Fire',
    render: (s) => (
      <Frame size={s} bg="#E05C5C1A">
        <path d="M50 84c-16 0-26-10-26-24 0-16 16-20 14-38 14 8 16 18 16 24 4-4 4-10 4-14 12 10 18 20 18 30 0 14-10 22-26 22Z" fill="#F5A623">
          <animate
            attributeName="opacity"
            values="1;0.75;1"
            dur="0.7s"
            repeatCount="indefinite"
          />
        </path>
        <path d="M50 80c-8 0-13-6-13-13 0-8 9-11 8-20 8 6 12 12 12 18 0 8-3 15-7 15Z" fill="#FFD17A">
          <animateTransform
            attributeName="transform"
            type="scale"
            values="1;1.12;1"
            dur="0.55s"
            additive="sum"
            repeatCount="indefinite"
          />
        </path>
      </Frame>
    ),
  },
  {
    id: 'mo-6',
    name: 'Wave',
    render: (s) => (
      <Frame size={s} bg="#39D9C822">
        <g style={{ transformOrigin: '50px 76px' }}>
          <animateTransform
            attributeName="transform"
            type="rotate"
            values="-22 50 76; 22 50 76; -22 50 76"
            dur="0.9s"
            repeatCount="indefinite"
          />
          <rect x="42" y="52" width="16" height="28" rx="7" fill="#39D9C8" />
          <circle cx="50" cy="42" r="16" fill="#39D9C8" />
        </g>
      </Frame>
    ),
  },
  {
    id: 'mo-7',
    name: 'Thinking',
    render: (s) => (
      <Frame size={s} bg="#9B8CFF22">
        <circle cx="46" cy="56" r="22" fill="#9B8CFF" />
        {[0, 1, 2].map((i) => (
          <circle key={i} cx={72 + i * 6} cy={34 - i * 8} r={3 + i} fill="#9B8CFF">
            <animate
              attributeName="opacity"
              values="0;1;0"
              dur="1.8s"
              begin={`${i * 0.4}s`}
              repeatCount="indefinite"
            />
          </circle>
        ))}
      </Frame>
    ),
  },
  {
    id: 'mo-8',
    name: 'Signal',
    render: (s) => (
      <Frame size={s} bg="#39D9C81A">
        {[0, 1, 2, 3].map((i) => (
          <rect key={i} x={22 + i * 16} y={70 - i * 14} width="10" height={12 + i * 14} rx="3" fill="#39D9C8">
            <animate
              attributeName="opacity"
              values="0.25;1;0.25"
              dur="1.4s"
              begin={`${i * 0.22}s`}
              repeatCount="indefinite"
            />
          </rect>
        ))}
      </Frame>
    ),
  },
  {
    id: 'mo-9',
    name: 'Rocket',
    render: (s) => (
      <Frame size={s} bg="#F5A62318">
        <g>
          <animateTransform
            attributeName="transform"
            type="translate"
            values="0 6; 0 -6; 0 6"
            dur="1.2s"
            repeatCount="indefinite"
          />
          <path d="M50 16c12 10 16 24 16 36l-8 12H42l-8-12c0-12 4-26 16-36Z" fill="#E6EAF3" />
          <circle cx="50" cy="42" r="6" fill="#39D9C8" />
          <path d="M42 64l8 20 8-20Z" fill="#F5A623">
            <animate attributeName="opacity" values="1;0.4;1" dur="0.3s" repeatCount="indefinite" />
          </path>
        </g>
      </Frame>
    ),
  },
  {
    id: 'mo-10',
    name: 'Check',
    render: (s) => (
      <Frame size={s} bg="#7BD88F22">
        <circle cx="50" cy="50" r="30" fill="none" stroke="#7BD88F" strokeWidth="6" />
        <path
          d="M36 51l10 11 20-24"
          fill="none"
          stroke="#7BD88F"
          strokeWidth="7"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray="52"
        >
          {loop('stroke-dashoffset', '52;0;0;52', '2s')}
        </path>
      </Frame>
    ),
  },
  {
    id: 'mo-11',
    name: 'Facepalm',
    render: (s) => (
      <Frame size={s} bg="#E05C5C1A">
        <circle cx="50" cy="52" r="26" fill="#E05C5C" opacity="0.85" />
        <g>
          <animateTransform
            attributeName="transform"
            type="translate"
            values="0 -22; 0 0; 0 0; 0 -22"
            dur="2.4s"
            repeatCount="indefinite"
          />
          <rect x="30" y="36" width="40" height="24" rx="10" fill="#FFD17A" />
        </g>
      </Frame>
    ),
  },
  {
    id: 'mo-12',
    name: 'Eyes',
    render: (s) => (
      <Frame size={s} bg="#F5A62318">
        {[34, 66].map((cx) => (
          <g key={cx}>
            <ellipse cx={cx} cy="50" rx="15" ry="18" fill="#E6EAF3" />
            <circle cx={cx} cy="50" r="7" fill="#0C0F14">
              <animate
                attributeName="cx"
                values={`${cx - 5};${cx + 5};${cx - 5}`}
                dur="2.2s"
                repeatCount="indefinite"
              />
            </circle>
          </g>
        ))}
      </Frame>
    ),
  },
  {
    id: 'mo-13',
    name: 'Spin',
    render: (s) => (
      <Frame size={s} bg="#9B8CFF22">
        <g>
          <animateTransform
            attributeName="transform"
            type="rotate"
            values="0 50 50; 360 50 50"
            dur="1.4s"
            repeatCount="indefinite"
          />
          <circle
            cx="50"
            cy="50"
            r="26"
            fill="none"
            stroke="#9B8CFF"
            strokeWidth="7"
            strokeDasharray="90 60"
            strokeLinecap="round"
          />
        </g>
      </Frame>
    ),
  },
  {
    id: 'mo-14',
    name: 'Sparkle',
    render: (s) => (
      <Frame size={s} bg="#FFD17A22">
        {[
          [50, 44, 22],
          [26, 26, 10],
          [76, 62, 12],
        ].map(([cx, cy, r], i) => (
          <path
            key={i}
            d={`M${cx} ${cy - r}l${r * 0.28} ${r * 0.72} ${r * 0.72} ${r * 0.28}-${r * 0.72} ${r * 0.28}-${r * 0.28} ${r * 0.72}-${r * 0.28}-${r * 0.72}-${r * 0.72}-${r * 0.28} ${r * 0.72}-${r * 0.28}Z`}
            fill="#FFD17A"
          >
            <animate
              attributeName="opacity"
              values="0.2;1;0.2"
              dur="1.6s"
              begin={`${i * 0.4}s`}
              repeatCount="indefinite"
            />
          </path>
        ))}
      </Frame>
    ),
  },
  {
    id: 'mo-15',
    name: 'No',
    render: (s) => (
      <Frame size={s} bg="#E05C5C22">
        <g>
          <animateTransform
            attributeName="transform"
            type="translate"
            values="-7 0; 7 0; -7 0"
            dur="0.4s"
            repeatCount="indefinite"
          />
          <circle cx="50" cy="50" r="28" fill="none" stroke="#E05C5C" strokeWidth="7" />
          <path d="M32 32l36 36" stroke="#E05C5C" strokeWidth="7" strokeLinecap="round" />
        </g>
      </Frame>
    ),
  },
  {
    id: 'mo-16',
    name: 'Popcorn',
    render: (s) => (
      <Frame size={s} bg="#F5A62318">
        <path d="M32 46h36l-5 36H37Z" fill="#E05C5C" />
        {[38, 50, 62].map((cx, i) => (
          <circle key={cx} cx={cx} cy="40" r="9" fill="#FFD17A">
            <animate
              attributeName="cy"
              values="40;26;40"
              dur={`${0.9 + i * 0.2}s`}
              repeatCount="indefinite"
            />
          </circle>
        ))}
      </Frame>
    ),
  },
  {
    id: 'mo-17',
    name: 'Coffee',
    render: (s) => (
      <Frame size={s} bg="#F5A62318">
        <path d="M28 42h40v22a16 16 0 0 1-16 16H44a16 16 0 0 1-16-16Z" fill="#8C97AE" />
        <path d="M68 48h8a8 8 0 0 1 0 16h-8" fill="none" stroke="#8C97AE" strokeWidth="5" />
        {[40, 50, 60].map((x, i) => (
          <path
            key={x}
            d={`M${x} 32c4-5-4-9 0-14`}
            stroke="#E6EAF3"
            strokeWidth="3"
            fill="none"
            strokeLinecap="round"
            opacity="0.7"
          >
            <animate
              attributeName="opacity"
              values="0;0.8;0"
              dur="2.2s"
              begin={`${i * 0.5}s`}
              repeatCount="indefinite"
            />
          </path>
        ))}
      </Frame>
    ),
  },
  {
    id: 'mo-18',
    name: 'Ping',
    render: (s) => (
      <Frame size={s} bg="#39D9C81A">
        <circle cx="50" cy="50" r="8" fill="#39D9C8" />
        {[0, 1, 2].map((i) => (
          <circle key={i} cx="50" cy="50" r="8" fill="none" stroke="#39D9C8" strokeWidth="3">
            <animate attributeName="r" values="8;34" dur="1.8s" begin={`${i * 0.6}s`} repeatCount="indefinite" />
            <animate attributeName="opacity" values="0.9;0" dur="1.8s" begin={`${i * 0.6}s`} repeatCount="indefinite" />
          </circle>
        ))}
      </Frame>
    ),
  },
  {
    id: 'mo-19',
    name: 'Lantern glow',
    render: (s) => (
      <Frame size={s} bg="#F5A62318">
        <path d="M38 22h24" stroke="#F5A623" strokeWidth="4" strokeLinecap="round" />
        <path
          d="M38 22 28 36v34l10 12h24l10-12V36L62 22H38Z"
          fill="#F5A62322"
          stroke="#F5A623"
          strokeWidth="3"
          strokeLinejoin="round"
        />
        {[
          [50, 40],
          [40, 54],
          [60, 54],
          [50, 68],
        ].map(([cx, cy], i) => (
          <circle key={i} cx={cx} cy={cy} r="4" fill="#FFD17A">
            <animate
              attributeName="opacity"
              values="0.3;1;0.3"
              dur="2.4s"
              begin={`${i * 0.3}s`}
              repeatCount="indefinite"
            />
          </circle>
        ))}
      </Frame>
    ),
  },
];

function Frame({
  size,
  bg,
  children,
}: {
  size: number;
  bg: string;
  children: React.ReactNode;
}) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      <rect width="100" height="100" rx="16" fill={bg} />
      {children}
    </svg>
  );
}

export function MotionClip({ id, size = 96 }: { id: string; size?: number }) {
  const c = MOTION_CLIPS.find((x) => x.id === id);
  if (!c) return null;
  return <>{c.render(size)}</>;
}
