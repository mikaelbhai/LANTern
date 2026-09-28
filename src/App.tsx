import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { Flashlight, MoreVertical, Search, Settings as SettingsIcon, X } from 'lucide-react';
import { MobileTabBar, NAV_ITEMS, Sidebar } from './components/Sidebar';
import { Onboarding } from './components/Onboarding';
import { Toasts } from './components/Toasts';
import { SystemPromptHost } from './components/SystemPrompt';
import { ControlConsent } from './components/ControlConsent';
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
import { HeaderSlot } from './components/ScreenHeader';
import { useBackDismiss } from './lib/hooks';
import { pushLayer } from './lib/backstack';
import { enableDpadNavigation, focusFirst, isTv } from './lib/tv';
import { IncomingFile } from './components/IncomingFile';
import { IncomingGame } from './components/IncomingGame';
import { NetworkStrip } from './components/NetworkStrip';
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

  /**
   * Which screen is showing.
   *
   * In the store rather than here, because things that are not screens have
   * to move between them - accepting a game invitation has to open the game.
   */
  const screen = useStore((s) => s.screen);
  const activeRoomId = useStore((s) => s.activeRoomId);
  const navigate = useStore((s) => s.navigate);
  const goBack = useStore((s) => s.goBack);
  const openRoom = useStore((s) => s.openRoom);

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
      /*
       * A television is always dark.
       *
       * Nothing forced it, so a panel reporting `prefers-color-scheme: light`
       * - which Android TV does - lit a whole living room wall white, and
       * took the d-pad focus outline with it: that outline is drawn in the
       * accent, and the accent in light mode is darkened for a white page,
       * which on a dark poster is very close to invisible. A TV has no
       * Settings screen to correct it from either, since a remote is not a
       * keyboard and that branch shows only Theatre and Games.
       */
      const dark =
        tv ||
        settings.theme === 'dark' ||
        (settings.theme === 'system' &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);
      root.classList.toggle('dark', dark);
      root.classList.toggle('light', !dark);

      /*
       * The accent moves with the theme, and has to be set here.
       *
       * It is an inline style on the root, so it beats the `html.light`
       * palette in index.css - which carries a darker gold that nothing was
       * ever reaching. #F5A623 on a near-white page is 1.9:1, so every piece
       * of accent-coloured text in light mode was unreadable.
       *
       * In this function rather than beside the other typography settings
       * because the system can change the mode underneath us, and only this
       * listener hears about it.
       */
      const rgb = hexToRgb(settings.accent, !dark);
      if (rgb) root.style.setProperty('--c-gold', rgb);
      // The same colour undarkened, for the surfaces that are dark whatever
      // the mode is - the cinema, the call overlay, the player. Darkening it
      // for a white page and then painting it on black gave Theatre a green
      // that was almost invisible against its own background.
      const bright = hexToRgb(settings.accent, false);
      if (bright) root.style.setProperty('--c-accent-bright', bright);
    };
    apply();
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    mql.addEventListener('change', apply);
    return () => mql.removeEventListener('change', apply);
  }, [settings.theme, settings.accent, tv]);

  React.useEffect(() => {
    const root = document.documentElement;
    root.dataset.density = settings.density;
    root.dataset.font = settings.fontSize;
  }, [settings.density, settings.fontSize]);

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
  /*
   * Back walks the trail one screen at a time, then Home, then out of the
   * app. It used to jump straight to Home from anywhere, so two steps in lost
   * both of them — and coming back from Settings to the chat you were reading
   * meant navigating there again by hand.
   *
   * A single `useBackDismiss(open, ...)` very nearly does this, but `open` is
   * a boolean and stays `true` for the entire time you are away from Home —
   * so it fires `pushLayer` once on the way in and never again, no matter how
   * many screens deep the trail goes. One history entry then covers however
   * many `goBack()`s are actually needed, so the first hardware back press
   * works and every press after it - still mid-trail - finds no history left
   * to intercept and quits the app instead. This keeps one layer pushed per
   * trail entry instead, added and removed as the trail grows and shrinks by
   * any means: a hardware back press, or a Back button inside a screen
   * calling `goBack()` directly.
   */
  const trailLength = useStore((s) => s.screenTrail.length);
  const depth = trailLength > 0 ? trailLength : screen !== 'home' ? 1 : 0;
  const backLayers = React.useRef<Array<() => void>>([]);
  React.useEffect(() => {
    while (backLayers.current.length < depth) {
      backLayers.current.push(pushLayer(() => goBack()));
    }
    while (backLayers.current.length > depth) {
      backLayers.current.pop()?.();
    }
  }, [depth]);
  useBackDismiss(drawerOpen, () => setDrawerOpen(false));
  /*
   * A room open inside Chats is its own step, on top of the trail above -
   * opening one never changes `screen` (still "chats"), so the trail-depth
   * layers above have no idea a room is open at all. Registered after them
   * so it pushes on top and is popped first: back closes the room and
   * lands on the room list, the same list a second press would have to
   * walk through anyway, before a third press leaves Chats. Without this a
   * single press skipped straight from an open conversation to Home,
   * verified live on a phone - the room list never appeared in between.
   */
  useBackDismiss(isMobile && screen === 'chats' && !!activeRoomId, () => openRoom(null));

  const go = React.useCallback(
    (s: Screen) => {
      navigate(s);
      setDrawerOpen(false);
      const active = useStore.getState().call;
      if (active && active.state !== 'ringing' && !active.pip) {
        useStore.getState().updateCall((c) => ({ ...c, pip: true }));
      }
    },
    [navigate],
  );

  if (!onboarded) return <Onboarding />;

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
      /*
        The cinema palette, for the same reason Theatre has it on a phone:
        this branch IS Theatre and Games, and it returns before the shell
        column that would otherwise apply it. Without this the bar carrying
        the two buttons was `bg-surface` against Theatre's own near-black -
        a lighter strip across the top of a dark room.
      */
      <div className="cinema h-full w-full flex flex-col bg-base text-txt overflow-hidden">
        <div className="shrink-0 flex items-center gap-3 px-4 py-2 border-b border-edge">
          <button
            onClick={() => navigate('theatre')}
            className={cn(
              'px-4 py-1.5 rounded-input text-sm font-medium transition-colors',
              screen === 'games' ? 'text-dim hover:text-txt' : 'bg-gold/15 text-gold',
            )}
          >
            Theatre
          </button>
          <button
            onClick={() => navigate('games')}
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
        {/*
          The four things a television needs that are not screens.

          Leaving these out was not a decision about televisions; they simply
          live at the bottom of the other branch and this one returns before
          reaching them. Each absence was its own fault:

          Toasts are how the application says anything went wrong, so without
          them a TV failed in complete silence - no unreachable peer, no
          library that could not be read, nothing.

          A call arrives on any device that is on the network, whether or not
          it can start one. With no overlay it rang with nothing on screen and
          no way to answer or refuse, and - worse - the call stayed set, so
          every later call was turned away as busy until the app restarted. A
          television is exactly the device somebody calls to say come and
          watch this.

          A file offered to a TV could not be accepted, which is the obvious
          way to get a video onto one.

          And the primer, because a call on a TV still asks for a microphone.
        */}
        {call && <CallOverlay />}
        <IncomingFile />
        <IncomingGame />
        <SystemPromptHost />
        <ControlConsent />
        <Toasts />
      </div>
    );
  }

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

  return (
    <div className="h-full w-full flex bg-base text-txt overflow-hidden">
      {!isMobile && (
        <Sidebar screen={screen} onNavigate={go} onOpenProfile={() => setProfileOpen(true)} />
      )}

      {/*
        Theatre darkens everything around it.

        A cinema screen between a white title bar and a white tab bar read as
        a block pasted in by mistake rather than as a decision. The class
        redeclares the palette for this column, so the bar above and the tabs
        below follow the screen and the sidebar - which is navigation, not
        the room - does not. See `.cinema` in index.css.
      */}
      <div className={cn('flex-1 min-w-0 flex flex-col', screen === 'theatre' && 'cinema bg-base')}>
        {/*
          An open conversation brings its own bar - back, who you are talking
          to, and whether they are here - so the app bar stands down rather
          than stacking a second one on top of it. Two bars and a composer
          left a phone about four messages of room.
        */}
        {isMobile && !(screen === 'chats' && activeRoomId) && (
          <MobileHeader
            screen={screen}
            onMenu={() => setDrawerOpen(true)}
            onNavigate={go}
          />
        )}

        {/* The network, when it has something to say. Silent otherwise, and
            it yields to a call, which wants the same strip of screen. */}
        <NetworkStrip onNavigate={go} />

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

        {/* Same room-open exception as the header above: a conversation
            already has a back arrow of its own, and the tab bar below it was
            costing the same "four messages of room" the header comment
            describes - just at the other edge of the screen instead of the
            top. */}
        {isMobile && !(screen === 'chats' && activeRoomId) && (
          <MobileTabBar screen={screen} onNavigate={go} />
        )}

      {/* Follows you across screens: a file offer should not wait behind one. */}
      <IncomingFile />
      <IncomingGame />
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
      {/* Above the call overlay in the tree, because the microphone prompt it
          explains is the one that happens on the way into a call. */}
      <SystemPromptHost />
      <ControlConsent />
      <Toasts />
    </div>
  );
}

