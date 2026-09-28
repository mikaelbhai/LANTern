/**
 * Showing an update download while the app is not on screen.
 *
 * The download itself runs natively and does not care whether the webview is
 * visible — but the progress bar in Settings does, and on a phone that screen
 * is usually the first thing backgrounded once the download is under way (the
 * point of starting it is to go do something else while it finishes). Without
 * this the download was silent from the moment somebody left the app, with
 * nothing to say it was still running, still stuck, or already done.
 *
 * One notification, replaced in place rather than stacked, the same id every
 * time. Best-effort throughout: a permission this app was never granted, or a
 * platform with no notification tray at all, should lose the progress bar,
 * never the download.
 */
import { isTauri } from './bridge';

const CHANNEL = 'lantern-update';
const NOTIFICATION_ID = 0x4c414e54; // "LANT" — fixed, so every update replaces the last.

let channelReady: Promise<void> | null = null;

async function ensureChannel(): Promise<void> {
  if (!isTauri()) return;
  if (!channelReady) {
    channelReady = (async () => {
      const { createChannel, Importance, Visibility } = await import(
        '@tauri-apps/plugin-notification'
      );
      await createChannel({
        id: CHANNEL,
        name: 'Update download',
        description: 'Progress while a LANTern update downloads.',
        importance: Importance.Low,
        visibility: Visibility.Public,
      });
    })().catch(() => {
      // Desktop has no channels; the call below works without one.
    });
  }
  return channelReady;
}

/** Rounded so a fast link does not repaint the notification every few bytes. */
let lastShown = -1;

/** Posts or updates the progress notification. Silent, never throws. */
export function showUpdateProgress(fraction: number): void {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  if (pct === lastShown) return;
  lastShown = pct;

  void (async () => {
    try {
      if (!isTauri()) return;
      const { isPermissionGranted, sendNotification } = await import(
        '@tauri-apps/plugin-notification'
      );
      // Asked for already, in onboarding and at launch — this never prompts,
      // only checks, so a refusal here costs the progress bar and nothing else.
      if (!(await isPermissionGranted())) return;
      await ensureChannel();
      sendNotification({
        id: NOTIFICATION_ID,
        channelId: CHANNEL,
        title: 'Downloading update',
        body: `${pct}%`,
        ongoing: true,
        autoCancel: false,
        silent: true,
      });
    } catch {
      // The in-app progress bar is the source of truth; this is a bonus.
    }
  })();
}

/** Clears the notification — the download finished, failed, or was cancelled. */
export function clearUpdateProgress(): void {
  lastShown = -1;
  if (!isTauri()) return;
  void import('@tauri-apps/plugin-notification')
    .then(({ cancel }) => cancel([NOTIFICATION_ID]))
    .catch(() => {});
}
