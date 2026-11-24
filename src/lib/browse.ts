/**
 * Browsing the phone's own storage, other computers' shared drives and media
 * servers.
 *
 * Native on Android (`window.LanternBrowse`, BrowseBridge.kt) because the page
 * cannot speak SMB or SSDP. Every call is asynchronous: a share can take seconds
 * to list, and a synchronous call into the shell would freeze the page for all of
 * it, so a request goes out with an id and its answer comes back as an event.
 *
 * Anywhere else (a desktop, a television, a browser) there is no such object and
 * `browseAvailable()` is false, and the screen never offers itself.
 */

export interface BrowseSource {
  /** `local`, `smb:<host>` or `upnp:<id>`: what a listing is asked for by. */
  id: string;
  kind: 'local' | 'smb' | 'upnp';
  name: string;
  /** Local sources: where it starts. */
  path?: string;
  host?: string;
  /** A computer the person added by hand, which stays when it is not found. */
  added?: boolean;
  /** A folder the person added on the phone. */
  pinned?: boolean;
  /** A login is saved for this computer. */
  saved?: boolean;
}

export interface BrowseSources {
  phone: BrowseSource[];
  folders: BrowseSource[];
  network: BrowseSource[];
  /** Whether Android's "All files access" is on: without it the phone's folders list as empty. */
  allFiles: boolean;
}

export interface BrowseEntry {
  name: string;
  /** A path on the phone, a path inside a share, or a media server's container id. */
  path: string;
  dir: boolean;
  size: number;
  modified: number;
  video: boolean;
  subtitle: boolean;
  /** Set where the file plays by its own address (a media server). */
  url: string | null;
}

/** The share wants a login that was not given, or was wrong. */
export class AuthRequiredError extends Error {
  constructor() {
    super('login needed');
  }
}

interface Bridge {
  request(id: string, json: string): void;
}

declare global {
  interface Window {
    LanternBrowse?: Bridge;
    __browseEvent?: (event: { id: string; ok: boolean; data?: unknown; error?: string }) => void;
  }
}

let wantBrowse = false;

/** Goes to the Files screen on its Browse tab, from somewhere with a shortcut to it. */
export function openBrowse(navigate: (to: 'files') => void): void {
  wantBrowse = true;
  navigate('files');
}

/** Whether the Files screen was opened by that shortcut; asked once, as it opens. */
export function takeBrowseRequest(): boolean {
  const was = wantBrowse;
  wantBrowse = false;
  return was;
}

export const browseAvailable = (): boolean =>
  typeof window !== 'undefined' && typeof window.LanternBrowse?.request === 'function';

const waiting = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let counter = 0;

function ask<T>(request: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const bridge = window.LanternBrowse;
    if (!bridge) return reject(new Error('Browsing is not available here'));
    window.__browseEvent = (event) => {
      const entry = waiting.get(event.id);
      if (!entry) return;
      waiting.delete(event.id);
      if (event.ok) entry.resolve(event.data);
      else entry.reject(event.error === 'auth' ? new AuthRequiredError() : new Error(event.error || 'failed'));
    };
    const id = `b${++counter}`;
    waiting.set(id, { resolve, reject });
    bridge.request(id, JSON.stringify(request));
  });
}

export const browse = {
  /** What is known now, at once: the phone's storage, added folders and servers, the last scan. */
  sources: () => ask<BrowseSources>({ op: 'sources' }),
  /** Looks for shared drives and media servers on the network, then answers as `sources` does. */
  scan: () => ask<BrowseSources>({ op: 'scan' }),
  list: async (source: string, path: string) =>
    (await ask<{ entries: BrowseEntry[] }>({ op: 'list', source, path })).entries,
  /** An address the player can open for a file (or, with `subtitle`, its subtitles as WebVTT). */
  open: async (source: string, path: string, subtitle = false) =>
    (await ask<{ url: string }>({ op: 'open', source, path, subtitle })).url,
  login: (host: string, user: string, password: string, remember: boolean) =>
    ask<unknown>({ op: 'login', host, user, password, remember }),
  addFolder: (path: string, name?: string) => ask<BrowseSources>({ op: 'addFolder', path, name: name ?? '' }),
  removeFolder: (path: string) => ask<BrowseSources>({ op: 'removeFolder', path }),
  addServer: (host: string, name?: string) => ask<BrowseSources>({ op: 'addServer', host, name: name ?? '' }),
  removeServer: (host: string) => ask<BrowseSources>({ op: 'removeServer', host }),
};
