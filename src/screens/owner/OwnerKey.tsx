/**
 * The owner key: one phone that administers the machines that agreed to it.
 *
 * Three pieces, all inert unless this build carries the feature (see
 * `lib/owner.ts`; a stock build never mounts any of them):
 *
 * - `OwnerHost`, mounted once, answers the things that arrive unasked: a device
 *   asking this machine to accept it as a key, the PIN the key has to type, and
 *   a notice that the key changed something here.
 * - `OwnerKeyTab`, the Settings page, for both roles - asking machines as the
 *   key, and holding or removing the key as a machine.
 * - `RemoteAdmin`, the key's view of one machine: hide titles, change ratings,
 *   unlist a folder.
 *
 * Nothing here decides anything. The machine decides, in its own code, on a
 * proof the window cannot make; these screens only ask and show.
 */
import React from 'react';
import { EyeOff, KeyRound, Search, ShieldCheck, Trash2 } from 'lucide-react';

import { api, on } from '../../lib/bridge';
import { useStore } from '../../lib/store';
import { useOwner, type AdminList, type AdminTitle } from '../../lib/owner';
import { AGES, TITLE_AGES, nearestAge } from '../../components/Audience';
import { PinPad } from '../../components/PinPad';
import { Button, Input, Modal, SectionTitle, Select, Spinner, Toggle } from '../../components/ui';

/* ------------------------------------------------------------------- host */

