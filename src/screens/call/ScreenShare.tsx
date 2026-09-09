import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowUpRight,
  Circle,
  Eraser,
  Highlighter,
  MonitorUp,
  MousePointer2,
  Pause,
  Pen,
  Play,
  Square as SquareIcon,
  Type,
  Volume2,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Badge, Button, IconButton, Modal, Toggle, Tooltip } from '../../components/ui';
import { useStore } from '../../lib/store';
import { cn } from '../../lib/utils';

type Tool = 'pointer' | 'pen' | 'highlighter' | 'rect' | 'arrow' | 'circle' | 'text' | 'erase';

interface Shape {
  id: string;
  tool: Tool;
  color: string;
  points: { x: number; y: number }[];
  text?: string;
}

const COLORS = ['#F5A623', '#39D9C8', '#E05C5C', '#9B8CFF', '#7BD88F'];

export function ScreenShareStage() {
  const call = useStore((s) => s.call)!;
  const peers = useStore((s) => s.peers);
  const profile = useStore((s) => s.profile);
  const updateCall = useStore((s) => s.updateCall);

  const share = call.screenShare!;
  const isSharer = share.byPeerId === profile.id;
  const sharerName = isSharer ? 'You' : (peers[share.byPeerId]?.name ?? 'Peer');

  const [tool, setTool] = React.useState<Tool>('pointer');
  const [color, setColor] = React.useState(COLORS[0]);
  const [shapes, setShapes] = React.useState<Shape[]>([]);
  const [draft, setDraft] = React.useState<Shape | null>(null);
  const [laser, setLaser] = React.useState<{ x: number; y: number } | null>(null);
  const [paused, setPaused] = React.useState(false);
  const [zoom, setZoom] = React.useState(1);
  const [textPrompt, setTextPrompt] = React.useState<{ x: number; y: number } | null>(null);
  const [textValue, setTextValue] = React.useState('');
  const [controlRequest, setControlRequest] = React.useState<string | null>(null);
  const [controlGranted, setControlGranted] = React.useState<string | null>(null);

  const stage = React.useRef<HTMLDivElement>(null);

  const toLocal = (e: React.PointerEvent): { x: number; y: number } => {
    const r = stage.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * 100, y: ((e.clientY - r.top) / r.height) * 100 };
  };

  const onDown = (e: React.PointerEvent) => {
    if (tool === 'pointer') return;
    const p = toLocal(e);
    if (tool === 'text') {
      setTextPrompt(p);
      return;
    }
    if (tool === 'erase') {
      setShapes((prev) =>
        prev.filter((s) => !s.points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < 3)),
      );
      return;
    }
    stage.current?.setPointerCapture(e.pointerId);
    setDraft({ id: `${Date.now()}`, tool, color, points: [p] });
  };

  const onMove = (e: React.PointerEvent) => {
    const p = toLocal(e);
    if (tool === 'pointer') setLaser(p);
    if (!draft) return;
    setDraft((d) => {
      if (!d) return d;
      if (d.tool === 'pen' || d.tool === 'highlighter') {
        return { ...d, points: [...d.points, p] };
      }
      return { ...d, points: [d.points[0], p] };
    });
  };

  const onUp = () => {
    if (draft && draft.points.length > 1) setShapes((prev) => [...prev, draft]);
    setDraft(null);
  };

  const tools: { id: Tool; label: string; icon: React.ElementType }[] = [
    { id: 'pointer', label: 'Laser pointer', icon: MousePointer2 },
    { id: 'pen', label: 'Pen', icon: Pen },
    { id: 'highlighter', label: 'Highlighter', icon: Highlighter },
    { id: 'rect', label: 'Rectangle', icon: SquareIcon },
    { id: 'arrow', label: 'Arrow', icon: ArrowUpRight },
    { id: 'circle', label: 'Circle', icon: Circle },
    { id: 'text', label: 'Text callout', icon: Type },
    { id: 'erase', label: 'Erase', icon: Eraser },
  ];

  const all = draft ? [...shapes, draft] : shapes;

  return (
    <div className="h-full flex flex-col gap-2">
      {/* toolbar */}
      <div className="shrink-0 flex items-center gap-1.5 flex-wrap">
        <Badge tone="gold">
          <MonitorUp size={9} />
          {sharerName} sharing {share.source}
        </Badge>
        {share.audio && (
          <Badge tone="cyan">
            <Volume2 size={9} />
            System audio
          </Badge>
        )}
        {isSharer && (
          <Tooltip content="Frames per second reaching viewers">
            <Badge tone={share.fps >= 25 ? 'cyan' : 'gold'}>{share.fps} fps</Badge>
          </Tooltip>
        )}

        <div className="w-px h-5 bg-edge mx-1" />

        {tools.map((t) => {
          const Icon = t.icon;
          return (
            <Tooltip key={t.id} content={t.label}>
              <button
                onClick={() => setTool(t.id)}
                aria-label={t.label}
                className={cn(
                  'h-7 w-7 rounded-input grid place-items-center border transition-colors',
                  tool === t.id
                    ? 'bg-gold/15 border-gold/50 text-gold'
                    : 'bg-raised border-edge text-dim hover:text-txt',
                )}
              >
                <Icon size={13} />
              </button>
            </Tooltip>
          );
        })}

        <div className="flex gap-1 ml-1">
          {COLORS.map((c) => (
            <button
              key={c}
              onClick={() => setColor(c)}
              aria-label={`Colour ${c}`}
              className={cn(
                'h-5 w-5 rounded-full border-2 transition-transform',
                color === c ? 'scale-110 border-txt' : 'border-transparent',
              )}
              style={{ background: c }}
            />
          ))}
        </div>

        <div className="ml-auto flex items-center gap-1">
          <IconButton label="Zoom out" size="sm" onClick={() => setZoom((z) => Math.max(1, z - 0.25))}>
            <ZoomOut size={13} />
          </IconButton>
          <span className="text-2xs font-mono text-muted w-9 text-center">
            {Math.round(zoom * 100)}%
          </span>
          <IconButton label="Zoom in" size="sm" onClick={() => setZoom((z) => Math.min(3, z + 0.25))}>
            <ZoomIn size={13} />
          </IconButton>

          <Button size="xs" onClick={() => setShapes([])}>
            Clear
          </Button>

          {isSharer ? (
            <Button
              size="xs"
              variant={paused ? 'primary' : 'outline'}
              icon={paused ? <Play size={11} /> : <Pause size={11} />}
              onClick={() => setPaused(!paused)}
            >
              {paused ? 'Resume' : 'Pause'}
            </Button>
          ) : (
            <Button
              size="xs"
              disabled={!!controlGranted}
              onClick={() => setControlRequest(profile.id)}
            >
              {controlGranted ? 'You have control' : 'Request control'}
            </Button>
          )}
        </div>
      </div>

      {/* stage */}
      <div className="flex-1 min-h-0 rounded-card border border-edge bg-base overflow-auto relative">
        <div
          ref={stage}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={() => setLaser(null)}
          className={cn(
            'relative origin-top-left',
            tool === 'pointer' ? 'cursor-default' : 'cursor-crosshair',
          )}
          style={{
            width: `${zoom * 100}%`,
            height: `${zoom * 100}%`,
            minHeight: '100%',
          }}
        >
          {/* Placeholder for the captured surface — the real frames arrive over WebRTC. */}
          <div className="absolute inset-0 grid place-items-center bg-[radial-gradient(circle_at_30%_25%,rgba(245,166,35,0.07),transparent_60%)]">
            <div className="text-center">
              <MonitorUp size={30} className="mx-auto text-muted mb-2" />
              <div className="text-xs text-dim">{share.source}</div>
              <div className="text-2xs text-muted mt-1">
                {paused ? 'Sharing paused' : 'Live from ' + sharerName}
              </div>
            </div>
          </div>

          {paused && <div className="absolute inset-0 bg-base/70 backdrop-blur-sm" />}

          <svg
            className="absolute inset-0 w-full h-full pointer-events-none"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            <defs>
              <marker
                id="arrowhead"
                markerWidth="4"
                markerHeight="4"
                refX="3"
                refY="2"
                orient="auto"
              >
                <path d="M0,0 L4,2 L0,4 Z" fill="currentColor" />
              </marker>
            </defs>
            {all.map((s) => (
              <ShapeNode key={s.id} shape={s} />
            ))}
          </svg>

          {/* text callouts sit outside the svg so they keep crisp typography */}
          {all
            .filter((s) => s.tool === 'text')
            .map((s) => (
              <span
                key={s.id}
                className="absolute px-1.5 py-0.5 rounded-input text-2xs font-medium pointer-events-none"
                style={{
                  left: `${s.points[0].x}%`,
                  top: `${s.points[0].y}%`,
                  background: 'rgb(var(--c-base) / 0.85)',
                  border: `1px solid ${s.color}`,
                  color: s.color,
                }}
              >
                {s.text}
              </span>
            ))}

          <AnimatePresence>
            {tool === 'pointer' && laser && (
              <motion.span
                initial={{ scale: 0.5, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ opacity: 0 }}
                className="absolute h-3 w-3 rounded-full pointer-events-none -translate-x-1/2 -translate-y-1/2"
                style={{
                  left: `${laser.x}%`,
                  top: `${laser.y}%`,
                  background: '#E05C5C',
                  boxShadow: '0 0 14px 4px rgba(224,92,92,0.6)',
                }}
              />
            )}
          </AnimatePresence>
        </div>
      </div>

      {/* text callout entry */}
      <Modal
        open={!!textPrompt}
        onClose={() => setTextPrompt(null)}
        title="Add a callout"
        footer={
          <>
            <Button onClick={() => setTextPrompt(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={!textValue.trim()}
              onClick={() => {
                setShapes((prev) => [
                  ...prev,
                  {
                    id: `${Date.now()}`,
                    tool: 'text',
                    color,
                    points: [textPrompt!],
                    text: textValue.trim(),
                  },
                ]);
                setTextValue('');
                setTextPrompt(null);
              }}
            >
              Place
            </Button>
          </>
        }
      >
        <input
          autoFocus
          value={textValue}
          onChange={(e) => setTextValue(e.target.value)}
          placeholder="Label text"
          className="w-full h-9 bg-raised border border-edge rounded-input px-2.5 text-sm focus:border-gold/60"
        />
      </Modal>

      {/* remote control permission */}
      <Modal
        open={!!controlRequest && isSharer}
        onClose={() => setControlRequest(null)}
        title="Remote control request"
        footer={
          <>
            <Button onClick={() => setControlRequest(null)}>Deny</Button>
            <Button
              variant="primary"
              onClick={() => {
                setControlGranted(controlRequest);
                setControlRequest(null);
              }}
            >
              Grant control
            </Button>
          </>
        }
      >
        <p className="text-xs text-dim">
          {peers[controlRequest ?? '']?.name ?? 'A viewer'} is asking to control your screen.
          Control is granted once and ends when you stop sharing.
        </p>
      </Modal>

      {/* viewer waiting state */}
      <Modal
        open={!!controlRequest && !isSharer}
        onClose={() => setControlRequest(null)}
        title="Waiting for permission"
      >
        <p className="text-xs text-dim">
          {sharerName} has been asked to grant you control. They must approve it explicitly.
        </p>
      </Modal>
    </div>
  );
}

function ShapeNode({ shape: s }: { shape: Shape }) {
  const [a, b] = s.points;
  const common = {
    stroke: s.color,
    strokeWidth: s.tool === 'highlighter' ? 2.4 : 0.6,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    fill: 'none',
    opacity: s.tool === 'highlighter' ? 0.4 : 1,
    vectorEffect: 'non-scaling-stroke' as const,
  };

  if (s.tool === 'text') return null;

  if (s.tool === 'pen' || s.tool === 'highlighter') {
    const d = s.points.map((p, i) => `${i ? 'L' : 'M'}${p.x} ${p.y}`).join(' ');
    return <path d={d} {...common} strokeWidth={s.tool === 'highlighter' ? 3 : 0.8} />;
  }

  if (!b) return null;

  if (s.tool === 'rect') {
    return (
      <rect
        x={Math.min(a.x, b.x)}
        y={Math.min(a.y, b.y)}
        width={Math.abs(b.x - a.x)}
        height={Math.abs(b.y - a.y)}
        {...common}
        strokeWidth={0.8}
      />
    );
  }

  if (s.tool === 'circle') {
    return (
      <ellipse
        cx={(a.x + b.x) / 2}
        cy={(a.y + b.y) / 2}
        rx={Math.abs(b.x - a.x) / 2}
        ry={Math.abs(b.y - a.y) / 2}
        {...common}
        strokeWidth={0.8}
      />
    );
  }

  return (
    <line
      x1={a.x}
      y1={a.y}
      x2={b.x}
      y2={b.y}
      {...common}
      strokeWidth={0.8}
      markerEnd="url(#arrowhead)"
      style={{ color: s.color }}
    />
  );
}

/* ------------------------------------------------------- Source picker */

const SOURCES = [
  { id: 'display-1', kind: 'Display', label: 'Display 1 — 2560 × 1440' },
  { id: 'display-2', kind: 'Display', label: 'Display 2 — 1920 × 1080' },
  { id: 'window-editor', kind: 'Window', label: 'Code editor' },
  { id: 'window-browser', kind: 'Window', label: 'Browser' },
  { id: 'window-terminal', kind: 'Window', label: 'Terminal' },
];

export function ShareSourcePicker({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const updateCall = useStore((s) => s.updateCall);
  const profile = useStore((s) => s.profile);
  const [selected, setSelected] = React.useState(SOURCES[0].id);
  const [audio, setAudio] = React.useState(false);

  const start = () => {
    const src = SOURCES.find((s) => s.id === selected)!;
    updateCall((c) => ({
      ...c,
      screenShare: { byPeerId: profile.id, source: src.label, audio, fps: 30 },
    }));
    onClose();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Share your screen"
      width="max-w-lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={start}>
            Start sharing
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-2">
          {SOURCES.map((s) => (
            <button
              key={s.id}
              onClick={() => setSelected(s.id)}
              className={cn(
                'p-2.5 rounded-card border text-left transition-colors',
                selected === s.id
                  ? 'border-gold/50 bg-gold/10 shadow-glow'
                  : 'border-edge bg-raised hover:border-edge-strong',
              )}
            >
              <div className="h-14 rounded-input bg-base border border-edge mb-2 grid place-items-center">
                <MonitorUp size={16} className="text-muted" />
              </div>
              <div className="text-2xs text-muted">{s.kind}</div>
              <div className="text-xs truncate">{s.label}</div>
            </button>
          ))}
        </div>

        <Toggle
          checked={audio}
          onChange={setAudio}
          label="Share system audio"
          hint="Windows and macOS natively; Linux via PulseAudio"
        />
      </div>
    </Modal>
  );
}
