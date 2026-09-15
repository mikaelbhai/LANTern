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
import { ShieldCheck, ShieldX, Baby } from 'lucide-react';

import { api } from '../lib/bridge';
import { useStore } from '../lib/store';
import { Button, SectionTitle, Select, Spinner } from './ui';
import type { RatingsStatus } from '../lib/types';

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
  { value: '12', label: 'Up to 12' },
  { value: '13', label: 'Up to 13' },
  { value: '16', label: 'Up to 16' },
  { value: '18', label: 'Up to 18' },
  { value: '99', label: 'Everything' },
];

/** The ratings a title can be given, and what each is called. */
export const TITLE_AGES = [
  { value: '', label: 'Unrated' },
  { value: '0', label: 'E — everyone' },
  { value: '7', label: '7+' },
  { value: '13', label: '13+' },
  { value: '16', label: '16+' },
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
  const [busy, setBusy] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    void api.peers.trusted().then(setTrusted).catch(() => setTrusted([]));
    void api.peers.blocked().then(setBlocked).catch(() => setBlocked([]));
    void api.ratings.status().then(setRatings).catch(() => setRatings(null));
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
