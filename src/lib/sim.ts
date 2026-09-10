/**
 * Browser-only stand-in for the Rust backend.
 *
 * Lets the full UI be developed and demoed with `npm run dev` alone. Under
 * Tauri this module is never imported.
 */
import { emit } from './bridge';
import type {
  ConnLayer,
  DiagStep,
  Initiator,
  NetInfo,
  OS,
  Peer,
  MediaItem,
  PeerScope,
  PortMapping,
  GameSession,
  Share,
  Transfer,
  WatchParty,
} from './types';
import { uid } from './utils';

const rnd = (a: number, b: number) => a + Math.random() * (b - a);

/** Small stable hash, so a given opponent always races at the same pace. */
const hashish = (s: string) => {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
};
const pick = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

const SEED: Array<Partial<Peer> & { name: string; os: OS }> = [
  { name: 'Nadia', os: 'macos', color: '#39D9C8', emoji: '🦊', layer: 'direct', ip: '192.168.1.24' },
  { name: 'Ravi', os: 'windows', color: '#F5A623', emoji: '🎧', layer: 'direct', ip: '192.168.1.31' },
  { name: 'Studio-PC', os: 'linux', color: '#9B8CFF', emoji: '🖥', layer: 'upnp', ip: '10.0.4.12' },
  { name: 'Tomas', os: 'android', color: '#E05C5C', emoji: '🚀', layer: 'relayed', ip: '10.0.4.88' },
  { name: 'Workshop', os: 'linux', color: '#7BD88F', emoji: '🔧', layer: 'routed', ip: '192.168.5.9' },
];

/** Devices sitting on the outer LAN, found only by probing outward. */
const UPSTREAM_SEED: Array<Partial<Peer> & { name: string; os: OS }> = [
  { name: 'Living-room TV', os: 'linux', color: '#5BA9F5', emoji: '📺', ip: '192.168.0.14' },
  { name: 'Anja', os: 'android', color: '#FF8FC7', emoji: '🌵', ip: '192.168.0.37' },
  { name: 'Office-NAS', os: 'linux', color: '#7BD88F', emoji: '🗄', ip: '192.168.0.52' },
];


/**
 * Titles standing in for a real media folder. Durations and sizes are
 * plausible so the Theatre's layout and progress maths are exercised properly.
 */
const MEDIA_SEED: Array<
  Omit<MediaItem, 'id' | 'shareId' | 'streamUrl' | 'addedAt' | 'progressSec'>