export function OwnerHost() {
  const available = useOwner((s) => s.available);
  const status = useOwner((s) => s.status);
  const refresh = useOwner((s) => s.refresh);
  const toast = useStore((s) => s.toast);

  // The machine the key is typing a PIN for, set when that machine has allowed it.
  const [ready, setReady] = React.useState<{ deviceId: string; name: string } | null>(null);
  const [pin, setPin] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (!available) return;
    const offs = [
      on('owner:ready', (p: { deviceId: string; name: string }) => {
        setPin('');
        setReady(p);
      }),
      on('owner:result', (p: { name?: string; accepted: boolean; denied?: boolean }) => {
        setReady(null);
        setBusy(false);
        toast({
          kind: p.accepted ? 'success' : 'error',
          title: p.accepted
            ? `${p.name || 'That device'} accepted this device as its owner key`
            : p.denied
              ? `${p.name || 'That device'} said no`
              : 'That PIN was not right',
        });
        void refresh();
      }),
      on('admin:changed', (p: { by: string; op: string }) =>
        toast({ kind: 'info', title: `${p.by} changed something here`, body: p.op }),
      ),
    ];
    return () => offs.forEach((off) => off());
  }, [available, toast, refresh]);

  if (!available) return null;

  const incoming = status?.incoming ?? null;

  return (
    <>
      {/* This machine, asked to accept a key. */}
      <Modal
        open={!!incoming}
        onClose={() => void api.owner.deny().then(refresh)}
        title="Owner key request"
        footer={
          incoming && !incoming.pin ? (
            <>
              <Button variant="ghost" onClick={() => void api.owner.deny().then(refresh)}>
                Deny
              </Button>
              <Button
                variant="primary"
                onClick={() => void api.owner.allow().then(refresh)}
              >
                Allow
              </Button>
            </>
          ) : (
            <Button variant="ghost" onClick={() => void api.owner.deny().then(refresh)}>
              Cancel
            </Button>
          )
        }
      >
        {incoming && (
          <div className="space-y-3 text-xs text-dim leading-relaxed">
            <p>
              <span className="text-txt font-medium">{incoming.name}</span> is asking to be the
              owner key for this device.
            </p>
            {!incoming.pin ? (
              <>
                <p>
                  If you allow it, that device can watch everything here with no age limit, browse
                  and fetch files on this device, and hide titles, change ratings and unlist
                  folders. It stays that way until you remove it in Settings.
                </p>
                <p className="text-muted">
                  Its key: <span className="text-txt">{incoming.fingerprint}</span>. The same words
                  should be on its screen.
                </p>
              </>
            ) : (
              <div className="text-center space-y-2 py-2">
                <div className="text-3xl tracking-[0.35em] text-txt font-semibold tabular-nums">
                  {incoming.pin}
                </div>
                <p>Type this on {incoming.name}. It stops working in three minutes.</p>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* The key, typing the PIN the machine is showing. */}
      <Modal
        open={!!ready}
        onClose={() => setReady(null)}
        title={`PIN from ${ready?.name || 'that device'}`}
        footer={
          <Button
            variant="primary"
            disabled={pin.length !== 6 || busy}
            onClick={() => {
              setBusy(true);
              void api.owner.confirm(pin).catch((e) => {
                setBusy(false);
                toast({ kind: 'error', title: String(e) });
              });
            }}
          >
            {busy ? 'Checking...' : 'Confirm'}
          </Button>
        }
      >
        <p className="text-xs text-dim mb-3">
          {ready?.name || 'That device'} is showing a six digit PIN. Type it here.
        </p>
        <PinPad value={pin} onChange={setPin} maxLength={6} />
      </Modal>
    </>
  );
}

/* --------------------------------------------------------------- settings */

function Entry({
  title,
  hint,
  action,
}: {
  title: React.ReactNode;
  hint?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-xs text-txt truncate">{title}</div>
        {hint && <div className="text-2xs text-muted mt-0.5">{hint}</div>}
      </div>
      {action}
    </div>
  );
}

export function OwnerKeyTab() {
  const status = useOwner((s) => s.status);
  const refresh = useOwner((s) => s.refresh);
  const peers = useStore((s) => s.peers);
  const toast = useStore((s) => s.toast);
  const [managing, setManaging] = React.useState<{ deviceId: string; name: string } | null>(null);

  React.useEffect(() => void refresh(), [refresh]);

  const online = Object.values(peers).filter((p) => p.status !== 'offline' && !p.hostOnly);
  const waiting = status?.outgoing ?? null;

  const ask = (deviceId: string) =>
    api.owner
      .request(deviceId)
      .then(() => refresh())
      .catch((e) => toast({ kind: 'error', title: String(e) }));

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle>This device as the key</SectionTitle>
        <p className="text-2xs text-muted leading-relaxed mb-2">
          Ask a device on this network to accept this one as its owner key. The person at that
          device has to allow it, and a PIN it shows has to be typed here. Nothing happens to a
          device that says no, or to one that is not running this build.
          {status?.identity && (
            <>
              {' '}
              Your key: <span className="text-txt">{status.identity.fingerprint}</span>
            </>
          )}
        </p>
        <div className="panel divide-y divide-edge/60">
          {online.length === 0 && <Entry title="No other device is on the network right now" />}
          {online.map((p) => (
            <Entry
              key={p.id}
              title={p.name}
              hint={status?.machines.some((m) => m.deviceId === p.deviceId) ? 'Accepted this key' : undefined}
              action={
                <Button
                  size="xs"
                  variant="outline"
                  disabled={!!waiting}
                  onClick={() => void ask(p.deviceId)}
                >
                  {waiting === p.deviceId ? 'Waiting...' : 'Ask'}
                </Button>
              }
            />
          ))}
        </div>
      </section>

      <section>
        <SectionTitle>Devices that accepted this key</SectionTitle>
        <div className="panel divide-y divide-edge/60">
          {(status?.machines.length ?? 0) === 0 && <Entry title="None yet" />}
          {status?.machines.map((m) => (
            <Entry
              key={m.deviceId}
              title={m.name || 'Device'}
              hint={m.online ? 'Connected' : 'Not connected'}
              action={
                <div className="flex gap-2">
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={!m.online}
                    onClick={() => setManaging({ deviceId: m.deviceId, name: m.name })}
                  >
                    Manage library
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => void api.owner.forgetMachine(m.deviceId).then(refresh)}
                  >
                    Forget
                  </Button>
                </div>
              }
            />
          ))}
        </div>
      </section>

      <section>
        <SectionTitle>This device accepting a key</SectionTitle>
        <div className="panel divide-y divide-edge/60">
          {status?.enrolled ? (
            <Entry
              title={
                <span className="inline-flex items-center gap-1.5">
                  <ShieldCheck size={13} className="text-gold" /> {status.enrolled.name || 'A device'}
                </span>
              }
              hint={
                <>
                  {status.proven.length > 0 ? 'Connected now. ' : 'Not connected. '}
                  Key: {status.enrolled.fingerprint}
                </>
              }
              action={
                <Button
                  size="xs"
                  variant="outline"
                  icon={<Trash2 size={12} />}
                  onClick={() => void api.owner.unenrol().then(refresh)}
                >
                  Remove
                </Button>
              }
            />
          ) : (
            <Entry
              title="No key"
              hint="When a device asks to be the owner key, a prompt appears here and you decide."
            />
          )}
        </div>
      </section>

      {managing && (
        <RemoteAdmin
          deviceId={managing.deviceId}
          name={managing.name}
          onClose={() => setManaging(null)}
        />
      )}
    </div>
  );
}

/* ----------------------------------------------------------------- admin */

const PAGE = 300;

