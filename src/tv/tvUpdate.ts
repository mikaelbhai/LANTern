import { latestInstallers, compareVersions, currentVersion, type ReleaseAsset } from '../lib/update';
import { api, on } from '../lib/bridge';

/**
 * Updating LANTV from the television itself.
 *
 * Two places to get it from, and the rule for choosing between them: ask the
 * other devices in the house first, then GitHub; the newer version wins, and
 * when the two are the same version the copy in the house wins, because it is
 * on the same network and the other is across the internet. Neither is
 * installed unless it is newer than what is running.
 */

/** What a device on this network offers. */
export interface LocalOffer {
  peer: string;
  name: string;
  size: number;
  url: string;
}

export interface Chosen {
  version: string;
  name: string;
  url: string;
  /** Where it comes from, for saying so. */
  source: 'network' | 'online';
  /** The device, when it is on the network. */
  peer?: string;
  size: number;
  /** A checksum published online for this same file, when there is one. */
  digest?: string;
}

/** The version a file is named for: LANTV-1.3.4.apk -> 1.3.4. */
export function versionOf(name: string): string | null {
  return /(\d+\.\d+\.\d+)/.exec(name)?.[1] ?? null;
}

/**
 * Picks what to install, or null when nothing here is newer than `current`.
 * Pure, so the rule can be checked without a network.
 */
export function choose(
  current: string,
  local: LocalOffer[],
  online: { asset: ReleaseAsset; version: string } | null,
): Chosen | null {
  let bestLocal: (LocalOffer & { version: string }) | null = null;
  for (const o of local) {
    const version = versionOf(o.name);
    if (!version) continue;
    if (!bestLocal || compareVersions(version, bestLocal.version) > 0) bestLocal = { ...o, version };
  }

  const newest = [bestLocal?.version, online?.version]
    .filter((v): v is string => !!v)
    .sort((a, b) => compareVersions(b, a))[0];
  if (!newest || compareVersions(newest, current) <= 0) return null;

  // The house wins a tie.
  if (bestLocal && compareVersions(bestLocal.version, newest) === 0) {
    return {
      version: bestLocal.version,
      name: bestLocal.name,
      url: bestLocal.url,
      source: 'network',
      peer: bestLocal.peer,
      size: bestLocal.size,
      // The same version published online vouches for the file in the house.
      digest:
        online && compareVersions(online.version, bestLocal.version) === 0 && online.asset.name === bestLocal.name
          ? online.asset.digest
          : undefined,
    };
  }
  if (!online) return null;
  return {
    version: online.version,
    name: online.asset.name,
    url: online.asset.url,
    source: 'online',
    size: online.asset.size,
    digest: online.asset.digest,
  };
}

export interface Found {
  current: string;
  /** What to install, or null when this is the newest there is. */
  chosen: Chosen | null;
  /** Whether GitHub could be asked; a television with no internet is ordinary. */
  askedOnline: boolean;
  /** The same, for the network. */
  askedNetwork: boolean;
  /** The online build, kept for falling back to if the network's copy will not do. */
  online: { asset: ReleaseAsset; version: string } | null;
}

/** Asks the network, then GitHub, and chooses. Never throws. */
export async function look(): Promise<Found> {
  const current = await currentVersion();

  const [local, online] = await Promise.all([
    api.update.scanLocal('Android TV').then(
      (l) => ({ ok: true as const, list: l }),
      () => ({ ok: false as const, list: [] as LocalOffer[] }),
    ),
    latestInstallers().then(
      (assets) => {
        const asset = assets.find((a) => /lantv/i.test(a.name));
        const version = asset ? versionOf(asset.name) : null;
        return asset && version ? { asset, version } : null;
      },
      () => null,
    ),
  ]);

  return {
    current,
    chosen: choose(current, local.list, online),
    askedOnline: online !== null,
    askedNetwork: local.ok,
    online,
  };
}

/**
 * Fetches the chosen file and hands it to the system installer.
 *
 * Tries where it was found; if that fails - a copy in the house that does not
 * match the published checksum, a device that went to sleep - falls back to
 * the online one when there is one. `progress` is 0..1.
 */
export async function install(
  chosen: Chosen,
  fallback: { asset: ReleaseAsset } | null,
  progress: (fraction: number) => void,
): Promise<void> {
  const off = on('update:progress', (p: { done?: number; total?: number }) => {
    progress(p?.total ? (p.done ?? 0) / p.total : 0);
  });
  try {
    let path: string;
    try {
      path =
        chosen.source === 'network'
          ? await api.update.downloadLan(chosen.url, chosen.name, chosen.digest)
          : await api.update.download(chosen.url, chosen.name, chosen.digest);
    } catch (e) {
      if (chosen.source !== 'network' || !fallback) throw e;
      path = await api.update.download(fallback.asset.url, fallback.asset.name, fallback.asset.digest);
    }
    await api.update.launch(path);
  } finally {
    off();
  }
}
