/**
 * Checking GitHub for a newer release.
 *
 * This is the only part of LANTern that talks to the internet, and it is worth
 * being blunt about that. Everything else — discovery, chat, calls, files,
 * Theatre — is confined to the local network by design. So this never runs on
 * its own: it happens when someone presses the button in Settings, and nothing
 * is downloaded or installed automatically. The result is a version number and
 * a link.
 *
 * The request is made from the webview rather than from Rust deliberately. The
 * webview already has a TLS stack; adding one to the native side would mean
 * shipping an HTTPS client inside an offline app, where it could be reached by
 * any other code path. Here it is one `fetch`, to one host, that the content
 * security policy names explicitly.
 */
import { isTauri } from './bridge';

/**
 * Where releases are published.
 *
 * Change this if the repository moves or was created under a different
 * account — it is the only place the update check knows about.
 */
export const RELEASE_REPO = 'mikaelbhai/LANTern';

/** One downloadable file attached to a release. */
export interface ReleaseAsset {
  name: string;
  url: string;
  size: number;
  /** `sha256:...` as GitHub reports it, or undefined on an older release. */
  digest?: string;
}

export interface UpdateStatus {
  state: 'current' | 'available' | 'offline' | 'unknown';
  /** The version running right now. */
  current: string;
  /** The newest published version, when the check succeeded. */
  latest?: string;
  /** Release page for a human to read before deciding. */
  url?: string;
  /** The file for this platform, when the release carries one. */
  asset?: ReleaseAsset;
  notes?: string;
  /** Why the check could not answer, when it could not. */
  detail?: string;
}

/**
 * Compares two dotted version strings.
 *
 * Returns a positive number when `a` is newer. Anything non-numeric in a
 * segment sorts as older, so a pre-release like `1.2.0-rc1` never displaces
 * the `1.2.0` it precedes.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .replace(/^v/i, '')
      .split(/[.\-+]/)
      .map((p) => (/^\d+$/.test(p) ? Number(p) : -1));

  const left = parts(a);
  const right = parts(b);
  const len = Math.max(left.length, right.length);

  for (let i = 0; i < len; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l - r;
  }
  return 0;
}

/** The version of the running build. */
export async function currentVersion(): Promise<string> {
  if (isTauri()) {
    try {
      const { getVersion } = await import('@tauri-apps/api/app');
      return await getVersion();
    } catch {
      // Fall through to the build-time constant.
    }
  }
  return __APP_VERSION__;
}

/**
 * Asks GitHub for the newest release and compares it with this build.
 *
 * Never throws. A machine with no route to the internet is the normal case for
 * this app, not an error, and it is reported as `offline` rather than dressed
 * up as a failure.
 */
export async function checkForUpdate(): Promise<UpdateStatus> {
  const current = await currentVersion();

  try {
    const response = await fetch(
      `https://api.github.com/repos/${RELEASE_REPO}/releases/latest`,
      {
        headers: { Accept: 'application/vnd.github+json' },
        // A LAN app should not sit spinning on a network that is not there.
        signal: AbortSignal.timeout(8000),
      },
    );

    if (response.status === 404) {
      return {
        state: 'unknown',
        current,
        detail: 'No releases have been published yet.',
      };
    }
    if (!response.ok) {
      return {
        state: 'unknown',
        current,
        detail: `GitHub answered ${response.status}.`,
      };
    }

    const release = (await response.json()) as {
      tag_name?: string;
      html_url?: string;
      body?: string;
      draft?: boolean;
      prerelease?: boolean;
      assets?: { name: string; browser_download_url: string; size: number; digest?: string }[];
    };

    const latest = (release.tag_name ?? '').replace(/^v/i, '');
    if (!latest || release.draft) {
      return { state: 'unknown', current, detail: 'No published release found.' };
    }

    return {
      state: compareVersions(latest, current) > 0 ? 'available' : 'current',
      current,
      latest,
      url: release.html_url,
      notes: release.body?.slice(0, 600),
      asset: pickAsset(release.assets ?? []),
    };
  } catch (err) {
    // Offline, blocked, or timed out. For this app that is unremarkable.
    return {
      state: 'offline',
      current,
      detail:
        err instanceof DOMException && err.name === 'TimeoutError'
          ? 'The check timed out.'
          : 'Could not reach GitHub. LANTern works without it.',
    };
  }
}

/**
 * Chooses the file this device can actually install.
 *
 * A release carries an installer for each platform, and offering the wrong one
 * is worse than offering none: an APK on Windows is an unopenable file, and a
 * setup.exe on a phone is the same. Anything unrecognised returns nothing and
 * the UI falls back to a link.
 */
export function pickAsset(
  assets: { name: string; browser_download_url: string; size: number; digest?: string }[],
): ReleaseAsset | undefined {
  const android = /Android/i.test(navigator.userAgent);
  const wanted = android ? /\.apk$/i : /setup\.exe$/i;

  // On a television, the TV build. It is the same application, but installing
  // the phone package there would leave it under the wrong name.
  const tv = android && /\bTV\b|GoogleTV|AndroidTV|BRAVIA|AFT[A-Z]/i.test(navigator.userAgent);

  const matches = assets.filter((a) => wanted.test(a.name));
  const chosen =
    (tv ? matches.find((a) => /lantv/i.test(a.name)) : matches.find((a) => !/lantv/i.test(a.name))) ??
    matches[0];
  if (!chosen) return undefined;

  return {
    name: chosen.name,
    url: chosen.browser_download_url,
    size: chosen.size,
    digest: chosen.digest,
  };
}

/** Bytes as a SHA-256 hex string, using the webview's own crypto. */
async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Downloads an update and checks it is what GitHub said it would be.
 *
 * This is the one place LANTern fetches something it will then execute, so the
 * bytes are hashed and compared against the digest published alongside the
 * release before they are written anywhere. A mismatch throws; it is never
 * merely reported and carried on from.
 *
 * Nothing is installed here either. The file is handed to the operating
 * system's own installer, which asks its own questions.
 */
export async function downloadUpdate(
  asset: ReleaseAsset,
  onProgress?: (received: number, total: number) => void,
): Promise<ArrayBuffer> {
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error(`Download failed: ${response.status}`);

  const total = asset.size;
  const reader = response.body?.getReader();
  let bytes: Uint8Array;

  if (reader) {
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      onProgress?.(received, total);
    }
    bytes = new Uint8Array(received);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
  } else {
    bytes = new Uint8Array(await response.arrayBuffer());
    onProgress?.(bytes.length, total);
  }

  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;

  const expected = asset.digest?.replace(/^sha256:/i, '').toLowerCase();
  if (expected) {
    const actual = await sha256(buffer);
    if (actual !== expected) {
      throw new Error('The download does not match the published checksum. It was not saved.');
    }
  }

  return buffer;
}
