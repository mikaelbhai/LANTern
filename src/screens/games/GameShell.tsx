import React from 'react';
import { motion } from 'framer-motion';
import { ArrowLeft, Palette, RotateCcw, Undo2 } from 'lucide-react';
import { Badge, Button, IconButton, Modal, Tooltip } from '../../components/ui';
import { CARD_THEMES, type CardTheme, type CardThemeId, getTheme } from '../../lib/cards';
import { useLocalStorage } from '../../lib/hooks';
import { cn, formatDuration } from '../../lib/utils';

/** Header, timer and theme picker shared by the four solitaire games. */
export function GameShell({
  title,
  themeKey,
  onExit,
  onUndo,
  canUndo,
  onRestart,
  moves,
  running,
  extraControls,
  status,
  children,
  standings,
  onThemeChange,
}: {
  title: string;
  themeKey: string;
  onExit: () => void;
  onUndo?: () => void;
  canUndo?: boolean;
  /**
   * Optional: in a hosted game only the host may deal again, so everyone else
   * has no restart to offer.
   */
  onRestart?: () => void;
  moves: number;
  running: boolean;
  extraControls?: React.ReactNode;
  status?: React.ReactNode;
  children: (theme: CardTheme) => React.ReactNode;
  /**
   * Live standings, when this game is being raced.
   *
   * Passed in rather than rendered by each game so the layout is decided once:
   * beside the board on a wide screen, above it on a narrow one, and absent
   * entirely when playing alone.
   */
  standings?: React.ReactNode;
  onThemeChange?: (t: CardThemeId) => void;
}) {
  const [themeId, setThemeId] = useLocalStorage<CardThemeId>(themeKey, 'classic');
  const [elapsed, setElapsed] = React.useState(0);
  const [themeOpen, setThemeOpen] = React.useState(false);
  const startedAt = React.useRef(Date.now());

  React.useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setElapsed(Date.now() - startedAt.current), 500);
    return () => clearInterval(id);
  }, [running]);

  const resetTimer = () => {
    startedAt.current = Date.now();
    setElapsed(0);
  };

  const theme = getTheme(themeId);

  return (
    <div className="h-full flex flex-col min-h-0">
      <header className="h-11 shrink-0 border-b border-edge bg-surface flex items-center px-3 gap-2 overflow-x-auto no-scrollbar">
        <IconButton label="Back to games" size="sm" onClick={onExit}>
          <ArrowLeft size={15} />
        </IconButton>
        <span className="text-sm font-semibold shrink-0">{title}</span>

        <div className="flex items-center gap-1.5 ml-2 shrink-0">
          <Tooltip content="Elapsed time">
            <Badge tone="muted">{formatDuration(elapsed)}</Badge>
          </Tooltip>
          <Tooltip content="Moves made">
            <Badge tone="muted">{moves} moves</Badge>
          </Tooltip>
          {status}
        </div>

        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {extraControls}
          {onUndo && (
            <Button size="xs" icon={<Undo2 size={11} />} disabled={!canUndo} onClick={onUndo}>
              Undo
            </Button>
          )}
          {/* Absent in a hosted game unless this device is the one dealing. */}
          {onRestart && (
          <Button
            size="xs"
            icon={<RotateCcw size={11} />}
            onClick={() => {
              onRestart();
              resetTimer();
            }}
          >
            New
          </Button>
          )}
          <IconButton label="Card theme" size="sm" onClick={() => setThemeOpen(true)}>
            <Palette size={14} />
          </IconButton>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-auto">
        {standings ? (
          <div className="flex flex-col lg:flex-row gap-3 p-3 h-full">
            {standings}
            <div className="flex-1 min-w-0">{children(theme)}</div>
          </div>
        ) : (
          children(theme)
        )}
      </div>

      <Modal open={themeOpen} onClose={() => setThemeOpen(false)} title="Card theme">
        <div className="grid grid-cols-5 gap-2">
          {CARD_THEMES.map((t) => (
            <button
              key={t.id}
              onClick={() => {
                setThemeId(t.id);
                onThemeChange?.(t.id);
              }}
              className={cn(
                'p-2 rounded-card border transition-all',
                themeId === t.id
                  ? 'border-gold/60 bg-gold/10 shadow-glow'
                  : 'border-edge bg-raised hover:border-edge-strong',
              )}
            >
              <div className="flex justify-center gap-0.5 mb-1.5">
                <span
                  className="h-9 w-6 rounded-[3px]"
                  style={{ background: t.face, border: `1px solid ${t.faceBorder}` }}
                />
                <span
                  className="h-9 w-6 rounded-[3px]"
                  style={{ background: t.back, border: `1px solid ${t.faceBorder}` }}
                />
              </div>
              <span className="text-[10px] text-dim block text-center">{t.name}</span>
            </button>
          ))}
        </div>
      </Modal>
    </div>
  );
}

/** Cards cascading off screen, then a burst — shown when a game is won. */
export function WinCelebration({
  open,
  title,
  detail,
  onNewGame,
  onExit,
  theme,
}: {
  open: boolean;
  title: string;
  detail: React.ReactNode;
  onNewGame: () => void;
  onExit: () => void;
  theme: CardTheme;
}) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[90] pointer-events-none">
      {Array.from({ length: 26 }, (_, i) => (
        <motion.span
          key={i}
          initial={{
            x: `${10 + (i % 7) * 12}vw`,
            y: '35vh',
            rotate: 0,
            opacity: 1,
          }}
          animate={{
            x: `${-20 + Math.random() * 140}vw`,
            y: '110vh',
            rotate: 360 * (Math.random() > 0.5 ? 1 : -1),
          }}
          transition={{
            duration: 1.8 + Math.random() * 1.6,
            delay: i * 0.06,
            ease: 'easeIn',
          }}
          className="absolute h-12 w-9 rounded-[4px]"
          style={{
            background: i % 2 ? theme.face : theme.back,
            border: `1px solid ${theme.faceBorder}`,
          }}
        />
      ))}

      {Array.from({ length: 18 }, (_, i) => (
        <motion.span
          key={`spark-${i}`}
          initial={{ scale: 0, opacity: 1, x: '50vw', y: '40vh' }}
          animate={{
            scale: 1,
            opacity: 0,
            x: `calc(50vw + ${Math.cos((i / 18) * Math.PI * 2) * 220}px)`,
            y: `calc(40vh + ${Math.sin((i / 18) * Math.PI * 2) * 220}px)`,
          }}
          transition={{ duration: 1.1, delay: 0.35 + (i % 6) * 0.08 }}
          className="absolute h-2 w-2 rounded-full bg-gold"
          style={{ boxShadow: '0 0 12px rgba(245,166,35,0.9)' }}
        />
      ))}

      <div className="absolute inset-0 grid place-items-center pointer-events-auto">
        <motion.div
          initial={{ scale: 0.9, opacity: 0, y: 12 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          transition={{ delay: 0.5, type: 'spring', stiffness: 200, damping: 22 }}
          className="panel p-6 text-center max-w-xs glass"
        >
          <div className="text-xl font-semibold text-gold mb-1">{title}</div>
          <div className="text-xs text-dim mb-4">{detail}</div>
          <div className="flex gap-2 justify-center">
            <Button onClick={onExit}>Leave</Button>
            <Button variant="primary" onClick={onNewGame}>
              Play again
            </Button>
          </div>
        </motion.div>
      </div>
    </div>
  );
}
