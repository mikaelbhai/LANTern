/**
 * Alerting for things that happen while you are not looking: incoming calls
 * and messages, on every platform LANTern runs on.
 *
 * A ringtone that only sounds while the window is open is not really a
 * ringtone. On Windows and Linux this app deliberately lives in the tray, and
 * on Android it is usually backgrounded — the two cases where a call matters
 * most are exactly the two where a webview-only chime is never heard.
 *
 * So an incoming call raises three things together:
 *
 *   1. the synthesised ring (no audio file ships in the bundle),
 *   2. an OS notification, which is what survives the app being out of sight,
 *   3. on desktop, the window itself, so answering is one click.
 *
 * Each is attempted independently. A phone that refuses notification
 * permission should still ring; a muted desktop should still light up the
 * tray. Nothing here throws — failing to ring must never take the call down
 * with it.
 */
import { startRingtone } from './audio';
import { api, isTauri } from './bridge';

/** Android needs a channel before a notification can carry sound or urgency. */
const CALL_CHANNEL = 'lantern-incoming-call';
/** Messages get their own channel so they can be silenced without silencing calls. */
const MESSAGE_CHANNEL = 'lantern-messages';

let channelReady: Promise<void> | null = null;

async function ensureCallChannel(): Promise<void> {
  if (!isTauri()) return;
  if (!channelReady) {
    channelReady = (async () => {
      const { createChannel, Importance, Visibility } = await import(
        '@tauri-apps/plugin-notification'
      );
      await createChannel({
        id: CALL_CHANNEL,
        name: 'Incoming calls',
        description: 'Rings when someone on your network calls you.',
        importance: Importance.High,
        visibility: Visibility.Private,
        vibration: true,
        lights: true,
      });
    })().catch(() => {
      // Desktop has no channels; the call below works without one.
    });
  }
  return channelReady;
}

/** Asks once, and remembers nothing — the OS is the source of truth. */
async function permitted(): Promise<boolean> {
  if (isTauri()) {
    try {
      const { isPermissionGranted, requestPermission } = await import(
        '@tauri-apps/plugin-notification'
      );
      if (await isPermissionGranted()) return true;
      return (await requestPermission()) === 'granted';
    } catch {
      return false;
    }
  }

  // Plain browser (the simulator).
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    return (await Notification.requestPermission()) === 'granted';
  } catch {
    return false;
  }
}

/**
 * Gets notification permission and the Android channel in place ahead of time.
 *
 * Called at startup. Doing this lazily at ring time fails in the one case that
 * matters: on Android 13+ the permission prompt is a system dialog, and a call
 * usually arrives while the app is backgrounded and cannot show one, so the
 * first call would never make a sound.
 */
export async function prepareCallAlerts(): Promise<boolean> {
  try {
    const granted = await permitted();
    if (granted) await ensureCallChannel();
    return granted;
  } catch {
    return false;
  }
}

let messageChannelReady: Promise<void> | null = null;

async function ensureMessageChannel(): Promise<void> {
  if (!isTauri()) return;
  if (!messageChannelReady) {
    messageChannelReady = (async () => {
      const { createChannel, Importance, Visibility } = await import(
        '@tauri-apps/plugin-notification'
      );
      await createChannel({
        id: MESSAGE_CHANNEL,
        name: 'Messages',
        description: 'A peer on your network sent you a message.',
        importance: Importance.Default,
        visibility: Visibility.Private,
      });
    })().catch(() => {});
  }
  return messageChannelReady;
}

/**
 * Raises an OS notification for a message that arrived out of sight.
 *
 * Only when the window is not focused. A notification for a message you are
 * already looking at is noise, and on a phone the same message would buzz
 * twice — once in the app, once in the shade.
 */
export function notifyMessage(from: string, body: string): void {
  if (typeof document !== 'undefined' && document.hasFocus()) return;

  void (async () => {
    try {
      if (!(await permitted())) return;
      await ensureMessageChannel();

      // A long message in a notification is unreadable; the app is where you
      // read it. This is a nudge, not a transcript.
      const preview = body.length > 140 ? `${body.slice(0, 139)}\u2026` : body;

      if (isTauri()) {
        const { sendNotification } = await import('@tauri-apps/plugin-notification');
        sendNotification({
          channelId: MESSAGE_CHANNEL,
          title: from,
          body: preview,
          // Grouped by sender, so ten messages are one conversation in the
          // shade rather than ten separate entries.
          group: from,
          autoCancel: true,
        });
      } else if (typeof Notification !== 'undefined') {
        new Notification(from, { body: preview, tag: from });
      }
    } catch {
      // Never let alerting break receiving.
    }
  })();
}

export interface RingRequest {
  /** Who is calling — shown as the notification title. */
  from: string;
  /** "Voice call", "Video call", "Screen share". */
  kind: string;
  /** Play the audible ring. The OS notification is posted either way. */
  audible: boolean;
  /** Bring the window forward. Pointless on a phone, where the OS decides. */
  raiseWindow: boolean;
}

/**
 * Starts alerting for an incoming call.
 *
 * Returns a function that stops the ring and clears the notification. Call it
 * when the call is answered, declined, or gives up — the notification is
 * marked `ongoing`, so on Android it cannot be swiped away and *must* be
 * cleared here or it will sit in the shade forever.
 */
export function ring(req: RingRequest): () => void {
  let stopped = false;
  let browserNotification: Notification | null = null;
  const notificationId = Math.floor(Math.random() * 2_000_000_000);

  // The ring is forced past the UI-sound mute: that switch is about interface
  // chirps, and a missed call costs more than an unwanted chime. Do-not-
  // disturb is decided by the caller, and does silence this entirely.
  const stopTone = req.audible ? startRingtone(true) : () => {};

  void (async () => {
    if (stopped) return;
    try {
      if (req.raiseWindow && isTauri()) {
        await api.system.showWindow().catch(() => {});
      }
      if (stopped || !(await permitted())) return;

      await ensureCallChannel();
      if (stopped) return;

      if (isTauri()) {
        const { sendNotification } = await import('@tauri-apps/plugin-notification');
        sendNotification({
          id: notificationId,
          channelId: CALL_CHANNEL,
          title: req.from,
          body: `Incoming ${req.kind.toLowerCase()}`,
          // Persistent and un-dismissable: a call is not a passing update.
          ongoing: true,
          autoCancel: false,
          silent: !req.audible,
        });
      } else if (typeof Notification !== 'undefined') {
        const n = new Notification(req.from, {
          body: `Incoming ${req.kind.toLowerCase()}`,
          requireInteraction: true,
          silent: !req.audible,
        });
        browserNotification = n;
        if (stopped) n.close();
      }
    } catch {
      // An alert that cannot be raised must not break answering the call.
    }
  })();

  return () => {
    if (stopped) return;
    stopped = true;
    stopTone();
    browserNotification?.close();
    browserNotification = null;

    if (isTauri()) {
      void import('@tauri-apps/plugin-notification')
        .then(({ cancel }) => cancel([notificationId]))
        .catch(() => {});
    }
  };
}
