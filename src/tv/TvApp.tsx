import React from 'react';

import { api, on } from '../lib/bridge';
import { claimArrowKeys } from '../lib/tv';
import { useStore } from '../lib/store';
import type { MediaItem } from '../lib/types';
import { TvExitPrompt, useRootBack } from './TvExit';
import { TvLibrary } from './TvLibrary';
import { TvPlayer } from './TvPlayer';
import { UNIT } from './units';

/**
 * How long to keep saying "looking" before saying "nothing".
 *
 * Other devices announce themselves over the network, and a television that
 * has just started has heard from none of them for the first few seconds; a
 * screen that said "nothing published" in that gap told the viewer something
 * that was not true yet, and then replaced it with the shelf a moment later.
 */
const LOOK_FOR_MS = 20_000;

/**
 * LANTV: the shelf and the player, and nothing else.
 *
 * No chat, calls, files, games, settings or network screens; none of them can
 * be reached from a remote and none belongs on a television. Anything that
 * would ask for attention - a message, a call, a file, a toast - is turned away
 * where it arrives (see the `isTv()` guards in the store) so there is nothing
 * to draw here for it.
 *
 * The player is always full screen and always on top of the shelf. The shelf
 * stays mounted underneath, so where you were in it is where you are when the
 * film ends.
 *
 * Back unwinds one thing at a time: the menu, the controls, the film, the
 * episode list - and then, rather than leaving the app on the next press, asks.
 * Holding Back asks from anywhere.
 */
export function TvApp() {
  const [items, setItems] = React.useState<MediaItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [settled, setSettled] = React.useState(false);
  const [playing, setPlaying] = React.useState<MediaItem | null>(null);
  const [leaving, setLeaving] = React.useState(false);
  const peers = useStore((s) => s.peers);

  const load = React.useCallback(async () => {
    try {
      const list = (await api.media.list()) ?? [];
      // What the host has not cleared for this device is not listed at all:
      // there is nobody here to ask, and a padlock on a remote is a dead end.
      setItems(list.filter((i) => !i.locked));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
    // Several events arrive together while devices are being found - one per
    // device, and again as each library is read - and each used to rebuild every
    // shelf from scratch. One rebuild once they have gone quiet is the same
    // result without the stutter, which on a television's processor was the
    // difference between a screen that appears and a screen that hangs.
    let pending: number | undefined;
    const soon = () => {
      window.clearTimeout(pending);
      pending = window.setTimeout(() => void load(), 250);
    };
    const off = on('media:changed', soon);
    // A library on another device changes without telling anybody.
    const poll = window.setInterval(() => void load(), 45_000);
    const settle = window.setTimeout(() => setSettled(true), LOOK_FOR_MS);
    return () => {
      off();
      window.clearTimeout(pending);
      window.clearInterval(poll);
      window.clearTimeout(settle);
    };
  }, [load]);

  // The arrow keys are this app's, not the browser's.
  React.useEffect(() => claimArrowKeys(), []);

  // A television has no name to give. It is announced as one so other devices
  // can see it is there.
  React.useEffect(() => {
    const s = useStore.getState();
    if (!s.onboarded) s.completeOnboarding({ name: 'LANTV' });
  }, []);

  // Back at the bottom of everything, and Back held down anywhere.
  useRootBack(() => setLeaving(true));
  React.useEffect(() => on('tv:backhold', () => setLeaving(true)), []);

  const devices = React.useMemo(
    () => Object.values(peers).map((p) => p.name).filter(Boolean),
    [peers],
  );

  return (
    <div
      className="cinema fixed inset-0 bg-black text-white overflow-hidden select-none"
      style={{ ['--u' as string]: UNIT, cursor: 'none' }}
    >
      <div className={playing ? 'invisible h-full' : 'h-full'}>
        <TvLibrary
          items={items}
          loading={loading || (!settled && items.length === 0)}
          devices={devices}
          active={!playing && !leaving}
          onPlay={setPlaying}
          onRescan={async () => {
            // Ask every device again, then read what came back.
            await api.net.refresh().catch(() => undefined);
            await api.media.scan().catch(() => undefined);
            await load();
          }}
        />
      </div>
      {playing && (
        <TvPlayer
          key={playing.id}
          item={playing}
          items={items}
          suspended={leaving}
          onPlay={setPlaying}
          onClose={() => {
            setPlaying(null);
            // What was watched has a new position now.
            void load();
          }}
        />
      )}
      {leaving && (
        <TvExitPrompt
          onStay={() => setLeaving(false)}
          onLeave={() => {
            setLeaving(false);
            void api.pip.exitApp();
          }}
        />
      )}
    </div>
  );
}
