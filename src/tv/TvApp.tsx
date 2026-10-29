import React from 'react';

import { api, on } from '../lib/bridge';
import { claimArrowKeys } from '../lib/tv';
import { useStore } from '../lib/store';
import type { MediaItem } from '../lib/types';
import { TvLibrary } from './TvLibrary';
import { TvPlayer } from './TvPlayer';
import { UNIT } from './units';

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
 */
export function TvApp() {
  const [items, setItems] = React.useState<MediaItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [playing, setPlaying] = React.useState<MediaItem | null>(null);

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
    const off = on('media:changed', () => void load());
    // A library on another device changes without telling anybody.
    const poll = window.setInterval(() => void load(), 45_000);
    return () => {
      off();
      window.clearInterval(poll);
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

  return (
    <div
      className="cinema fixed inset-0 bg-black text-white overflow-hidden select-none"
      style={{ ['--u' as string]: UNIT, cursor: 'none' }}
    >
      <div className={playing ? 'invisible h-full' : 'h-full'}>
        <TvLibrary items={items} loading={loading} active={!playing} onPlay={setPlaying} />
      </div>
      {playing && (
        <TvPlayer
          key={playing.id}
          item={playing}
          items={items}
          onPlay={setPlaying}
          onClose={() => {
            setPlaying(null);
            // What was watched has a new position now.
            void load();
          }}
        />
      )}
    </div>
  );
}
