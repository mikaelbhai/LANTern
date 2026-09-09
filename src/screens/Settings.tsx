import React from 'react';
import {
  Bell,
  FolderOpen,
  Info,
  Lock,
  MonitorCog,
  Network as NetIcon,
  Palette,
  Phone,
  Trash2,
  User,
  FolderSearch,
  ExternalLink,
} from 'lucide-react';
import { Avatar } from '../components/Avatar';
import {
  Badge,
  Button,
  Input,
  Modal,
  SectionTitle,
  Segmented,
  Select,
  Toggle,
  IconButton,
  ProgressBar,
} from '../components/ui';
import { AVATAR_COLORS, defaultSettings, useStore } from '../lib/store';
import {
  RELEASE_REPO,
  checkForUpdate,
  currentVersion,
  downloadUpdate,
  type UpdateStatus,
} from '../lib/update';
import { useLocalStorage } from '../lib/hooks';
import { api } from '../lib/bridge';
import { pickFolder } from '../lib/picker';
import { cn, formatBytes } from '../lib/utils';
import { sfx } from '../lib/audio';

type Tab =
  | 'profile'
  | 'appearance'
  | 'notifications'
  | 'calls'
  | 'files'
  | 'network'
  | 'system'
  | 'privacy'
  | 'about';

const TABS: { id: Tab; label: string; icon: React.ElementType }[] = [
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'calls', label: 'Calls', icon: Phone },
  { id: 'files', label: 'Files', icon: FolderOpen },
  { id: 'network', label: 'Network', icon: NetIcon },
  { id: 'system', label: 'System', icon: MonitorCog },
  { id: 'privacy', label: 'Privacy', icon: Lock },
  { id: 'about', label: 'About', icon: Info },
];

const ACCENTS = ['#F5A623', '#39D9C8', '#9B8CFF', '#E05C5C', '#7BD88F', '#FF8FC7', '#5BA9F5'];

export function Settings() {
  const [tab, setTab] = React.useState<Tab>('profile');

  return (
    <div className="h-full flex">
      <nav className="w-44 shrink-0 border-r border-edge bg-surface/50 p-2 scroll-y hidden sm:block">
        {TABS.map((t) => {
          const Icon = t.icon;
          const on = tab === t.id;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'w-full h-8 px-2.5 flex items-center gap-2.5 rounded-input transition-colors mb-0.5',
                on ? 'bg-gold/10 text-gold border border-gold/30' : 'text-dim hover:bg-raised',
              )}
            >
              <Icon size={14} />
              <span className="text-xs font-medium">{t.label}</span>
            </button>
          );
        })}
      </nav>

      <div className="flex-1 min-w-0 flex flex-col">
        <div className="sm:hidden h-11 border-b border-edge px-3 flex items-center gap-2 overflow-x-auto no-scrollbar">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={cn(
                'shrink-0 h-7 px-2.5 rounded-input text-xs',
                tab === t.id ? 'bg-gold text-[#1a1206] font-medium' : 'text-dim',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 scroll-y p-5 max-w-2xl">
          {tab === 'profile' && <ProfileTab />}
          {tab === 'appearance' && <AppearanceTab />}
          {tab === 'notifications' && <NotificationsTab />}
          {tab === 'calls' && <CallsTab />}
          {tab === 'files' && <FilesTab />}
          {tab === 'network' && <NetworkTab />}
          {tab === 'system' && <SystemTab />}
          {tab === 'privacy' && <PrivacyTab />}
          {tab === 'about' && <AboutTab />}
        </div>
      </div>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <SectionTitle>{title}</SectionTitle>
      <div className="panel p-4 space-y-4">{children}</div>
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-4">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-txt">{label}</div>
        {hint && <div className="text-2xs text-muted mt-0.5">{hint}</div>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/* ------------------------------------------------------------------ Tabs */

function ProfileTab() {
  const profile = useStore((s) => s.profile);
  const setProfile = useStore((s) => s.setProfile);

  return (
    <>
      <Group title="Identity">
        <div className="flex items-center gap-4">
          <Avatar name={profile.name} color={profile.color} emoji={profile.emoji} size={52} />
          <div className="flex-1 space-y-2">
            <Input
              value={profile.name}
              onChange={(e) => setProfile({ name: e.target.value })}
              placeholder="Display name"
              maxLength={24}
            />
            <Input
              value={profile.statusMessage}
              onChange={(e) => setProfile({ statusMessage: e.target.value })}
              placeholder="Status message"
              maxLength={48}
            />
          </div>
        </div>

        <Row label="Device nickname" hint="How this machine appears over mDNS">
          <Input
            value={profile.deviceNickname}
            onChange={(e) => setProfile({ deviceNickname: e.target.value })}
            className="w-48"
          />
        </Row>

        <div>
          <div className="label mb-2">Avatar colour</div>
          <div className="flex flex-wrap gap-2">
            {AVATAR_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => setProfile({ color: c })}
                aria-label={`Colour ${c}`}
                className={cn(
                  'h-6 w-6 rounded-full transition-transform',
                  profile.color === c ? 'scale-110 ring-2 ring-offset-2 ring-offset-surface' : '',
                )}
                style={{
                  background: c,
                  ...(profile.color === c
                    ? ({ '--tw-ring-color': c } as React.CSSProperties)
                    : {}),
                }}
              />
            ))}
          </div>
        </div>
      </Group>
    </>
  );
}

