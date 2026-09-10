import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  MessageSquare,
  Phone,
  Video,
  Send,
  Crown,
  Wifi,
  Network as NetIcon,
  Router,
  Repeat,
  Users,
  Activity as ActivityIcon,
  RefreshCw,
  ArrowUp,
} from 'lucide-react';
import { Avatar } from '../components/Avatar';
import { DeviceTag } from '../components/PeerName';
import { ConnBadge, NatBadge, ScopeBadge, latencyTone } from '../components/ConnBadge';
import { Badge, Button, Empty, IconButton, SectionTitle, Tooltip } from '../components/ui';
import { api } from '../lib/bridge';
import { useStore } from '../lib/store';
import { callPeer, challengePeer, openDm, sendFilesToPeer } from '../lib/actions';
import { pickFilesToSend } from '../lib/picker';
import { useNativeFileDrop } from '../lib/hooks';
import { osGlyph, osLabel, relativeTime } from '../lib/utils';
import { useNow } from '../lib/hooks';
import type { Screen } from '../lib/nav';
import type { Peer } from '../lib/types';
import { PullToRefresh } from '../components/PullToRefresh';

export function Home({ onNavigate }: { onNavigate: (s: Screen) => void }) {
  const peers = useStore((s) => s.peers);
  const list = Object.values(peers).sort((a, b) => a.name.localeCompare(b.name));
  const toast = useStore((s) => s.toast);
  const [refreshing, setRefreshing] = React.useState(false);

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
      <NetworkHealthBar onNavigate={onNavigate} />

      <div className="flex-1 min-h-0 flex">
        <PullToRefresh className="flex-1 min-w-0" onRefresh={refresh}>
        <div className="p-4">
          <SectionTitle
            right={
              <div className="flex items-center gap-2">
                <Badge tone={list.length ? 'cyan' : 'muted'}>
                  <Users size={9} />
                  {list.length} online
                </Badge>
                <IconButton label="Look for peers now" size="xs" onClick={refresh}>
                  <RefreshCw
                    size={11}
                    className={refreshing ? 'animate-spin text-gold' : undefined}
                  />
                </IconButton>
              </div>
            }
          >
            Peers on the network
          </SectionTitle>

          {list.length === 0 ? (
            <div className="panel">
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
            </div>
          ) : (
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(248px,1fr))]">
              <AnimatePresence>
                {list.map((p) => (
                  <PeerCard key={p.id} peer={p} onNavigate={onNavigate} />
                ))}
              </AnimatePresence>
            </div>
          )}
        </div>
        </PullToRefresh>

        <ActivityFeed />
      </div>
    </div>
  );
}

