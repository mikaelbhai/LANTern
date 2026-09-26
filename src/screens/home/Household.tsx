/**
 * The household: who is here, on what, and what they are doing.
 *
 * The peer list used to be one card per device, which is what the network
 * reports and not what anybody thinks. One person with a phone, a laptop and
 * a television appeared three times under the same name, and choosing which
 * of the three to send a file to is a question the app is better placed to
 * answer than the person is.
 *
 * So a row is a person, and their devices sit underneath it. Actions on the
 * person go to whichever of their devices is awake and closest, because
 * presence and latency are both already known per peer.
 *
 * Sorted by presence, not by recency. On a network the first question is who
 * is actually on it, which is the one way this differs from every messaging
 * app it otherwise resembles.
 *
 * The grouping key is the display name, which is a weak join: two people who
 * both call themselves by the same name merge, and one person using two names
 * does not. It is right often enough to be worth having, and pairing devices
 * as companions replaces the guess with something authoritative.
 */
import React from 'react';
import { ChevronDown, ChevronUp, Crown, Laptop, MessageSquare, Monitor, Phone, Play, Power, Send, Smartphone, Video } from 'lucide-react';

import { api } from '../../lib/bridge';
import { callPeer, challengePeer, openDm, sendFilesToPeer } from '../../lib/actions';
import { pickFilesToSend } from '../../lib/picker';
import { useStore } from '../../lib/store';
import { Avatar } from '../../components/Avatar';
import { Button, IconButton } from '../../components/ui';
import { cn, formatBytes } from '../../lib/utils';
import type { Peer, Transfer, Wakeable } from '../../lib/types';
import type { Screen } from '../../lib/nav';

/** One person and every device answering to their name. */
interface Person {
  name: string;
  devices: Peer[];
  /** Awake devices, nearest first. Empty when they are all asleep. */
  here: Peer[];
  /** Who to act on: the nearest awake device, or the last one seen. */
  best: Peer;
}

export function Household({ onNavigate }: { onNavigate: (s: Screen) => void }) {
  const peers = useStore((s) => s.peers);
  const transfers = useStore((s) => s.transfers);
  const rooms = useStore((s) => s.rooms);

  const [open, setOpen] = React.useState<string | null>(null);
  const [asleep, setAsleep] = React.useState<Wakeable[]>([]);
  const [woken, setWoken] = React.useState<Record<string, string>>({});

  // Machines this device knows the hardware address of and cannot currently
  // see. Nothing acknowledges a wake packet, so this list is the only way to
  // offer the action at all.
  const loadAsleep = React.useCallback(() => {
    void api.wake
      .list()
      .then((all) => setAsleep(all.filter((d) => !d.online)))
      .catch(() => setAsleep([]));
  }, []);
  React.useEffect(loadAsleep, [loadAsleep, peers]);

  const people = React.useMemo(() => group(Object.values(peers)), [peers]);

  const wake = async (device: Wakeable) => {
    setWoken((w) => ({ ...w, [device.deviceId]: 'Sent' }));
    try {
      await api.wake.send(device.mac);
    } catch {
      setWoken((w) => ({ ...w, [device.deviceId]: 'Could not send' }));
    }
  };

  if (people.length === 0 && asleep.length === 0) return null;

  return (
    <div className="divide-y divide-edge/60">
      {people.map((person) => (
        <PersonRow
          key={person.name}
          person={person}
          transfers={Object.values(transfers)}
          unread={unreadFor(person, rooms)}
          expanded={open === person.name}
          onToggle={() => setOpen(open === person.name ? null : person.name)}
          onNavigate={onNavigate}
        />
      ))}

      {/*
        Machines nobody can see. Kept in the same list rather than a drawer
        underneath it: a device being asleep is a state it is in, not a
        different kind of thing.
      */}
      {asleep.map((device) => (
        <div key={device.deviceId} className="flex items-center gap-3 px-4 py-3">
          <Avatar name={device.name || device.mac} size={40} status="offline" />
          <div className="min-w-0 flex-1">
            <div className="text-sm text-muted truncate">{device.name || device.mac}</div>
            <div className="text-2xs text-muted mt-0.5">Not here right now</div>
          </div>
          {woken[device.deviceId] ? (
            <span className="text-2xs text-muted shrink-0">{woken[device.deviceId]}</span>
          ) : (
            <Button size="sm" icon={<Power size={12} />} onClick={() => void wake(device)}>
              Wake
            </Button>
          )}
        </div>
      ))}

      {asleep.length > 0 && (
        <p className="px-4 py-2 text-2xs text-muted leading-relaxed">
          Nothing answers a wake packet. If the machine comes back it appears above.
        </p>
      )}
    </div>
  );
}