> = [
  {
    title: 'The Quiet Harbour',
    relPath: 'films/the-quiet-harbour.mp4',
    durationSec: 6720,
    sizeBytes: 4_182_302_720,
    year: 2023,
    kind: 'film',
    genres: ['Drama', 'Slow cinema'],
    synopsis:
      'A lighthouse keeper counts the ships that never come in, and the winter that finally does.',
  },
  {
    title: 'Copper Signal',
    relPath: 'films/copper-signal.mp4',
    durationSec: 5940,
    sizeBytes: 3_508_170_752,
    year: 2021,
    kind: 'film',
    genres: ['Thriller', 'Tech'],
    synopsis:
      'Two engineers discover their city\u2019s emergency network has been answering calls nobody placed.',
  },
  {
    title: 'Northern Lantern',
    relPath: 'films/northern-lantern.mp4',
    durationSec: 7500,
    sizeBytes: 5_912_797_184,
    year: 2024,
    kind: 'film',
    genres: ['Adventure'],
    synopsis: 'A winter crossing of the archipelago, filmed entirely by lamplight.',
  },
  {
    title: 'Subnet',
    relPath: 'series/subnet/s01e01.mp4',
    durationSec: 2760,
    sizeBytes: 1_509_949_440,
    year: 2022,
    kind: 'episode',
    series: 'Subnet',
    season: 1,
    episode: 1,
    genres: ['Sci-fi'],
    synopsis: 'The building gets its own network. The building starts making decisions.',
  },
  {
    title: 'Subnet',
    relPath: 'series/subnet/s01e02.mp4',
    durationSec: 2820,
    sizeBytes: 1_556_925_644,
    year: 2022,
    kind: 'episode',
    series: 'Subnet',
    season: 1,
    episode: 2,
    genres: ['Sci-fi'],
    synopsis: 'Floor seven goes dark, and the lift starts skipping it.',
  },
  {
    title: 'Subnet',
    relPath: 'series/subnet/s01e03.mp4',
    durationSec: 2700,
    sizeBytes: 1_476_395_008,
    year: 2022,
    kind: 'episode',
    series: 'Subnet',
    season: 1,
    episode: 3,
    genres: ['Sci-fi'],
    synopsis: 'Someone answers the intercom from a flat that was never let.',
  },
  {
    title: 'Grain & Gravel',
    relPath: 'films/grain-and-gravel.mp4',
    durationSec: 5280,
    sizeBytes: 2_899_102_924,
    year: 2019,
    kind: 'film',
    genres: ['Documentary'],
    synopsis: 'Three quarries, four seasons, and the people who move the mountain.',
  },
  {
    title: 'Ember Season',
    relPath: 'films/ember-season.mp4',
    durationSec: 6300,
    sizeBytes: 3_972_844_748,
    year: 2020,
    kind: 'film',
    genres: ['Drama'],
    synopsis: 'A family runs a fire lookout for one last summer.',
  },
  {
    title: 'Workshop Notes',
    relPath: 'clips/workshop-notes.mp4',
    durationSec: 640,
    sizeBytes: 268_435_456,
    kind: 'clip',
    genres: ['How-to'],
    synopsis: 'Fifteen minutes on sharpening, filmed on a phone propped against a tin.',
  },
  {
    title: 'Rooftop Timelapse',
    relPath: 'clips/rooftop-timelapse.mp4',
    durationSec: 214,
    sizeBytes: 96_468_992,
    kind: 'clip',
    genres: ['Short'],
    synopsis: 'Nine hours of weather over the harbour, compressed to three minutes.',
  },
];

let media: MediaItem[] = [];
let party: WatchParty | null = null;
let session: GameSession | null = null;
let opponentTimer: number | undefined;

let peers: Peer[] = [];
let net: NetInfo = {
  ip: '192.168.1.17',
  subnet: '255.255.255.0',
  gateway: '192.168.1.1',
  nat: 'double',
  upnpAvailable: true,
  interfaces: [
    { name: 'Ethernet', ip: '192.168.1.17', kind: 'ethernet', mask: '255.255.255.0', cidr: '192.168.1.0/24' },
    { name: 'Wi-Fi', ip: '10.0.4.5', kind: 'wifi', mask: '255.255.255.0', cidr: '10.0.4.0/24' },
  ],
  port: 7979,
  stunPort: 7980,
  relayHub: false,
  relayBytes: 0,
  bridging: false,
  hostPort: 7981,
  upstream: {
    routerWanIp: '192.168.0.23',
    // The simulator pretends the router answered, so the panel shows the
    // confirmed styling rather than the estimate styling.
    wanConfirmed: true,
    wanIsPrivate: true,
    subnet: '192.168.0.0/24',
    gateway: '192.168.0.1',
    reachable: false,
    published: false,
    publishedVia: null,
    publishedAddress: null,
    lastScanAt: null,
    hostsScanned: 0,
    // Two uplinks, so the multi-WAN path is exercised in the preview.
    wans: [
      { externalIp: '203.0.113.14', service: 'WANIPConnection:1', published: false },
      { externalIp: '198.51.100.7', service: 'WANIPConnection:2', published: false },
    ],
  },
};

let mappings: PortMapping[] = [
  { id: uid(), external: 7979, internal: 7979, proto: 'UDP', description: 'LANTern signaling' },
  { id: uid(), external: 7979, internal: 7979, proto: 'TCP', description: 'LANTern signaling' },
];

const transfers = new Map<string, Transfer>();
let shares: Share[] = [];
let started = false;

