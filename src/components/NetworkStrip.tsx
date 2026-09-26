/**
 * The network, speaking only when it has something to say.
 *
 * Network used to be a screen you had to think to visit, which meant the
 * faults it could name went unnamed. Two of this machine's interfaces sharing
 * an address range is the clearest example: nothing looks wrong, peers appear,
 * messages arrive, and then calls fail for a reason no part of the interface
 * mentions. The information existed the whole time.
 *
 * So it moved to a line under the title bar that is absent when everything is
 * fine, and is the first thing you see when it is not. It is also where a
 * diagnosis belongs: attached to the moment the fault is visible, rather than
 * behind a tab somebody has to suspect.
 *
 * It yields to a call. Both want the same strip of screen and an active call
 * is always the more urgent of the two.
 */
import React from 'react';
import { AlertTriangle, WifiOff } from 'lucide-react';

import { on } from '../lib/bridge';
import { useStore } from '../lib/store';
import type { Screen } from '../lib/nav';

interface Fault {
  /** One line, naming the fault rather than describing a symptom. */
  title: string;
  /** What it costs, in the terms somebody would notice it by. */
  body: string;
  icon: React.ReactNode;
}

export function NetworkStrip({ onNavigate }: { onNavigate: (s: Screen) => void }) {
  const net = useStore((s) => s.net);
  const call = useStore((s) => s.call);
  const peers = useStore((s) => s.peers);

  /**
   * Peers that answer on the signalling link but whose library cannot be
   * read. Worth naming because it looks exactly like "they have published
   * nothing", and it is usually a firewall.
   */
  const [unreachable, setUnreachable] = React.useState<string[]>([]);
  React.useEffect(
    () => on('library:unreachable', (names) => setUnreachable((names as string[]) ?? [])),
    [],
  );

  /** A service that could not bind. Arrives once, at startup. */
  const [service, setService] = React.useState<string | null>(null);
  React.useEffect(
    () =>
      on('service:failed', (f: { service: string; port: number }) =>
        setService(`${f.service} could not start on port ${f.port}`),
      ),
    [],
  );

  // A call owns this space while it is running.
  if (call && call.state !== 'ended') return null;

  const fault = firstFault(net, unreachable, service, Object.keys(peers).length);
  if (!fault) return null;

  return (
    <button
      onClick={() => onNavigate('network')}
      className="w-full shrink-0 flex items-center gap-2.5 px-4 py-2.5 bg-warn/[0.14] border-b border-warn/30 text-left"
    >
      <span className="text-warn shrink-0">{fault.icon}</span>
      <span className="min-w-0 flex-1">
        {/* The fault in the first line, what it costs in the second, both
            in warning amber. Not the accent: the accent is green and is
            also whatever Settings has been set to, and a warning painted
            in the colour of "everything is fine" is not a warning. */}
        <span className="block text-xs text-warn font-medium truncate">{fault.title}</span>
        <span className="block text-2xs text-warn/80 truncate">{fault.body}</span>
      </span>
      <span className="text-xs text-warn font-semibold shrink-0">Fix</span>
    </button>
  );
}

/**
 * The one worth interrupting for, in order of how badly it breaks things.
 *
 * One at a time on purpose. A strip that stacks three warnings is a screen,
 * and a screen is the thing this exists to avoid.
 */
function firstFault(
  net: ReturnType<typeof useStore.getState>['net'],
  unreachable: string[],
  service: string | null,
  peerCount: number,
): Fault | null {
  if (service) {
    return {
      title: service,
      body: 'Another copy of LANTern may already be running',
      icon: <AlertTriangle size={15} />,
    };
  }

  /*
   * Two interfaces on one address range.
   *
   * The worst of these because nothing else reports it. Messages ride a link
   * that is already up and carry on working, so only calls fail - and they
   * fail in a way that reads as the other device being asleep.
   */
  const clash = net?.sameSubnet?.[0];
  if (clash && net) {
    return {
      title: `Two networks share ${networkOf(net, clash.a)}`,
      // The cost, not the mechanism. `Wi-Fi and Ethernet reach different
      // places by the same addresses` is the true sentence and it ran off
      // the right edge of a phone, which made it no sentence at all. Which
      // two interfaces clash is on the Network screen, one tap away.
      body: 'Calls may not connect until one is turned off',
      icon: <AlertTriangle size={15} />,
    };
  }

  if (unreachable.length > 0) {
    const who = unreachable.length === 1 ? unreachable[0] : `${unreachable.length} devices`;
    return {
      title: `Can't read what ${who} is sharing`,
      body: 'They answer, but their files are being refused. Usually a firewall',
      icon: <WifiOff size={15} />,
    };
  }

  /*
   * An empty network is not a fault.
   *
   * This used to say "nothing else on this network yet", which is the same
   * sentence the house list says underneath it in its own empty state, in
   * more words. A strip that speaks when nothing is wrong is a strip people
   * learn to look past, and then it is no use on the day something is.
   */
  return null;
}

/**
 * The network an interface is on, in the form somebody can act on.
 *
 * Not `net.subnet`, which is the mask. Printing 255.255.255.0 at somebody
 * says nothing about which addresses are involved, and it shipped that way
 * once already.
 */
function networkOf(net: NonNullable<ReturnType<typeof useStore.getState>['net']>, name: string): string {
  return net.interfaces.find((i) => i.name === name)?.cidr ?? net.interfaces[0]?.cidr ?? net.subnet;
}
