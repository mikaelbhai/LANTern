import React from 'react';
import { motion } from 'framer-motion';
import {
  Home,
  MessageSquare,
  Phone,
  FolderOpen,
  Film,
  Gamepad2,
  Flashlight,
  Settings as SettingsIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Moon,
} from 'lucide-react';
import { LanternMark, Wordmark } from './Logo';
import { Avatar } from './Avatar';
import { Tooltip } from './ui';
import { useStore } from '../lib/store';
import { cn, formatDuration } from '../lib/utils';
import type { Screen } from '../lib/nav';

export const NAV_ITEMS: {
  id: Screen;
  label: string;
  icon: React.ElementType;
}[] = [
  { id: 'home', label: 'Home', icon: Home },
  { id: 'chats', label: 'Chats', icon: MessageSquare },
  { id: 'calls', label: 'Calls', icon: Phone },
  { id: 'files', label: 'Files', icon: FolderOpen },
  { id: 'theatre', label: 'Theatre', icon: Film },
  { id: 'games', label: 'Games', icon: Gamepad2 },
  { id: 'network', label: 'Network', icon: Flashlight },
];

export function Sidebar({
  screen,
  onNavigate,
  onOpenProfile,
}: {
  screen: Screen;
  onNavigate: (s: Screen) => void;
  onOpenProfile: () => void;
}) {
  const collapsed = useStore((s) => s.settings.sidebarCollapsed);
  const setSettings = useStore((s) => s.setSettings);
  const profile = useStore((s) => s.profile);
  const rooms = useStore((s) => s.rooms);
  const activity = useStore((s) => s.activity);
  const dnd = useStore((s) => s.settings.notifications.dnd);
  const activeGame = useStore((s) => s.activeGame);
  const peers = useStore((s) => s.peers);

  const unread = Object.values(rooms).reduce((n, r) => n + r.unread, 0);
  const [pulse, setPulse] = React.useState(false);
  const lastActivity = activity[0]?.id;

  React.useEffect(() => {
    if (!lastActivity) return;
    setPulse(true);
    const t = setTimeout(() => setPulse(false), 2400);
    return () => clearTimeout(t);
  }, [lastActivity]);

  const width = collapsed ? 60 : 208;

  return (
    <motion.aside
      animate={{ width }}
      transition={{ type: 'spring', stiffness: 200, damping: 24 }}
      className="h-full bg-surface border-r border-edge flex flex-col shrink-0 overflow-hidden"
    >
      <div
        className={cn(
          'h-14 flex items-center shrink-0 border-b border-edge drag-region',
          collapsed ? 'justify-center px-2' : 'px-3.5',
        )}
      >
        {collapsed ? (
          <LanternMark size={22} pulse={pulse} />
        ) : (
          <Wordmark size="md" pulse={pulse} />
        )}
      </div>

      <button
        onClick={onOpenProfile}
        aria-label="Your profile"
        className={cn(
          'flex items-center gap-2.5 border-b border-edge hover:bg-raised/60 transition-colors shrink-0',
          collapsed ? 'justify-center h-14 px-2' : 'h-14 px-3.5',
        )}
      >
        <Avatar
          name={profile.name || 'You'}
          color={profile.color}
          emoji={profile.emoji}
          size={collapsed ? 26 : 30}
          status={dnd ? 'dnd' : 'available'}
        />
        {!collapsed && (
          <span className="min-w-0 text-left flex-1">
            <span className="block text-xs font-medium truncate">
              {profile.name || 'Set your name'}
            </span>
            <span className="flex items-center gap-1 text-2xs text-muted truncate">
              {dnd && <Moon size={9} className="shrink-0" />}
              {profile.statusMessage || `${Object.keys(peers).length} peers online`}
            </span>
          </span>
        )}
      </button>

      <ActiveCallChip collapsed={collapsed} />

      <nav className="flex-1 py-2 px-2 space-y-0.5 scroll-y no-scrollbar">
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          const on = screen === item.id;
          const badge = item.id === 'chats' && unread > 0 ? unread : null;
          const dot = item.id === 'games' && activeGame;

          const button = (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              aria-label={item.label}
              aria-current={on ? 'page' : undefined}
              className={cn(
                'relative w-full flex items-center rounded-input transition-colors group',
                collapsed ? 'justify-center h-9' : 'h-9 px-2.5 gap-2.5',
                on ? 'text-gold' : 'text-dim hover:text-txt hover:bg-raised/70',
              )}
            >
              {on && (
                <motion.span
                  layoutId="nav-active"
                  className="absolute inset-0 bg-gold/10 border border-gold/30 rounded-input shadow-glow"
                  transition={{ type: 'spring', stiffness: 260, damping: 26 }}
                />
              )}
              <span className="relative z-10 flex items-center gap-2.5 w-full">
                <Icon size={16} className="shrink-0" />
                {!collapsed && <span className="text-xs font-medium">{item.label}</span>}
                {!collapsed && badge && (
                  <span className="ml-auto min-w-[17px] h-[17px] px-1 grid place-items-center rounded-full bg-gold text-[#1a1206] text-[10px] font-bold">
                    {badge > 99 ? '99+' : badge}
                  </span>
                )}
                {!collapsed && dot && (
                  <span className="ml-auto h-1.5 w-1.5 rounded-full bg-[#9B8CFF]" />
                )}
              </span>
              {collapsed && badge && (
                <span className="absolute top-1 right-1 h-1.5 w-1.5 rounded-full bg-gold" />
              )}
            </button>
          );

          return collapsed ? (
            <Tooltip key={item.id} content={item.label} side="right" delay={200}>
              {button}
            </Tooltip>
          ) : (
            button
          );
        })}
      </nav>

      <div className="p-2 border-t border-edge space-y-0.5 shrink-0">
        {(() => {
          const on = screen === 'settings';
          const btn = (
            <button
              onClick={() => onNavigate('settings')}
              aria-label="Settings"
              aria-current={on ? 'page' : undefined}
              className={cn(
                'relative w-full flex items-center rounded-input transition-colors',
                collapsed ? 'justify-center h-9' : 'h-9 px-2.5 gap-2.5',
                on ? 'text-gold bg-gold/10 border border-gold/30' : 'text-dim hover:text-txt hover:bg-raised/70',
              )}
            >
              <SettingsIcon size={16} />
              {!collapsed && <span className="text-xs font-medium">Settings</span>}
            </button>
          );
          return collapsed ? (
            <Tooltip content="Settings" side="right" delay={200}>
              {btn}
            </Tooltip>
          ) : (
            btn
          );
        })()}

        <button
          onClick={() => setSettings((s) => ({ ...s, sidebarCollapsed: !s.sidebarCollapsed }))}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className={cn(
            'w-full flex items-center rounded-input text-muted hover:text-txt hover:bg-raised/70 transition-colors',
            collapsed ? 'justify-center h-8' : 'h-8 px-2.5 gap-2.5',
          )}
        >
          {collapsed ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
          {!collapsed && <span className="text-2xs">Collapse</span>}
        </button>
      </div>
    </motion.aside>
  );
}