function PersonRow({
  person,
  transfers,
  unread,
  expanded,
  onToggle,
  onNavigate,
}: {
  person: Person;
  transfers: Transfer[];
  unread: number;
  expanded: boolean;
  onToggle: () => void;
  onNavigate: (s: Screen) => void;
}) {
  const here = person.here.length > 0;
  const several = person.devices.length > 1;

  return (
    <div>
      <div className="flex items-center gap-3 px-4 py-3">
        <button onClick={onToggle} className="shrink-0" aria-label={`Devices for ${person.name}`}>
          <Avatar
            name={person.name}
            color={person.best.color}
            emoji={person.best.emoji}
            size={40}
            status={here ? 'available' : 'offline'}
          />
        </button>

        <button onClick={onToggle} className="min-w-0 flex-1 text-left">
          <div className="flex items-baseline gap-2">
            <span className={cn('text-sm truncate flex-1', here ? 'text-txt' : 'text-muted')}>
              {person.name}
            </span>
            {unread > 0 && (
              <span className="shrink-0 min-w-[18px] h-[18px] px-1.5 grid place-items-center rounded-full bg-gold text-[#1a1206] text-2xs font-medium">
                {unread > 99 ? '99+' : unread}
              </span>
            )}
          </div>
          <div className="text-2xs text-muted truncate mt-0.5">{describe(person, transfers)}</div>
        </button>

        {several && (
          <span className="text-muted shrink-0">
            {expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
          </span>
        )}
      </div>

      {/* The five things you can do to a person, on the device that answers. */}
      {here && (
        <div className="flex items-center gap-1 px-4 pb-2.5">
          <IconButton
            label={`Message ${person.name}`}
            onClick={() => {
              openDm(person.best.id);
              onNavigate('chats');
            }}
          >
            <MessageSquare size={15} />
          </IconButton>
          <IconButton label="Voice call" onClick={() => callPeer(person.best.id, 'voice')}>
            <Phone size={15} />
          </IconButton>
          <IconButton label="Video call" onClick={() => callPeer(person.best.id, 'video')}>
            <Video size={15} />
          </IconButton>
          <IconButton label="Send a file" onClick={() => void send(person.best.id)}>
            <Send size={15} />
          </IconButton>
          <IconButton
            label="Play chess"
            className="ml-auto"
            onClick={() => {
              challengePeer(person.best.id, 'chess');
              onNavigate('games');
            }}
          >
            <Crown size={15} />
          </IconButton>
        </div>
      )}

      {expanded && several && (
        <div className="bg-raised/40 px-4 py-1.5 space-y-2">
          {person.devices.map((device) => (
            <div key={device.deviceId} className="flex items-center gap-2.5 py-1">
              <span className="text-muted shrink-0">
                <DeviceIcon os={device.os} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-xs truncate">{device.deviceName || device.name}</div>
                <div className="text-2xs text-muted truncate">{whereabouts(device, transfers)}</div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Ask for files, then hand them to the device that is actually awake. */
async function send(peerId: string) {
  const picked = await pickFilesToSend();
  const paths = picked.map((f) => f.path).filter((p): p is string => !!p);
  if (paths.length) void sendFilesToPeer(peerId, paths);
}

/** A glyph for the kind of machine, from what it reports itself to be. */
function DeviceIcon({ os }: { os: string }) {
  if (os === 'android' || os === 'ios') return <Smartphone size={14} />;
  if (os === 'macos' || os === 'linux') return <Laptop size={14} />;
  return <Monitor size={14} />;
}

/**
 * Everyone answering to one name, nearest awake device first.
 *
 * Latency is `-1` until it has been measured, which must not sort as nearer
 * than a device that has actually answered.
 */
function group(peers: Peer[]): Person[] {
  const by = new Map<string, Peer[]>();
  for (const peer of peers) {
    const name = peer.name || peer.deviceName || 'Unknown';
    by.set(name, [...(by.get(name) ?? []), peer]);
  }

  const nearest = (a: Peer, b: Peer) => {
    const cost = (p: Peer) => (p.latencyMs < 0 ? Number.MAX_SAFE_INTEGER : p.latencyMs);
    return cost(a) - cost(b);
  };

  const people: Person[] = [...by.entries()].map(([name, devices]) => {
    const here = devices.filter((d) => d.status !== 'offline').sort(nearest);
    return { name, devices: [...devices].sort(nearest), here, best: here[0] ?? devices[0] };
  });

  // Here first, then by name. Presence is the question this list answers.
  return people.sort(
    (a, b) => Number(b.here.length > 0) - Number(a.here.length > 0) || a.name.localeCompare(b.name),
  );
}

/** What the person's row says underneath their name. */
function describe(person: Person, transfers: Transfer[]): string {
  if (person.here.length === 0) {
    return person.devices.length > 1 ? 'All their devices are asleep' : 'Not here right now';
  }

  const moving = transfers.find(
    (t) => t.state === 'active' && person.devices.some((d) => d.id === t.peerId),
  );
  if (moving) {
    const way = moving.direction === 'in' ? 'Receiving' : 'Sending';
    return `${way} ${moving.name}`;
  }

  if (person.devices.length === 1) {
    const only = person.devices[0];
    return only.deviceName || `On ${only.ip}`;
  }

  const asleep = person.devices.length - person.here.length;
  const on = person.here[0].deviceName || 'one device';
  return asleep > 0 ? `On the ${on}, ${asleep} asleep` : `On ${person.here.length} devices`;
}

/** What one device is doing, for the expanded list. */
function whereabouts(device: Peer, transfers: Transfer[]): string {
  if (device.status === 'offline') return 'Asleep';

  const moving = transfers.find((t) => t.state === 'active' && t.peerId === device.id);
  if (moving) {
    const pct = moving.size > 0 ? Math.round((moving.sent / moving.size) * 100) : 0;
    return `${moving.name}, ${pct}% of ${formatBytes(moving.size)}`;
  }

  if (device.statusMessage) return device.statusMessage;
  return device.latencyMs >= 0 ? `${device.latencyMs.toFixed(0)} ms` : 'Here';
}

/**
 * Unread across every device a person is at.
 *
 * Summed rather than taken from one room, because a message is from a person
 * and it does not matter which of their machines sent it. Clearing is still
 * per room, which is a seam pairing will need to close.
 */
function unreadFor(person: Person, rooms: Record<string, { members: string[]; unread: number }>): number {
  const ids = new Set(person.devices.map((d) => d.deviceId));
  return Object.values(rooms)
    .filter((room) => room.members.some((m) => ids.has(m)))
    .reduce((sum, room) => sum + (room.unread ?? 0), 0);
}
