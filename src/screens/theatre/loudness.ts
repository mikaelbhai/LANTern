/**
 * Volume past 100%.
 *
 * A media element's own volume stops at 1, and quiet films are common - a
 * dialogue track mixed for a cinema, played through a laptop speaker. The only
 * way past it is to route the element through a Web Audio gain stage.
 *
 * Two things make that fragile, and both are handled by the caller:
 *  - An element can be wired into a graph once, for good. Wired, its sound
 *    comes only from the graph, so the graph has to stay connected for the
 *    life of the element, even when the gain is back to 1.
 *  - A graph fed by an element whose media was fetched without a successful
 *    CORS check outputs silence, not an error. So this is only ever attached
 *    to an element that asked for `crossOrigin` and has loaded.
 */
interface Stage {
  context: AudioContext;
  gain: GainNode;
}

const stages = new WeakMap<HTMLMediaElement, Stage>();

/** Sets the gain for an element, wiring it in on first use. False if it cannot be. */
export function setBoost(el: HTMLMediaElement, gain: number): boolean {
  let stage = stages.get(el);
  if (!stage) {
    // Nothing to do, and nothing worth wiring in for: a gain of 1 on an
    // unwired element is just the element's own volume.
    if (gain <= 1) return true;
    try {
      const Context: typeof AudioContext | undefined =
        window.AudioContext ?? (window as any).webkitAudioContext;
      if (!Context) return false;
      const context = new Context();
      const source = context.createMediaElementSource(el);
      const node = context.createGain();
      source.connect(node);
      node.connect(context.destination);
      stage = { context, gain: node };
      stages.set(el, stage);
    } catch {
      return false;
    }
  }
  stage.gain.gain.value = Math.max(0, gain);
  // Contexts start suspended until a gesture; this is called from one, but a
  // suspended context is silence, so it is asked every time.
  if (stage.context.state === 'suspended') void stage.context.resume().catch(() => {});
  return true;
}
