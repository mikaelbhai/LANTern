import { api } from './bridge';

/**
 * The backhaul for a bug that leaves no trace once the tab holding it is
 * gone — a button that silently did nothing, not a crash. Every uncaught
 * error and unhandled rejection lands here and is written to a file a
 * restart cannot take with it, plus whatever breadcrumbs a call site chose
 * to record on its own (see `answerCall` in `store.ts` for the one this
 * existed to catch).
 */
export function logClientError(message: string) {
  console.error(message);
  void api.system.logError('error', message).catch(() => {});
}

export function logBreadcrumb(message: string) {
  void api.system.logError('info', message).catch(() => {});
}

/** Installed once, before the app renders. */
export function installErrorBackhaul() {
  window.addEventListener('error', (e) => {
    logClientError(
      `${e.message} at ${e.filename}:${e.lineno}:${e.colno}${e.error?.stack ? `\n${e.error.stack}` : ''}`,
    );
  });
  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    logClientError(`unhandled rejection: ${detail}`);
  });
}
