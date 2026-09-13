/**
 * The handful of things older WebKit is missing.
 *
 * LANTern says it runs on macOS 12.0, and that has to be true rather than
 * nearly true. Safari on 12.0 is 15.2; two of the functions in the shipped
 * bundle arrived in 15.4, which leaves 12.0 to 12.2 with an application that
 * starts, throws, and shows nothing — the worst of the three outcomes, because
 * "refuses to install" at least tells you something.
 *
 * Both are one-liners, and one of them comes from a dependency rather than
 * from here, so editing the source would not have covered it. Imported first
 * in `main.tsx`, before anything can call them.
 *
 * This is not a general polyfill library and should not become one. Anything
 * added here should come from an actual audit of the built bundle against the
 * version the application claims to support.
 */

/** Safari 15.4. Used by framer-motion. */
if (!Object.hasOwn) {
  Object.defineProperty(Object, 'hasOwn', {
    value: function hasOwn(target: object, key: PropertyKey): boolean {
      return Object.prototype.hasOwnProperty.call(target, key);
    },
    configurable: true,
    writable: true,
  });
}

/** Safari 15.4. Negative indices from the end, which is the only reason to use it. */
function at(this: { length: number; [i: number]: unknown }, index: number): unknown {
  const len = this.length;
  // Truncate rather than round: `at(1.7)` is `at(1)`, as specified.
  const i = Math.trunc(index) || 0;
  const from = i < 0 ? len + i : i;
  return from < 0 || from >= len ? undefined : this[from];
}

for (const proto of [Array.prototype, String.prototype]) {
  if (!(proto as { at?: unknown }).at) {
    Object.defineProperty(proto, 'at', { value: at, configurable: true, writable: true });
  }
}

/**
 * Safari 16. Used by the update check.
 *
 * The cost of its absence was not a crash anybody could see: the call throws,
 * the update check catches everything and reports `offline`, and a Mac on
 * macOS 12 therefore said it could not reach the internet whether or not it
 * could - permanently, with no way to update from inside the application.
 */
if (typeof AbortSignal !== 'undefined' && !AbortSignal.timeout) {
  Object.defineProperty(AbortSignal, 'timeout', {
    value: function timeout(ms: number): AbortSignal {
      const controller = new AbortController();
      // `TimeoutError`, not the default `AbortError`, so anything telling the
      // two apart still can.
      setTimeout(() => controller.abort(new DOMException('signal timed out', 'TimeoutError')), ms);
      return controller.signal;
    },
    configurable: true,
    writable: true,
  });
}

export {};
