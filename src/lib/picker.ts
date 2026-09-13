import { isTauri } from './bridge';

/**
 * Folder and file selection.
 *
 * The browser's `webkitdirectory` input deliberately withholds real paths — it
 * hands back `webkitRelativePath` only. That is fine for staging an upload, but
 * useless for hosting, where the Rust server must open the directory itself.
 * Under Tauri we use the native dialog, which returns an absolute path.
 */

export interface PickedFolder {
  /** Absolute path — only available under Tauri. */
  path: string | null;
  /** Folder name for display. */
  name: string;
  /** Files staged from the browser input, when there is no native dialog. */
  files: File[];
  /**
   * Absolute paths of the individual files picked, when a native dialog gave
   * them. Sending a file needs the path — the server opens it directly — and
   * a browser `File` never carries one.
   */
  paths?: string[];
}

export async function pickFolder(): Promise<PickedFolder | null> {
  if (isTauri() && !isAndroid()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: true, multiple: false }).catch(() => null);
    if (typeof selected !== 'string') return null;
    return {
      path: selected,
      name: selected.split(/[\\/]/).filter(Boolean).pop() ?? selected,
      files: [],
    };
  }

  // Browser fallback: stage the files so counts and previews still work, but
  // there is no real path to hand the server.
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    Object.assign(input, { webkitdirectory: true, directory: true });
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      if (!files.length) {
        resolve(null);
        return;
      }
      const rel = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath;
      resolve({
        path: null,
        name: rel ? rel.split('/')[0] : 'Folder',
        files,
      });
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

export async function pickFiles(accept?: string): Promise<PickedFolder | null> {
  if (isTauri() && !isAndroid()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: false, multiple: true }).catch(() => null);
    const paths = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (!paths.length) return null;
    // Everything picked has to live under one root for the server to serve it.
    const first = paths[0];
    const parent = first.replace(/[\\/][^\\/]+$/, '');
    return {
      path: parent,
      name: parent.split(/[\\/]/).filter(Boolean).pop() ?? parent,
      files: [],
      paths,
    };
  }

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    if (accept) input.accept = accept;
    input.onchange = () => {
      const files = Array.from(input.files ?? []);
      resolve(files.length ? { path: null, name: 'Files', files } : null);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

/**
 * Android's file picker is the Storage Access Framework, which hands back
 * `content://` URIs rather than filesystem paths, and the Rust server opens
 * paths. For *publishing a folder* there is nothing to be done about that: a
 * folder of content URIs is not something that can be served. A phone
 * therefore joins the library as a consumer — it watches and downloads.
 *
 * Sending individual files is a different matter and does work: each one is
 * copied into the app's own storage first, where it has a path like anything
 * else. See `pickFilesToSend`.
 */
export const isAndroid = (): boolean =>
  typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);

/** Why hosting is unavailable here, or `null` when it works. */
export type HostBlocker = 'browser' | 'android' | null;

export function hostBlocker(): HostBlocker {
  if (!isTauri()) return 'browser';
  if (isAndroid()) return 'android';
  return null;
}

/** A file staged for sending, from either a native dialog or the browser. */
export interface StagedFile {
  name: string;
  size: number;
  /** Absolute path. Only a native dialog can supply one, and sending needs it. */
  path?: string;
}

/**
 * Picks files to send, with real paths where the platform allows it.
 *
 * The browser input is kept as a fallback so the simulator still shows the
 * flow, but those entries have no path and cannot actually be sent — the
 * server opens files by path.
 */
export async function pickFilesToSend(): Promise<StagedFile[]> {
  if (isTauri()) {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const selected = await open({ directory: false, multiple: true }).catch(() => null);
    const picked = Array.isArray(selected) ? selected : selected ? [selected] : [];
    if (!picked.length) return [];

    const { api } = await import('./bridge');

    if (!isAndroid()) {
      const stats = await api.files.stat(picked).catch(() => []);
      return stats.map((f) => ({ name: f.name, size: f.size, path: f.path }));
    }

    // Android's picker hands back `content://` URIs naming files that belong
    // to other applications. They cannot be opened by path, and the sender's
    // HTTP server opens files by path — so each one is copied into this app's
    // own storage first, which is the only thing that can read them.
    //
    // Before this, a phone could pick files and then be told there was nothing
    // to send, because every entry arrived without a path and the send step
    // quietly dropped all of them.
    const staged: StagedFile[] = [];
    for (const source of picked) {
      const file = await api.files.stage(source).catch(() => null);
      if (file) staged.push({ name: file.name, size: file.size, path: file.path });
    }
    return staged;
  }

  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.onchange = () =>
      resolve(Array.from(input.files ?? []).map((f) => ({ name: f.name, size: f.size })));
    input.oncancel = () => resolve([]);
    input.click();
  });
}

/** True when a share can actually be served — i.e. we have a real path. */
export const canHost = (): boolean => hostBlocker() === null;