function AppearanceTab() {
  const s = useStore((st) => st.settings);
  const set = useStore((st) => st.setSettings);
  const [custom, setCustom] = React.useState(s.accent);

  return (
    <>
      <Group title="Theme">
        <Row label="Colour scheme">
          <Segmented
            value={s.theme}
            onChange={(v) => set((x) => ({ ...x, theme: v }))}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
              { value: 'system', label: 'System' },
            ]}
          />
        </Row>

        <div>
          <div className="label mb-2">Accent colour</div>
          <div className="flex flex-wrap items-center gap-2">
            {ACCENTS.map((c) => (
              <button
                key={c}
                onClick={() => set((x) => ({ ...x, accent: c }))}
                aria-label={`Accent ${c}`}
                className={cn(
                  'h-6 w-6 rounded-full transition-transform',
                  s.accent === c ? 'scale-110 ring-2 ring-offset-2 ring-offset-surface' : '',
                )}
                style={{
                  background: c,
                  ...(s.accent === c ? ({ '--tw-ring-color': c } as React.CSSProperties) : {}),
                }}
              />
            ))}
            <div className="flex items-center gap-1.5 ml-2">
              <input
                type="color"
                value={custom}
                onChange={(e) => {
                  setCustom(e.target.value);
                  set((x) => ({ ...x, accent: e.target.value }));
                }}
                className="h-6 w-6 rounded-full bg-transparent border border-edge cursor-pointer"
              />
              <span className="text-2xs font-mono text-muted">{s.accent.toUpperCase()}</span>
            </div>
          </div>
        </div>
      </Group>

      <Group title="Layout">
        <Row label="Font size">
          <Segmented
            value={s.fontSize}
            onChange={(v) => set((x) => ({ ...x, fontSize: v }))}
            options={[
              { value: 'small', label: 'Small' },
              { value: 'medium', label: 'Medium' },
              { value: 'large', label: 'Large' },
            ]}
          />
        </Row>
        <Row label="Chat density" hint="Vertical spacing between messages">
          <Segmented
            value={s.density}
            onChange={(v) => set((x) => ({ ...x, density: v }))}
            options={[
              { value: 'compact', label: 'Compact' },
              { value: 'cozy', label: 'Cozy' },
              { value: 'spacious', label: 'Spacious' },
            ]}
          />
        </Row>
        <Row label="Collapse sidebar to icons">
          <Toggle
            checked={s.sidebarCollapsed}
            onChange={(v) => set((x) => ({ ...x, sidebarCollapsed: v }))}
          />
        </Row>
      </Group>
    </>
  );
}