function makePeer(
  s: Partial<Peer> & { name: string; os: OS },
  scope: PeerScope = 'local',
  initiatedBy: Initiator = 'us',
): Peer {
  const layer = (s.layer ?? 'direct') as ConnLayer;
  const id = uid();
  return {
    id,
    deviceId: id,
    name: s.name,
    color: s.color ?? '#F5A623',
    emoji: s.emoji ?? '🏮',
    os: s.os,
    ip: s.ip ?? '192.168.1.50',
    addresses: [s.ip ?? '192.168.1.50'],
    port: 7979,
    layer,
    latencyMs: Math.round(layer === 'direct' ? rnd(0.4, 3) : layer === 'relayed' ? rnd(18, 42) : rnd(4, 14)),
    lossPct: layer === 'relayed' ? +rnd(0, 1.4).toFixed(1) : 0,
    status: 'available',
    lastSeen: Date.now(),
    trusted: true,
    scope,
    initiatedBy,
  };
}

export function start() {
  if (started) return;
  started = true;

  // Peers trickle in the way real mDNS discovery does.
  SEED.forEach((s, i) => {
    setTimeout(() => {
      const p = makePeer(s);
      peers.push(p);
      emit('peer:joined', p);
    }, 300 + i * 550);
  });

  setInterval(() => {
    peers.forEach((p) => {
      const base = p.layer === 'direct' ? 1.4 : p.layer === 'relayed' ? 28 : 9;
      p.latencyMs = Math.max(0.3, +(base + rnd(-base * 0.4, base * 0.6)).toFixed(1));
      p.lastSeen = Date.now();
      emit('peer:updated', p);
    });
    if (net.relayHub) {
      net.relayBytes += Math.round(rnd(40_000, 260_000));
      emit('net:changed', net);
    }
  }, 2600);

  // Occasional inbound chatter so presence/typing UI has something to show.
  setInterval(() => {
    if (!peers.length || Math.random() > 0.35) return;
    const p = pick(peers);
    emit('typing', { peerId: p.id });
  }, 9000);

  // Peers browsing whatever folders are currently published.
  setInterval(() => {
    const live = shares.filter((s) => s.running);
    if (!live.length) return;
    let touched = false;
    for (const share of live) {
      if (Math.random() > 0.45) continue;
      const hits = Math.ceil(rnd(1, 5));
      share.requests += hits;
      share.bytesServed += Math.round(rnd(18_000, 900_000) * hits);
      share.lastRequestAt = Date.now();
      share.activeViewers = Math.max(
        0,
        Math.min(peers.length, share.activeViewers + (Math.random() > 0.6 ? 1 : -1)),
      );
      touched = true;
    }
    if (touched) emit('host:changed', shares.map((s) => ({ ...s })));
  }, 3200);
}

