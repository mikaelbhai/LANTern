/**
 * Saying what the operating system is about to ask, before it asks.
 *
 * Three of LANTern's features are gated behind a dialog the application does
 * not draw and cannot read: the microphone, the camera, and the firewall. Each
 * appears without warning, in the system's own words, offering choices whose
 * consequences are invisible — and each remembers a refusal permanently.
 *
 * That is not hypothetical. One mistaken press on a microphone prompt left
 * calls broken on a device with nothing in the application able to undo it,
 * and the way back was to reinstall. A firewall prompt answered with Cancel
 * turns file serving off in a way that then looks exactly like a network
 * fault, which is the hardest kind of problem to find.
 *
 * So the choice is described first: what will appear, which option to pick by
 * the name the dialog gives it, and what refusing costs. The primer is shown
 * only when the system is actually going to ask — a primer in front of a
 * decision already made is noise, and noise teaches people to dismiss primers.
 */

export type PromptKind = 'microphone' | 'camera' | 'firewall';
export type Platform = 'windows' | 'macos' | 'android' | 'other';

export interface Primer {
  /** What the person is about to do, in their terms. */
  title: string;
  /** What the system will put on screen. */
  what: string;
  /** The option to choose, named as the dialog names it. */
  choose: string;
  /** Why that is the right one. Empty where it is obvious. */
  because: string;
  /** What refusing costs, and how to undo it. */
  ifRefused: string;
}

export function detectPlatform(ua?: string): Platform {
  const agent = ua ?? (typeof navigator === 'undefined' ? '' : navigator.userAgent);
  if (/Android/i.test(agent)) return 'android';
  if (/Mac OS X|Macintosh/i.test(agent)) return 'macos';
  if (/Windows/i.test(agent)) return 'windows';
  return 'other';
}

/** The wording for one prompt on one platform. */
export function primerFor(kind: PromptKind, platform: Platform): Primer {
  if (kind === 'firewall') return firewallPrimer(platform);
  return devicePrimer(kind, platform);
}

function firewallPrimer(platform: Platform): Primer {
  if (platform !== 'windows') {
    return {
      title: 'Your system may ask about incoming connections',
      what: 'A dialog asking whether LANTern File Server may accept connections from the network.',
      choose: 'Allow',
      because:
        'Serving a folder means other devices connect to this one, which is an incoming connection.',
      ifRefused:
        'Published folders stop being reachable, and nothing reports it — it looks like a quiet network. Your firewall settings can change it back.',
    };
  }
  return {
    title: 'Windows will ask about the file server',
    what: 'A Windows Security Alert saying it has blocked some features of LANTern File Server, with two tick boxes and an Allow access button.',
    choose: 'Tick Private networks, leave Public networks unticked, then Allow access',
    because:
      'Private covers your home or office network, which is where your own devices are. Public is meant for airports and cafes, where you would not want your folders offered to strangers.',
    ifRefused:
      'Nothing can reach your published folders, and the app cannot tell that apart from an empty network — it simply looks broken. Undoing it means finding LANTern File Server in Windows Defender Firewall settings.',
  };
}

function devicePrimer(kind: 'microphone' | 'camera', platform: Platform): Primer {
  const noun = kind === 'camera' ? 'camera' : 'microphone';
  const settingsName = kind === 'camera' ? 'Camera' : 'Microphone';
  const verb = kind === 'camera' ? 'take pictures and record video' : 'record audio';

  switch (platform) {
    case 'android':
      return {
        title: 'Android will ask for the ' + noun,
        what:
          'A dialog asking whether to allow LANTern to ' +
          verb +
          ', offering While using the app, Only this time, and Don’t allow.',
        choose: 'While using the app',
        because:
          'Only this time also works, but the permission is withdrawn when you leave the app, so it asks again on every single call.',
        ifRefused:
          'Calls connect with no ' +
          noun +
          '. You can grant it again in Android Settings, under Apps, LANTern, Permissions.',
      };
    case 'macos':
      return {
        title: 'macOS will ask for the ' + noun,
        what:
          'A dialog saying LANTern would like to access the ' +
          noun +
          ', with Don’t Allow and OK.',
        choose: 'OK',
        because: '',
        ifRefused:
          'Calls connect with no ' +
          noun +
          ', and macOS will not ask a second time. You can turn it back on in System Settings, Privacy & Security, ' +
          settingsName +
          '.',
      };
    case 'windows':
      return {
        title: 'Windows will ask for the ' + noun,
        what: 'A prompt asking whether LANTern may use your ' + noun + ', with Allow and Block.',
        choose: 'Allow',
        because: '',
        ifRefused:
          'Calls connect with no ' +
          noun +
          ', and the prompt does not come back. You can turn it back on in Windows Settings, Privacy & security, ' +
          settingsName +
          '.',
      };
    default:
      return {
        title: 'Your system will ask for the ' + noun,
        what: 'A prompt asking whether LANTern may use your ' + noun + '.',
        choose: 'Allow',
        because: '',
        // Naming a settings page here would be a guess, and sending somebody
        // to the wrong one is worse than admitting the platform is unknown.
        // Saying nothing at all is worse still: the refusal is permanent.
        ifRefused:
          'Calls connect with no ' +
          noun +
          ', and the prompt is not usually offered twice. Turning it back on means finding the permission Settings your system keeps for LANTern.',
      };
  }
}

/**
 * Whether the system still has a question to ask.
 *
 * Answered already, either way, means no primer: describing a dialog that is
 * not coming is noise, and somebody who refused needs the way back rather than
 * a description of a prompt they will never see again.
 */
export async function systemWillAsk(
  kind: 'microphone' | 'camera',
  permissions?: Permissions,
): Promise<boolean> {
  const perms =
    permissions ?? (typeof navigator === 'undefined' ? undefined : navigator.permissions);
  // No Permissions API — WebKit has never answered a microphone query. The
  // honest answer is then that it might ask, so the primer is shown once and
  // the caller is what stops it appearing twice.
  if (!perms || typeof perms.query !== 'function') return true;
  try {
    const status = await perms.query({ name: kind as PermissionName });
    return status.state === 'prompt';
  } catch {
    return true;
  }
}

/** Where "this has been explained once" is remembered. */
export const seenKey = (kind: PromptKind): string => 'lantern.primer.' + kind;

/**
 * Whether this primer has already been shown on this device.
 *
 * Wrapped because storage throws outright in some contexts rather than
 * returning nothing, and a primer must never be the reason a call fails.
 */
export function alreadyExplained(kind: PromptKind): boolean {
  try {
    return localStorage.getItem(seenKey(kind)) === '1';
  } catch {
    return false;
  }
}

export function rememberExplained(kind: PromptKind): void {
  try {
    localStorage.setItem(seenKey(kind), '1');
  } catch {
    /* a primer shown twice beats a crash */
  }
}

/**
 * The whole decision: should this prompt be explained, right now.
 *
 * The firewall cannot be queried — no browser exposes it — so for that one
 * having been explained once on this device is the only signal there is.
 */
export async function shouldExplain(
  kind: PromptKind,
  permissions?: Permissions,
): Promise<boolean> {
  if (alreadyExplained(kind)) return false;
  if (kind === 'firewall') return true;
  return systemWillAsk(kind, permissions);
}