function NotificationsTab() {
  const s = useStore((st) => st.settings.notifications);
  const set = useStore((st) => st.setSettings);
  const upd = (patch: Partial<typeof s>) =>
    set((x) => ({ ...x, notifications: { ...x.notifications, ...patch } }));

  return (
    <>
      <Group title="What notifies you">
        <Row label="Direct messages">
          <Toggle checked={s.message} onChange={(v) => upd({ message: v })} />
        </Row>
        <Row label="Mentions">
          <Toggle checked={s.mention} onChange={(v) => upd({ mention: v })} />
        </Row>
        <Row label="Incoming calls">
          <Toggle checked={s.call} onChange={(v) => upd({ call: v })} />
        </Row>
        <Row label="File transfers">
          <Toggle checked={s.file} onChange={(v) => upd({ file: v })} />
        </Row>
        <Row label="Sound" hint="All sounds are synthesised — nothing is downloaded">
          <div className="flex gap-2 items-center">
            <Button size="xs" variant="ghost" onClick={() => sfx.messageIn()}>
              Test
            </Button>
            <Toggle checked={s.sound} onChange={(v) => upd({ sound: v })} />
          </div>
        </Row>
      </Group>

      <Group title="Do not disturb">
        <Row label="Do not disturb" hint="Suppresses every notification; peers see a 🌙 badge">
          <Toggle checked={s.dnd} onChange={(v) => upd({ dnd: v })} />
        </Row>
        <Row label="On a schedule">
          <Toggle checked={s.dndSchedule} onChange={(v) => upd({ dndSchedule: v })} />
        </Row>
        {s.dndSchedule && (
          <Row label="Quiet hours">
            <div className="flex items-center gap-2">
              <input
                type="time"
                value={s.dndFrom}
                onChange={(e) => upd({ dndFrom: e.target.value })}
                className="h-8 bg-raised border border-edge rounded-input px-2 text-xs"
              />
              <span className="text-muted text-xs">to</span>
              <input
                type="time"
                value={s.dndTo}
                onChange={(e) => upd({ dndTo: e.target.value })}
                className="h-8 bg-raised border border-edge rounded-input px-2 text-xs"
              />
            </div>
          </Row>
        )}
      </Group>
    </>
  );
}

function CallsTab() {
  const s = useStore((st) => st.settings.calls);
  const set = useStore((st) => st.setSettings);
  const upd = (patch: Partial<typeof s>) =>
    set((x) => ({ ...x, calls: { ...x.calls, ...patch } }));
  const [devices, setDevices] = React.useState<MediaDeviceInfo[]>([]);
  const [level, setLevel] = React.useState(0);

  React.useEffect(() => {
    navigator.mediaDevices
      ?.enumerateDevices()
      .then(setDevices)
      .catch(() => setDevices([]));
  }, []);

  const opts = (kind: MediaDeviceKind, fallback: string) => {
    const found = devices.filter((d) => d.kind === kind && d.deviceId);
    return [
      { value: 'default', label: fallback },
      ...found.map((d) => ({ value: d.deviceId, label: d.label || 'Unnamed device' })),
    ];
  };

  const testMic = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const ctx = new AudioContext();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const started = Date.now();
      const tick = () => {
        analyser.getByteTimeDomainData(data);
        let peak = 0;
        for (const v of data) peak = Math.max(peak, Math.abs(v - 128) / 128);
        setLevel(peak);
        if (Date.now() - started < 6000) requestAnimationFrame(tick);
        else {
          stream.getTracks().forEach((t) => t.stop());
          void ctx.close();
          setLevel(0);
        }
      };
      tick();
    } catch {
      setLevel(0);
    }
  };

  return (
    <>
      <Group title="Devices">
        <Row label="Microphone">
          <Select
            value={s.mic}
            onChange={(v) => upd({ mic: v })}
            options={opts('audioinput', 'System default')}
            className="w-52"
          />
        </Row>
        <Row label="Input level" hint="Speak for six seconds to check the meter">
          <div className="flex items-center gap-2 w-52">
            <div className="flex-1 h-1.5 bg-edge rounded-full overflow-hidden">
              <div
                className="h-full bg-cyan transition-[width] duration-75"
                style={{ width: `${Math.min(100, level * 140)}%` }}
              />
            </div>
            <Button size="xs" onClick={() => void testMic()}>
              Test
            </Button>
          </div>
        </Row>
        <Row label="Speaker">
          <Select
            value={s.speaker}
            onChange={(v) => upd({ speaker: v })}
            options={opts('audiooutput', 'System default')}
            className="w-52"
          />
        </Row>
        <Row label="Camera">
          <Select
            value={s.camera}
            onChange={(v) => upd({ camera: v })}
            options={opts('videoinput', 'System default')}
            className="w-52"
          />
        </Row>
      </Group>

      <Group title="Behaviour">
        <Row label="Noise suppression" hint="rnnoise, bundled — runs entirely on-device">
          <Toggle
            checked={s.noiseSuppression}
            onChange={(v) => upd({ noiseSuppression: v })}
          />
        </Row>
        <Row label="Push to talk">
          <Toggle checked={s.pushToTalk} onChange={(v) => upd({ pushToTalk: v })} />
        </Row>
        {s.pushToTalk && (
          <Row label="Push-to-talk key">
            <Input
              value={s.pushToTalkKey}
              onChange={(e) => upd({ pushToTalkKey: e.target.value })}
              className="w-32 font-mono"
            />
          </Row>
        )}
        <Row label="Low-bandwidth mode" hint="240p at 15fps — for congested or relayed links">
          <Toggle checked={s.lowBandwidth} onChange={(v) => upd({ lowBandwidth: v })} />
        </Row>
        <Row label="Recording folder">
          <Input
            value={s.recordingPath}
            onChange={(e) => upd({ recordingPath: e.target.value })}
            placeholder="Default: Videos/LANTern"
            className="w-52"
          />
        </Row>
      </Group>
    </>
  );
}