export async function handle(cmd: string, args: any): Promise<any> {
  await new Promise((r) => setTimeout(r, 20));
  switch (cmd) {
    case 'start_services':
      return null;

    case 'host_os':
      return navigator.userAgent.includes('Win')
        ? 'windows'
        : navigator.userAgent.includes('Mac')
          ? 'macos'
          : navigator.userAgent.includes('Android')
            ? 'android'
            : 'linux';

    case 'net_info':
      return { ...net };

    case 'net_set_relay_hub':
      net.relayHub = args.on;
      emit('net:changed', net);
      return null;

    case 'net_set_bridging':
      net.bridging = args.on;
      emit('net:changed', net);
      return null;

    case 'net_set_port':
      net.port = args.port;
      emit('net:changed', net);
      return null;

    case 'net_add_manual_peer': {
      const p = makePeer({
        name: `${args.ip}`,
        os: 'unknown',
        ip: args.ip,
        layer: 'manual',
      });
      p.port = args.port;
      peers.push(p);
      emit('peer:joined', p);
      return p;
    }

    case 'net_add_by_phrase': {
      const p = makePeer({ name: 'Paired device', os: 'unknown', layer: 'manual' });
      peers.push(p);
      emit('peer:joined', p);
      return p;
    }

    case 'net_diagnose': {
      const peer = peers.find((p) => p.id === args.peerId);
      const layer = peer?.layer ?? 'relayed';
      const order: ConnLayer[] = ['direct', 'routed', 'upnp', 'relayed', 'manual'];
      const target = order.indexOf(layer);
      const detailFail: Record<string, string> = {
        direct: 'mDNS query timed out — peer is not on this subnet',
        routed: 'ICE host candidates unreachable across subnet boundary',
        upnp: 'Gateway returned no AddPortMapping response',
        relayed: 'No reachable relay hub volunteered',
        manual: 'No manual address on file',
      };
      const steps: DiagStep[] = [];
      for (let i = 0; i < order.length; i++) {
        const l = order[i];
        if (i < target) {
          steps.push({ layer: l, ok: false, detail: detailFail[l] });
        } else if (i === target) {
          steps.push({
            layer: l,
            ok: true,
            detail: 'Connection established',
            rttMs: peer?.latencyMs ?? 12,
          });
          break;
        }
      }
      return steps;
    }

    case 'net_invite':
      return {
        phrase: 'amber lantern quiet river copper signal',
        payload: `lantern://connect?ip=${net.ip}&port=${net.port}&fp=8f2a41c9`,
      };

    /**
     * Probe the outer LAN. Traffic outward through our own router is allowed,
     * so a sweep finds upstream peers even though they cannot reach in to us.
     */
    case 'net_scan_upstream': {
      if (!net.upstream) return [];
      const found: Peer[] = [];
      const known = new Set(peers.map((p) => p.ip));

      for (const seed of UPSTREAM_SEED) {
        if (known.has(seed.ip!)) continue;
        const p = makePeer({ ...seed, layer: 'routed' }, 'upstream', 'us');
        p.latencyMs = +rnd(3, 11).toFixed(1);
        found.push(p);
        peers.push(p);
      }

      net.upstream = {
        ...net.upstream,
        reachable: true,
        lastScanAt: Date.now(),
        hostsScanned: 254,
      };

      // Results arrive as the sweep progresses rather than all at once.
      found.forEach((p, i) => setTimeout(() => emit('peer:joined', p), 400 + i * 500));
      setTimeout(() => emit('net:changed', net), 300);
      return found;
    }

    /**
     * Open a mapping on our own router so upstream devices can initiate to us,
     * which is the direction a double NAT otherwise blocks outright.
     */
    case 'net_publish_upstream': {
      if (!net.upstream) return null;
      const on = args.on as boolean;
      const address = `${net.upstream.routerWanIp}:${net.port}`;

      if (on) {
        mappings.push({
          id: uid(),
          external: net.port,
          internal: net.port,
          proto: 'TCP',
          description: 'LANTern upstream reachability',
        });
      } else {
        mappings = mappings.filter(
          (m) => m.description !== 'LANTern upstream reachability',
        );
      }

      net.upstream = {
        ...net.upstream,
        published: on,
        publishedVia: on ? 'upnp' : null,
        publishedAddress: on ? address : null,
        wans: net.upstream.wans.map((w) => ({ ...w, published: on })),
      };
      emit('net:changed', net);
      return net.upstream;
    }

    case 'net_publish_upstream_manual': {
      if (!net.upstream) return null;
      const on = args.on as boolean;
      net.upstream = {
        ...net.upstream,
        published: on,
        publishedVia: on ? 'manual' : null,
        publishedAddress: on ? `${net.upstream.routerWanIp}:${net.port}` : null,
      };
      emit('net:changed', net);
      return net.upstream;
    }


    /* ------------------------------------------------------------ games */

    case 'game_start': {
      session = {
        id: uid(),
        game: args.game,
        seed: args.seed,
        hostId: 'me',
        players: ['me', ...args.peerIds],
        startedAt: Date.now(),
        progress: {},
      };

      // Give the opponents a plausible pace so the race panel has something to
      // show while there is no real peer on the other end.
      clearInterval(opponentTimer);
      const started = Date.now();
      opponentTimer = window.setInterval(() => {
        if (!session) return;
        for (const peerId of session.players.filter((p) => p !== 'me')) {
          const previous = session.progress[peerId];
          if (previous?.finished) continue;
          const pace = 0.006 + (hashish(peerId) % 5) * 0.0018;
          const completion = Math.min(1, (previous?.completion ?? 0) + pace);
          session.progress[peerId] = {
            peerId,
            completion,
            moves: Math.round(completion * 180),
            elapsedMs: Date.now() - started,
            finished: completion >= 1,
            finishedAt: completion >= 1 ? Date.now() : undefined,
          };
          if (completion >= 1 && !session.winnerId) session.winnerId = peerId;
        }
        emit('game:session', { ...session, progress: { ...session.progress } });
      }, 1000);

      emit('game:session', { ...session });
      return { ...session };
    }

    case 'game_report': {
      if (!session || session.id !== args.sessionId) return null;
      session.progress['me'] = {
        peerId: 'me',
        completion: args.completion,
        moves: args.moves,
        elapsedMs: args.elapsedMs,
        finished: args.finished,
        finishedAt: args.finished ? Date.now() : undefined,
      };
      if (args.finished && !session.winnerId) session.winnerId = 'me';
      emit('game:session', { ...session, progress: { ...session.progress } });
      return { ...session };
    }

    case 'game_lobby': {
      if (!session || session.id !== args.sessionId) return null;
      session.waiting = args.waiting ?? [];
      session.nextGame = args.nextGame ?? undefined;
      emit('game:session', { ...session });
      return { ...session };
    }

    case 'game_leave':
      clearInterval(opponentTimer);
      session = null;
      emit('game:session', null);
      return null;

    /* ----------------------------------------------------------- party */

    case 'party_start': {
      party = {
        id: uid(),
        itemId: args.itemId,
        hostId: 'me',
        members: args.memberIds,
        playing: true,
        positionSec: 0,
        updatedAt: Date.now(),
      };
      emit('party:changed', { ...party });
      return { ...party };
    }

    case 'party_sync': {
      if (party && party.id === args.partyId) {
        party.playing = args.playing;
        party.positionSec = args.positionSec;
        party.updatedAt = Date.now();
        emit('party:changed', { ...party });
      }
      return null;
    }

    case 'party_leave':
      party = null;
      emit('party:changed', null);
      return null;

    /* ---------------------------------------------------------- system */

    // A browser has no tray; the UI reads this to hide those settings.
    case 'tray_supported':
      return false;

    case 'window_hide_to_tray':
    case 'window_show':
      return null;

    case 'autostart_get':
      return false;

    case 'autostart_set':
      return args.enabled;

    /* --------------------------------------------------------- theatre */

    case 'media_list':
    case 'media_scan': {
      if (!media.length) media = buildLibrary();
      return media.map((m) => ({ ...m }));
    }

    case 'media_set_progress': {
      const item = media.find((m) => m.id === args.id);
      if (item) item.progressSec = args.progressSec;
      emit('media:changed', media.map((m) => ({ ...m })));
      return null;
    }

    /* ------------------------------------------------------- hosting */

    case 'host_list':
      return shares.map((s) => ({ ...s }));

    case 'host_create': {
      const share: Share = {
        id: uid(),
        name: args.name,
        path: args.path,
        slug: args.slug,
        mode: args.mode,
        running: true,
        requirePhrase: args.requirePhrase,
        phrase: args.requirePhrase ? 'copper signal quiet river' : undefined,
        allowUpload: args.allowUpload,
        fileCount: args.fileCount,
        totalBytes: args.totalBytes,
        createdAt: Date.now(),
        requests: 0,
        bytesServed: 0,
        activeViewers: 0,
        lastRequestAt: null,
      };
      shares.push(share);
      emit('host:changed', shares.map((s) => ({ ...s })));
      return { ...share };
    }

    case 'host_set_running': {
      const share = shares.find((s) => s.id === args.id);
      if (!share) return null;
      share.running = args.running;
      if (!args.running) share.activeViewers = 0;
      emit('host:changed', shares.map((s) => ({ ...s })));
      return { ...share };
    }

    case 'host_update': {
      const share = shares.find((s) => s.id === args.id);
      if (!share) return null;
      Object.assign(share, args.patch);
      emit('host:changed', shares.map((s) => ({ ...s })));
      return { ...share };
    }

    case 'host_remove':
      shares = shares.filter((s) => s.id !== args.id);
      emit('host:changed', shares.map((s) => ({ ...s })));
      return null;

    case 'host_rescan':
      return null;

    // A browser cannot read a real directory, so nothing is reported and the
    // UI keeps whatever the file picker staged.
    case 'host_probe':
      return {
        exists: false,
        fileCount: 0,
        totalBytes: 0,
        hasIndexHtml: false,
        videoCount: 0,
      };

    case 'host_open':
      window.open(args.url, '_blank', 'noopener');
      return null;

    case 'net_upnp_list':
      return [...mappings];

    case 'net_upnp_open': {
      const m: PortMapping = {
        id: uid(),
        external: args.internal,
        internal: args.internal,
        proto: args.proto,
        description: 'LANTern manual',
      };
      mappings.push(m);
      return m;
    }

    case 'net_upnp_close':
      mappings = mappings.filter((m) => m.id !== args.id);
      return null;

    case 'peers_list':
      return [...peers];

    case 'peers_ping': {
      const p = peers.find((x) => x.id === args.peerId);
      return p?.latencyMs ?? 999;
    }

    case 'peers_trust': {
      const p = peers.find((x) => x.id === args.peerId);
      if (p) p.trusted = args.trusted;
      return null;
    }

    case 'chat_send':
      // No peers in the browser preview, so nothing is delivered.
      return 0;

    case 'chat_typing':
      return null;

    case 'chat_react':
      return null;

    case 'files_offer': {
      const out: Transfer[] = args.files.map((f: any) => ({
        id: uid(),
        name: f.name,
        size: f.size,
        sent: 0,
        peerId: args.peerId,
        direction: 'out' as const,
        state: 'active' as const,
        speedBps: 0,
        startedAt: Date.now(),
        mime: f.mime,
      }));
      out.forEach((t) => {
        transfers.set(t.id, t);
        driveTransfer(t.id);
      });
      return out;
    }

    case 'files_pause': {
      const t = transfers.get(args.id);
      if (t && t.state === 'active') t.state = 'paused';
      return null;
    }

    case 'files_resume': {
      const t = transfers.get(args.id);
      if (t && t.state === 'paused') {
        t.state = 'active';
        driveTransfer(t.id);
      }
      return null;
    }

    case 'files_cancel': {
      const t = transfers.get(args.id);
      if (t) {
        t.state = 'cancelled';
        emit('transfer:progress', { ...t });
      }
      return null;
    }

    case 'files_reveal':
    case 'files_open':
      return null;

    default:
      return null;
  }
}