/** Always-visible reminder that a call is live, and the way back into it. */
function ActiveCallChip({ collapsed }: { collapsed: boolean }) {
  const call = useStore((s) => s.call);
  const updateCall = useStore((s) => s.updateCall);
  const [elapsed, setElapsed] = React.useState(0);

  React.useEffect(() => {
    if (!call || call.state === 'ringing') return;
    const tick = () => setElapsed(Date.now() - call.startedAt);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [call?.id, call?.startedAt, call?.state]);

  if (!call || call.state === 'ringing' || !call.pip) return null;

  const body = (
    <button
      onClick={() => updateCall((c) => ({ ...c, pip: false }))}
      className={cn(
        'w-full flex items-center gap-2 bg-cyan/10 border border-cyan/40 rounded-input',
        'hover:bg-cyan/[0.16] transition-colors',
        collapsed ? 'justify-center h-9' : 'h-9 px-2.5',
      )}
    >
      <span className="relative flex h-2 w-2 shrink-0">
        <span className="absolute inline-flex h-full w-full rounded-full bg-cyan opacity-60 animate-ping" />
        <span className="relative inline-flex h-2 w-2 rounded-full bg-cyan" />
      </span>
      {!collapsed && (
        <>
          <span className="text-2xs text-cyan font-medium">On a call</span>
          <span className="ml-auto text-2xs font-mono text-cyan tabular-nums">
            {formatDuration(elapsed)}
          </span>
        </>
      )}
    </button>
  );

  return (
    <div className="px-2 pt-2 shrink-0">
      {collapsed ? (
        <Tooltip content={`On a call · ${formatDuration(elapsed)}`} side="right" delay={200}>
          {body}
        </Tooltip>
      ) : (
        body
      )}
    </div>
  );
}

export function MobileTabBar({
  screen,
  onNavigate,
}: {
  screen: Screen;
  onNavigate: (s: Screen) => void;
}) {
  const rooms = useStore((s) => s.rooms);
  const unread = Object.values(rooms).reduce((n, r) => n + r.unread, 0);
  const items = NAV_ITEMS.slice(0, 5);

  return (
    // The gesture-bar inset is padding on the bar; the row keeps its own
    // height inside it. Putting both on one fixed-height element subtracted
    // the inset from the row, squashing the icons and letting the system
    // gesture bar sit on top of the labels.
    <nav className="shrink-0 safe-b bg-surface border-t border-edge">
      <div className="h-14 flex items-stretch">
      {items.map((item) => {
        const Icon = item.icon;
        const on = screen === item.id;
        return (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            aria-label={item.label}
            aria-current={on ? 'page' : undefined}
            className={cn(
              'flex-1 flex flex-col items-center justify-center gap-1 relative transition-colors',
              on ? 'text-gold' : 'text-muted',
            )}
          >
            {on && (
              <motion.span
                layoutId="tab-active"
                className="absolute top-0 h-[2px] w-8 bg-gold rounded-full shadow-glow"
              />
            )}
            <span className="relative">
              <Icon size={19} />
              {item.id === 'chats' && unread > 0 && (
                <span className="absolute -top-1 -right-1.5 min-w-[15px] h-[15px] px-1 grid place-items-center rounded-full bg-gold text-[#1a1206] text-[9px] font-bold">
                  {unread > 9 ? '9+' : unread}
                </span>
              )}
            </span>
            <span className="text-[10px] font-medium">{item.label}</span>
          </button>
        );
      })}
      </div>
    </nav>
  );
}