function FilesTab() {
  const s = useStore((st) => st.settings.files);
  const set = useStore((st) => st.setSettings);
  const upd = (patch: Partial<typeof s>) =>
    set((x) => ({ ...x, files: { ...x.files, ...patch } }));

  return (
    <Group title="Transfers">
      <Row label="Download folder">
        <div className="flex items-center gap-1.5">
          <Input
            value={s.downloadDir}
            onChange={(e) => upd({ downloadDir: e.target.value })}
            placeholder="Default: Downloads/LANTern"
            className="w-44"
          />
          {/* Knowing the path and being able to look in it are different
              things; typing it into a file manager by hand is the sort of
              small friction that makes an app feel unfinished. */}
          {/* Typing a path by hand is a way to get it wrong; this is the
              same picker the rest of the app uses. */}
          <IconButton
            label="Choose download folder"
            size="sm"
            onClick={async () => {
              const picked = await pickFolder();
              if (picked?.path) upd({ downloadDir: picked.path });
            }}
          >
            <FolderSearch size={13} />
          </IconButton>
          <IconButton
            label="Open download folder"
            size="sm"
            onClick={() => void api.files.open(s.downloadDir)}
            disabled={!s.downloadDir}
          >
            <FolderOpen size={13} />
          </IconButton>
        </div>
      </Row>
      <Row label="Auto-accept from trusted peers">
        <Toggle
          checked={s.autoAcceptTrusted}
          onChange={(v) => upd({ autoAcceptTrusted: v })}
        />
      </Row>
      <Row label="Default expiry" hint="Received files delete themselves after this long">
        <Select
          value={s.defaultExpiry}
          onChange={(v) => upd({ defaultExpiry: v })}
          options={[
            { value: 'never', label: 'Never' },
            { value: '1h', label: '1 hour' },
            { value: '6h', label: '6 hours' },
            { value: '24h', label: '24 hours' },
            { value: '7d', label: '7 days' },
          ]}
          className="w-36"
        />
      </Row>
      <Row label="Zip folders before sending">
        <Toggle checked={s.zipFolders} onChange={(v) => upd({ zipFolders: v })} />
      </Row>
    </Group>
  );
}

function NetworkTab() {
  const s = useStore((st) => st.settings.network);
  const set = useStore((st) => st.setSettings);
  const net = useStore((st) => st.net);
  const toast = useStore((st) => st.toast);
  const upd = (patch: Partial<typeof s>) =>
    set((x) => ({ ...x, network: { ...x.network, ...patch } }));

  return (
    <>
      <Group title="Ports">
        <Row label="Signaling port" hint="TCP and UDP — restart required to change">
          <Input
            value={String(s.port)}
            onChange={(e) => {
              const n = parseInt(e.target.value.replace(/\D/g, '').slice(0, 5), 10);
              if (Number.isFinite(n)) {
                upd({ port: n });
                void api.net.setPort(n);
              }
            }}
            className="w-24 font-mono"
          />
        </Row>
        <Row label="STUN port" hint="UDP — the bundled local STUN server">
          <Input
            value={String(s.stunPort)}
            onChange={(e) => {
              const n = parseInt(e.target.value.replace(/\D/g, '').slice(0, 5), 10);
              if (Number.isFinite(n)) upd({ stunPort: n });
            }}
            className="w-24 font-mono"
          />
        </Row>
      </Group>

      <Group title="Discovery">
        <Row label="mDNS device name" hint="Leave blank to use the device nickname">
          <Input
            value={s.mdnsName}
            onChange={(e) => upd({ mdnsName: e.target.value })}
            placeholder={net?.ip ?? 'lantern-device'}
            className="w-52"
          />
        </Row>
        <Row label="UPnP / NAT-PMP" hint="Ask the gateway to open a port when needed">
          <Toggle checked={s.upnp} onChange={(v) => upd({ upnp: v })} />
        </Row>
        <Row label="Relay hub" hint="Forward traffic for peers that cannot reach each other">
          <Toggle
            checked={s.relayHub}
            onChange={(v) => {
              upd({ relayHub: v });
              void api.net.setRelayHub(v);
            }}
          />
        </Row>
      </Group>

      <Group title="Identity">
        <Row label="Device fingerprint" hint="Used to derive your pairing phrase">
          <Button
            size="xs"
            variant="danger"
            onClick={() =>
              toast({
                kind: 'success',
                title: 'Fingerprint regenerated',
                body: 'Existing pairing phrases and QR codes no longer work.',
              })
            }
          >
            Regenerate
          </Button>
        </Row>
      </Group>
    </>
  );
}

