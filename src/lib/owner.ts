/**
 * The owner key's state in the window.
 *
 * Everything here is behind `api.owner.available()`: in a build without the
 * feature nothing in this file talks to the native side, and the screens that
 * use it render nothing.
 */
import { create } from 'zustand';

import { api, on } from './bridge';

export interface OwnerStatus {
  available: boolean;
  /** This device's own key, once it has asked anybody. */
  identity: { fingerprint: string } | null;
  /** The key this machine agreed to. */
  enrolled: { name: string; fingerprint: string; enrolledAt: number } | null;
  /** Somebody asking this machine right now. `pin` is set once it was allowed. */
  incoming: { deviceId: string; name: string; fingerprint: string; pin: string | null } | null;
  /** The machine this device is waiting on, as the key. */
  outgoing: string | null;
  /** Keys whose proof is good on a link that is open now. */
  proven: string[];
  /** Machines that accepted this device as their key. */
  machines: { deviceId: string; name: string; seenAt: number; online: boolean }[];
}

export interface AdminTitle {
  streamPath: string;
  title: string | null;
  relPath: string | null;
  minAge: number | null;
  ratedByHost: boolean;
  hidden: boolean;
  shareId: string | null;
}

export interface AdminFolder {
  id: string;
  name: string;
  slug: string;
  unlisted: boolean;
  audience: string[];
  running: boolean;
}

export interface AdminList {
  total: number;
  offset: number;
  titles: AdminTitle[];
  folders: AdminFolder[];
  devices: { deviceId: string; name: string; maxAge: number }[];
  defaultAge: number;
}

interface OwnerStore {
  available: boolean;
  status: OwnerStatus | null;
  refresh: () => Promise<void>;
}

export const useOwner = create<OwnerStore>((set) => ({
  available: false,
  status: null,
  refresh: async () => {
    try {
      set({ status: await api.owner.status() });
    } catch {
      /* a machine that is not answering is not a reason to clear what was shown */
    }
  },
}));

let started = false;

/** Finds out whether the owner switched this device on, and if so keeps it current. */
export async function initOwner(): Promise<void> {
  if (started) return;
  started = true;
  const refresh = () => void useOwner.getState().refresh();
  const check = async () => {
    const available = await api.owner.available();
    if (available !== useOwner.getState().available) {
      useOwner.setState({ available, status: available ? useOwner.getState().status : null });
    }
    if (available) refresh();
  };
  await check();
  for (const event of ['owner:requested', 'owner:ready', 'owner:result', 'owner:changed']) {
    on(event, refresh);
  }
  // Switching it on or off means making or deleting a file outside the app, so
  // it is looked for again whenever the window comes back to the front.
  window.addEventListener('focus', () => void check());
}
