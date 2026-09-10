import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Menu, Flashlight, Settings as SettingsIcon, X } from 'lucide-react';
import { MobileTabBar, NAV_ITEMS, Sidebar } from './components/Sidebar';
import { Onboarding } from './components/Onboarding';
import { Toasts } from './components/Toasts';
import { Wordmark } from './components/Logo';
import { Avatar } from './components/Avatar';
import { IconButton } from './components/ui';
import { ProfileModal } from './screens/ProfileModal';
import { Home } from './screens/Home';
import { Chats } from './screens/Chats';
import { Calls } from './screens/Calls';
import { Files } from './screens/Files';
import { Theatre } from './screens/Theatre';
import { Games } from './screens/Games';
import { Network } from './screens/Network';
import { Settings } from './screens/Settings';
import { CallOverlay } from './screens/call/CallOverlay';
import { useStore } from './lib/store';
import { startBridge } from './lib/bridge';
import { setSoundEnabled } from './lib/audio';
import { prepareCallAlerts } from './lib/ringer';
import { useIsMobile } from './lib/hooks';
import { SCREEN_TITLES, type Screen } from './lib/nav';
import { cn } from './lib/utils';
import { useBackDismiss } from './lib/hooks';
import { enableDpadNavigation, focusFirst, isTv } from './lib/tv';
import { IncomingFile } from './components/IncomingFile';
import { useHud } from './lib/useHud';
import { RejoinBanner } from './screens/games/LeaveGuard';

export default function App() {
  const onboarded = useStore((s) => s.onboarded);
  const init = useStore((s) => s.init);
  const settings = useStore((s) => s.settings);
  const call = useStore((s) => s.call);
  const isMobile = useIsMobile();

  // Drives the popup in the corner of the screen while this window is out of
  // sight. Does nothing on a phone, and nothing while the window is up.
  useHud();

  const [screen, setScreen] = React.useState<Screen>('home');

  /**
   * Television mode.
   *
   * Decided once at startup: a device does not stop being a TV, and
   * re-evaluating it on a resize would swap the whole shell out when a video
   * goes fullscreen.
   */
  const [tv] = React.useState(isTv);

  React.useEffect(() => {
    if (!tv) return;
    // The arrows only become navigation on a device whose only input is a
    // four-way pad; anywhere else they belong to the focused control.
    document.documentElement.dataset.tv = 'true';
    const stop = enableDpadNavigation();
    // After the first render has produced something to land on.
    const settle = window.setTimeout(focusFirst, 400);
    return () => {
      window.clearTimeout(settle);
      stop();
    };
  }, [tv]);
  const [profileOpen, setProfileOpen] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);

  React.useEffect(() => {
    // The store is initialised even if the native services fail to come up, so
    // a backend problem shows as an app with no peers rather than a blank window.
    startBridge()
      .catch((err) => console.error('LANTern: bridge failed to start', err))
      .finally(() => void init());
  }, [init]);

  // Theme + typography live on <html> so CSS variables cascade everywhere.
  React.useEffect(() => {
    const root = document.documentElement;
    const apply = () => {
      const dark =
        settings.theme === 'dark' ||
        (settings.theme === 'system' &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);
      root.classList.toggle('dark', dark);
      root.classList.toggle('light', !dark);
    };
    apply();
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    mql.addEventListener('change', apply);
    return () => mql.removeEventListener('change', apply);
  }, [settings.theme]);

  React.useEffect(() => {
    const root = document.documentElement;
    root.dataset.density = settings.density;
    root.dataset.font = settings.fontSize;
    const rgb = hexToRgb(settings.accent);
    if (rgb) root.style.setProperty('--c-gold', rgb);
  }, [settings.density, settings.fontSize, settings.accent]);

  React.useEffect(() => {
    setSoundEnabled(settings.notifications.sound && !settings.notifications.dnd);
  }, [settings.notifications.sound, settings.notifications.dnd]);

  // Ask for notification permission at startup rather than when a call
  // arrives. On Android 13+ the request is a system dialog, and a call is
  // precisely the moment the app is likely to be backgrounded and unable to
  // show one — leaving the first call silent.
  React.useEffect(() => {
    if (!settings.notifications.call) return;
    void prepareCallAlerts();
  }, [settings.notifications.call]);

  // Navigating during a call minimises it rather than blocking the app — the
  // session keeps running in the floating window.
  // Back from any screen returns Home before it leaves the app, which is what
  // the gesture means on Android. From Home itself there is nothing left to
  // pop, so the press falls through and the app exits — correct behaviour.
  useBackDismiss(screen !== 'home', () => setScreen('home'));
  useBackDismiss(drawerOpen, () => setDrawerOpen(false));

  const go = React.useCallback(
    (s: Screen) => {
      setScreen(s);
      setDrawerOpen(false);
      const active = useStore.getState().call;
      if (active && active.state !== 'ringing' && !active.pip) {
        useStore.getState().updateCall((c) => ({ ...c, pip: true }));
      }
    },
    [],
  );

  if (!onboarded) return <Onboarding />;

  const screens: Record<Screen, React.ReactNode> = {
    home: <Home onNavigate={go} />,
    chats: <Chats />,
    calls: <Calls />,
    files: <Files />,
    theatre: <Theatre />,
    games: <Games />,
    network: <Network />,
    settings: <Settings />,
  };

  if (tv) {
    /*
      Theatre and Games, and nothing else.

      Chats, Files and Settings all want a keyboard that a remote control is
      not. Games do not: every one of them is a grid you move around with a
      pad and select with a button, which is exactly what a television has.
      Leaving them off meant a room full of people around a TV could watch
      something together but not play anything together, which is a strange
      thing for this application to be unable to do.

      Two buttons rather than a sidebar: a rail the pad has to cross on the way
      to everything is a tax on every single press.
    */
    return (
      <div className="h-full w-full flex flex-col bg-base text-txt overflow-hidden">
        <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-edge">
          <button
            onClick={() => setScreen('theatre')}
            className={cn(
              'px-4 py-1.5 rounded-input text-sm font-medium transition-colors',
              screen === 'games' ? 'text-dim hover:text-txt' : 'bg-gold/15 text-gold',
            )}
          >
            Theatre
          </button>
          <button
            onClick={() => setScreen('games')}
            className={cn(
              'px-4 py-1.5 rounded-input text-sm font-medium transition-colors',
              screen === 'games' ? 'bg-gold/15 text-gold' : 'text-dim hover:text-txt',
            )}
          >
            Games
          </button>
        </div>
        <div className="flex-1 min-h-0">{screen === 'games' ? <Games /> : <Theatre />}</div>
        <RejoinBanner />
      </div>
    );
  }

  return (
    <div className="h-full w-full flex bg-base text-txt overflow-hidden">
      {!isMobile && (
        <Sidebar screen={screen} onNavigate={go} onOpenProfile={() => setProfileOpen(true)} />
      )}

      <div className="flex-1 min-w-0 flex flex-col">
        {isMobile && (
          <MobileHeader
            screen={screen}
            onMenu={() => setDrawerOpen(true)}
            onProfile={() => setProfileOpen(true)}
          />
        )}

        {/*
          Screens are rendered plainly, with no entrance animation. Anything
          JS-driven here (AnimatePresence, a motion fade) only progresses while
          the window is painting, so an occluded or minimised window could leave
          a screen stuck invisible or half-swapped. Correctness beats a 140ms
          fade; animation inside screens is unaffected.
        */}
        <main className="flex-1 min-h-0 relative">
          <div key={screen} className="absolute inset-0">
            {screens[screen]}
          </div>
        </main>

        {isMobile && <MobileTabBar screen={screen} onNavigate={go} />}

      {/* Follows you across screens: a file offer should not wait behind one. */}
      <IncomingFile />
      <RejoinBanner />
      </div>

      {isMobile && (
        <MobileDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          screen={screen}
          onNavigate={go}
        />
      )}

      {call && <CallOverlay />}
      <ProfileModal open={profileOpen} onClose={() => setProfileOpen(false)} />
      <Toasts />
    </div>
  );
}