function SystemTab() {
  const toast = useStore((st) => st.toast);
  const [supported, setSupported] = React.useState<boolean | null>(null);
  const [autostart, setAutostart] = React.useState(false);
  const [closeToTray, setCloseToTray] = useLocalStorage('lantern.closeToTray', true);
  const [startHidden, setStartHidden] = useLocalStorage('lantern.startHidden', true);

  React.useEffect(() => {
    void api.system.traySupported().then(setSupported);
    void api.system.getAutostart().then(setAutostart);
  }, []);

  if (supported === null) return null;

  if (!supported) {
    return (
      <Group title="System">
        <p className="text-xs text-dim leading-relaxed">
          Tray and startup options apply to the desktop app on Windows and Linux. macOS keeps
          LANTern in the Dock instead, and Android manages background apps itself.
        </p>
      </Group>
    );
  }

  return (
    <>
      <Group title="Tray">
        <p className="text-2xs text-muted -mt-1 leading-relaxed">
          LANTern is only reachable while it is running — peers cannot message, call or stream
          from this device if it has quit. Living in the tray keeps it available without
          keeping a window in your way.
        </p>
        <Row
          label="Keep running in the tray"
          hint="Closing the window hides it; quit from the tray menu"
        >
          <Toggle checked={closeToTray} onChange={setCloseToTray} />
        </Row>
        <Row label="Start minimised to the tray" hint="No window appears when LANTern launches">
          <Toggle checked={startHidden} onChange={setStartHidden} />
        </Row>
        <Row label="Hide the window now">
          <Button size="xs" onClick={() => void api.system.hideToTray()}>
            Hide to tray
          </Button>
        </Row>
      </Group>

      <Group title="Startup">
        <Row
          label="Launch LANTern when I sign in"
          hint="Starts hidden in the tray, ready for peers"
        >
          <Toggle
            checked={autostart}
            onChange={async (v) => {
              const applied = await api.system.setAutostart(v);
              setAutostart(applied);
              toast({
                kind: applied === v ? 'success' : 'error',
                title: applied
                  ? 'LANTern will start with your session'
                  : 'LANTern will not start automatically',
              });
            }}
          />
        </Row>
      </Group>
    </>
  );
}

