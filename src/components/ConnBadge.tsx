import React from 'react';
import { Radio, Route, DoorOpen, Repeat, Hand, ArrowUp, ArrowDown } from 'lucide-react';
import { Badge, Tooltip } from './ui';
import type { ConnLayer, NatType, PeerScope } from '../lib/types';

export const LAYER_META: Record<
  ConnLayer,
  { label: string; tone: 'cyan' | 'gold' | 'neutral' | 'danger'; icon: React.ElementType; blurb: string }
> = {
  direct: {
    label: 'Direct',
    tone: 'cyan',
    icon: Radio,
    blurb: 'Same subnet — discovered over mDNS, peer-to-peer WebRTC.',
  },
  routed: {
    label: 'Routed',
    tone: 'cyan',
    icon: Route,
    blurb: 'Different subnet, routable IPs — ICE using the local STUN server.',
  },
  upnp: {
    label: 'UPnP',
    tone: 'gold',
    icon: DoorOpen,
    blurb: 'Port opened on the gateway via UPnP/NAT-PMP.',
  },
  relayed: {
    label: 'Relayed',
    tone: 'gold',
    icon: Repeat,
    blurb: 'Traffic forwarded by a LANTern relay hub on the network.',
  },
  manual: {
    label: 'Manual',
    tone: 'neutral',
    icon: Hand,
    blurb: 'Connected from an address, QR code or pairing phrase you entered.',
  },
};

export function ConnBadge({ layer, compact }: { layer: ConnLayer; compact?: boolean }) {
  const meta = LAYER_META[layer];
  const Icon = meta.icon;
  return (
    <Tooltip content={meta.blurb}>
      <Badge tone={meta.tone}>
        <Icon size={9} />
        {!compact && meta.label}
      </Badge>
    </Tooltip>
  );
}

export const NAT_META: Record<NatType, { label: string; tone: 'cyan' | 'gold' | 'danger' | 'neutral'; blurb: string }> = {
  open: {
    label: 'Open',
    tone: 'cyan',
    blurb: 'No NAT in the way — peers can reach this device directly.',
  },
  moderate: {
    label: 'Moderate',
    tone: 'cyan',
    blurb: 'A single NAT with predictable port mapping. Hole punching works.',
  },
  strict: {
    label: 'Strict',
    tone: 'gold',
    blurb: 'Symmetric NAT — direct connections usually need a relay hub.',
  },
  double: {
    label: 'Double NAT',
    tone: 'gold',
    blurb: 'Two routers between you and the peer. LANTern falls back through UPnP and relay hubs.',
  },
  unknown: { label: 'Unknown', tone: 'neutral', blurb: 'NAT type has not been probed yet.' },
};

export function NatBadge({ nat }: { nat: NatType }) {
  const meta = NAT_META[nat];
  return (
    <Tooltip content={meta.blurb}>
      <Badge tone={meta.tone}>{meta.label}</Badge>
    </Tooltip>
  );
}

const SCOPE_META: Record<
  PeerScope,
  { label: string; icon: React.ElementType; blurb: string } | null
> = {
  // The common case needs no badge — only cross-NAT peers are worth calling out.
  local: null,
  upstream: {
    label: 'Upstream',
    icon: ArrowUp,
    blurb: 'On the network above our router. We opened the session outward to reach them.',
  },
  downstream: {
    label: 'Downstream',
    icon: ArrowDown,
    blurb: 'Behind a NAT of their own, below us. They opened the session to reach us.',
  },
};

export function ScopeBadge({ scope }: { scope: PeerScope }) {
  const meta = SCOPE_META[scope];
  if (!meta) return null;
  const Icon = meta.icon;
  return (
    <Tooltip content={meta.blurb}>
      <Badge tone="neutral">
        <Icon size={9} />
        {meta.label}
      </Badge>
    </Tooltip>
  );
}

export function latencyTone(ms: number): string {
  if (ms < 5) return 'text-cyan';
  if (ms < 25) return 'text-gold';
  return 'text-danger';
}