function MobileHeader({
  screen,
  onMenu,
  onProfile,
}: {
  screen: Screen;
  onMenu: () => void;
  onProfile: () => void;
}) {
  const profile = useStore((s) => s.profile);
  return (
    <header className="safe-t shrink-0 bg-surface border-b border-edge">
      {/* The status-bar inset is padding on the header, and the row keeps its
          own height inside it. Putting both on one fixed-height element made
          the title slide out from under its own bar. */}
      <div className="h-14 flex items-center px-3 gap-2">
      <IconButton label="Menu" onClick={onMenu}>
        <Menu size={18} />
      </IconButton>
      <span className="text-sm font-semibold flex-1">{SCREEN_TITLES[screen]}</span>
      <button onClick={onProfile} aria-label="Profile">
        <Avatar
          name={profile.name}
          color={profile.color}
          emoji={profile.emoji}
          size={28}
        />
      </button>
      </div>
    </header>
  );
}

function MobileDrawer({
  open,
  onClose,
  screen,
  onNavigate,
}: {
  open: boolean;
  onClose: () => void;
  screen: Screen;
  onNavigate: (s: Screen) => void;
}) {
  const extras = [
    { id: 'network' as Screen, label: 'Network', icon: Flashlight },
    { id: 'settings' as Screen, label: 'Settings', icon: SettingsIcon },
  ];

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[110] scrim"
          onMouseDown={(e) => e.target === e.currentTarget && onClose()}
        >
          <motion.div
            initial={{ x: -260 }}
            animate={{ x: 0 }}
            exit={{ x: -260 }}
            transition={{ type: 'spring', stiffness: 240, damping: 26 }}
            className="h-full w-[248px] bg-surface border-r border-edge flex flex-col safe-t"
          >
            <div className="h-14 flex items-center justify-between px-3.5 border-b border-edge">
              <Wordmark size="sm" />
              <IconButton label="Close" size="sm" onClick={onClose}>
                <X size={15} />
              </IconButton>
            </div>
            <nav className="p-2 space-y-0.5">
              {[...NAV_ITEMS, ...extras.filter((e) => !NAV_ITEMS.some((n) => n.id === e.id))].map(
                (item) => {
                  const Icon = item.icon;
                  const on = screen === item.id;
                  return (
                    <button
                      key={item.id}
                      onClick={() => onNavigate(item.id)}
                      className={cn(
                        'w-full h-11 px-3 flex items-center gap-3 rounded-input transition-colors',
                        on
                          ? 'bg-gold/10 border border-gold/30 text-gold'
                          : 'text-dim hover:bg-raised',
                      )}
                    >
                      <Icon size={17} />
                      <span className="text-sm font-medium">{item.label}</span>
                    </button>
                  );
                },
              )}
            </nav>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function hexToRgb(hex: string): string | null {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
  if (!m) return null;
  return `${parseInt(m[1], 16)} ${parseInt(m[2], 16)} ${parseInt(m[3], 16)}`;
}