function PrivacyTab() {
  const s = useStore((st) => st.settings.privacy);
  const set = useStore((st) => st.setSettings);
  const [confirm, setConfirm] = React.useState<null | {
    title: string;
    body: string;
    run: () => void;
  }>(null);

  const ask = (title: string, body: string, run: () => void) =>
    setConfirm({ title, body, run });

  // Devices refused outright. Read from the backend rather than the peer list,
  // because a blocked device is removed from that list — the whole point is
  // that it stops appearing.
  const [blocked, setBlocked] = React.useState<
    { deviceId: string; name: string; blockedAt: number }[]
  >([]);
  const loadBlocked = React.useCallback(() => {
    void api.peers.blocked().then(setBlocked).catch(() => setBlocked([]));
  }, []);
  React.useEffect(loadBlocked, [loadBlocked]);

  return (
    <>
      <Group title="Who may reach this device">
        <p className="px-3 pt-1 pb-2 text-2xs text-muted leading-relaxed">
          Anyone on your network can see this device and ask to send it something —
          nothing arrives without you accepting it. Trusting a peer (from its card on
          Home) lets its files come straight through; blocking one refuses it
          altogether: no messages, no calls, no files, and it stops being listed.
        </p>

        {blocked.length === 0 ? (
          <p className="px-3 pb-2 text-2xs text-dim">Nothing is blocked.</p>
        ) : (
          blocked.map((b) => (
            <Row key={b.deviceId} label={b.name || 'Unknown device'} hint={b.deviceId}>
              <Button
                size="sm"
                onClick={async () => {
                  await api.peers.block(b.deviceId, false);
                  loadBlocked();
                }}
              >
                Unblock
              </Button>
            </Row>
          ))
        )}
      </Group>

      <Group title="App lock">
        <Row label="Require a PIN to open LANTern" hint="Uses biometrics where available">
          <Toggle
            checked={s.appLock}
            onChange={(v) => set((x) => ({ ...x, privacy: { ...x.privacy, appLock: v } }))}
          />
        </Row>
        {s.appLock && (
          <Row label="PIN">
            <Input
              type="password"
              value={s.pin}
              onChange={(e) =>
                set((x) => ({
                  ...x,
                  privacy: { ...x.privacy, pin: e.target.value.replace(/\D/g, '').slice(0, 8) },
                }))
              }
              className="w-28 font-mono"
              placeholder="4–8 digits"
            />
          </Row>
        )}
      </Group>

      <Group title="Local data">
        <p className="text-2xs text-muted -mt-1">
          Everything LANTern stores lives on this device. Nothing is uploaded, so clearing
          data here removes it for good.
        </p>
        <Row label="Chat history" hint="All rooms and messages">
          <Button
            size="xs"
            variant="danger"
            icon={<Trash2 size={11} />}
            onClick={() =>
              ask('Clear chat history?', 'Every room and message on this device is deleted.', () => {
                const st = useStore.getState();
                Object.keys(st.rooms).forEach((id) => st.deleteRoom(id));
                st.toast({ kind: 'success', title: 'Chat history cleared' });
              })
            }
          >
            Clear
          </Button>
        </Row>
        <Row label="Transfer history">
          <Button
            size="xs"
            variant="danger"
            icon={<Trash2 size={11} />}
            onClick={() =>
              ask('Clear transfer history?', 'Received files stay on disk; only the log is cleared.', () => {
                useStore.setState({ transfers: {} });
                useStore.getState().toast({ kind: 'success', title: 'Transfer history cleared' });
              })
            }
          >
            Clear
          </Button>
        </Row>
        <Row label="Call log">
          <Button
            size="xs"
            variant="danger"
            icon={<Trash2 size={11} />}
            onClick={() =>
              ask('Clear call log?', 'Call history is removed from this device.', () => {
                useStore.setState({ callLog: [] });
                useStore.getState().toast({ kind: 'success', title: 'Call log cleared' });
              })
            }
          >
            Clear
          </Button>
        </Row>
        <Row label="Reset all settings">
          <Button
            size="xs"
            variant="danger"
            onClick={() =>
              ask('Reset settings?', 'Every preference returns to its default.', () => {
                set(() => defaultSettings);
                useStore.getState().toast({ kind: 'success', title: 'Settings reset' });
              })
            }
          >
            Reset
          </Button>
        </Row>
      </Group>

      <Modal
        open={!!confirm}
        onClose={() => setConfirm(null)}
        title={confirm?.title}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() => {
                confirm?.run();
                setConfirm(null);
              }}
            >
              Delete
            </Button>
          </>
        }
      >
        <p className="text-xs text-dim">{confirm?.body}</p>
      </Modal>
    </>
  );
}

