/**
 * Crossy Road, drawn as pixel art on a canvas.
 *
 * Everyone hops through the same world at the same time — see `lib/crossy.ts`
 * for why none of it needs sending. What does travel is where each player has
 * got to, a few times a second, so you can see the others racing ahead or
 * being flattened.
 *
 * Drawn rather than assembled from images: every sprite here is a handful of
 * coloured rectangles on a grid, which keeps the whole game one file with no
 * artwork to ship, and gives the chunky look the style wants. Rendering is
 * pixel-snapped and `imageSmoothingEnabled` is off, so nothing turns to mush
 * on a high-density screen.
 */
import React from 'react';
import { Trophy } from 'lucide-react';

import { Badge, Button } from '../../components/ui';
import {
  LANES,
  VIEW_ROWS,
  hop,
  obstaclesAt,
  rowAt,
  settle,
  start,
} from '../../lib/crossy';
import type { Direction, Player } from '../../lib/crossy';
import { api, on } from '../../lib/bridge';
import { useStore } from '../../lib/store';
import { sfx } from '../../lib/audio';
import { GameShell } from './GameShell';
import { useLeaveGuard } from './LeaveGuard';
import { usePlayerNames } from './turns';

/** The palette. Flat colours, no gradients — this is meant to look printed. */
const SKY = '#7EC8E3';
const PALETTE = {
  grass: ['#6ABE4F', '#5CAF45'],
  road: ['#4A4A52', '#42424A'],
  river: ['#3D7DCA', '#3670B8'],
  rail: ['#8A7B6B', '#7E7060'],
  kerb: '#2F2F36',
  log: '#8B5E34',
  train: '#C8453C',
  sleeper: '#5D5347',
};

const CARS = ['#F5A623', '#E05C5C', '#9B8CFF', '#39D9C8', '#F0E68C'];
const PLAYER_COLOURS = ['#F7E14A', '#FF8FB1', '#8FE3A2', '#9BD1FF'];

interface Ghost {
  row: number;
  cell: number;
  best: number;
  alive: boolean;
}

