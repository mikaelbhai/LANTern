/**
 * Who may see what this device publishes.
 *
 * Three decisions that only mean something together, and that were previously
 * in three different states of existing: a block list with a screen of its
 * own, a trust list with no interface at all, and maturity limits reachable
 * only from Settings — which is nowhere near the moment anybody thinks about
 * them. A host deciding what to publish is deciding who it is for, and this is
 * that question in one place.
 *
 * Mounted from Theatre, from a published folder, and from Settings. The same
 * component in all three, because three copies of a permission control is how
 * two of them end up out of date.
 *
 * Everything here is enforced by *this* device at the moment bytes would
 * leave. Nothing depends on the watching app agreeing to behave.
 */
import React from 'react';
import { ShieldCheck, ShieldX, Baby, Clock, EyeOff, Globe, KeyRound, X } from 'lucide-react';

import { api } from '../lib/bridge';
import { useStore } from '../lib/store';
import { Button, Checkbox, IconButton, Input, SectionTitle, Select, Spinner } from './ui';
import { PinPad, sanitizePin } from './PinPad';
import type { RatingsStatus, Share } from '../lib/types';

/**
 * The allowances a host can hand out.
 *
 * Ages rather than letters, for the reason the Rust side keeps them that way:
 * every country writes the letters differently and a number is what they all
 * agree on underneath. "Everything" is 99 rather than 18 so that a title rated
 * above eighteen — there are a few — is not silently excluded from the setting
 * that says it excludes nothing.
 */
export const AGES = [
  { value: '0', label: 'Unrated only' },
  { value: '7', label: 'Up to 7' },
  { value: '10', label: 'Up to 10' },
  { value: '13', label: 'Up to 13' },
  { value: '16', label: 'Up to 16' },
  { value: '17', label: 'Up to 17' },
  { value: '18', label: 'Up to 18' },
  { value: '99', label: 'Everything' },
];

/**
 * The ratings a title can be given, and what each is called.
 *
 * The numbers real systems actually use, rather than a tidy handful. Two
 * buckets sounded simpler until the library hit it: R and TV-MA are 17, TV-14
 * is 14, PG is 10, and rounding all of them to "13+" is not a simplification,
 * it is telling a thirteen year old's tablet that Deadpool is fine.
 *
 * The label carries what the number means where there is a familiar name for
 * it, because "17+" and "R" are the same fact and only one of them is what
 * anybody has seen on a box.
 */
export const TITLE_AGES = [
  { value: '', label: 'Unrated' },
  { value: '0', label: 'E — everyone' },
  { value: '7', label: '7+' },
  { value: '10', label: '10+ — PG' },
  { value: '13', label: '13+ — PG-13' },
  { value: '14', label: '14+ — TV-14' },
  { value: '16', label: '16+' },
  { value: '17', label: '17+ — R, TV-MA' },
  { value: '18', label: '18+' },
];

/** The nearest allowance we can draw, for a number set by an older build. */
export function nearestAge(age: number): string {
  return AGES.reduce((best, o) =>
    Math.abs(Number(o.value) - age) < Math.abs(Number(best.value) - age) ? o : best,
  ).value;
}

/** How a title's rating is written on a card. Empty when nobody has said. */
export function ratingLabel(minAge?: number): string {
  if (minAge === undefined || minAge === null) return '';
  if (minAge <= 0) return 'E';
  return `${minAge}+`;
}

interface Row {
  deviceId: string;
  name: string;
}

interface Approval {
  deviceId: string;
  name: string;
  streamPath: string;
  title: string;
  /** When it lapses, or 0 for never — which is what one title means. */
  expiresAt: number;
}

/** "Just this title", or how much of the window is left. */
function describeApproval(a: Approval): string {
  if (a.expiresAt === 0) return a.title ? `Just ${a.title}` : 'One title';
  const mins = Math.max(0, Math.round((a.expiresAt - Date.now()) / 60000));
  const scope = a.streamPath === '*' ? 'Everything' : a.title || 'One title';
  if (mins >= 60) {
    const h = Math.floor(mins / 60);
    return `${scope} — ${h}h ${mins % 60}m left`;
  }
  return `${scope} — ${mins}m left`;
}

/**
 * The panel itself.
 *
 * `compact` drops the explanatory paragraphs, for the places this appears
 * inside something already explaining itself.
 */