/** One machine's titles, folders and ratings, from the key. */
export function RemoteAdmin({
  deviceId,
  name,
  onClose,
}: {
  deviceId: string;
  name: string;
  onClose: () => void;
}) {
  const toast = useStore((s) => s.toast);
  const [list, setList] = React.useState<AdminList | null>(null);
  const [query, setQuery] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);

  const load = React.useCallback(
    (offset = 0) =>
      api.admin
        .call<AdminList>(deviceId, 'library.list', { offset, limit: PAGE })
        .then((next) => {
          setError(null);
          setList((prev) =>
            offset > 0 && prev ? { ...next, titles: [...prev.titles, ...next.titles] } : next,
          );
        })
        .catch((e) => setError(String(e))),
    [deviceId],
  );

  React.useEffect(() => void load(), [load]);

  const act = (op: string, args: unknown, then: () => void) =>
    api.admin
      .call(deviceId, op, args)
      .then(then)
      .catch((e) => toast({ kind: 'error', title: String(e) }));

  const patch = (path: string, change: Partial<AdminTitle>) =>
    setList((l) =>
      l && { ...l, titles: l.titles.map((t) => (t.streamPath === path ? { ...t, ...change } : t)) },
    );

  const shown = (list?.titles ?? []).filter((t) =>
    query ? (t.title ?? t.relPath ?? '').toLowerCase().includes(query.toLowerCase()) : true,
  );

  return (
    <Modal open onClose={onClose} title={`${name || 'Device'} library`} width="max-w-2xl">
      {error && <p className="text-xs text-danger mb-3">{error}</p>}
      {!list && !error && (
        <div className="py-8 grid place-items-center">
          <Spinner />
        </div>
      )}
      {list && (
        <div className="space-y-5">
          <section>
            <SectionTitle>Household</SectionTitle>
            <div className="panel divide-y divide-edge/60">
              <Entry
                title="Default for devices nobody has set"
                action={
                  <Select
                    value={nearestAge(list.defaultAge)}
                    onChange={(v) =>
                      act('rating.default', { maxAge: Number(v) }, () =>
                        setList((l) => l && { ...l, defaultAge: Number(v) }),
                      )
                    }
                    options={AGES}
                    className="w-40"
                  />
                }
              />
            </div>
          </section>

          {list.folders.length > 0 && (
            <section>
              <SectionTitle>Folders</SectionTitle>
              <div className="panel divide-y divide-edge/60">
                {list.folders.map((f) => (
                  <Entry
                    key={f.id}
                    title={f.name}
                    hint={f.unlisted ? 'Unlisted: only the devices it names can see it' : 'Listed'}
                    action={
                      <Toggle
                        small
                        checked={f.unlisted}
                        label="Unlist"
                        onChange={(v) =>
                          act(
                            'audience.share',
                            { shareId: f.id, unlisted: v, deviceIds: f.audience },
                            () =>
                              setList(
                                (l) =>
                                  l && {
                                    ...l,
                                    folders: l.folders.map((x) =>
                                      x.id === f.id ? { ...x, unlisted: v } : x,
                                    ),
                                  },
                              ),
                          )
                        }
                      />
                    }
                  />
                ))}
              </div>
            </section>
          )}

          <section>
            <SectionTitle>Titles ({list.total})</SectionTitle>
            <div className="relative mb-2">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" />
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search titles"
                className="pl-8"
              />
            </div>
            <div className="panel divide-y divide-edge/60">
              {shown.map((t) => (
                <Entry
                  key={t.streamPath}
                  title={
                    <span className="inline-flex items-center gap-1.5">
                      {t.hidden && <EyeOff size={12} className="text-muted shrink-0" />}
                      {t.title || t.relPath || t.streamPath}
                    </span>
                  }
                  hint={
                    t.minAge != null && !t.ratedByHost ? 'Rating guessed from the file name' : undefined
                  }
                  action={
                    <div className="flex items-center gap-3">
                      <Toggle
                        small
                        checked={t.hidden}
                        label="Hide"
                        onChange={(v) =>
                          act('hide.titles', { paths: [t.streamPath], hidden: v }, () =>
                            patch(t.streamPath, { hidden: v }),
                          )
                        }
                      />
                      <Select
                        value={t.minAge == null ? '' : String(t.minAge)}
                        onChange={(v) =>
                          act(
                            'rating.titles',
                            { paths: [t.streamPath], minAge: v === '' ? null : Number(v) },
                            () =>
                              patch(t.streamPath, {
                                minAge: v === '' ? null : Number(v),
                                ratedByHost: v !== '',
                              }),
                          )
                        }
                        options={TITLE_AGES}
                        className="w-36"
                      />
                    </div>
                  }
                />
              ))}
              {shown.length === 0 && <Entry title="Nothing matches" />}
            </div>
            {list.titles.length < list.total && !query && (
              <div className="mt-2 text-center">
                <Button size="xs" variant="outline" onClick={() => void load(list.titles.length)}>
                  Load more
                </Button>
              </div>
            )}
          </section>
        </div>
      )}
    </Modal>
  );
}

export { KeyRound as OwnerKeyIcon };
