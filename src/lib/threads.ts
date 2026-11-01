import React from 'react';
import { create } from 'zustand';

import { api } from './bridge';
import { useStore } from './store';
import type { Message, Peer, Room } from './types';

/**
 * One conversation per person, however many rooms hold it.
 *
 * A direct message is a room per device. So the same person under a device id
 * they no longer use (a reinstall, a profile that was reset) is a second room,
 * and so are the PC and the phone of somebody who has paired the two as their
 * own - three chats with Mikael, each holding a piece of the conversation, none
 * of them all of it.
 *
 * This joins them for display and never touches what is stored: the rooms and
 * their messages stay exactly as they are, the list shows one row for the
 * person, and the conversation shows every one of those rooms' messages in time
 * order. Reversible by deleting this file, which is the point of not migrating.
 */

const same = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
const EMPTY: Message[] = [];

export interface Threads {
  /** For every room, the room that stands for its conversation. */
  primaryOf: Record<string, string>;
  /** For every primary room, every room that is part of it (itself included). */
  ids: Record<string, string[]>;
}

/**
 * Groups direct-message rooms by who they are with.
 *
 * Pure: it is told the rooms, who is here, which devices are the person's own,
 * and when each room was last used, and answers with the grouping. Rooms that
 * are not direct messages, and a person with only one room, stand for
 * themselves.
 *
 * Two rooms are with the same person when the names match ignoring capitals
 * and spacing, or when both are with devices the person has paired as their own
 * (their names need not match: a PC and a phone are called what they are
 * called). The room to show is the one with somebody here, then the most
 * recently used, so a message sent from the merged conversation goes to a device
 * that can receive it.
 */
export function buildThreads(
  rooms: Record<string, Room>,
  peers: Record<string, Peer>,
  own: Set<string>,
  lastTs: (roomId: string) => number,
): Threads {
  // The names of the person's own devices, so that a room under an old id for
  // one of them (which is no longer a device anybody can say is paired) still
  // joins the rest of their own conversation by what it is called.
  const ownNames = new Set<string>();
  for (const room of Object.values(rooms)) {
    if (room.kind !== 'dm') continue;
    const peer = peers[room.members[0]];
    if (own.has(peer?.deviceId ?? room.members[0])) ownNames.add(same(peer?.name ?? room.name));
  }

  const groups = new Map<string, Room[]>();
  for (const room of Object.values(rooms)) {
    if (room.kind !== 'dm') continue;
    const peer = peers[room.members[0]];
    const device = peer?.deviceId ?? room.members[0];
    const name = same(peer?.name ?? room.name);
    const key = own.has(device) || ownNames.has(name) ? '@own' : `n:${name}`;
    groups.set(key, [...(groups.get(key) ?? []), room]);
  }

  const primaryOf: Record<string, string> = {};
  const ids: Record<string, string[]> = {};
  for (const room of Object.values(rooms)) {
    primaryOf[room.id] = room.id;
    ids[room.id] = [room.id];
  }

  for (const members of groups.values()) {
    if (members.length < 2) continue;
    const here = (r: Room) => {
      const p = peers[r.members[0]];
      return p && p.status !== 'offline' ? 1 : 0;
    };
    const best = [...members].sort(
      (a, b) => here(b) - here(a) || lastTs(b.id) - lastTs(a.id) || b.createdAt - a.createdAt,
    )[0];
    ids[best.id] = members.map((r) => r.id);
    for (const r of members) primaryOf[r.id] = best.id;
    for (const r of members) if (r.id !== best.id) delete ids[r.id];
  }
  return { primaryOf, ids };
}

/** The devices this one has paired as its own. */
export const useOwn = create<{ ids: Set<string> }>(() => ({ ids: new Set() }));

/** Reads who they are again; called when the devices on the network change. */
export function refreshOwn(): void {
  void api.peers
    .companions()
    .then((list) =>
      useOwn.setState({ ids: new Set(Array.isArray(list) ? list.map((c) => c.deviceId) : []) }),
    )
    .catch(() => undefined);
}

/** The grouping, as it stands now. */
export function useThreads(): Threads {
  const rooms = useStore((s) => s.rooms);
  const peers = useStore((s) => s.peers);
  const messages = useStore((s) => s.messages);
  const own = useOwn((s) => s.ids);
  return React.useMemo(
    () =>
      buildThreads(rooms, peers, own, (id) => messages[id]?.at(-1)?.ts ?? rooms[id]?.createdAt ?? 0),
    [rooms, peers, own, messages],
  );
}

/** Every message in the conversation a room belongs to, oldest first. */
export function useThreadMessages(roomId: string): Message[] {
  const threads = useThreads();
  const messages = useStore((s) => s.messages);
  return React.useMemo(() => {
    const ids = threads.ids[threads.primaryOf[roomId] ?? roomId] ?? [roomId];
    if (ids.length < 2) return messages[roomId] ?? EMPTY;
    return ids.flatMap((id) => messages[id] ?? EMPTY).sort((a, b) => a.ts - b.ts);
  }, [threads, messages, roomId]);
}
