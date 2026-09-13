import React from 'react';
import { Power } from 'lucide-react';
import { Button } from './ui';
import { api } from '../lib/bridge';
import { useStore } from '../lib/store';
import type { Wakeable } from '../lib/types';

/**
 * Devices this machine has seen, and could try to wake.
 *
 * The list is of hardware addresses remembered from when each device was last
 * awake, because that is the only time one can be learned — there is no way
 * to look up a machine that is off. A device appears here after it has been
 * on the network once, and stays.
 *
 * Nothing acknowledges a magic packet. There is no reply, ever, so this can
 * honestly report that it sent one and nothing more; whether the machine
 * wakes is between its network card and its firmware, and the only evidence
 * is the device turning up in the peer list. The button says so rather than
 * pretending to a result it cannot have.
 */
export function WakeList() {
  const [devices, setDevices] = React.useState<Wakeable[]>([]);
  const [sent, setSent] = React.useState<Record<string, string>>({});
  const peers = useStore((s) => s.peers);

  const load = React.useCallback(() => {
    void api.wake
      .list()
      .then(setDevices)
      .catch(() => setDevices([]));
  }, []);

  React.useEffect(load, [load]);

  // Only the ones that are not already here. A wake button beside a device
  // you are talking to is noise.
  const online = new Set(Object.values(peers).map((p) => p.deviceId));
  const asleep = devices.filter((d) => !online.has(d.deviceId));

  if (!asleep.length) return null;

  const wake = async (device: Wakeable) => {
    try {
      const count = await api.wake.send(device.mac);
      setSent((was) => ({
        ...was,
        [device.deviceId]: `${count} packet${count === 1 ? '' : 's'} sent`,
      }));
    } catch (err) {
      setSent((was) => ({ ...was, [device.deviceId]: String(err) }));
    }
  };

  return (
    <div className="px-3 py-2 border-t border-edge">
      <p className="text-2xs uppercase tracking-wide text-muted mb-1.5">Not here right now</p>
      <ul className="flex flex-col gap-1">
        {asleep.map((device) => (
          <li key={device.deviceId} className="flex items-center gap-2">
            <span className="text-xs truncate flex-1 text-dim">
              {device.name || device.mac}
            </span>
            {sent[device.deviceId] ? (
              <span className="text-[10px] text-muted shrink-0">{sent[device.deviceId]}</span>
            ) : (
              <Button
                size="sm"
                variant="ghost"
                icon={<Power size={12} />}
                onClick={() => void wake(device)}
              >
                Wake
              </Button>
            )}
          </li>
        ))}
      </ul>
      <p className="text-[10px] text-muted leading-relaxed mt-1.5">
        Nothing answers a wake packet. If the machine comes back it will appear above.
      </p>
    </div>
  );
}
