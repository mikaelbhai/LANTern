import React from 'react';

import { useMirrorShow } from '../lib/mirror';
import { useArmedBack } from './TvExit';
import { intentOf } from './remote';
import { u } from './units';

/**
 * A phone asking to show its screen here, and the screen once it does.
 *
 * The question is asked on the television because it is the television's screen
 * that is being taken over. A phone this person has vouched for is let straight
 * in (see initMirror); anybody else is asked, with OK to allow and Back to refuse.
 *
 * While a phone is showing, its picture is a native surface behind this page
 * (MirrorReceiver.kt), so the page goes see-through and keeps only a corner label
 * that fades, and the one key that matters: Back stops it.
 */
export function TvMirror() {
  const offer = useMirrorShow((s) => s.offer);
  const showing = useMirrorShow((s) => s.showing);
  if (offer) return <Prompt name={offer.name} />;
  if (showing) return <Showing name={showing.name} live={showing.live} />;
  return null;
}

function Prompt({ name }: { name: string }) {
  const [at, setAt] = React.useState<0 | 1>(0);
  const focus = React.useRef(at);
  focus.current = at;
  const { accept, decline } = useMirrorShow.getState();

  useArmedBack(decline, false);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const intent = intentOf(e);
      if (!intent) return;
      e.preventDefault();
      e.stopPropagation();
      if (intent === 'left' || intent === 'up') setAt(0);
      else if (intent === 'right' || intent === 'down') setAt(1);
      else if (intent === 'ok') (focus.current === 0 ? accept : decline)();
      else if (intent === 'back') decline();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [accept, decline]);

  const button = (label: string, index: 0 | 1, run: () => void) => (
    <div
      onMouseEnter={() => setAt(index)}
      onClick={run}
      className={
        at === index
          ? 'rounded-2xl font-bold bg-white text-black ring-4 ring-white/40 cursor-pointer'
          : 'rounded-2xl font-bold bg-white/10 text-white/80 cursor-pointer'
      }
      style={{ fontSize: u(2.4), padding: `${u(1.4)} ${u(5)}`, minWidth: u(16), textAlign: 'center' }}
    >
      {label}
    </div>
  );

  return (
    <div className="absolute inset-0 z-[70] grid place-items-center bg-black/85" role="alertdialog" aria-label="Show a phone's screen?">
      <div className="text-center" style={{ maxWidth: u(80) }}>
        <div className="font-bold" style={{ fontSize: u(4.2) }}>
          Show {name}&rsquo;s screen?
        </div>
        <div className="text-white/60" style={{ fontSize: u(2), marginTop: u(1.2) }}>
          Everything on that phone&rsquo;s screen, and its sound, will play here.
        </div>
        <div className="flex justify-center" style={{ gap: u(3), marginTop: u(4) }}>
          {button('Allow', 0, accept)}
          {button('No', 1, decline)}
        </div>
        <div className="text-white/40" style={{ fontSize: u(1.5), marginTop: u(3) }}>
          OK chooses · Back says no
        </div>
      </div>
    </div>
  );
}

function Showing({ name, live }: { name: string; live: boolean }) {
  const stop = useMirrorShow.getState().stop;
  const [hint, setHint] = React.useState(true);

  useArmedBack(stop, false);

  // The picture is behind the page: everything in front has to let it through.
  React.useEffect(() => {
    document.documentElement.classList.add('tv-native-video');
    return () => document.documentElement.classList.remove('tv-native-video');
  }, []);

  // The label is shown when the picture arrives and on any key, then gets out of the way.
  React.useEffect(() => {
    if (!live) return;
    setHint(true);
    const id = window.setTimeout(() => setHint(false), 4000);
    return () => window.clearTimeout(id);
  }, [live]);

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const intent = intentOf(e);
      if (!intent) return;
      e.preventDefault();
      e.stopPropagation();
      if (intent === 'back') stop();
      else setHint(true);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [stop]);

  return (
    <div className="absolute inset-0 z-[70] pointer-events-none">
      {!live && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="text-center text-white/80" style={{ fontSize: u(2.6) }}>
            Waiting for {name}&hellip;
            <div className="text-white/45" style={{ fontSize: u(1.7), marginTop: u(1) }}>
              Allow screen capture on the phone · Back cancels
            </div>
          </div>
        </div>
      )}
      <div
        className={`absolute rounded-full bg-black/60 text-white transition-opacity duration-500 ${live && hint ? 'opacity-100' : 'opacity-0'}`}
        style={{ top: u(3), right: u(4), fontSize: u(1.7), padding: `${u(0.8)} ${u(2)}` }}
      >
        {name}&rsquo;s screen · Back to stop
      </div>
    </div>
  );
}