function NetworkHealthBar({ onNavigate }: { onNavigate: (s: Screen) => void }) {
  const net = useStore((s) => s.net);
  const peers = useStore((s) => s.peers);
  const relayed = Object.values(peers).filter((p) => p.layer === 'relayed').length;

  if (!net) {
    return <div className="h-11 shrink-0 border-b border-edge bg-surface animate-pulse" />;
  }

  // The network above this one, when there is one. A router whose WAN address
  // is itself private is sitting behind another router — that upper network is
  // where "the LAN above" lives, and it is the difference between a peer being
  // unreachable and being reachable through a forwarded port.
  const up = net.upstream;
  const hasUpstream = !!up && up.wanIsPrivate;

  // Real interfaces only. Link-local addresses are what Windows assigns to an
  // adapter that never got a lease — showing 169.254.x.x as a LAN would list
  // disconnected hardware as if it were a network.
  const lans = (net.interfaces ?? []).filter(
    (i) => !!i.cidr && !i.ip.startsWith('169.254.'),
  );

  return (
    <div className="h-11 shrink-0 border-b border-edge bg-surface flex items-center gap-4 px-4 overflow-x-auto no-scrollbar">
      {/*
        One chip per interface, not one for the machine. A device with Ethernet
        and Wi-Fi is on two LANs at once, and which one a peer is reachable on
        is the difference between a direct hop and no route at all.
      */}
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="label">{lans.length > 1 ? 'LANs' : 'LAN'}</span>
        {lans.map((iface) => (
          <Tooltip
            key={iface.name + iface.ip}
            content={`${iface.name} — this device is ${iface.ip} on ${iface.cidr}`}
          >
            <Badge tone="cyan">
              {iface.kind === 'wifi' ? <Wifi size={9} /> : <NetIcon size={9} />}
              {iface.cidr}
            </Badge>
          </Tooltip>
        ))}
        {lans.length === 0 && <Badge tone="muted">No network</Badge>}
      </div>
      <Stat icon={<Router size={12} />} label="Gateway" value={net.gateway} mono />

      {hasUpstream && (
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="label">LAN above</span>
          <Tooltip
            content={
              up!.wanConfirmed
                ? `Your router's address up there is ${up!.routerWanIp}. Devices on that network can reach this one only through a forwarded port.`
                : 'Estimated from your gateway — the router has not answered a UPnP query, so this network has not been confirmed.'
            }
          >
            <Badge tone={up!.wanConfirmed ? 'gold' : 'muted'}>
              <ArrowUp size={9} />
              {up!.subnet || up!.routerWanIp}
              {!up!.wanConfirmed && ' ?'}
            </Badge>
          </Tooltip>
        </div>
      )}

      <div className="flex items-center gap-1.5 shrink-0">
        <span className="label">NAT</span>
        <NatBadge nat={net.nat} />
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <span className="label">Relay</span>
        <Badge tone={net.relayHub ? 'gold' : 'muted'}>
          <Repeat size={9} />
          {net.relayHub ? 'Hub on' : relayed ? `${relayed} via hub` : 'Off'}
        </Badge>
      </div>
      <Button
        size="xs"
        variant="ghost"
        className="ml-auto shrink-0"
        onClick={() => onNavigate('network')}
      >
        Diagnostics
      </Button>
    </div>
  );
}

/** True when two addresses share a network under `mask`. */
function sameNetwork(a: string, b: string, mask: string): boolean {
  const oct = (v: string) => v.split('.').map(Number);
  const [x, y, m] = [oct(a), oct(b), oct(mask)];
  if ([x, y, m].some((p) => p.length !== 4 || p.some(isNaN))) return false;
  return x.every((o, i) => (o & m[i]) === (y[i] & m[i]));
}

/** Turns an address and mask into the network it sits on. */
function cidrOf(ip: string, mask: string): string {
  const a = ip.split('.').map(Number);
  const m = mask.split('.').map(Number);
  if (a.length !== 4 || m.length !== 4 || a.some(isNaN) || m.some(isNaN)) return ip;
  const bits = m.reduce((n, o) => n + ((o >>> 0).toString(2).match(/1/g)?.length ?? 0), 0);
  return `${a.map((o, i) => o & m[i]).join('.')}/${bits}`;
}

function Stat({
  icon,
  label,
  value,
  mono,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <span className="text-muted">{icon}</span>
      <span className="label">{label}</span>
      <span className={`text-xs text-txt ${mono ? 'font-mono' : ''}`}>{value}</span>
    </div>
  );
}

