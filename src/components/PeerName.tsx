/**
 * Naming a peer.
 *
 * A person and the machine they are sitting at are two different things, and
 * for a long time only the machine had a name here — every device announced
 * its hostname and nothing else, so the network read as a list of computers.
 *
 * Now both travel. The person's name is the one that matters and gets the
 * weight; the machine's is shown beside it, because one person can be at three
 * devices and "Mikael" alone does not say which of them you are about to send
 * a file to.
 */
import React from 'react';

import type { Peer } from '../lib/types';
import { cn } from '../lib/utils';

/**
 * The machine's name, when it is worth saying.
 *
 * Withheld when it matches the person's name, which is what happens when
 * somebody has not set one — or is on an older build that only ever sent the
 * hostname. Repeating it twice would be noise.
 */
export function deviceLabel(peer: Pick<Peer, 'name' | 'deviceName'>): string | null {
  const device = peer.deviceName?.trim();
  if (!device) return null;
  if (device.toLowerCase() === peer.name.trim().toLowerCase()) return null;
  return device;
}

/** The machine's name as a quiet tag beside the person's. */
export function DeviceTag({
  peer,
  className,
}: {
  peer: Pick<Peer, 'name' | 'deviceName'>;
  className?: string;
}) {
  const device = deviceLabel(peer);
  if (!device) return null;

  return (
    <span
      title={`on ${device}`}
      className={cn(
        'text-2xs text-muted truncate shrink min-w-0 font-mono',
        className,
      )}
    >
      {device}
    </span>
  );
}