export function Crossy({ onExit }: { onExit: () => void }) {
  const session = useStore((s) => s.gameSession);
  const active = session && session.game === 'crossy' ? session : null;
  const myId = useStore((s) => s.profile.id);

  const players = React.useMemo(() => {
    if (!active) return [myId];
    return Array.from(new Set(active.players.map((p) => (p === 'me' ? myId : p)))).sort();
  }, [active, myId]);
  const names = usePlayerNames(players);

  const seed = active?.seed ?? 1;

  // Everyone measures the world from the same instant, so the same lorry is in
  // the same place on every screen. Playing alone there is no session to take
  // it from, so the moment this mounted stands in — captured unconditionally,
  // because a hook behind a `??` is a hook that sometimes does not run.
  const mountedAt = React.useRef(Date.now());

  /**
   * Time the player was actually here for.
   *
   * `requestAnimationFrame` stops while the app is in the background, but the
   * world is a function of the wall clock — so switching apps for a minute and
   * coming back would drop you in front of a lorry that crossed the screen
   * while you were gone. The time spent away is subtracted instead, so the
   * road resumes where you left it.
   *
   * In a shared game this means your traffic drifts from everyone else's by
   * however long you were away. That is the kinder half of the trade: their
   * hoppers still show where they really are, and you are not killed by a
   * lorry you were never given the chance to see.
   */
  const awayFor = React.useRef(0);
  React.useEffect(() => {
    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.hidden) {
        hiddenAt = Date.now();
      } else if (hiddenAt) {
        awayFor.current += Date.now() - hiddenAt;
        hiddenAt = 0;
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  const startedAt = active?.startedAt ?? mountedAt.current;

  // Leaving a live game asks first, and holds the seat for a minute.
  const leave = useLeaveGuard(onExit, players.length);

  const canvas = React.useRef<HTMLCanvasElement>(null);
  const me = React.useRef<Player>(start());
  const ghosts = React.useRef<Record<string, Ghost>>({});
  const [, forceRender] = React.useReducer((n) => n + 1, 0);
  const [best, setBest] = React.useState(0);
  const [dead, setDead] = React.useState(false);

  /* ------------------------------------------------------------ controls */

  const move = React.useCallback((direction: Direction) => {
    if (!me.current.alive) return;
    me.current = hop(me.current, direction);
    if (direction === 'forward') sfx.cardPlace();
    setBest((b) => Math.max(b, me.current.best));
  }, []);

  React.useEffect(() => {
    const keys: Record<string, Direction> = {
      ArrowUp: 'forward',
      ArrowDown: 'back',
      ArrowLeft: 'left',
      ArrowRight: 'right',
      w: 'forward',
      s: 'back',
      a: 'left',
      d: 'right',
    };
    const onKey = (e: KeyboardEvent) => {
      const direction = keys[e.key];
      if (!direction) return;
      e.preventDefault();
      move(direction);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [move]);

  /* -------------------------------------------------------- the world tick */

  React.useEffect(() => {
    let raf = 0;
    let last = performance.now();

    const frame = (now: number) => {
      const delta = Math.min(0.05, (now - last) / 1000);
      last = now;
      const seconds = (Date.now() - startedAt - awayFor.current) / 1000;

      const before = me.current.alive;
      me.current = settle(me.current, seed, seconds, delta);
      if (before && !me.current.alive) {
        sfx.gameLose();
        setDead(true);
      }

      paint(canvas.current, seed, seconds, me.current, ghosts.current, players, myId);
      raf = requestAnimationFrame(frame);
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [seed, startedAt, players, myId]);

  /* ------------------------------------------------------------- the race */

  React.useEffect(() => {
    if (!active) return;
    // Often enough to look live, rarely enough that a busy Wi-Fi does not care.
    const id = setInterval(() => {
      void api.game
        .move(active.id, {
          row: me.current.row,
          cell: Number(me.current.cell.toFixed(2)),
          best: me.current.best,
          alive: me.current.alive,
        })
        .catch(() => {});
    }, 200);
    return () => clearInterval(id);
  }, [active?.id]);

  React.useEffect(() => {
    return on('game:move', (msg: { sessionId?: string; move?: Ghost; from?: string }) => {
      if (!active || msg.sessionId !== active.id || !msg.from || !msg.move) return;
      ghosts.current[msg.from] = msg.move;
      forceRender();
    });
  }, [active?.id]);

  const restart = () => {
    me.current = start();
    setDead(false);
  };

  const standings = [...players]
    .map((id) => ({
      id,
      best: id === myId ? best : (ghosts.current[id]?.best ?? 0),
      alive: id === myId ? me.current.alive : (ghosts.current[id]?.alive ?? true),
    }))
    .sort((a, b) => b.best - a.best);

  return (
    <>
    <GameShell
      title="Crossy Road"
      themeKey="lantern.crossy.theme"
      onExit={leave.requestExit}
      onRestart={restart}
      moves={best}
      running={!dead}
      status={
        <>
          <Badge tone={dead ? 'muted' : 'cyan'}>{dead ? 'Flattened' : `${best} rows`}</Badge>
          {active && <Badge tone="muted">{players.length} racing</Badge>}
        </>
      }
    >
      {() => (
        <div className="h-full flex flex-col lg:flex-row gap-3 p-3">
          <div className="panel p-3 w-full lg:w-[190px] shrink-0 order-2 lg:order-1">
            <span className="label">Furthest</span>
            <div className="space-y-2 mt-2">
              {standings.map((row, i) => (
                <div key={row.id} className="flex items-center gap-2">
                  <span className="text-2xs text-muted w-3">{i + 1}</span>
                  <span
                    className="h-3 w-3 rounded-sm shrink-0"
                    style={{
                      background:
                        PLAYER_COLOURS[players.indexOf(row.id) % PLAYER_COLOURS.length],
                      opacity: row.alive ? 1 : 0.4,
                    }}
                  />
                  <span className="text-xs truncate flex-1">{names[row.id]}</span>
                  <span className="text-xs font-mono tabular-nums">{row.best}</span>
                  {i === 0 && row.best > 0 && <Trophy size={11} className="text-gold" />}
                </div>
              ))}
            </div>

            {dead && (
              <Button size="sm" full onClick={restart} className="mt-3">
                Go again
              </Button>
            )}

            <p className="text-2xs text-muted leading-relaxed mt-3">
              Arrow keys, or the buttons below. Stay off the road, ride the logs, and never
              stand on the rails.
            </p>
          </div>

          <div className="order-1 lg:order-2 flex-1 min-w-0 flex flex-col items-center justify-center gap-2">
            <canvas
              ref={canvas}
              className="rounded-card border border-edge max-w-full"
              style={{ imageRendering: 'pixelated' }}
            />

            {/* Touch and D-pad. A keyboard is not the only way in. */}
            <div className="grid grid-cols-3 gap-1.5 w-[190px] lg:hidden">
              <span />
              <PadButton label="Forward" onPress={() => move('forward')}>↑</PadButton>
              <span />
              <PadButton label="Left" onPress={() => move('left')}>←</PadButton>
              <PadButton label="Back" onPress={() => move('back')}>↓</PadButton>
              <PadButton label="Right" onPress={() => move('right')}>→</PadButton>
            </div>
          </div>
        </div>
      )}
    </GameShell>
      {leave.dialog}
    </>
  );
}

function PadButton({
  label,
  onPress,
  children,
}: {
  label: string;
  onPress: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      aria-label={label}
      onClick={onPress}
      className="h-12 rounded-input bg-surface border border-edge text-lg active:bg-raised"
    >
      {children}
    </button>
  );
}

/* --------------------------------------------------------------- drawing */

function paint(
  canvas: HTMLCanvasElement | null,
  seed: number,
  seconds: number,
  player: Player,
  ghosts: Record<string, Ghost>,
  players: string[],
  myId: string,
): void {
  if (!canvas) return;

  // A whole number of pixels per cell, so nothing lands on a half pixel.
  const cellSize = 22;
  const width = LANES * cellSize;
  const height = VIEW_ROWS * cellSize;
  const dpr = Math.min(2, window.devicePixelRatio || 1);

  if (canvas.width !== width * dpr) {
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
  }

  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;

  ctx.fillStyle = SKY;
  ctx.fillRect(0, 0, width, height);

  // The player sits a third of the way up, so there is road to read ahead.
  const bottomRow = Math.max(0, player.row - Math.floor(VIEW_ROWS / 3));

  for (let screenRow = 0; screenRow < VIEW_ROWS; screenRow++) {
    const worldRow = bottomRow + screenRow;
    const y = height - (screenRow + 1) * cellSize;
    const row = rowAt(seed, worldRow);

    // The strip itself, banded so successive rows read apart.
    const band = PALETTE[row.kind][worldRow % 2];
    ctx.fillStyle = band;
    ctx.fillRect(0, y, width, cellSize);

    if (row.kind === 'road') {
      // Lane markings.
      ctx.fillStyle = '#6A6A74';
      for (let x = 0; x < width; x += cellSize) ctx.fillRect(x + 6, y + cellSize / 2 - 1, 8, 2);
    }
    if (row.kind === 'rail') {
      ctx.fillStyle = PALETTE.sleeper;
      for (let x = 0; x < width; x += 8) ctx.fillRect(x, y + 4, 4, cellSize - 8);
      ctx.fillStyle = '#B9B2A6';
      ctx.fillRect(0, y + 5, width, 2);
      ctx.fillRect(0, y + cellSize - 7, width, 2);
    }

    // What is moving along it.
    for (const left of obstaclesAt(row, seconds)) {
      const x = Math.round(left * cellSize);
      const w = row.width * cellSize;
      if (x + w < 0 || x > width) continue;

      if (row.kind === 'river') {
        ctx.fillStyle = PALETTE.log;
        ctx.fillRect(x, y + 3, w, cellSize - 6);
        ctx.fillStyle = '#6F4A28';
        ctx.fillRect(x, y + 3, w, 3);
      } else if (row.kind === 'rail') {
        ctx.fillStyle = PALETTE.train;
        ctx.fillRect(x, y + 2, w, cellSize - 4);
        ctx.fillStyle = '#FFF1C9';
        ctx.fillRect(x + w - 6, y + 6, 4, 4);
      } else {
        const colour = CARS[Math.abs(Math.round(left) + worldRow) % CARS.length];
        ctx.fillStyle = colour;
        ctx.fillRect(x + 1, y + 4, w - 2, cellSize - 8);
        // A windscreen, which is what makes it read as a car.
        ctx.fillStyle = 'rgba(255,255,255,0.75)';
        ctx.fillRect(x + (row.speed > 0 ? w - 8 : 3), y + 7, 5, 5);
      }
    }
  }

  const drawHopper = (cell: number, worldRow: number, colour: string, faded: boolean) => {
    const screenRow = worldRow - bottomRow;
    if (screenRow < 0 || screenRow >= VIEW_ROWS) return;
    const x = Math.round(cell * cellSize);
    const y = height - (screenRow + 1) * cellSize;

    ctx.globalAlpha = faded ? 0.45 : 1;
    // A shadow gives it somewhere to stand.
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(x + 3, y + cellSize - 6, cellSize - 6, 4);
    // Body, then a lighter face, then two eyes: the whole sprite.
    ctx.fillStyle = colour;
    ctx.fillRect(x + 3, y + 4, cellSize - 6, cellSize - 8);
    ctx.fillStyle = 'rgba(255,255,255,0.85)';
    ctx.fillRect(x + 5, y + 6, cellSize - 10, 6);
    ctx.fillStyle = '#1A1A1F';
    ctx.fillRect(x + 6, y + 7, 3, 3);
    ctx.fillRect(x + cellSize - 9, y + 7, 3, 3);
    ctx.globalAlpha = 1;
  };

  // Everyone else first, so you are never hidden behind them.
  for (const [id, ghost] of Object.entries(ghosts)) {
    if (id === myId) continue;
    const seat = players.indexOf(id);
    drawHopper(ghost.cell, ghost.row, PLAYER_COLOURS[(seat + 1) % PLAYER_COLOURS.length], true);
  }
  drawHopper(player.cell, player.row, PLAYER_COLOURS[0], !player.alive);
}