export function Audience({ compact = false }: { compact?: boolean }) {
  const peers = useStore((s) => s.peers);

  const [trusted, setTrusted] = React.useState<Row[] | null>(null);
  const [blocked, setBlocked] = React.useState<Row[] | null>(null);
  const [ratings, setRatings] = React.useState<RatingsStatus | null>(null);
  const [approvals, setApprovals] = React.useState<Approval[]>([]);
  const [shares, setShares] = React.useState<Share[]>([]);
  /** Which tiers already have a phrase set. Never the phrases themselves. */
  const [pins, setPins] = React.useState<number[]>([]);
  /** Which folder's device list is open. One at a time; they get long. */
  const [opened, setOpened] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    void api.peers.trusted().then(setTrusted).catch(() => setTrusted([]));
    void api.peers.blocked().then(setBlocked).catch(() => setBlocked([]));
    void api.ratings.status().then(setRatings).catch(() => setRatings(null));
    void api.ratings.approvals().then(setApprovals).catch(() => setApprovals([]));
    void api.host.list().then(setShares).catch(() => setShares([]));
    void api.ratings.pins().then(setPins).catch(() => setPins([]));
  }, []);
  React.useEffect(load, [load]);

  const trustedIds = new Set((trusted ?? []).map((t) => t.deviceId));
  const blockedIds = new Set((blocked ?? []).map((b) => b.deviceId));

  // Everyone seen on the network who is neither vouched for nor refused. These
  // are the ones there is still a decision to make about, so they are the ones
  // the controls are offered against.
  const undecided = Object.values(peers)
    .filter((p) => !trustedIds.has(p.deviceId) && !blockedIds.has(p.deviceId))
    .map((p) => ({ deviceId: p.deviceId, name: p.name }));

  const act = async (id: string, fn: () => Promise<unknown>) => {
    setBusy(id);
    try {
      await fn();
      load();
    } finally {
      setBusy(null);
    }
  };

  const loading = trusted === null || blocked === null;

  return (
    <div className="space-y-6">
      <section>
        <SectionTitle>Allowed</SectionTitle>
        {!compact && (
          <p className="text-2xs text-muted leading-relaxed mb-2">
            Devices you have vouched for. Files from these arrive without being
            asked about, where that setting is on. Everyone else can still be
            seen and can still ask.
          </p>
        )}
        <div className="panel divide-y divide-edge/60">
          {loading ? (
            <div className="p-3 flex items-center gap-2 text-2xs text-dim">
              <Spinner size={12} /> Reading the lists…
            </div>
          ) : trusted.length === 0 ? (
            <p className="p-3 text-2xs text-dim">
              Nobody is on the allow list. Add someone from below.
            </p>
          ) : (
            trusted.map((t) => (
              <Entry
                key={t.deviceId}
                icon={<ShieldCheck size={13} className="text-emerald-400" />}
                name={t.name || 'Unknown device'}
                hint={t.deviceId}
                busy={busy === t.deviceId}
                action={
                  <Button
                    size="sm"
                    onClick={() => act(t.deviceId, () => api.peers.trust(t.deviceId, false))}
                  >
                    Remove
                  </Button>
                }
              />
            ))
          )}
        </div>
      </section>

      <section>
        <SectionTitle>Blocked</SectionTitle>
        {!compact && (
          <p className="text-2xs text-muted leading-relaxed mb-2">
            Refused outright: no messages, no calls, no files, and they stop
            being listed at all.
          </p>
        )}
        <div className="panel divide-y divide-edge/60">
          {loading ? null : blocked.length === 0 ? (
            <p className="p-3 text-2xs text-dim">Nothing is blocked.</p>
          ) : (
            blocked.map((b) => (
              <Entry
                key={b.deviceId}
                icon={<ShieldX size={13} className="text-rose-400" />}
                name={b.name || 'Unknown device'}
                hint={b.deviceId}
                busy={busy === b.deviceId}
                action={
                  <Button
                    size="sm"
                    onClick={() => act(b.deviceId, () => api.peers.block(b.deviceId, false))}
                  >
                    Unblock
                  </Button>
                }
              />
            ))
          )}
        </div>
      </section>

      {approvals.length > 0 && (
        <section>
          <SectionTitle>Let past the rating</SectionTitle>
          {!compact && (
            <p className="text-2xs text-muted leading-relaxed mb-2">
              One-off permission, given from a title in Theatre. It does not
              change what these devices are allowed — which is the point: the
              limit is still there afterwards.
            </p>
          )}
          <div className="panel divide-y divide-edge/60">
            {approvals.map((a) => (
              <Entry
                key={`${a.deviceId}:${a.streamPath}`}
                icon={<Clock size={13} className="text-gold" />}
                name={a.name || 'Unknown device'}
                hint={describeApproval(a)}
                busy={busy === a.deviceId + a.streamPath}
                action={
                  <Button
                    size="sm"
                    onClick={() =>
                      act(a.deviceId + a.streamPath, () =>
                        api.ratings.revoke(a.deviceId, a.streamPath),
                      )
                    }
                  >
                    Withdraw
                  </Button>
                }
              />
            ))}
          </div>
        </section>
      )}

      {undecided.length > 0 && (
        <section>
          <SectionTitle>Everyone else on the network</SectionTitle>
          <div className="panel divide-y divide-edge/60">
            {undecided.map((p) => (
              <Entry
                key={p.deviceId}
                name={p.name || 'Unknown device'}
                hint={p.deviceId}
                busy={busy === p.deviceId}
                action={
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      onClick={() => act(p.deviceId, () => api.peers.trust(p.deviceId, true))}
                    >
                      Allow
                    </Button>
                    <Button
                      size="sm"
                      variant="danger"
                      onClick={() => act(p.deviceId, () => api.peers.block(p.deviceId, true))}
                    >
                      Block
                    </Button>
                  </div>
                }
              />
            ))}
          </div>
        </section>
      )}

      <section>
        <SectionTitle>Maturity</SectionTitle>
        {!compact && (
          <p className="text-2xs text-muted leading-relaxed mb-2">
            Checked here, on this device, every time a file would be sent — not
            by the watching app agreeing to hide anything. Titles above a
            device's limit still appear in its library, marked locked, because a
            door somebody can see is easier to ask about than a gap they cannot.
          </p>
        )}
        <div className="panel divide-y divide-edge/60">
          <Entry
            icon={<Baby size={13} className="text-muted" />}
            name="Default for new devices"
            hint="What a device nobody has set is allowed to watch"
            action={
              <Select
                value={nearestAge(ratings?.defaultAge ?? 12)}
                onChange={(v) => void api.ratings.setDefault(Number(v)).then(load)}
                options={AGES}
                className="w-40"
              />
            }
          />
          {allDevices(peers, trusted ?? [], blocked ?? [], ratings).map((d) => (
            <Entry
              key={d.deviceId}
              name={d.name || 'Device'}
              hint={
                ratings?.devices.some((x) => x.deviceId === d.deviceId)
                  ? 'Set by you'
                  : 'Using the default'
              }
              action={
                <Select
                  value={nearestAge(d.maxAge)}
                  onChange={(v) =>
                    void api.ratings.setDevice(d.deviceId, Number(v)).then(load)
                  }
                  options={AGES}
                  className="w-40"
                />
              }
            />
          ))}
        </div>
        {(ratings?.overrides ?? 0) > 0 && (
          <p className="text-2xs text-dim mt-2">
            {ratings?.overrides} title{ratings?.overrides === 1 ? '' : 's'} rated by hand.
          </p>
        )}
      </section>

      <RatingPins pins={pins} onChange={load} compact={compact} />

      {shares.length > 0 && (
        <section>
          <SectionTitle>Published folders</SectionTitle>
          {!compact && (
            <p className="text-2xs text-muted leading-relaxed mb-2">
              A folder is listed to everyone on the network. Unlisted is the
              strictest setting there is: everyone is refused unless you name
              them, and nothing else lifts it — not being allowed, not being
              allowed every rating. The folder stops appearing in the index
              and in what peers are told this device publishes, and asking
              for it by name gets the same answer as asking for something
              that was never there.
            </p>
          )}
          <div className="panel divide-y divide-edge/60">
            {shares.map((sh) => {
              const chosen = sh.audience ?? [];
              // Unlisted is its own state, not "the list happens to be
              // empty". Reading emptiness as no restriction would turn the
              // strictest setting into the loosest the moment it was
              // switched on.
              const unlisted = !!sh.unlisted;
              return (
                <div key={sh.id}>
                  <Entry
                    icon={
                      unlisted ? (
                        <EyeOff size={13} className="text-gold" />
                      ) : (
                        <Globe size={13} className="text-muted" />
                      )
                    }
                    name={sh.name}
                    hint={
                      unlisted
                        ? chosen.length === 0
                          ? 'Unlisted — nobody named'
                          : `Unlisted — ${chosen.length} device${chosen.length === 1 ? '' : 's'}`
                        : 'Listed to everyone on the network'
                    }
                    busy={busy === sh.id}
                    action={
                      <Select
                        value={unlisted ? 'chosen' : 'everyone'}
                        onChange={(v) => {
                          if (v === 'everyone') {
                            setOpened(null);
                            void act(sh.id, () =>
                              api.host.setAudience(sh.id, false, []),
                            );
                          } else {
                            setOpened(sh.id);
                            void act(sh.id, () =>
                              api.host.setAudience(sh.id, true, chosen),
                            );
                          }
                        }}
                        options={[
                          { value: 'everyone', label: 'Everyone' },
                          { value: 'chosen', label: 'Only chosen devices' },
                        ]}
                        className="w-44"
                      />
                    }
                  />

                  {(opened === sh.id || unlisted) && (
                    <div className="px-3 pb-3 -mt-1 space-y-1.5">
                      {allDevices(peers, trusted ?? [], blocked ?? [], ratings).length === 0 ? (
                        <p className="text-2xs text-dim">
                          No other devices yet. Anyone who joins can be named here.
                        </p>
                      ) : (
                        allDevices(peers, trusted ?? [], blocked ?? [], ratings).map((d) => (
                          <Checkbox
                            key={d.deviceId}
                            checked={chosen.includes(d.deviceId)}
                            label={d.name || 'Device'}
                            onChange={(on) => {
                              const next = on
                                ? [...chosen, d.deviceId]
                                : chosen.filter((x) => x !== d.deviceId);
                              void act(sh.id, () =>
                                api.host.setAudience(sh.id, true, next),
                              );
                            }}
                          />
                        ))
                      )}
                      {unlisted && chosen.length === 0 && (
                        <p className="text-2xs text-gold/80">
                          Nobody is named, so nobody can see this folder — not
                          even devices you have allowed. Tick somebody.
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

/**
 * Everyone worth offering a limit for.
 *
 * Devices the host has already given one, plus everyone currently on the
 * network, minus anyone blocked — a limit for a device that is refused
 * altogether is a control with nothing behind it. Devices that have been given
 * a limit but are not here right now stay listed, because forgetting a
 * restriction when a tablet goes to sleep is the one thing this must not do.
 */
function allDevices(
  peers: Record<string, { deviceId: string; name: string }>,
  _trusted: Row[],
  blocked: Row[],
  ratings: RatingsStatus | null,
): { deviceId: string; name: string; maxAge: number }[] {
  const refused = new Set(blocked.map((b) => b.deviceId));
  const out = new Map<string, { deviceId: string; name: string; maxAge: number }>();

  for (const d of ratings?.devices ?? []) {
    if (!refused.has(d.deviceId)) out.set(d.deviceId, { ...d });
  }
  for (const p of Object.values(peers)) {
    if (refused.has(p.deviceId) || out.has(p.deviceId)) continue;
    out.set(p.deviceId, {
      deviceId: p.deviceId,
      name: p.name,
      maxAge: ratings?.defaultAge ?? 12,
    });
  }
  // A name from the live peer list beats one stored when the limit was set.
  for (const p of Object.values(peers)) {
    const row = out.get(p.deviceId);
    if (row && p.name) row.name = p.name;
  }
  return [...out.values()];
}

/**
 * PINs: the other way past the rating gate.
 *
 * An approval needs the host present, at their own screen, saying yes to a
 * specific device and a specific title. A PIN needs neither — whoever knows
 * it unlocks the tier on whatever they are holding, on this device and on
 * every other device on the network that happens to answer to the same
 * PIN, which is how one parent setting it once can open it for every
 * child's tablet in the house without walking to each one.
 *
 * Numeric and entered on a pad rather than typed as free text: this used to
 * be a "pass phrase" of any characters at all, which meant hunting across a
 * full software keyboard on a phone for whatever the phrase demanded next.
 * Ten keys, all the same size, fixes that on both ends — setting one here
 * and entering one in PinUnlock.tsx.
 *
 * Only the tiers are ever shown, never the PINs. Once set, a PIN is
 * write-only from here — checked against, never displayed — because a
 * settings screen is not a safe place to leave a secret sitting in plain
 * text for whoever looks at it next.
 */
function RatingPins({
  pins,
  onChange,
  compact,
}: {
  pins: number[];
  onChange: () => void;
  compact: boolean;
}) {
  const [editing, setEditing] = React.useState<number | null>(null);
  const [pin, setPin] = React.useState('');
  const [busy, setBusy] = React.useState<number | null>(null);
  const [error, setError] = React.useState('');

  // Every tier worth a PIN. Not 0 — that is the floor nobody is unlocking
  // up into — and not 99, which already means everything and has nothing
  // left for a PIN to open.
  const tiers = AGES.filter((a) => a.value !== '0' && a.value !== '99');

  const startEditing = (age: number) => {
    setEditing(age);
    setPin('');
    setError('');
  };

  const save = async (age: number) => {
    if (pin.length > 0 && pin.length < 4) {
      setError('At least four digits.');
      return;
    }
    setBusy(age);
    try {
      await api.ratings.pinSet(age, pin);
      setEditing(null);
      setPin('');
      onChange();
    } catch (err) {
      setError(String(err ?? 'Could not save that.'));
    } finally {
      setBusy(null);
    }
  };

  const clear = async (age: number) => {
    setBusy(age);
    try {
      await api.ratings.pinSet(age, '');
      onChange();
    } finally {
      setBusy(null);
    }
  };

  return (
    <section>
      <SectionTitle>PINs</SectionTitle>
      {!compact && (
        <p className="text-2xs text-muted leading-relaxed mb-2">
          A PIN set here unlocks that tier on any device that enters it — this one
          included. It only ever raises what a device may watch, never lowers it, and a
          PIN entered on a device already allowed further does nothing.
        </p>
      )}
      <div className="panel divide-y divide-edge/60">
        {tiers.map((tier) => {
          const age = Number(tier.value);
          const set = pins.includes(age);
          const isEditing = editing === age;

          return (
            <div key={tier.value}>
              <Entry
                icon={<KeyRound size={13} className={set ? 'text-gold' : 'text-muted'} />}
                name={tier.label}
                hint={set ? 'A PIN is set' : undefined}
                busy={busy === age}
                action={
                  isEditing ? (
                    <IconButton label="Cancel" size="xs" onClick={() => setEditing(null)}>
                      <X size={12} />
                    </IconButton>
                  ) : set ? (
                    <div className="flex items-center gap-1.5">
                      <Button size="xs" onClick={() => startEditing(age)}>
                        Change
                      </Button>
                      <Button size="xs" variant="danger" onClick={() => void clear(age)}>
                        Remove
                      </Button>
                    </div>
                  ) : (
                    <Button size="xs" onClick={() => startEditing(age)}>
                      Set a PIN…
                    </Button>
                  )
                }
              />
              {isEditing && (
                <div className="px-3 pb-3 space-y-2">
                  <PinPad
                    value={pin}
                    onChange={(v) => {
                      setPin(sanitizePin(v));
                      setError('');
                    }}
                  />
                  {error && <p className="text-2xs text-danger text-center">{error}</p>}
                  <Button size="sm" variant="primary" full onClick={() => void save(age)}>
                    Save
                  </Button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function Entry({
  icon,
  name,
  hint,
  action,
  busy,
}: {
  icon?: React.ReactNode;
  name: string;
  hint?: string;
  action: React.ReactNode;
  busy?: boolean;
}) {
  return (
    <div className="flex items-center gap-3 p-3">
      {icon && <span className="shrink-0">{icon}</span>}
      <div className="min-w-0 flex-1">
        <div className="text-xs text-txt truncate">{name}</div>
        {hint && <div className="text-2xs text-muted truncate mt-0.5">{hint}</div>}
      </div>
      <div className="shrink-0">{busy ? <Spinner size={12} /> : action}</div>
    </div>
  );
}