/**
 * Assembles the library the way the real scanner will: each media share on the
 * network contributes its files, addressed at the publishing device's host port.
 */
function buildLibrary(): MediaItem[] {
  const owners = [
    { peerId: undefined as string | undefined, ip: net.ip, shareId: 'local-media' },
    ...peers.slice(0, 2).map((p, i) => ({
      peerId: p.id,
      ip: p.ip,
      shareId: `share-${i}`,
    })),
  ];

  return MEDIA_SEED.map((seed, i) => {
    const owner = owners[i % owners.length];
    return {
      ...seed,
      id: `media-${i}`,
      shareId: owner.shareId,
      peerId: owner.peerId,
      streamUrl: `http://${owner.ip}:${net.hostPort}/theatre/${seed.relPath}`,
      addedAt: Date.now() - i * 86_400_000,
      // A couple of part-watched titles so Continue watching is populated.
      progressSec: i === 1 ? 2140 : i === 3 ? 900 : 0,
    };
  });
}

function driveTransfer(id: string) {
  const tick = () => {
    const t = transfers.get(id);
    if (!t || t.state !== 'active') return;
    // LAN speeds: roughly 20–90 MB/s, jittered.
    const bps = rnd(20, 90) * 1024 * 1024;
    t.speedBps = bps;
    t.sent = Math.min(t.size, t.sent + bps * 0.25);
    if (t.sent >= t.size) {
      t.state = 'done';
      t.finishedAt = Date.now();
      t.speedBps = 0;
      emit('transfer:progress', { ...t });
      return;
    }
    emit('transfer:progress', { ...t });
    setTimeout(tick, 250);
  };
  setTimeout(tick, 250);
}
