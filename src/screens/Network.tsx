import React from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Check,
  Copy,
  DoorOpen,
  Flashlight,
  Layers,
  Plus,
  QrCode as QrIcon,
  Radar,
  Repeat,
  Router,
  ShieldQuestion,
  Trash2,
  Wifi,
  X,
  Zap,
} from 'lucide-react';
import { Avatar } from '../components/Avatar';
import { DeviceTag } from '../components/PeerName';
import { QrCode } from '../components/QrCode';
import { ConnBadge, LAYER_META, NatBadge, ScopeBadge, latencyTone } from '../components/ConnBadge';
import {
  Badge,
  Button,
  Empty,
  IconButton,
  Input,
  Modal,
  SectionTitle,
  Select,
  Spinner,
  Toggle,
  Tooltip,
} from '../components/ui';
import { api } from '../lib/bridge';
import { useStore } from '../lib/store';
import { validatePhrase } from '../lib/phrase';
import { cn, formatBytes, osGlyph, relativeTime } from '../lib/utils';
import type { ConnLayer, DiagStep, NetInfo, PortMapping } from '../lib/types';
import { copyText } from '../lib/clipboard';

export function Network() {
  const peers = useStore((s) => s.peers);
  const [addOpen, setAddOpen] = React.useState(false);
  const [inviteOpen, setInviteOpen] = React.useState(false);
  const [firewallOpen, setFirewallOpen] = React.useState(false);
  const [diagPeer, setDiagPeer] = React.useState<string | null>(null);

  const peerList = Object.values(peers);

  return (
    <div className="h-full flex flex-col">
      <header className="h-11 shrink-0 border-b border-edge bg-surface flex items-center px-4 gap-2">
        <Flashlight size={15} className="text-gold" />
        <span className="text-sm font-semibold">Network</span>
        <span className="text-2xs text-muted hidden sm:block">
          Connectivity, NAT traversal and pairing
        </span>
        <div className="ml-auto flex gap-2">
          <Button size="xs" icon={<QrIcon size={12} />} onClick={() => setInviteOpen(true)}>
            Invite
          </Button>
          <Button
            size="xs"
            variant="primary"
            icon={<Plus size={12} />}
            onClick={() => setAddOpen(true)}
          >
            Add peer
          </Button>
        </div>
      </header>

      <div className="flex-1 scroll-y p-4 space-y-5">
        <MyNetworkCard onFirewall={() => setFirewallOpen(true)} />
        <UpstreamCard />

        <section>
          <SectionTitle right={<Badge tone="muted">{peerList.length}</Badge>}>
            Peer connections
          </SectionTitle>
          {peerList.length === 0 ? (
            <div className="panel">
              <Empty
                icon={<Wifi size={18} />}
                title="No peers connected"
                hint="Peers on the same subnet appear automatically. Across subnets, add one by address, QR code or pairing phrase."
              />
            </div>
          ) : (
            <div className="grid gap-2.5 [grid-template-columns:repeat(auto-fill,minmax(300px,1fr))]">
              {peerList.map((p) => (
                <PeerConnCard key={p.id} peerId={p.id} onDiagnose={() => setDiagPeer(p.id)} />
              ))}
            </div>
          )}
        </section>

        <div className="grid gap-5 lg:grid-cols-2">
          <RelayHubCard />
          <UpnpManager />
        </div>

        <BridgeCard />
        <ConnectionStack />
      </div>

      <AddPeerModal open={addOpen} onClose={() => setAddOpen(false)} />
      <InviteModal open={inviteOpen} onClose={() => setInviteOpen(false)} />
      <FirewallModal open={firewallOpen} onClose={() => setFirewallOpen(false)} />
      <DiagnosticsModal peerId={diagPeer} onClose={() => setDiagPeer(null)} />
    </div>
  );
}

/* ------------------------------------------------------------ My network */

