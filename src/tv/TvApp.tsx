import React from 'react';

import { api, on } from '../lib/bridge';
import { claimArrowKeys } from '../lib/tv';
import { useStore } from '../lib/store';
import { useBackDismiss } from '../lib/hooks';
import { emptyOverrides, groupLibrary } from '../lib/collections';
import { mergeOverrides, usePeerOverrides } from '../lib/peerCollections';
import type { MediaItem } from '../lib/types';
import { TvDetail } from './TvDetail';
import { TvDevices } from './TvDevices';
import { TvExitPrompt, useRootBack } from './TvExit';
import { TvGrid } from './TvGrid';
import { TvEmpty, TvHome } from './TvLibrary';
import { TvPlayer } from './TvPlayer';
import { TABS, TAB_STOPS, TvTabs } from './TvTabs';
import { intentOf } from './remote';
import { movieTiles, showTiles, type Tile } from './tvShelves';
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
 * LANTV: a bar of tabs over a page, a page for each title, and the player.
 *
 * No chat, calls, files, games, settings or network screens; none of them can
 * be reached from a remote and none belongs on a television. Anything that
 * would ask for attention - a message, a call, a file, a toast - is turned away
 * where it arrives (see the `isTv()` guards in the store) so there is nothing
 * to draw here for it.
 *
 * Where the cursor is - the bar or the page - is held here; each page handles
 * its own keys while it has it. The player is always full screen and always on
 * top, and the pages stay mounted underneath, so where you were is where you
 * are when the film ends.
 *
 * Back unwinds one thing at a time: the menu, the controls, the film, a
 * title's page, the page back to the bar - and then, rather than leaving the
 * app on the next press, asks. Holding Back asks from anywhere.
 */
export function TvApp() {
  const [items, setItems] = React.useState<MediaItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [settled, setSettled] = React.useState(false);
  const [playing, setPlaying] = React.useState<MediaItem | null>(null);
  const [detail, setDetail] = React.useState<Tile | null>(null);
  const [leaving, setLeaving] = React.useState(false);
  const [stop, setStop] = React.useState(0);
  const [zone, setZone] = React.useState<'tabs' | 'page'>('page');
  const [busy, setBusy] = React.useState(false);
  const peers = useStore((s) => s.peers);

  const tab = TABS[Math.min(stop, TABS.length - 1)].id;

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

  // A title's page closes first; then the page gives the cursor back to the bar.
  useBackDismiss(!!detail, () => setDetail(null));
  useBackDismiss(zone === 'page' && !detail, () => setZone('tabs'));

  const peerList = React.useMemo(() => Object.values(peers), [peers]);
  const devices = React.useMemo(() => peerList.map((p) => p.name).filter(Boolean), [peerList]);

  const peerOverrides = usePeerOverrides();
  const grouping = React.useMemo(
    () => groupLibrary(items, mergeOverrides(peerOverrides, emptyOverrides())),
    [items, peerOverrides],
  );
  const movies = React.useMemo(() => movieTiles(grouping), [grouping]);
  const shows = React.useMemo(() => showTiles(grouping), [grouping]);

  const rescan = React.useCallback(async () => {
    if (busy) return;
    setBusy(true);
    // Never shorter than a moment, or a refresh that answers at once looks like a
    // press that did nothing.
    const minimum = new Promise((done) => window.setTimeout(done, 700));
    try {
      await Promise.all([
        (async () => {
          // Ask every device again, then read what came back.
          await api.net.refresh().catch(() => undefined);
          await api.media.scan().catch(() => undefined);
          await load();
        })(),
        minimum,
      ]);
    } finally {
      setBusy(false);
    }
  }, [busy, load]);
  const rescanRef = React.useRef(rescan);
  rescanRef.current = rescan;

  const open = React.useCallback((t: Tile) => setDetail(t), []);
  const up = React.useCallback(() => setZone('tabs'), []);

  const barActive = zone === 'tabs' && !detail && !playing && !leaving;
  const pageActive = zone === 'page' && !detail && !playing && !leaving;
  const empty = !items.length;

  // The bar's keys. Moving across it changes the page at once.
  const bar = React.useRef({ stop, barActive, pageActive, empty });
  bar.current = { stop, barActive, pageActive, empty };
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const b = bar.current;
      const intent = intentOf(e);
      if (!intent || intent === 'back') return;
      if (b.barActive) {
        e.preventDefault();
        e.stopPropagation();
        if (intent === 'left') setStop(Math.max(0, b.stop - 1));
        else if (intent === 'right') setStop(Math.min(TAB_STOPS - 1, b.stop + 1));
        else if (intent === 'down') setZone('page');
        else if (intent === 'ok' && b.stop === TABS.length) void rescanRef.current();
        return;
      }
      // Nothing to show: Refresh is all there is on the page.
      if (b.pageActive && b.empty) {
        e.preventDefault();
        e.stopPropagation();
        if (intent === 'ok') void rescanRef.current();
        else if (intent === 'up') setZone('tabs');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const searching = loading || (!settled && empty);

  return (
    <div
      className="cinema tv-apple fixed inset-0 bg-black text-white overflow-hidden select-none"
      style={{ ['--u' as string]: UNIT, cursor: 'none' }}
    >
      <div className={playing ? 'invisible h-full' : 'h-full'}>
        <div className="relative h-full">
          <div key={tab} className="tv-fade-in h-full">
            {empty && tab !== 'devices' ? (
              <TvEmpty loading={searching} busy={busy} devices={devices} focused={pageActive} />
            ) : tab === 'home' ? (
              <TvHome items={items} grouping={grouping} active={pageActive} onPlay={setPlaying} onOpen={open} onUp={up} />
            ) : tab === 'movies' ? (
              <TvGrid heading="Movies" tiles={movies} empty="No films yet." active={pageActive} onOpen={open} onUp={up} />
            ) : tab === 'shows' ? (
              <TvGrid heading="Shows" tiles={shows} empty="No series yet." active={pageActive} onOpen={open} onUp={up} />
            ) : (
              <TvDevices
                peers={peerList}
                items={items}
                active={pageActive}
                busy={busy}
                onRefresh={() => void rescan()}
                onUp={up}
              />
            )}
          </div>

          {!detail && (
            <TvTabs current={tab} stop={stop} focused={barActive} busy={busy} deviceCount={peerList.length} />
          )}
        </div>

        {detail && <TvDetail key={detail.key} tile={detail} active={!playing && !leaving} onPlay={setPlaying} />}
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
