/**
 * Warning that this device is unreachable on one of its networks.
 *
 * Windows classes every network as Private or Public, and a Public one means
 * "let nothing in". LANTern's firewall rules are scoped to Private, which is
 * correct — nobody wants a file server exposed on café Wi-Fi — but the failure
 * it produces is silent and deeply confusing: the device can still reach out,
 * so discovery works, messages arrive and calls connect, while every attempt
 * by a peer to open a connection *to* it is dropped. What people see is a peer
 * that is plainly online with an empty library.
 *
 * So it is said out loud, on the machine that can fix it, with the fix
 * attached. Windows shows its own consent prompt for the change; this only
 * offers.
 */
import React from 'react';
import { ShieldAlert } from 'lucide-react';

import { api } from '../lib/bridge';
import { Button } from './ui';

export interface ConnectionProfile {
  alias: string;
  category: string;
  blocksPeers: boolean;
}

export function NetworkPrivacy() {
  const [profiles, setProfiles] = React.useState<ConnectionProfile[]>([]);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState<string | null>(null);

  const load = React.useCallback(() => {
    void api.net
      .connectionProfiles()
      .then(setProfiles)
      .catch(() => setProfiles([]));
  }, []);

  React.useEffect(load, [load]);

  const blocking = profiles.filter((p) => p.blocksPeers);
  if (!blocking.length) return null;

  const fix = async (alias: string) => {
    setBusy(alias);
    setFailed(null);
    try {
      await api.net.setPrivate(alias);
      load();
    } catch (err) {
      setFailed(String(err ?? 'Windows would not make the change.'));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-card border border-gold/30 bg-gold/10 p-3 mb-3">
      <div className="flex items-start gap-2.5">
        <ShieldAlert size={16} className="text-gold shrink-0 mt-0.5" />
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-gold/90">
            {blocking.map((p) => p.alias).join(' and ')}{' '}
            {blocking.length > 1 ? 'are' : 'is'} set to Public — other devices cannot reach
            this one
          </p>
          <p className="text-2xs text-dim leading-relaxed mt-1">
            Windows blocks incoming connections on a Public network. Calls and messages still
            work, because those go out from here — but nobody can open your files, so your
            library looks empty to them. Setting the network to Private fixes it. Only do
            this on a network you trust.
          </p>

          <div className="flex flex-wrap gap-1.5 mt-2">
            {blocking.map((p) => (
              <Button
                key={p.alias}
                size="sm"
                onClick={() => void fix(p.alias)}
                disabled={busy !== null}
              >
                {busy === p.alias ? 'Asking Windows…' : `Make ${p.alias} private`}
              </Button>
            ))}
          </div>

          {failed && (
            <p className="text-2xs text-dim leading-relaxed mt-2">
              {failed} You can do it yourself in Settings → Network &amp; internet, by opening
              the network's properties and choosing Private.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
