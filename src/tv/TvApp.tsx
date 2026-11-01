import React from 'react';

import { api, on } from '../lib/bridge';
import { claimArrowKeys } from '../lib/tv';
import { useStore } from '../lib/store';
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

  /*
   * Back is one handler, armed once, that works out what it means when it is
   * pressed: a title's page closes, then the page gives the cursor back to the
   * bar, then - with nothing left - it asks.
   *
   * It used to be a layer for each of those, pushed and released as the cursor
   * moved between the bar and a page. Each release rewinds the browser's
   * history asynchronously, so quick presses left the history a step out of
   * line with the stack - and the next Back went straight through the question
   * and out of the app, which is the whole app then loading again from nothing.
   */
  const where = React.useRef({ detail, zone, playing });
  where.current = { detail, zone, playing };
  useRootBack(() => {
    const w = where.current;
    if (w.detail) setDetail(null);
    else if (w.zone === 'page') setZone('tabs');
    else setLeaving(true);
  });
  React.useEffect(() => on('tv:backhold', () => setLeaving(true)), []);

  /*
   * A mouse.
   *
   * A television is driven by a remote and has no pointer, so the cursor was
   * hidden and nothing answered a click. A mouse plugged in is now another way
   * of pressing the same buttons: moving it shows the cursor (and hides it again
   * when it rests), hovering a card or button puts the cursor there, a click is
   * OK, the wheel is Up and Down, and the right button is Back.
   *
   * The wheel and the right button do not know about any page: they press the
   * key the remote would, so every page already handles them.
   */
  const [pointer, setPointer] = React.useState(false);
  React.useEffect(() => {
    let idle: number | undefined;
    let lastWheel = 0;
    const key = (name: string, code: number) =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: name, keyCode: code, bubbles: true, cancelable: true }),
      );
    const move = () => {
      setPointer(true);
      window.clearTimeout(idle);
      idle = window.setTimeout(() => setPointer(false), 4000);
    };
    const wheel = (e: WheelEvent) => {
      // A film has no list to scroll, and a menu inside it has its own rows.
      if (where.current.playing || Math.abs(e.deltaY) < 4) return;
      const now = Date.now();
      if (now - lastWheel < 140) return;
      lastWheel = now;
      key(e.deltaY > 0 ? 'ArrowDown' : 'ArrowUp', e.deltaY > 0 ? 40 : 38);
    };
    const context = (e: MouseEvent) => {
      e.preventDefault();
      history.back();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('wheel', wheel, { passive: true });
    window.addEventListener('contextmenu', context);
    return () => {
      window.clearTimeout(idle);
      window.removeEventListener('mousemove', move);
      window.removeEventListener('wheel', wheel);
      window.removeEventListener('contextmenu', context);
    };
  }, []);

  /*
   * Only the devices that are hosting, right now.
   *
   * A television has nothing to do with a phone's chat or a laptop that is only
   * browsing: what it wants to know about the network is who it can watch from.
   * So the list - and the count in the bar - is the devices that are serving a
   * library at this moment, or serving with nobody signed in, and nothing is
   * kept about the rest.
   */
  const peerList = React.useMemo(() => {
    const serving = new Set<string>();
    for (const i of items) if (i.peerId) serving.add(i.peerId);
    return Object.values(peers).filter(
      (p) => p.hostOnly || serving.has(p.id) || serving.has(p.deviceId),
    );
  }, [peers, items]);
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
      style={{ ['--u' as string]: UNIT, cursor: pointer ? 'default' : 'none' }}
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
            <TvTabs
              current={tab}
              stop={stop}
              focused={barActive}
              busy={busy}
              deviceCount={peerList.length}
              onPointer={(s, kind) => {
                if (playing || leaving) return;
                setStop(s);
                setZone('tabs');
                if (kind === 'click') {
                  if (s === TABS.length) void rescanRef.current();
                  else setZone('page');
                }
              }}
            />
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
            // Back from a film lands on the library, not on the page that was
            // opened to start it.
            setDetail(null);
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