function MyNetworkCard({ onFirewall }: { onFirewall: () => void }) {
  const net = useStore((s) => s.net);
  if (!net) return <div className="panel h-28 animate-pulse" />;

  return (
    <section className="panel p-4">
      <SectionTitle
        right={
          <Button size="xs" variant="ghost" icon={<ShieldQuestion size={12} />} onClick={onFirewall}>
            Firewall guide
          </Button>
        }
      >
        This device
      </SectionTitle>

      <div className="grid gap-x-6 gap-y-3 [grid-template-columns:repeat(auto-fit,minmax(150px,1fr))]">
        <Field label="IP address" value={net.ip} mono />
        <Field label="Subnet mask" value={net.subnet} mono />
        <Field label="Gateway" value={net.gateway} mono />
        <Field label="Signaling port" value={`${net.port} TCP+UDP`} mono />
        <Field label="STUN port" value={`${net.stunPort} UDP`} mono />
        <div>
          <div className="label mb-1">NAT type</div>
          <NatBadge nat={net.nat} />
        </div>
        <div>
          <div className="label mb-1">UPnP</div>
          <Badge tone={net.upnpAvailable ? 'cyan' : 'danger'}>
            {net.upnpAvailable ? 'Available' : 'Unavailable'}
          </Badge>
        </div>
      </div>

      <div className="mt-4 pt-3 border-t border-edge">
        <div className="label mb-2">Interfaces</div>
        <div className="flex flex-wrap gap-2">
          {net.interfaces.map((i) => (
            <div
              key={i.name}
              className="flex items-center gap-2 bg-raised border border-edge rounded-input px-2.5 h-7"
            >
              <Wifi size={11} className="text-muted" />
              <span className="text-xs">{i.name}</span>
              <span className="text-2xs font-mono text-dim">{i.ip}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="label mb-1">{label}</div>
      <div className={`text-xs text-txt ${mono ? 'font-mono' : ''}`}>{value}</div>
    </div>
  );
}

/* ------------------------------------------------------ Across the NAT */

/**
 * Double NAT is asymmetric, and the UI has to say so plainly: this device can
 * always open a connection outward to the upstream LAN, but nothing up there
 * can open one inward until a mapping is published on our own router. Both
 * directions are offered separately because they are solved separately.
 */
function UpstreamCard() {
  const net = useStore((s) => s.net);
  const peers = useStore((s) => s.peers);
  const toast = useStore((s) => s.toast);

  const [scanning, setScanning] = React.useState(false);
  const [publishing, setPublishing] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [forwardOpen, setForwardOpen] = React.useState(false);

  const upstream = net?.upstream;
  const upstreamPeers = Object.values(peers).filter((p) => p.scope === 'upstream');

  if (!net) return null;

  if (!upstream) {
    return (
      <section className="panel p-4">
        <SectionTitle>Across the NAT</SectionTitle>
        <p className="text-xs text-dim">
          Only one router sits between this device and the rest of the network, so there
          is no upstream LAN to cross. Peers here are reachable directly.
        </p>
      </section>
    );
  }

  const scan = async () => {
    setScanning(true);
    try {
      const found = await api.net.scanUpstream();
      toast({
        kind: found.length ? 'success' : 'info',
        title: found.length
          ? `Found ${found.length} device${found.length === 1 ? '' : 's'} upstream`
          : 'No LANTern devices found upstream',
        body: `Swept ${upstream.subnet} from this side of the router.`,
      });
    } finally {
      setScanning(false);
    }
  };

  const togglePublish = async (on: boolean) => {
    setPublishing(true);
    try {
      await api.net.publishUpstream(on);
      toast({
        kind: on ? 'success' : 'info',
        title: on ? 'Published upstream' : 'Upstream mapping closed',
        body: on
          ? 'Devices on the outer network can now start conversations with this one.'
          : 'Only connections this device starts will work again.',
      });
    } finally {
      setPublishing(false);
    }
  };

  const copyAddress = async () => {
    if (!upstream.publishedAddress) return;
    try {
      await copyText(upstream.publishedAddress);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <section className="panel p-4">
      <SectionTitle
        right={
          <Badge tone={upstream.reachable ? 'cyan' : 'muted'}>
            <ArrowUpDown size={9} />
            {upstream.reachable ? 'Upstream reachable' : 'Not probed yet'}
          </Badge>
        }
      >
        Across the NAT
      </SectionTitle>

      <p className="text-xs text-dim mb-4 leading-relaxed">
        This device sits behind a second router, so the two directions are not
        equivalent. Outbound always works. Inbound needs a door opened.
      </p>

      <NatDiagram net={net} upstream={upstream} upstreamPeers={upstreamPeers.length} />

      <div className="grid gap-3 md:grid-cols-2 mt-4">
        {/* outbound */}
        <div className="rounded-card border border-cyan/30 bg-cyan/[0.05] p-3">
          <div className="flex items-center gap-2 mb-1.5">
            <ArrowUp size={12} className="text-cyan" />
            <span className="text-xs font-medium">Reaching devices above</span>
            <Badge tone="cyan">Always works</Badge>
          </div>
          <p className="text-2xs text-muted leading-relaxed mb-2.5">
            Our router forwards outbound traffic, so LANTern can open a session to
            anything on {upstream.subnet}. Once open, that one session carries traffic
            both ways — messages, calls and files from either side.
          </p>
          <div className="flex items-center gap-2">
            <Button
              size="xs"
              variant="primary"
              icon={scanning ? <Spinner size={11} /> : <Radar size={11} />}
              disabled={scanning}
              onClick={() => void scan()}
            >
              {scanning ? 'Sweeping…' : 'Scan upstream network'}
            </Button>
            {upstream.lastScanAt && (
              <span className="text-[10px] text-muted">
                {upstream.hostsScanned} hosts · {relativeTime(upstream.lastScanAt)}
              </span>
            )}
          </div>
        </div>

        {/* inbound */}
        <div
          className={cn(
            'rounded-card border p-3 transition-colors',
            upstream.published
              ? 'border-gold/40 bg-gold/[0.06]'
              : 'border-edge bg-raised/40',
          )}
        >
          <div className="flex items-center gap-2 mb-1.5">
            <ArrowDown size={12} className={upstream.published ? 'text-gold' : 'text-muted'} />
            <span className="text-xs font-medium">Letting them reach us</span>
            <Badge tone={upstream.published ? 'gold' : 'danger'}>
              {upstream.published ? 'Open' : 'Blocked by NAT'}
            </Badge>
          </div>
          <p className="text-2xs text-muted leading-relaxed mb-2.5">
            Our router drops unsolicited inbound packets — it has no way to know which
            device they are for. The hole can be opened automatically over UPnP, or by
            forwarding port {net.port} on the router yourself.
          </p>

          {net.upnpAvailable ? (
            <Toggle
              checked={upstream.published}
              disabled={publishing}
              onChange={(v) => void togglePublish(v)}
              label="Publish this device to the upstream network"
              hint="LANTern asks the router to forward the port"
            />
          ) : (
            // UPnP is off or unsupported on this router, so the automatic path
            // is genuinely unavailable — offer the one that always works
            // instead of a switch that can never move.
            <div className="space-y-2.5">
              <div className="flex items-start gap-2 rounded-input bg-base border border-edge px-2.5 py-2">
                <ShieldQuestion size={12} className="text-muted shrink-0 mt-0.5" />
                <p className="text-2xs text-muted leading-relaxed">
                  This router did not answer a UPnP request, so LANTern cannot open the
                  port on its own. Forwarding it by hand takes about a minute and works
                  on every router.
                </p>
              </div>

              {upstream.published && upstream.publishedVia === 'manual' ? (
                <div className="flex items-center gap-2">
                  <Badge tone="gold">Forwarded manually</Badge>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void api.net.publishUpstreamManual(false)}
                  >
                    Undo
                  </Button>
                </div>
              ) : (
                <Button
                  size="xs"
                  variant="primary"
                  icon={<DoorOpen size={11} />}
                  onClick={() => setForwardOpen(true)}
                >
                  Forward it manually
                </Button>
              )}
            </div>
          )}

          {upstream.wans.length > 1 && (
            <div className="mt-2.5">
              <div className="label mb-1">
                {upstream.wans.length} uplinks on this router
              </div>
              <div className="space-y-1">
                {upstream.wans.map((wan) => (
                  <div
                    key={wan.externalIp + wan.service}
                    className="flex items-center gap-2 bg-base border border-edge rounded-input px-2.5 h-7"
                  >
                    <span
                      className={cn(
                        'h-1.5 w-1.5 rounded-full shrink-0',
                        wan.published ? 'bg-cyan' : 'bg-muted',
                      )}
                    />
                    <span className="text-2xs font-mono text-dim flex-1 truncate">
                      {wan.externalIp}
                    </span>
                    <Badge tone={wan.published ? 'cyan' : 'muted'}>
                      {wan.published ? 'Mapped' : 'Not mapped'}
                    </Badge>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-muted mt-1.5 leading-relaxed">
                A dual-WAN router switches between uplinks, so LANTern maps the port on
                every one — otherwise inbound would work only some of the time.
              </p>
            </div>
          )}

          {upstream.published && upstream.publishedAddress && (
            <div className="mt-2.5">
              <div className="label mb-1">Hand this address to devices above</div>
              <div className="flex items-center gap-2 bg-base border border-edge rounded-input px-2.5 h-8">
                <span className="text-xs font-mono text-gold flex-1 truncate">
                  {upstream.publishedAddress}
                </span>
                <IconButton label="Copy address" size="xs" onClick={() => void copyAddress()}>
                  {copied ? <Check size={11} className="text-cyan" /> : <Copy size={11} />}
                </IconButton>
              </div>
            </div>
          )}
        </div>
      </div>

      <ManualForwardModal
        open={forwardOpen}
        onClose={() => setForwardOpen(false)}
        net={net}
      />

      {upstreamPeers.length > 0 && (
        <div className="mt-4 pt-3 border-t border-edge">
          <div className="label mb-2">Devices on the upstream network</div>
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(200px,1fr))]">
            {upstreamPeers.map((p) => (
              <div
                key={p.id}
                className="flex items-center gap-2 p-2 rounded-input bg-raised border border-edge"
              >
                <Avatar name={p.name} color={p.color} emoji={p.emoji} size={26} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    <span className="text-xs truncate">{p.name}</span>
                    <DeviceTag peer={p} />
                  </div>
                  <div className="text-[10px] font-mono text-muted truncate">
                    {p.ip}:{p.port}
                  </div>
                </div>
                <Tooltip
                  content={
                    p.initiatedBy === 'us'
                      ? 'We opened this session outward; it carries both directions.'
                      : 'They reached us through the published mapping.'
                  }
                >
                  <Badge tone="cyan">{p.initiatedBy === 'us' ? 'We dialled' : 'They dialled'}</Badge>
                </Tooltip>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/**
 * Walks the user through forwarding the port on their own router.
 *
 * The values are filled in from this device's actual address, because the
 * mistake people make is forwarding to the wrong internal host.
 */
function ManualForwardModal({
  open,
  onClose,
  net,
}: {
  open: boolean;
  onClose: () => void;
  net: NetInfo;
}) {
  const toast = useStore((s) => s.toast);
  const [copied, setCopied] = React.useState<string | null>(null);

  const rows: [string, string][] = [
    ['Service name', 'LANTern'],
    ['External port', String(net.port)],
    ['Internal port', String(net.port)],
    ['Internal IP address', net.ip],
    ['Protocol', 'TCP and UDP (or Both)'],
  ];

  const copy = async (label: string, value: string) => {
    try {
      await copyText(value);
      setCopied(label);
      setTimeout(() => setCopied(null), 1400);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Forward the port on your router"
      width="max-w-lg"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={async () => {
              await api.net.publishUpstreamManual(true);
              toast({
                kind: 'success',
                title: 'Marked as forwarded',
                body: 'Devices upstream can now start conversations with this one.',
              });
              onClose();
            }}
          >
            I've set this up
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <ol className="space-y-2 list-decimal pl-4 marker:text-muted">
          <li className="text-xs text-dim leading-relaxed">
            Open your router's admin page — usually{' '}
            <button
              onClick={() => void api.host.openInBrowser(`http://${net.gateway}`)}
              className="text-cyan hover:underline font-mono"
            >
              http://{net.gateway}
            </button>
          </li>
          <li className="text-xs text-dim leading-relaxed">
            Find <span className="text-txt">Port forwarding</span> — it may sit under
            Advanced, NAT, Firewall, or Virtual Server depending on the make.
          </li>
          <li className="text-xs text-dim leading-relaxed">
            Add a rule with exactly these values:
          </li>
        </ol>

        <div className="panel divide-y divide-edge">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-center gap-3 px-3 h-9">
              <span className="text-2xs text-muted w-36 shrink-0">{label}</span>
              <span className="text-xs font-mono text-gold flex-1 truncate">{value}</span>
              <IconButton
                label={`Copy ${label}`}
                size="xs"
                onClick={() => void copy(label, value)}
              >
                {copied === label ? (
                  <Check size={11} className="text-cyan" />
                ) : (
                  <Copy size={11} />
                )}
              </IconButton>
            </div>
          ))}
        </div>

        <p className="text-2xs text-muted leading-relaxed">
          Point the rule at <span className="font-mono text-dim">{net.ip}</span> — this
          device. If your router hands out addresses by DHCP, reserve this one for the
          device too, or the rule will point at the wrong machine after a reboot.
        </p>
      </div>
    </Modal>
  );
}

/** Three stacked networks, with the arrows that do and do not get through. */
function NatDiagram({
  net,
  upstream,
  upstreamPeers,
}: {
  net: NetInfo;
  upstream: NonNullable<NetInfo['upstream']>;
  upstreamPeers: number;
}) {
  const inboundOpen = upstream.published;

  return (
    <div className="rounded-card border border-edge bg-base/60 p-3">
      <div className="flex items-stretch gap-3">
        <div className="flex-1 min-w-0 space-y-2">
          <Tier
            label="Upstream network"
            detail={upstream.subnet}
            sub={`gateway ${upstream.gateway}`}
            tone="cyan"
            badge={
              upstreamPeers > 0
                ? `${upstreamPeers} peer${upstreamPeers === 1 ? '' : 's'}`
                : undefined
            }
          />
          <Tier
            label="Our router"
            detail={`${upstream.routerWanIp}  →  ${net.gateway}`}
            sub={net.upnpAvailable ? 'UPnP available' : 'UPnP unavailable'}
            tone="gold"
          />
          <Tier
            label="This device"
            detail={net.ip}
            sub={`port ${net.port}`}
            tone="neutral"
          />
        </div>

        {/* direction rail */}
        <div className="w-24 shrink-0 flex flex-col items-center justify-center gap-2 border-l border-edge pl-3">
          <div className="flex flex-col items-center gap-1">
            <ArrowUp size={14} className="text-cyan" />
            <span className="text-[10px] text-cyan text-center leading-tight">
              out
              <br />
              always
            </span>
          </div>
          <div className="h-px w-full bg-edge" />
          <div className="flex flex-col items-center gap-1">
            <ArrowDown size={14} className={inboundOpen ? 'text-gold' : 'text-muted'} />
            <span
              className={cn(
                'text-[10px] text-center leading-tight',
                inboundOpen ? 'text-gold' : 'text-muted',
              )}
            >
              in
              <br />
              {inboundOpen ? 'published' : 'blocked'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function Tier({
  label,
  detail,
  sub,
  tone,
  badge,
}: {
  label: string;
  detail: string;
  sub: string;
  tone: 'cyan' | 'gold' | 'neutral';
  badge?: string;
}) {
  const border = {
    cyan: 'border-cyan/30',
    gold: 'border-gold/30',
    neutral: 'border-edge',
  }[tone];

  return (
    <div className={cn('rounded-input border bg-surface px-2.5 py-1.5', border)}>
      <div className="flex items-center gap-2">
        <span className="text-2xs font-medium text-txt">{label}</span>
        {badge && <Badge tone="cyan">{badge}</Badge>}
        <span className="ml-auto text-2xs font-mono text-dim truncate">{detail}</span>
      </div>
      <div className="text-[10px] text-muted mt-0.5">{sub}</div>
    </div>
  );
}

/* ---------------------------------------------------------- Peer cards */

function PeerConnCard({ peerId, onDiagnose }: { peerId: string; onDiagnose: () => void }) {
  const peer = useStore((s) => s.peers[peerId]);
  if (!peer) return null;

  return (
    <div className="panel p-3">
      <div className="flex items-center gap-2.5">
        <Avatar name={peer.name} color={peer.color} emoji={peer.emoji} size={32} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-medium truncate">{peer.name}</span>
            <span className="text-2xs">{osGlyph(peer.os)}</span>
            <DeviceTag peer={peer} />
          </div>
          <div className="text-2xs font-mono text-muted truncate">
            {peer.ip}:{peer.port}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <ConnBadge layer={peer.layer} />
          <ScopeBadge scope={peer.scope} />
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mt-3">
        <Metric label="Latency" value={`${peer.latencyMs.toFixed(1)} ms`} tone={latencyTone(peer.latencyMs)} />
        <Metric
          label="Packet loss"
          value={`${peer.lossPct.toFixed(1)}%`}
          tone={peer.lossPct > 1 ? 'text-danger' : 'text-cyan'}
        />
        <Metric label="Trusted" value={peer.trusted ? 'Yes' : 'No'} tone="text-dim" />
      </div>

      <Button size="xs" full className="mt-2.5" icon={<Zap size={11} />} onClick={onDiagnose}>
        Test connection
      </Button>
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div className="bg-raised/60 border border-edge rounded-input px-2 py-1.5">
      <div className="text-[10px] uppercase tracking-wide text-muted">{label}</div>
      <div className={`text-xs font-mono mt-0.5 ${tone}`}>{value}</div>
    </div>
  );
}

/* ------------------------------------------------------------ Relay hub */

function RelayHubCard() {
  const net = useStore((s) => s.net);
  const setSettings = useStore((s) => s.setSettings);
  const cap = useStore((s) => s.settings.network.relayCapMbps);
  const [busy, setBusy] = React.useState(false);

  if (!net) return null;

  const toggle = async (on: boolean) => {
    setBusy(true);
    await api.net.setRelayHub(on);
    setSettings((s) => ({ ...s, network: { ...s.network, relayHub: on } }));
    setBusy(false);
  };

  return (
    <section className="panel p-4">
      <SectionTitle right={busy ? <Spinner /> : null}>Relay hub</SectionTitle>
      <p className="text-xs text-dim mb-3 leading-relaxed">
        Volunteer this device as a local TURN relay. Peers that cannot reach each other
        directly — across a double NAT, say — route through here instead. Media stays
        encrypted end to end via DTLS and never leaves the LAN.
      </p>

      <Toggle
        checked={net.relayHub}
        onChange={(v) => void toggle(v)}
        label="Act as a relay hub for other peers"
      />

      <AnimatePresence>
        {net.relayHub && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <div className="mt-3 pt-3 border-t border-edge space-y-3">
              <div className="flex items-center justify-between">
                <span className="label">Relayed this session</span>
                <span className="text-xs font-mono text-gold">{formatBytes(net.relayBytes)}</span>
              </div>
              <div className="space-y-1.5">
                <label className="label">Bandwidth cap</label>
                <Select
                  value={String(cap)}
                  onChange={(v) =>
                    setSettings((s) => ({
                      ...s,
                      network: { ...s.network, relayCapMbps: Number(v) },
                    }))
                  }
                  options={[
                    { value: '0', label: 'Unlimited (LAN default)' },
                    { value: '10', label: '10 Mbps' },
                    { value: '50', label: '50 Mbps' },
                    { value: '100', label: '100 Mbps' },
                    { value: '500', label: '500 Mbps' },
                  ]}
                />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </section>
  );
}

/* ----------------------------------------------------------- UPnP manager */

function UpnpManager() {
  const [mappings, setMappings] = React.useState<PortMapping[]>([]);
  const [port, setPort] = React.useState('7979');
  const [proto, setProto] = React.useState<'TCP' | 'UDP'>('UDP');
  const [loading, setLoading] = React.useState(true);
  const net = useStore((s) => s.net);

  const refresh = React.useCallback(async () => {
    setMappings(await api.net.upnpList());
    setLoading(false);
  }, []);

  React.useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = async () => {
    const n = parseInt(port, 10);
    if (!Number.isFinite(n) || n < 1 || n > 65535) return;
    await api.net.upnpOpen(n, proto);
    void refresh();
  };

  return (
    <section className="panel p-4">
      <SectionTitle
        right={
          <Badge tone={net?.upnpAvailable ? 'cyan' : 'danger'}>
            <Router size={9} />
            {net?.upnpAvailable ? 'Gateway responding' : 'No gateway'}
          </Badge>
        }
      >
        UPnP port mappings
      </SectionTitle>

      {loading ? (
        <div className="h-16 grid place-items-center">
          <Spinner />
        </div>
      ) : mappings.length === 0 ? (
        <p className="text-xs text-muted py-3">No mappings open on the gateway.</p>
      ) : (
        <ul className="space-y-1.5 mb-3">
          {mappings.map((m) => (
            <li
              key={m.id}
              className="flex items-center gap-2 bg-raised border border-edge rounded-input px-2.5 h-8"
            >
              <DoorOpen size={12} className="text-gold shrink-0" />
              <span className="text-xs font-mono">
                {m.external} → {m.internal}
              </span>
              <Badge tone="muted">{m.proto}</Badge>
              <span className="text-2xs text-muted truncate flex-1">{m.description}</span>
              <IconButton
                label="Close mapping"
                size="xs"
                onClick={async () => {
                  await api.net.upnpClose(m.id);
                  void refresh();
                }}
              >
                <Trash2 size={11} />
              </IconButton>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-2">
        <Input
          value={port}
          onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
          placeholder="Port"
          className="w-24"
        />
        <Select
          value={proto}
          onChange={(v) => setProto(v)}
          options={[
            { value: 'UDP', label: 'UDP' },
            { value: 'TCP', label: 'TCP' },
          ]}
          className="w-24"
        />
        <Button size="sm" icon={<Plus size={12} />} onClick={() => void add()}>
          Open
        </Button>
      </div>
    </section>
  );
}

/* ---------------------------------------------------------- Subnet bridge */

function BridgeCard() {
  const net = useStore((s) => s.net);
  if (!net) return null;
  const multiHomed = net.interfaces.length > 1;

  return (
    <section className="panel p-4">
      <SectionTitle
        right={
          <Badge tone={multiHomed ? 'cyan' : 'muted'}>
            <Layers size={9} />
            {net.interfaces.length} interface{net.interfaces.length === 1 ? '' : 's'}
          </Badge>
        }
      >
        Subnet bridge
      </SectionTitle>
      <p className="text-xs text-dim mb-3 leading-relaxed">
        {multiHomed
          ? 'This device sits on more than one network. Bridging announces LANTern on every interface and proxies discovery and signaling between them, so peers on either side can find each other.'
          : 'Bridging needs a second network interface — Ethernet and Wi-Fi on different subnets, for example.'}
      </p>
      <Toggle
        checked={net.bridging}
        disabled={!multiHomed}
        onChange={(v) => void api.net.setBridging(v)}
        label="Bridge discovery across interfaces"
        hint={
          multiHomed
            ? net.interfaces.map((i) => `${i.name} (${i.ip})`).join('  ·  ')
            : undefined
        }
      />
    </section>
  );
}

/* -------------------------------------------------------- Connection stack */

const STACK: { layer: ConnLayer; title: string; detail: string }[] = [
  {
    layer: 'direct',
    title: 'Layer 0 — Direct',
    detail: 'mDNS discovery on the same subnet, then a direct WebSocket and WebRTC peer connection. Sub-millisecond on a flat LAN.',
  },
  {
    layer: 'routed',
    title: 'Layer 1 — Routed',
    detail: 'mDNS cannot cross the subnet, so ICE candidates are exchanged through a shared peer and gathered against the bundled STUN server.',
  },
  {
    layer: 'upnp',
    title: 'Layer 2 — UPnP punch',
    detail: 'LANTern asks each gateway for a temporary port mapping over UPnP or NAT-PMP, then shares the mapped address out of band.',
  },
  {
    layer: 'relayed',
    title: 'Layer 3 — Local relay',
    detail: 'A peer reachable from both sides volunteers as a TURN-style relay and forwards media. No internet involved.',
  },
  {
    layer: 'manual',
    title: 'Layer 4 — Manual',
    detail: 'You supply the address yourself: IP and port, a scanned QR code, or a six-word pairing phrase. Always works if you know where the peer is.',
  },
];

function ConnectionStack() {
  const peers = useStore((s) => s.peers);
  const counts = Object.values(peers).reduce<Record<string, number>>((acc, p) => {
    acc[p.layer] = (acc[p.layer] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <section className="panel p-4">
      <SectionTitle>Connection stack</SectionTitle>
      <p className="text-xs text-dim mb-3">
        LANTern tries each layer in order and stops at the first that connects.
      </p>
      <ol className="space-y-1.5">
        {STACK.map((s) => {
          const meta = LAYER_META[s.layer];
          const Icon = meta.icon;
          const n = counts[s.layer] ?? 0;
          return (
            <li
              key={s.layer}
              className="flex gap-3 p-2.5 rounded-input bg-raised/50 border border-edge"
            >
              <span className="h-6 w-6 shrink-0 rounded-input bg-base border border-edge grid place-items-center text-gold">
                <Icon size={12} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium">{s.title}</span>
                  {n > 0 && (
                    <Badge tone="cyan">
                      {n} peer{n === 1 ? '' : 's'}
                    </Badge>
                  )}
                </div>
                <p className="text-2xs text-muted mt-0.5 leading-relaxed">{s.detail}</p>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/* -------------------------------------------------------------- Add peer */

function AddPeerModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = React.useState<'address' | 'qr' | 'phrase'>('address');
  const [ip, setIp] = React.useState('');
  const [port, setPort] = React.useState('7979');
  const [phrase, setPhrase] = React.useState('');
  const [busy, setBusy] = React.useState(false);
  const toast = useStore((s) => s.toast);

  const check = validatePhrase(phrase);
  const ipValid = /^(\d{1,3}\.){3}\d{1,3}$/.test(ip.trim());

  const connectAddress = async () => {
    setBusy(true);
    try {
      const peer = await api.net.addManualPeer(ip.trim(), parseInt(port, 10) || 7979);
      toast({ kind: 'success', title: 'Peer added', body: `${peer.ip}:${peer.port}` });
      onClose();
      setIp('');
    } finally {
      setBusy(false);
    }
  };

  const connectPhrase = async () => {
    setBusy(true);
    try {
      const peer = await api.net.addByPhrase(phrase.trim().toLowerCase());
      toast({ kind: 'success', title: 'Paired', body: peer.name });
      onClose();
      setPhrase('');
    } catch (err) {
      // A phrase carries the address itself, so one that will not decode is a
      // mistyped or misheard word rather than a peer that is not answering.
      toast({
        kind: 'error',
        title: 'That phrase did not work',
        body: String(err ?? 'Check the words and try again.'),
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Add a peer" width="max-w-lg">
      <div className="flex gap-1 mb-4 bg-raised border border-edge rounded-input p-[2px]">
        {(
          [
            ['address', 'IP address'],
            ['qr', 'QR code'],
            ['phrase', 'Pairing phrase'],
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`flex-1 h-7 rounded-[4px] text-xs transition-colors ${
              tab === k ? 'bg-gold text-[#1a1206] font-medium' : 'text-dim hover:text-txt'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'address' && (
        <div className="space-y-3">
          <p className="text-xs text-dim">
            Use this when mDNS cannot reach the peer — a different subnet, or a network that
            blocks multicast. You need the address the peer shows in its own Network panel.
          </p>
          <div className="flex gap-2">
            <div className="flex-1 space-y-1.5">
              <label className="label">IP address</label>
              <Input
                value={ip}
                onChange={(e) => setIp(e.target.value)}
                placeholder="192.168.1.42"
                className="font-mono"
              />
            </div>
            <div className="w-24 space-y-1.5">
              <label className="label">Port</label>
              <Input
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/\D/g, '').slice(0, 5))}
                className="font-mono"
              />
            </div>
          </div>
          <Button
            variant="primary"
            full
            disabled={!ipValid || busy}
            onClick={() => void connectAddress()}
          >
            {busy ? 'Connecting…' : 'Connect'}
          </Button>
        </div>
      )}

      {tab === 'qr' && (
        <div className="space-y-3">
          <p className="text-xs text-dim">
            Scan the invite code shown on the other device. On Android LANTern opens the
            camera; on desktop, pick a photo of the code.
          </p>
          <div className="h-40 rounded-card border border-dashed border-edge-strong grid place-items-center bg-raised/40">
            <div className="text-center">
              <QrIcon size={26} className="mx-auto text-muted mb-2" />
              <p className="text-2xs text-muted">
                Camera scanning is available in the packaged app
              </p>
            </div>
          </div>
          <Button full>Choose an image…</Button>
        </div>
      )}

      {tab === 'phrase' && (
        <div className="space-y-3">
          <p className="text-xs text-dim">
            Six words derived from the other device's fingerprint. Read it aloud, text it,
            or write it down — the phrase is the out-of-band channel.
          </p>
          <div className="space-y-1.5">
            <label className="label">Pairing phrase</label>
            <Input
              value={phrase}
              onChange={(e) => setPhrase(e.target.value)}
              placeholder="amber lantern quiet river copper signal"
              className="font-mono"
            />
            {phrase.trim() && !check.valid && (
              <p className="text-2xs text-danger">
                {check.reason}
                {check.unknownWords.length ? `: ${check.unknownWords.join(', ')}` : ''}
              </p>
            )}
          </div>
          <Button
            variant="primary"
            full
            disabled={!check.valid || busy}
            onClick={() => void connectPhrase()}
          >
            {busy ? 'Pairing…' : 'Pair'}
          </Button>
        </div>
      )}
    </Modal>
  );
}

/* --------------------------------------------------------------- Invite */

function InviteModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [invite, setInvite] = React.useState<{ phrase: string; payload: string } | null>(null);
  const [copied, setCopied] = React.useState<'phrase' | 'payload' | null>(null);

  React.useEffect(() => {
    if (open) void api.net.invite().then(setInvite);
  }, [open]);

  const copy = async (what: 'phrase' | 'payload', text: string) => {
    try {
      await copyText(text);
      setCopied(what);
      setTimeout(() => setCopied(null), 1600);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Invite a device">
      {!invite ? (
        <div className="h-40 grid place-items-center">
          <Spinner size={18} />
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-xs text-dim">
            Share either of these with the other device. Both encode the same address and
            fingerprint — nothing is sent anywhere, you carry it across yourself.
          </p>

          <div className="flex justify-center">
            <div className="p-2.5 bg-[#E6EAF3] rounded-card">
              <QrCode value={invite.payload} size={168} />
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="label">Pairing phrase</div>
            <div className="flex items-center gap-2 bg-raised border border-edge rounded-input px-2.5 h-9">
              <span className="text-xs font-mono text-gold flex-1 truncate">
                {invite.phrase}
              </span>
              <IconButton
                label="Copy phrase"
                size="xs"
                onClick={() => void copy('phrase', invite.phrase)}
              >
                {copied === 'phrase' ? (
                  <Check size={11} className="text-cyan" />
                ) : (
                  <Copy size={11} />
                )}
              </IconButton>
            </div>
          </div>

          <div className="space-y-1.5">
            <div className="label">Connection link</div>
            <div className="flex items-center gap-2 bg-raised border border-edge rounded-input px-2.5 h-9">
              <span className="text-2xs font-mono text-dim flex-1 truncate">
                {invite.payload}
              </span>
              <IconButton
                label="Copy link"
                size="xs"
                onClick={() => void copy('payload', invite.payload)}
              >
                {copied === 'payload' ? (
                  <Check size={11} className="text-cyan" />
                ) : (
                  <Copy size={11} />
                )}
              </IconButton>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* --------------------------------------------------------- Diagnostics */

function DiagnosticsModal({ peerId, onClose }: { peerId: string | null; onClose: () => void }) {
  const peer = useStore((s) => (peerId ? s.peers[peerId] : null));
  const [steps, setSteps] = React.useState<DiagStep[]>([]);
  const [running, setRunning] = React.useState(false);

  React.useEffect(() => {
    if (!peerId) {
      setSteps([]);
      return;
    }
    let cancelled = false;
    setRunning(true);
    setSteps([]);
    void api.net.diagnose(peerId).then((all) => {
      if (cancelled) return;
      // Reveal one layer at a time so the fallback order is legible.
      all.forEach((step, i) => {
        setTimeout(() => {
          if (cancelled) return;
          setSteps((prev) => [...prev, step]);
          if (i === all.length - 1) setRunning(false);
        }, 380 * (i + 1));
      });
      if (!all.length) setRunning(false);
    });
    return () => {
      cancelled = true;
    };
  }, [peerId]);

  return (
    <Modal
      open={!!peerId}
      onClose={onClose}
      title={peer ? `Connection test — ${peer.name}` : 'Connection test'}
      width="max-w-lg"
    >
      <div className="space-y-2">
        {steps.map((s, i) => {
          const meta = LAYER_META[s.layer];
          const Icon = meta.icon;
          return (
            <motion.div
              key={i}
              initial={{ opacity: 0, x: -8 }}
              animate={{ opacity: 1, x: 0 }}
              className={`flex gap-3 p-3 rounded-card border ${
                s.ok ? 'border-cyan/40 bg-cyan/5' : 'border-edge bg-raised/50'
              }`}
            >
              <span
                className={`h-6 w-6 shrink-0 rounded-input grid place-items-center border ${
                  s.ok ? 'border-cyan/40 text-cyan' : 'border-edge text-muted'
                }`}
              >
                {s.ok ? <Check size={12} /> : <X size={12} />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Icon size={11} className={s.ok ? 'text-cyan' : 'text-muted'} />
                  <span className="text-xs font-medium">{meta.label}</span>
                  {s.rttMs !== undefined && (
                    <Badge tone="cyan">{s.rttMs.toFixed(1)} ms</Badge>
                  )}
                </div>
                <p className="text-2xs text-muted mt-0.5">{s.detail}</p>
              </div>
            </motion.div>
          );
        })}

        {running && (
          <div className="flex items-center gap-2 p-3 text-xs text-muted">
            <Spinner />
            Probing next layer…
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ----------------------------------------------------------- Firewall */

const FIREWALL_GUIDE: Record<string, { title: string; steps: string[]; command?: string }> = {
  windows: {
    title: 'Windows Defender Firewall',
    steps: [
      'Open Windows Security → Firewall & network protection → Advanced settings.',
      'Choose Inbound Rules → New Rule → Port.',
      'Add TCP 7979 and UDP 7979, 7980, then allow the connection on Private networks.',
    ],
    command:
      'netsh advfirewall firewall add rule name="LANTern" dir=in action=allow protocol=UDP localport=7979,7980',
  },
  macos: {
    title: 'macOS firewall',
    steps: [
      'System Settings → Network → Firewall → Options.',
      'Add LANTern to the list and set it to “Allow incoming connections”.',
      'macOS asks on first launch — if you dismissed that prompt, add it here.',
    ],
  },
  linux: {
    title: 'Linux (ufw / firewalld)',
    steps: [
      'Allow the signaling and STUN ports on your LAN interface only.',
      'No root is needed to run LANTern itself — only to change firewall rules.',
    ],
    command: 'sudo ufw allow from 192.168.0.0/16 to any port 7979,7980 proto udp',
  },
  android: {
    title: 'Android',
    steps: [
      'Android has no user firewall by default — no configuration needed.',
      'If a VPN or private-DNS app is active, exempt LANTern so LAN traffic stays local.',
    ],
  },
};

function FirewallModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [os, setOs] = React.useState<string>('windows');
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (open) void api.profile.os().then(setOs);
  }, [open]);

  const guide = FIREWALL_GUIDE[os] ?? FIREWALL_GUIDE.windows;

  return (
    <Modal open={open} onClose={onClose} title="Firewall setup" width="max-w-lg">
      <div className="space-y-4">
        <div className="flex gap-2 items-center">
          <span className="label">Platform</span>
          <Select
            value={os}
            onChange={setOs}
            options={[
              { value: 'windows', label: 'Windows' },
              { value: 'macos', label: 'macOS' },
              { value: 'linux', label: 'Linux' },
              { value: 'android', label: 'Android' },
            ]}
            className="w-40"
          />
        </div>

        <div className="panel p-3 bg-raised/40">
          <div className="flex gap-4 text-xs">
            <div>
              <div className="label mb-1">Signaling</div>
              <div className="font-mono text-gold">7979 TCP + UDP</div>
            </div>
            <div>
              <div className="label mb-1">STUN</div>
              <div className="font-mono text-gold">7980 UDP</div>
            </div>
          </div>
        </div>

        <div>
          <h4 className="text-xs font-semibold mb-2">{guide.title}</h4>
          <ol className="space-y-1.5 list-decimal pl-4 marker:text-muted">
            {guide.steps.map((s, i) => (
              <li key={i} className="text-xs text-dim leading-relaxed">
                {s}
              </li>
            ))}
          </ol>
        </div>

        {guide.command && (
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="label">Or run this</span>
              <button
                onClick={async () => {
                  await copyText(guide.command!);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                }}
                className="text-2xs text-muted hover:text-txt flex items-center gap-1"
              >
                {copied ? <Check size={10} className="text-cyan" /> : <Copy size={10} />}
                {copied ? 'Copied' : 'Copy'}
              </button>
            </div>
            <pre className="bg-base border border-edge rounded-input p-2.5 text-2xs font-mono text-glow overflow-x-auto">
              {guide.command}
            </pre>
          </div>
        )}

        <p className="text-2xs text-muted">
          LANTern never opens an outbound internet connection. Restricting these rules to your
          local subnet is safe and recommended.
        </p>
      </div>
    </Modal>
  );
}