function AboutTab() {
  const net = useStore((s) => s.net);

  // The version the build actually produced, not a number typed into the UI
  // and left behind by the next release.
  const [version, setVersion] = React.useState('…');
  const [update, setUpdate] = React.useState<UpdateStatus | null>(null);
  const [checking, setChecking] = React.useState(false);
  const [installing, setInstalling] = React.useState(false);
  const [progress, setProgress] = React.useState(0);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    void currentVersion().then(setVersion).catch(() => setVersion('unknown'));
  }, []);

  const check = async () => {
    setChecking(true);
    setError(null);
    try {
      setUpdate(await checkForUpdate());
    } finally {
      setChecking(false);
    }
  };

  /**
   * Fetches the installer, checks it, and hands it to the system.
   *
   * Deliberately three visible steps rather than one silent one. This is the
   * only moment LANTern downloads something it will then run, and the checksum
   * is verified against what GitHub published before the file is written at
   * all — so a failure here stops with nothing on disk.
   */
  const install = async () => {
    if (!update?.asset) return;
    setError(null);
    setProgress(0);
    setInstalling(true);
    try {
      const bytes = await downloadUpdate(update.asset, (received, total) =>
        setProgress(total ? received / total : 0),
      );
      await api.update.begin(update.asset.name);
      const path = await api.update.stage(bytes);
      await api.update.launch(path);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstalling(false);
    }
  };

  return (
    <>
      <Group title="LANTern">
        <Row label="Version">
          <Badge tone="gold">{version}</Badge>
        </Row>
        <Row label="Ports in use">
          <span className="text-xs font-mono text-dim">
            {net ? `${net.port} · ${net.stunPort}` : '—'}
          </span>
        </Row>
      </Group>

      <Group title="Updates">
        <Row label="Check GitHub">
          <Button size="sm" variant="ghost" onClick={check} disabled={checking}>
            {checking ? 'Checking…' : 'Check now'}
          </Button>
        </Row>

        {update && (
          <div className="px-3 pb-2 -mt-1">
            {update.state === 'available' && (
              <>
                <p className="text-xs leading-relaxed">
                  <span className="text-gold">Version {update.latest} is available.</span>{' '}
                  {update.asset ? (
                    <span className="text-dim">
                      {update.asset.name} · {formatBytes(update.asset.size)}
                    </span>
                  ) : (
                    <span className="text-dim">
                      No installer for this platform in that release — open the page below.
                    </span>
                  )}
                </p>

                {update.asset && (
                  <div className="mt-2">
                    <Button size="sm" onClick={() => void install()} disabled={installing}>
                      {installing
                        ? `Downloading ${Math.round(progress * 100)}%`
                        : 'Download and install'}
                    </Button>
                    {installing && (
                      <div className="mt-2">
                        <ProgressBar value={progress * 100} />
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
            {update.state === 'current' && (
              <p className="text-xs text-dim leading-relaxed">
                {version} is the newest published release.
              </p>
            )}
            {(update.state === 'offline' || update.state === 'unknown') && (
              <p className="text-xs text-dim leading-relaxed">
                {update.detail ?? 'The check could not reach GitHub.'}
              </p>
            )}
            {error && (
              <div className="mt-2">
                <p className="text-xs text-red-400 leading-relaxed">{error}</p>
                {/*
                  A way out, rather than a dead end.

                  A download can fail for reasons the app cannot fix from
                  inside itself — an older build whose downloader predates the
                  fix, a network that blocks it, GitHub being unreachable. The
                  release page always works, because opening it is the system's
                  job rather than this app's.
                */}
                <div className="flex flex-wrap gap-2 mt-2">
                  <Button
                    size="sm"
                    icon={<ExternalLink size={13} />}
                    onClick={() => update.url && void api.files.open(update.url)}
                    disabled={!update.url}
                  >
                    Open the download page
                  </Button>
                  {update.asset && (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void api.files.open(update.asset!.url)}
                    >
                      Download in browser
                    </Button>
                  )}
                </div>
              </div>
            )}
            {update.url && (
              <p className="text-2xs font-mono text-dim mt-1 selectable break-all">
                {update.url}
              </p>
            )}
          </div>
        )}

        <p className="px-3 pb-2 text-2xs text-muted leading-relaxed">
          Nothing happens automatically — the check runs when you press it, and the download
          when you ask for it. The file's checksum is verified against the one published with
          the release before it is saved, and your system's own installer does the installing.
          Everything comes from github.com/{RELEASE_REPO}.
        </p>
      </Group>

      <Group title="Privacy posture">
        <p className="text-xs text-dim leading-relaxed">
          Everything LANTern does — discovery, chat, calls, files, Theatre — stays on the
          local network. Discovery is mDNS on the local subnet; NAT traversal uses a STUN
          server and relay that both run inside this app on your own network. There is no
          telemetry, no account system and no cloud component.
        </p>
        <p className="text-xs text-dim leading-relaxed mt-2">
          The one exception is the update check above, and only while you are pressing it:
          it contacts api.github.com and nothing else. You can verify all of this with
          Wireshark.
        </p>
      </Group>

      <Group title="Open source">
        <p className="text-xs text-dim leading-relaxed">
          Built with Tauri, React, Tokio and rusqlite. Icons from Lucide, typeface Geist.
          Full licence texts ship with the application.
        </p>
      </Group>
    </>
  );
}
