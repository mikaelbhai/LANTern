/**
 * The household: who is here, on what, and what they are doing.
 *
 * The peer list used to be one card per device, which is what the network
 * reports and not what anybody thinks. One person with a phone, a laptop and
 * a television appeared three times under the same name, and choosing which
 * of the three to send a file to is a question the app is better placed to
 * answer than the person is.
 *
 * So a row is a person, and their devices sit underneath it. Sorted by
 * presence, not by recency: on a network the first question is who is
 * actually on it, which is the one way this differs from every messaging app
 * it otherwise resembles.
 *
 * The five action icons that used to sit under every person have gone. Each
 * of them exists again one tap in — calling and video from the chat header,
 * files from the composer, games from the Games tab — and a row of five
 * glyphs under each of six people is thirty targets on a phone screen, in a
 * list whose job is to be read.
 *
 * The grouping key is the display name, which is a weak join: two people who
 * both call themselves by the same name merge, and one person using two names
 * does not. It is right often enough to be worth having, and pairing devices
 * as companions replaces the guess with something authoritative.
 */
import React from 'react';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronUp,
  Laptop,
  Monitor,
  Play,
  Power,
  Smartphone,
  Tv,
  Users,
} from 'lucide-react';

import { api } from '../../lib/bridge';
import { openDm } from '../../lib/actions';
import { useStore } from '../../lib/store';
import { Avatar } from '../../components/Avatar';
import { Button } from '../../components/ui';
import { cn, whenLabel } from '../../lib/utils';
import { useNow } from '../../lib/hooks';
import type { Message, Peer, Room, Transfer, Wakeable } from '../../lib/types';
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

/** The subtitle of a row: a glyph, then the words. */
interface Line {
  icon?: React.ReactNode;
  text: string;
  /** True when the glyph and text describe something happening now. */
  live?: boolean;
}

