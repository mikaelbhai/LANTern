/**
 * Home: the house, in one list.
 *
 * What used to be here was a bar of network facts across the top — the LAN,
 * the gateway, the upstream guess, the NAT shape and the relay state — above
 * a grid of one card per device. Five facts nobody is looking for, on the
 * screen where they are looking for a person. What that bar was actually for,
 * saying when something is wrong, is now the strip under the title bar, which
 * appears only then; the rest is still on the Network screen, which is where
 * you go when you want it.
 *
 * So this is a search field and a list, and nothing else. Every row is
 * somebody or something you can open, the newest thing about them is on the
 * row, and the one button on the screen starts a conversation.
 */
import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  MessageSquare,
  MessageSquarePlus,
  Phone,
  Send,
  Crown,
  Network as NetIcon,
  Users,
  Activity as ActivityIcon,
  RefreshCw,
  Search,
} from 'lucide-react';
import { Household } from './home/Household';
import { Button, Empty, IconButton, Input } from '../components/ui';
import { api } from '../lib/bridge';
import { useStore } from '../lib/store';
import { relativeTime } from '../lib/utils';
import { useNow } from '../lib/hooks';
import type { Screen } from '../lib/nav';
import { PullToRefresh } from '../components/PullToRefresh';

export function Home({ onNavigate }: { onNavigate: (s: Screen) => void }) {
  const peers = useStore((s) => s.peers);
  const rooms = useStore((s) => s.rooms);
  const openRoom = useStore((s) => s.openRoom);
  const toast = useStore((s) => s.toast);
  const [refreshing, setRefreshing] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const field = React.useRef<HTMLInputElement>(null);

  const empty = Object.keys(peers).length === 0 && Object.keys(rooms).length === 0;

  /*
   * The magnifier in the title bar, arriving as an event.
   *
   * The field lives here rather than in the header because it belongs to
   * this list, and the header is on every screen. Focus is a moment, not a
   * state: a store flag would have to be cleared again afterwards, and every
   * path that forgot to clear it would trap the keyboard open.
   */
  React.useEffect(() => {
    const focus = () => field.current?.focus();
    window.addEventListener('lantern:search', focus);
    return () => window.removeEventListener('lantern:search', focus);
  }, []);

  /**
   * Announce again and re-dial everything we know.
   *
   * Discovery is mDNS, and multicast is the first thing a busy or unfriendly
   * network drops. Without this the only remedy for a stale peer list was to
   * wait, or restart the app.
   */
  const refresh = async () => {
    if (refreshing) return;
    setRefreshing(true);
    try {
      const known = await api.net.refresh();
      toast({
        kind: 'info',
        title: known ? `${known} device${known === 1 ? '' : 's'} known` : 'No devices found yet',
        body: known ? 'Re-announced and re-dialled.' : 'Still listening — nothing has answered.',
      });
    } catch {
      toast({ kind: 'error', title: 'Refresh failed' });
    } finally {
      // Long enough that the spin reads as an action rather than a flicker.
      setTimeout(() => setRefreshing(false), 600);
    }
  };

  return (
    <div className="h-full flex flex-col">
      {/* One field for the whole house: people, what they are playing, and
          what is on their shelves. */}
      <div className="shrink-0 px-4 py-2.5">
        <Input
          ref={field}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search people, films, files"
          icon={<Search size={15} />}
          className="h-11 rounded-full bg-raised border-transparent pl-10 text-sm"
        />
      </div>

      <div className="flex-1 min-h-0 flex">
        <div className="flex-1 min-w-0 relative">
          <PullToRefresh className="h-full" onRefresh={refresh}>
            {/*
              A row per person, their devices underneath, sleepers and shared
              rooms included. This was a card per device, which is what the
              network reports and not what anybody thinks: one person with a
              phone, a laptop and a television appeared three times under the
              same name. See home/Household.tsx.
            */}
            <Household onNavigate={onNavigate} query={query} />

            {/* Room for the button to float over. Without it the last row in
                the house sits underneath the one control on the screen and
                cannot be reached. */}
            <div className="h-20" aria-hidden />

            {empty && (
              <Empty
                icon={<NetIcon size={20} />}
                title="Listening for peers…"
                hint="LANTern is broadcasting over mDNS. If a device is on another subnet, add it from the Network panel."
                action={
                  <div className="flex gap-2">
                    <Button variant="primary" onClick={refresh} disabled={refreshing}>
                      {refreshing ? 'Looking…' : 'Look again'}
                    </Button>
                    <Button variant="ghost" onClick={() => onNavigate('network')}>
                      Open Network panel
                    </Button>
                  </div>
                }
              />
            )}

            {/*
              A phone pulls the list down to look again. A mouse has nothing
              to pull, so the same action sits at the foot of the list on a
              wide window — where it is also out of the way of the list
              itself, which is what anybody came here for.
            */}
            {!empty && (
              <div className="hidden lg:flex items-center justify-center gap-2 py-4">
                <IconButton label="Look for peers now" size="xs" onClick={refresh}>
                  <RefreshCw size={11} className={refreshing ? 'animate-spin text-gold' : undefined} />
                </IconButton>
                <span className="text-2xs text-muted">
                  {Object.keys(peers).length} device
                  {Object.keys(peers).length === 1 ? '' : 's'} on the network
                </span>
              </div>
            )}
          </PullToRefresh>

          {/*
            The one thing you can start from this screen, on a phone.

            Not on a wide window: there the sidebar carries Chats permanently,
            so a floating button is a second door to the same room - and it
            landed on top of the refresh line at the foot of the list.
          */}
          <button
            onClick={() => {
              openRoom(null);
              onNavigate('chats');
            }}
            aria-label="New conversation"
            className="lg:hidden absolute bottom-5 right-5 h-14 w-14 rounded-full bg-gold text-on-gold grid place-items-center shadow-lg active:scale-95 transition-transform"
          >
            <MessageSquarePlus size={22} />
          </button>
        </div>

        <ActivityFeed />
      </div>
    </div>
  );
}

function ActivityFeed() {
  const activity = useStore((s) => s.activity);
  const peers = useStore((s) => s.peers);
  const now = useNow(20_000);

  const iconFor = (kind: string) =>
    ({
      transfer: <Send size={12} />,
      call: <Phone size={12} />,
      message: <MessageSquare size={12} />,
      peer: <Users size={12} />,
      game: <Crown size={12} />,
    })[kind] ?? <ActivityIcon size={12} />;

  return (
    <aside className="w-[264px] shrink-0 border-l border-edge bg-surface/50 hidden lg:flex flex-col">
      <div className="h-11 px-4 flex items-center border-b border-edge shrink-0">
        <span className="label">Activity</span>
      </div>
      <div className="flex-1 scroll-y">
        {activity.length === 0 ? (
          <Empty
            icon={<ActivityIcon size={18} />}
            title="Nothing yet"
            hint="Transfers, calls and peers joining show up here."
          />
        ) : (
          <ul className="p-2 space-y-1">
            <AnimatePresence initial={false}>
              {activity.slice(0, 60).map((a) => (
                <motion.li
                  key={a.id}
                  layout
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="flex gap-2.5 px-2 py-2 rounded-input hover:bg-raised/60"
                >
                  <span className="text-muted mt-[3px] shrink-0">{iconFor(a.kind)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-xs text-txt leading-snug">{a.text}</span>
                    <span className="block text-2xs text-muted mt-0.5">
                      {relativeTime(a.ts, now)}
                      {a.peerId && peers[a.peerId] ? ` · ${peers[a.peerId].name}` : ''}
                    </span>
                  </span>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        )}
      </div>
    </aside>
  );
}
