/**
 * Whether this computer can be woken, and a way to make it so.
 *
 * Waking is done by the device that wants the machine on, sending one packet to
 * this machine's network card; this screen is the other half - the card has to
 * be listening, and the sender has to know what to address. Paired devices are
 * told the address while this machine is awake, and only paired ones: a wake
 * packet cannot be authenticated, so whoever holds the address can use it.
 *
 * Nothing here can see the firmware setting, and nothing acknowledges a packet,
 * so the screen says what it can read and what it cannot rather than
 * promising a wake.
 */
import React from 'react';
import { Power } from 'lucide-react';

import { api, on } from '../lib/bridge';
import { useStore } from '../lib/store';
import type { WakeStatus } from '../lib/types';
import { Badge, Button, SectionTitle } from './ui';

const yesNo = (value: boolean | null | undefined, yes = 'On', no = 'Off') =>
  value === true ? yes : value === false ? no : 'Not known';

export function WakeThisPc() {
  const peers = useStore((s) => s.peers);
  const toast = useStore((s) => s.toast);
  const [status, setStatus] = React.useState<WakeStatus | null>(null);
  const [busy, setBusy] = React.useState(false);

  const load = React.useCallback(() => {
    void api.wake
      .status()
      // The simulator, and a build without the command, answer with nothing.
      .then((s) => setStatus(s && typeof s === 'object' && 'supported' in s ? s : null))
      .catch(() => setStatus(null));
  }, []);

  // Re-read when somebody joins or leaves (who it has been shared with changes),
  // and when a pairing finishes - the moment the address is first handed over.
  React.useEffect(load, [load, peers]);
  React.useEffect(() => {
    const offs = [
      on('pair:accepted', () => setTimeout(load, 500)),
      on('pair:result', () => setTimeout(load, 500)),
      on('wake:changed', load),
    ];
    return () => offs.forEach((off) => off());
  }, [load]);

  if (!status || !status.supported || !status.mac) return null;

  const ready = status.magicPacket !== false && status.deviceMayWake !== false;

  const enable = async () => {
    setBusy(true);
    try {
      setStatus(await api.wake.enable());
      toast({ kind: 'success', title: 'This computer can now be woken', body: 'Windows has been told to listen for it.' });
    } catch (err) {
      toast({ kind: 'error', title: 'Nothing was changed', body: String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel p-4">
      <SectionTitle right={<Badge tone={ready ? 'cyan' : 'gold'}>{ready ? 'Ready' : 'Needs turning on'}</Badge>}>
        Wake this computer
      </SectionTitle>
      <p className="text-xs text-dim leading-relaxed mb-3">
        A paired phone or computer can switch this one on from sleep. The address it needs is given
        only to devices you have paired with.
      </p>

      <dl className="text-xs grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
        <dt className="text-muted">Network card</dt>
        <dd className="text-right sm:text-left">
          {status.adapter} <span className="text-muted font-mono">{status.mac}</span>
        </dd>
        <dt className="text-muted">Wake on Magic Packet</dt>
        <dd>{yesNo(status.magicPacket)}</dd>
        <dt className="text-muted">Allowed to wake the PC</dt>
        <dd>{yesNo(status.deviceMayWake, 'Yes', 'No')}</dd>
        <dt className="text-muted">Fast Startup</dt>
        <dd>{yesNo(status.fastStartup)}</dd>
        <dt className="text-muted">Shared with</dt>
        <dd>
          {status.sharedWith === 0
            ? 'No paired device is connected right now'
            : `${status.sharedWith} paired device${status.sharedWith === 1 ? '' : 's'}`}
        </dd>
      </dl>

      {!ready && (
        <div className="mt-3">
          <Button size="sm" variant="primary" icon={<Power size={13} />} disabled={busy} onClick={() => void enable()}>
            {busy ? 'Waiting for Windows…' : 'Turn on'}
          </Button>
          <p className="text-2xs text-muted leading-relaxed mt-1.5">
            Windows will ask you to approve this once.
          </p>
        </div>
      )}

      <ul className="mt-3 space-y-1 text-2xs text-muted leading-relaxed list-disc pl-4">
        {!status.wired && (
          <li>A Wi-Fi card rarely wakes a machine that is off. A cable is far more reliable.</li>
        )}
        {status.fastStartup && (
          <li>
            Fast Startup is on. Waking from sleep is not affected; if it will not wake after a full
            shut down, turn Fast Startup off in Power Options.
          </li>
        )}
        <li>
          It also has to be allowed in the BIOS or UEFI ("Wake on LAN" or "Power on by PCI-E").
          This app cannot see or change that, and nothing replies to a wake packet, so the only
          proof is the computer coming back.
        </li>
      </ul>
    </section>
  );
}