/**
 * One bar for the whole phone: the product, a way to search it, and a menu.
 *
 * It used to be a hamburger, the name of the screen you were already looking
 * at, and your own avatar. None of the three was worth a tap - the screen
 * announces itself by the tab that is lit, and nobody opens their own profile
 * from the top of every screen. What was missing was search, which is the
 * first thing anybody reaches for in a list of people.
 *
 * The search button does not open a screen. Home already carries the field;
 * this focuses it, and from anywhere else it goes to Home and focuses it
 * there. An event rather than a store field because focus is a moment, not
 * a state, and a state would have to be cleared again afterwards.
 */
function MobileHeader({
  screen,
  onMenu,
  onNavigate,
}: {
  screen: Screen;
  onMenu: () => void;
  onNavigate: (s: Screen) => void;
}) {
  const home = screen === 'home';

  const search = () => {
    if (!home) onNavigate('home');
    // After the screen has mounted, or the field it is meant to focus does
    // not exist yet.
    setTimeout(() => window.dispatchEvent(new CustomEvent('lantern:search')), 0);
  };

  return (
    <header className="safe-t shrink-0 bg-surface">
      {/* The status-bar inset is padding on the header, and the row keeps its
          own height inside it. Putting both on one fixed-height element made
          the title slide out from under its own bar. */}
      <div className="h-14 flex items-center pl-4 pr-1 gap-1">
        {/* The product on the screen you land on, the screen's name
            everywhere else. Naming the screen you are already looking at was
            worth nothing on Home, where the tab is lit underneath it; it is
            worth having on the six screens that are two taps deep. */}
        <span className="flex-1 min-w-0 text-lg font-semibold tracking-tight text-txt truncate select-none">
          {home ? 'LANTern' : SCREEN_TITLES[screen]}
        </span>

        {/* Where each screen puts its own buttons. See ScreenHeader.tsx. */}
        <HeaderSlot />

        {home && (
          <IconButton label="Search" onClick={search}>
            <Search size={19} />
          </IconButton>
        )}
        <IconButton label="More" onClick={onMenu}>
          <MoreVertical size={19} />
        </IconButton>
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

/**
 * The accent as space-separated channels, darkened for a light page.
 *
 * Accents are chosen against the dark theme, where a bright gold reads well.
 * The same colour on a near-white page fails contrast badly, so on light it
 * is taken down until it is legible as text. Lightness rather than
 * saturation, so the colour somebody chose is still the colour they see.
 */
function hexToRgb(hex: string, forLight = false): string | null {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex.trim());
  if (!m) return null;
  let [r, g, b] = [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];

  if (forLight) {
    // Scaled towards black until the relative luminance clears the point
    // where 4.5:1 against the light base becomes reachable. Iterative
    // because the curve is not linear and one fixed factor is wrong for
    // both a yellow and a blue.
    for (let i = 0; i < 24 && luminance(r, g, b) > 0.18; i++) {
      r = Math.round(r * 0.92);
      g = Math.round(g * 0.92);
      b = Math.round(b * 0.92);
    }
  }
  return `${r} ${g} ${b}`;
}

function luminance(r: number, g: number, b: number): number {
  const channel = (v: number) => {
    const n = v / 255;
    return n <= 0.03928 ? n / 12.92 : Math.pow((n + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}