function PeerCard({ peer, onNavigate }: { peer: Peer; onNavigate: (s: Screen) => void }) {
  const cardRef = React.useRef<HTMLDivElement>(null);
  const [htmlDragOver, setHtmlDragOver] = React.useState(false);

  // A native drop carries real paths; an HTML one does not, and the server
  // opens files by path. Under Tauri this is the only drop that can work.
  const nativeDragOver = useNativeFileDrop(cardRef, (paths) => {
    void sendFilesToPeer(peer.id, paths);
  });
  const dragOver = htmlDragOver || nativeDragOver;
  const setDragOver = setHtmlDragOver;

  // The network this peer sits on, and whether it is ours. Computed from our
  // own mask: a peer on 192.168.1.x when we are on 192.168.100.x is a
  // different LAN, however similar the two addresses look.
  const net = useStore((s) => s.net);

  // Which of our own interfaces can actually reach this peer. Each is tested
  // with its own mask, so an interface on a /16 is not judged by a /24.
  const via = (net?.interfaces ?? []).find(
    (i) => !!i.cidr && sameNetwork(i.ip, peer.ip, i.mask),
  );
  const peerLan = via?.cidr ?? (net?.subnet ? cidrOf(peer.ip, net.subnet) : peer.ip);

  const chooseFiles = async () => {
    const picked = await pickFilesToSend();
    const paths = picked.map((f) => f.path).filter((p): p is string => !!p);
    if (paths.length) void sendFilesToPeer(peer.id, paths);
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.94 }}
      animate={{
        opacity: 1,
        scale: 1,
        boxShadow: ['0 0 0 rgba(245,166,35,0)', '0 0 18px rgba(245,166,35,0.28)', '0 0 0 rgba(245,166,35,0)'],
      }}
      exit={{ opacity: 0, scale: 0.94 }}
      transition={{ type: 'spring', stiffness: 200, damping: 22, boxShadow: { duration: 1.4 } }}
      ref={cardRef}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        // Only reachable in a plain browser: under Tauri the native drag-drop
        // handler above intercepts, and it is the one that has real paths.
        if (e.dataTransfer.files.length) void chooseFiles();
      }}
      className={`panel p-3 transition-colors ${
        dragOver ? 'border-gold shadow-glow bg-gold/5' : 'hover:border-edge-strong'
      }`}
    >
      <div className="flex items-start gap-2.5">
        <Avatar
          name={peer.name}
          color={peer.color}
          emoji={peer.emoji}
          size={38}
          status={peer.status}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium truncate">{peer.name}</span>
            <Tooltip content={osLabel(peer.os)}>
              <span className="text-xs leading-none">{osGlyph(peer.os)}</span>
            </Tooltip>
            <DeviceTag peer={peer} />
          </div>
          <div className="flex items-center gap-1.5 mt-1 flex-wrap">
            <ConnBadge layer={peer.layer} />
            <ScopeBadge scope={peer.scope} />
            <Tooltip content={`Round-trip time${peer.lossPct ? ` · ${peer.lossPct}% loss` : ''}`}>
              <span className={`text-2xs font-mono ${latencyTone(peer.latencyMs)}`}>
                {/* A negative reading means it has not been timed yet. Showing
                    "0.0 ms" for that claimed a perfect link that nobody had
                    measured, and over a network it is not even possible. */}
                {peer.latencyMs < 0 ? '— ms' : `${peer.latencyMs.toFixed(1)} ms`}
              </span>
            </Tooltip>
          </div>
          <div className="text-2xs text-muted font-mono mt-1 truncate">
            {peer.ip}:{peer.port}
          </div>
          {/*
            Which network this device is actually on. The address alone does
            not say it — 192.168.100.x and 192.168.1.x look alike at a glance,
            and telling them apart is the whole question when two LANs are in
            play.
          */}
          <div className="flex items-center gap-1 mt-1">
            <Badge tone={via ? 'cyan' : 'gold'}>
              {via?.kind === 'wifi' ? <Wifi size={9} /> : <NetIcon size={9} />}
              {peerLan}
            </Badge>
            <span className="text-2xs text-muted truncate">
              {via ? `via ${via.name}` : 'routed — not on any of our networks'}
            </span>
          </div>
        </div>
      </div>

      <div className="flex items-center gap-1 mt-3 pt-2.5 border-t border-edge">
        <IconButton
          label="Message"
          onClick={() => {
            openDm(peer.id);
            onNavigate('chats');
          }}
        >
          <MessageSquare size={15} />
        </IconButton>
        <IconButton label="Voice call" onClick={() => callPeer(peer.id, 'voice')}>
          <Phone size={15} />
        </IconButton>
        <IconButton label="Video call" onClick={() => callPeer(peer.id, 'video')}>
          <Video size={15} />
        </IconButton>
        <IconButton label="Send file" onClick={() => void chooseFiles()}>
          <Send size={15} />
        </IconButton>
        <IconButton
          label="Play chess"
          className="ml-auto"
          onClick={() => {
            challengePeer(peer.id, 'chess');
            onNavigate('games');
          }}
        >
          <Crown size={15} />
        </IconButton>
      </div>

    </motion.div>
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
