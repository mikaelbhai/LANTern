/**
 * Making sense of a refused microphone.
 *
 * `getUserMedia` fails with a handful of DOM exceptions whose names are
 * precise and whose messages are useless to the person reading them. The one
 * that matters is `NotAllowedError`: somebody pressed "no" on the permission
 * prompt, and the webview remembers that forever. It will not ask again.
 *
 * That single mistaken press used to leave calls broken with nothing in the
 * application able to undo it — the only way back was to reinstall. So the
 * error is translated into what actually happened and what to do about it.
 */
import { api, isTauri } from './bridge';

export type MediaTrouble = 'denied' | 'missing' | 'busy' | 'unknown';

export interface MediaProblem {
  kind: MediaTrouble;
  title: string;
  body: string;
  /** True when the operating system has a page that fixes it. */
  fixable: boolean;
}

/** Which of the two was being asked for, for the wording. */
export type MediaWanted = 'microphone' | 'camera';

function platform(): 'windows' | 'macos' | 'android' | 'other' {
  if (typeof navigator === 'undefined') return 'other';
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return 'android';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos';
  if (/Windows/i.test(ua)) return 'windows';
  return 'other';
}

/** Where this operating system keeps the switch. */
function where(want: MediaWanted): string {
  const thing = want === 'camera' ? 'Camera' : 'Microphone';
  switch (platform()) {
    case 'windows':
      return `Settings › Privacy & security › ${thing}, and let desktop apps use it.`;
    case 'macos':
      return `System Settings › Privacy & Security › ${thing}, and switch LANTern on.`;
    case 'android':
      return `Settings › Apps › LANTern › Permissions › ${thing}, and set it to Allow.`;
    default:
      return `your system's privacy settings, under ${thing}.`;
  }
}

/**
 * Turns whatever `getUserMedia` threw into something worth showing.
 *
 * Matched on `name` rather than the message: the names are specified and the
 * messages differ between engines and say nothing useful in any of them.
 */
export function readMediaError(err: unknown, want: MediaWanted = 'microphone'): MediaProblem {
  const name = (err as { name?: string } | null)?.name ?? '';
  const thing = want === 'camera' ? 'camera' : 'microphone';

  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return {
      kind: 'denied',
      title: `LANTern cannot use the ${thing}`,
      // The important half is that it will not ask again, because otherwise
      // the obvious thing to try is starting another call, which fails the
      // same way for reasons nobody can see.
      body: `Permission was refused, and it will not be asked for again. Turn it back on in ${where(want)}`,
      fixable: platform() === 'windows' || platform() === 'macos',
    };
  }

  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return {
      kind: 'missing',
      title: `No ${thing} found`,
      body: `Nothing on this device answers as a ${thing}. Plug one in, or start a voice call instead of a video one.`,
      fixable: false,
    };
  }

  if (name === 'NotReadableError' || name === 'AbortError') {
    return {
      kind: 'busy',
      title: `The ${thing} is in use`,
      body: `Another application is holding it. Close whatever is using it and try again.`,
      fixable: false,
    };
  }

  return {
    kind: 'unknown',
    title: `Could not open the ${thing}`,
    body: (err as { message?: string } | null)?.message ?? 'The device did not respond.',
    fixable: false,
  };
}

/** Opens the operating system's own privacy page, where there is one. */
export async function openPrivacySettings(want: MediaWanted): Promise<boolean> {
  if (!isTauri()) return false;
  return api.system.openPrivacySettings(want).catch(() => false);
}
