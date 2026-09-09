/**
 * Making the Android back gesture mean something.
 *
 * Tauri hands the back press to the WebView: if the page can go back it does,
 * otherwise the activity finishes. This app is a single page that never
 * touched the History API, so `canGoBack()` was always false and back quit the
 * app — from a video, from a call, from a half-filled dialog. On Android that
 * reads as a bug, because on Android back is *the* navigation control.
 *
 * So every dismissible layer pushes a history entry while it is open. Back
 * then pops the layer instead of the app, and when nothing is left the press
 * falls through and the app exits, which is the correct behaviour for a home
 * screen.
 *
 * Works the same on desktop, where it wires up Alt+Left and the mouse's back
 * button for free.
 */

type Layer = {
  id: number;
  dismiss: () => void;
};

let stack: Layer[] = [];
let nextId = 1;
let wired = false;

/**
 * History entries this module removed itself.
 *
 * A layer closed by its own controls — the back arrow in the player, Escape,
 * a Close button — has to drop the history entry it pushed, and the only way
 * to do that is `history.back()`. That fires `popstate` exactly as a real back
 * press does, and the handler would then dismiss the layer *underneath* the
 * one that just closed: closing the player would shut the Theatre screen too
 * and land on Home. Counting the pops we caused lets the handler tell the two
 * apart.
 */
let selfPops = 0;

function ensureWired() {
  if (wired || typeof window === 'undefined') return;
  wired = true;

  window.addEventListener('popstate', () => {
    if (selfPops > 0) {
      selfPops--;
      return;
    }

    const top = stack.pop();
    // The entry is already gone from history by the time this fires, so the
    // dismiss must not try to pop it again.
    top?.dismiss();
  });
}

/**
 * Registers a layer as open, returning a function to close it.
 *
 * Call the returned function when the layer closes by any other means — a
 * Close button, Escape, finishing a task — so the history entry it pushed does
 * not outlive it and swallow the next back press.
 */
export function pushLayer(dismiss: () => void): () => void {
  ensureWired();

  const layer: Layer = { id: nextId++, dismiss };
  stack.push(layer);
  history.pushState({ lantern: layer.id }, '');

  return () => {
    const index = stack.findIndex((l) => l.id === layer.id);
    if (index === -1) return;

    stack.splice(index, 1);
    // Only unwind history when this was the newest entry. A layer closed out
    // of order would otherwise pop someone else's.
    if (index === stack.length) {
      selfPops++;
      history.back();
    }
  };
}

/** How many dismissible layers are currently open. */
export function openLayers(): number {
  return stack.length;
}