export function Household({
  onNavigate,
  query = '',
}: {
  onNavigate: (s: Screen) => void;
  /** Filters by person or by any of their device names. */
  query?: string;
}) {
  const peers = useStore((s) => s.peers);
  const transfers = useStore((s) => s.transfers);
  const rooms = useStore((s) => s.rooms);
  const messages = useStore((s) => s.messages);
  const profile = useStore((s) => s.profile);
  const openRoom = useStore((s) => s.openRoom);
  const now = useNow(30_000);

  const [open, setOpen] = React.useState<string | null>(null);
  const [known, setKnown] = React.useState<Wakeable[]>([]);
  const [woken, setWoken] = React.useState<Record<string, string>>({});

  // Machines this device knows the hardware address of. Nothing acknowledges
  // a wake packet, so this list is the only way to offer the action at all —
  // and it is also what decides whether a sleeping device in somebody's
  // expanded list gets a button or only a line of text.
  const loadWakeable = React.useCallback(() => {
    void api.wake
      .list()
      // The simulator has no wake table at all, so this can come back as
      // undefined rather than an empty list. An unguarded spread of it took
      // the whole Home screen down to a white page.
      .then((all) => setKnown(Array.isArray(all) ? all : []))
      .catch(() => setKnown([]));
  }, []);
  React.useEffect(loadWakeable, [loadWakeable, peers]);

  const wakeable = React.useMemo(() => {
    const by = new Map<string, Wakeable>();
    for (const d of known) if (!d.online) by.set(d.deviceId, d);
    return by;
  }, [known]);

  const needle = query.trim().toLowerCase();

  const people = React.useMemo(() => {
    const all = group(Object.values(peers));
    if (!needle) return all;
    // Their own name, or the name of any machine they are at: looking for
    // "pixel" should find the person holding it.
    return all.filter(
      (p) =>
        p.name.toLowerCase().includes(needle) ||
        p.devices.some((d) => (d.deviceName || '').toLowerCase().includes(needle)),
    );
  }, [peers, needle]);

  /*
   * The rooms that are not one person.
   *
   * Everyone, and any group somebody has made. A direct message gets no row
   * of its own because the person it belongs to already has one — two rows
   * for the same conversation is the duplication this list exists to undo,
   * in a different key.
   */
  const shared = React.useMemo(() => {
    const list = Object.values(rooms).filter((r) => r.kind !== 'dm');
    const matching = needle ? list.filter((r) => r.name.toLowerCase().includes(needle)) : list;
    return matching.sort((a, b) => lastTs(b, messages) - lastTs(a, messages));
  }, [rooms, messages, needle]);

  // A machine we know the address of that is not anybody in the list above:
  // one that has never announced itself under a name.
  const strangers = React.useMemo(() => {
    const seen = new Set(Object.values(peers).map((p) => p.deviceId));
    return [...wakeable.values()].filter((d) => !seen.has(d.deviceId));
  }, [wakeable, peers]);

  /*
   * Wake everything named, under one key.
   *
   * The payoff of grouping by person is that you wake Rehan rather than
   * choosing which of his two boxes gets the packet, so the button on a
   * person's row sends to all of them at once. Nothing acknowledges a wake
   * packet, so `Sent` is the whole of the feedback that is honestly
   * available - and a second failing device must not overwrite a first one
   * that went out, which is why the key is the button, not the machine.
   */
  const wake = async (key: string, devices: Wakeable[]) => {
    setWoken((w) => ({ ...w, [key]: 'Sent' }));
    const results = await Promise.allSettled(devices.map((d) => api.wake.send(d.mac)));
    if (results.every((r) => r.status === 'rejected')) {
      setWoken((w) => ({ ...w, [key]: 'Could not send' }));
    }
  };

  if (people.length === 0 && shared.length === 0 && strangers.length === 0) return null;

  return (
    <div>
      {people.map((person) => (
        <PersonRow
          key={person.name}
          person={person}
          transfers={Object.values(transfers)}
          unread={unreadFor(person, rooms)}
          when={whenLabel(whenFor(person, rooms, messages), now)}
          wakeable={wakeable}
          woken={woken[person.name]}
          onWake={(devices) => void wake(person.name, devices)}
          expanded={open === person.name}
          onToggle={() => setOpen(open === person.name ? null : person.name)}
          onOpen={() => {
            openDm(person.best.id);
            onNavigate('chats');
          }}
        />
      ))}

      {shared.map((room) => (
        <RoomRow
          key={room.id}
          room={room}
          last={lastMessage(room, messages)}
          peers={peers}
          meId={profile.id}
          when={whenLabel(lastTs(room, messages), now)}
          onOpen={() => {
            openRoom(room.id);
            onNavigate('chats');
          }}
        />
      ))}

      {/*
        Machines nobody can see. Kept in the same list rather than a drawer
        underneath it: a device being asleep is a state it is in, not a
        different kind of thing.
      */}
      {strangers.map((device) => (
        <Row
          key={device.deviceId}
          avatar={<Avatar name={device.name || device.mac} size={44} muted />}
          title={device.name || device.mac}
          dim
          line={{ text: 'Not here right now' }}
          right={
            woken[device.deviceId] ? (
              <span className="text-2xs text-muted">{woken[device.deviceId]}</span>
            ) : (
              <Button
                size="sm"
                variant="accent"
                className="rounded-full"
                icon={<Power size={12} />}
                onClick={() => void wake(device.deviceId, [device])}
              >
                Wake
              </Button>
            )
          }
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------- rows */

/**
 * The shape every row in this list shares.
 *
 * Avatar, two lines of text, and one right-hand column. Written once because
 * a person, a group and a machine that is merely asleep have to line up down
 * the screen, and three separately hand-built rows never quite did.
 */
function Row({
  avatar,
  title,
  line,
  when,
  right,
  dim,
  onClick,
  onAvatarClick,
  children,
}: {
  avatar: React.ReactNode;
  title: string;
  line: Line;
  when?: string;
  right?: React.ReactNode;
  dim?: boolean;
  onClick?: () => void;
  onAvatarClick?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div className="border-b border-edge/70 last:border-b-0">
      <div className="flex items-center gap-3 pl-4 pr-3 py-2.5">
        <span
          onClick={onAvatarClick}
          className={cn('shrink-0', onAvatarClick && 'cursor-pointer')}
        >
          {avatar}
        </span>

        {onClick ? (
          <button type="button" onClick={onClick} className="min-w-0 flex-1 text-left">
            <Lines title={title} line={line} dim={dim} />
          </button>
        ) : (
          <div className="min-w-0 flex-1">
            <Lines title={title} line={line} dim={dim} />
          </div>
        )}

        <div className="shrink-0 flex flex-col items-end gap-1.5 self-start pt-0.5">
          {when && <span className="text-2xs text-muted leading-none">{when}</span>}
          {right}
        </div>
      </div>
      {children}
    </div>
  );
}

function Lines({ title, line, dim }: { title: string; line: Line; dim?: boolean }) {
  return (
    <>
      <span
        className={cn(
          'block text-[15px] leading-tight truncate',
          dim ? 'text-muted' : 'text-txt font-medium',
        )}
      >
        {title}
      </span>
      <span
        className={cn(
          'flex items-center gap-1 text-xs leading-tight mt-1',
          dim ? 'text-muted' : 'text-dim',
        )}
      >
        {line.icon && (
          <span className={cn('shrink-0', line.live ? 'text-gold' : 'text-muted')}>{line.icon}</span>
        )}
        <span className="truncate">{line.text}</span>
      </span>
    </>
  );
}

function PersonRow({
  person,
  transfers,
  unread,
  when,
  wakeable,
  woken,
  onWake,
  expanded,
  onToggle,
  onOpen,
}: {
  person: Person;
  transfers: Transfer[];
  unread: number;
  when: string;
  wakeable: Map<string, Wakeable>;
  /** What the person's own Wake button has to say for itself, if anything. */
  woken?: string;
  onWake: (devices: Wakeable[]) => void;
  expanded: boolean;
  onToggle: () => void;
  onOpen: () => void;
}) {
  const here = person.here.length > 0;
  const appliance = isAppliance(person.best);

  /*
   * The collapsed case.
   *
   * When every one of somebody's devices is asleep there is nothing to look
   * at inside the row - two lines both reading "asleep" - and the only thing
   * anybody wants is to wake them. So the devices stay shut, the chevron
   * goes, and the Wake button comes up onto the person.
   */
  const sleepers = here ? [] : person.devices.map((d) => wakeable.get(d.deviceId)).filter(isWakeable);
  const canWake = !here && sleepers.length > 0;
  const several = here && person.devices.length > 1;

  return (
    <Row
      avatar={
        appliance ? (
          <Avatar name={person.name} size={44} muted icon={<Tv size={20} />} />
        ) : (
          <Avatar
            name={person.name}
            color={person.best.color}
            emoji={person.best.emoji}
            size={44}
            muted={!here}
          />
        )
      }
      title={person.name}
      dim={!here}
      line={describe(person)}
      when={when}
      /*
        Tapping the row opens the conversation; tapping the avatar opens the
        devices. The chevron appears only when there is more than one device
        to show, so for a single-device person the avatar is a target with no
        visible hint — deliberately, because it is still the way to reach a
        machine you are not chatting to.
      */
      onClick={onOpen}
      onAvatarClick={several ? onToggle : undefined}
      right={
        <div className="flex items-center gap-1.5">
          {canWake &&
            (woken ? (
              <span className="text-2xs text-muted">{woken}</span>
            ) : (
              <Button
                size="sm"
                variant="accent"
                className="rounded-full"
                icon={<Power size={12} />}
                onClick={() => onWake(sleepers)}
              >
                Wake
              </Button>
            ))}
          {unread > 0 && (
            <span className="min-w-[20px] h-5 px-1.5 grid place-items-center rounded-full bg-gold text-on-gold text-2xs font-semibold">
              {unread > 99 ? '99+' : unread}
            </span>
          )}
          {several && (
            <button
              onClick={onToggle}
              aria-label={`Devices for ${person.name}`}
              className="text-muted"
            >
              {expanded ? <ChevronUp size={17} /> : <ChevronDown size={17} />}
            </button>
          )}
        </div>
      }
    >
      {expanded && several && (
        <div className="bg-raised border-t border-edge/70 pl-[68px] pr-3 py-1">
          {person.devices.map((device) => {
            const sleeper = wakeable.get(device.deviceId);
            const moving = transfers.find((t) => t.state === 'active' && t.peerId === device.id);
            const asleep = device.status === 'offline';
            return (
              <div key={device.deviceId} className="flex items-center gap-2.5 py-2">
                <span className={cn('shrink-0', asleep ? 'text-muted' : 'text-gold')}>
                  <DeviceIcon peer={device} />
                </span>
                <div className="min-w-0 flex-1">
                  <div
                    className={cn('text-xs truncate', asleep ? 'text-muted' : 'text-txt font-medium')}
                  >
                    {device.deviceName || device.name}
                  </div>
                  {moving ? (
                    <TransferLine transfer={moving} />
                  ) : (
                    <div className="text-2xs text-muted truncate mt-0.5">{whereabouts(device)}</div>
                  )}
                </div>
                {asleep && sleeper && (
                  <Button
                    size="sm"
                    variant="accent"
                    className="rounded-full shrink-0"
                    icon={<Power size={12} />}
                    onClick={() => onWake([sleeper])}
                  >
                    Wake
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </Row>
  );
}

/** A transfer as one line: what it is, how far it has got, and a bar. */
function TransferLine({ transfer }: { transfer: Transfer }) {
  const pct = transfer.size > 0 ? Math.round((transfer.sent / transfer.size) * 100) : 0;
  const Arrow = transfer.direction === 'in' ? ArrowDown : ArrowUp;
  return (
    <div className="flex items-center gap-2 mt-1">
      <span className="text-gold shrink-0">
        <Arrow size={11} />
      </span>
      <span className="text-2xs text-dim truncate max-w-[45%]">{transfer.name}</span>
      <span className="flex-1 h-1 rounded-full bg-edge overflow-hidden min-w-[30px]">
        <span className="block h-full bg-gold rounded-full" style={{ width: `${pct}%` }} />
      </span>
      <span className="text-2xs text-muted shrink-0 tabular-nums">{pct}%</span>
    </div>
  );
}

function RoomRow({
  room,
  last,
  peers,
  meId,
  when,
  onOpen,
}: {
  room: Room;
  last: Message | undefined;
  peers: Record<string, Peer>;
  meId: string;
  when: string;
  onOpen: () => void;
}) {
  const who = last
    ? last.authorId === meId
      ? 'You'
      : (peers[last.authorId]?.name ?? 'Someone')
    : '';
  const text = last
    ? `${who}: ${last.deleted ? 'Deleted' : last.body || attachmentWord(last)}`
    : room.kind === 'broadcast'
      ? 'Everybody on the network'
      : `${room.members.length} people`;

  return (
    <Row
      avatar={<Avatar name={room.name} size={44} muted icon={<Users size={20} />} />}
      title={room.name}
      line={{ text }}
      when={when}
      onClick={onOpen}
      right={
        room.unread > 0 ? (
          <span className="min-w-[20px] h-5 px-1.5 grid place-items-center rounded-full bg-gold text-on-gold text-2xs font-semibold">
            {room.unread > 99 ? '99+' : room.unread}
          </span>
        ) : undefined
      }
    />
  );
}

/* ---------------------------------------------------------------- helpers */

/** Narrows away the devices we have no hardware address for. */
function isWakeable(d: Wakeable | undefined): d is Wakeable {
  return !!d;
}

/** A glyph for the kind of machine, from what it reports itself to be. */
function DeviceIcon({ peer }: { peer: Peer }) {
  // A television announces itself as Android, exactly like a phone, so the
  // same name test that keeps it out of somebody's group picks its glyph.
  if (isAppliance(peer)) return <Tv size={15} />;
  if (peer.os === 'android') return <Smartphone size={15} />;
  if (peer.os === 'macos' || peer.os === 'linux') return <Laptop size={15} />;
  return <Monitor size={15} />;
}

/** A machine that belongs to the house rather than to a person. */
function isAppliance(peer: Peer): boolean {
  const name = `${peer.deviceName ?? ''} ${peer.name ?? ''}`.toLowerCase();
  return /(^|\W)(tv|television|shield|chromecast|firestick|projector)(\W|$)/.test(name);
}

/**
 * Everyone answering to one name, nearest awake device first.
 *
 * Appliances are pulled out first and keyed by their own name. A television
 * in the sitting room is signed in as whoever set it up, so grouping on the
 * display name alone filed it under that person - and an appliance is not
 * somebody's device. Nobody thinks of the TV as a thing Mashal is carrying,
 * and nobody wants to expand Mashal to find it.
 *
 * Latency is `-1` until it has been measured, which must not sort as nearer
 * than a device that has actually answered.
 */
function group(peers: Peer[]): Person[] {
  const by = new Map<string, Peer[]>();
  for (const peer of peers) {
    const name = isAppliance(peer)
      ? peer.deviceName || peer.name || 'Unknown'
      : peer.name || peer.deviceName || 'Unknown';
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

  /*
   * People, then appliances, and inside each of those the ones who are here.
   *
   * Presence sorted on its own put the television above everybody asleep,
   * which is the wrong answer to "who is about": a sitting-room TV is always
   * awake and is never the thing you came to this list for. A person who is
   * not here is still more interesting than a box that is.
   */
  const rank = (p: Person) => (isAppliance(p.best) ? 1 : 0);
  return people.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      Number(b.here.length > 0) - Number(a.here.length > 0) ||
      a.name.localeCompare(b.name),
  );
}

/**
 * What the person's row says underneath their name.
 *
 * Not what is being transferred. A transfer is true of a machine and not of a
 * person - it is arriving on the Pixel, not on Mashal - so it sits on the
 * device row inside, and this line goes on answering the question the row is
 * for, which is where they are.
 */
function describe(person: Person): Line {
  // Whatever a device says it is doing beats whatever can be inferred about
  // where it is. "Watching Flow, 48 minutes left" is the answer to the
  // question somebody is actually asking of this row.
  const saying = person.here.find((d) => d.statusMessage)?.statusMessage;
  if (saying) return { icon: <Play size={11} />, text: saying, live: true };

  const sleeping = person.devices.filter((d) => d.status === 'offline');
  const names = (list: Peer[]) => {
    const words = list.map((d) => d.deviceName || d.name).slice(0, 2);
    const rest = list.length - words.length;
    const joined = words.join(' and ');
    return rest > 0 ? `${joined} and ${rest} more` : joined;
  };

  if (person.here.length === 0) {
    return {
      text: person.devices.length > 1 ? `${names(sleeping)} asleep` : 'Not here right now',
    };
  }

  const on = person.here[0].deviceName || person.here[0].name;
  if (sleeping.length === 0) {
    return { text: person.devices.length > 1 ? `On ${person.here.length} devices` : `On the ${on}` };
  }
  return { text: `On the ${on}, ${names(sleeping)} asleep` };
}

/** What one device is doing, for the expanded list. */
function whereabouts(device: Peer): string {
  if (device.status === 'offline') {
    return device.lastSeen ? `Asleep since ${short(device.lastSeen)}` : 'Asleep';
  }
  if (device.statusMessage) return device.statusMessage;
  return device.latencyMs >= 0 ? `Here, ${device.latencyMs.toFixed(0)} ms away` : 'Here';
}

function short(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/** A word for a message that has no words. */
function attachmentWord(m: Message): string {
  if (m.voice) return 'Voice message';
  if (m.sticker || m.gif) return 'Sticker';
  if (m.attachments.length)
    return m.attachments.length === 1 ? 'File' : `${m.attachments.length} files`;
  return '';
}

function lastMessage(room: Room, messages: Record<string, Message[]>): Message | undefined {
  const list = messages[room.id];
  return list && list.length ? list[list.length - 1] : undefined;
}

function lastTs(room: Room, messages: Record<string, Message[]>): number {
  return lastMessage(room, messages)?.ts ?? room.createdAt;
}

/**
 * The timestamp on a person's row.
 *
 * The last thing they said, if they have said anything, and otherwise the
 * last time any of their devices was seen. Both answer the same question —
 * when this row last meant something — and a row with neither would be the
 * only one in the list with a blank right-hand column.
 */
function whenFor(
  person: Person,
  rooms: Record<string, Room>,
  messages: Record<string, Message[]>,
): number {
  const ids = new Set(person.devices.map((d) => d.deviceId));
  let latest = 0;
  for (const room of Object.values(rooms)) {
    if (room.kind !== 'dm') continue;
    if (!room.members.some((m) => ids.has(m))) continue;
    latest = Math.max(latest, lastTs(room, messages));
  }
  if (latest) return latest;
  return person.devices.reduce((n, d) => Math.max(n, d.lastSeen), 0);
}

/**
 * Unread across every device a person is at.
 *
 * Summed rather than taken from one room, because a message is from a person
 * and it does not matter which of their machines sent it. Clearing is still
 * per room, which is a seam pairing will need to close.
 */
function unreadFor(person: Person, rooms: Record<string, Room>): number {
  const ids = new Set(person.devices.map((d) => d.deviceId));
  return Object.values(rooms)
    .filter((room) => room.kind === 'dm' && room.members.some((m) => ids.has(m)))
    .reduce((sum, room) => sum + (room.unread ?? 0), 0);
}
