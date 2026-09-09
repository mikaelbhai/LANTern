import React from 'react';

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = React.useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  React.useEffect(() => {
    const mql = window.matchMedia(query);
    const on = () => setMatches(mql.matches);
    on();
    mql.addEventListener('change', on);
    return () => mql.removeEventListener('change', on);
  }, [query]);
  return matches;
}

export const useIsMobile = () => useMediaQuery('(max-width: 860px)');

export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = React.useState(Date.now());
  React.useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

/** Calls `fn` when a click lands outside the returned ref. */
export function useClickOutside<T extends HTMLElement>(fn: () => void) {
  const ref = React.useRef<T>(null);
  React.useEffect(() => {
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) fn();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [fn]);
  return ref;
}

export function useLocalStorage<T>(key: string, initial: T) {
  const [value, setValue] = React.useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  });
  React.useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage full or unavailable */
    }
  }, [key, value]);
  return [value, setValue] as const;
}

/** Keeps an interval running only while `active` is true. */
export function useInterval(fn: () => void, ms: number | null) {
  const saved = React.useRef(fn);
  saved.current = fn;
  React.useEffect(() => {
    if (ms === null) return;
    const id = setInterval(() => saved.current(), ms);
    return () => clearInterval(id);
  }, [ms]);
}


/**
 * Native OS file drops onto one element.
 *
 * An HTML drop hands over `File` objects with no path, which is useless for
 * sending — the server opens files by path. Tauri reports drops separately,
 * with real paths and a screen position, so this hit-tests that position
 * against the element to decide whether the drop was meant for it.
 *
 * Returns whether something is currently hovering over the element, so the
 * caller can show the same highlight it would for an HTML drag.
 */
export function useNativeFileDrop(
  ref: React.RefObject<HTMLElement>,
  onPaths: (paths: string[]) => void,
): boolean {
  const [over, setOver] = React.useState(false);
  const handler = React.useRef(onPaths);
  handler.current = onPaths;

  React.useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    let dispose: (() => void) | null = null;
    let cancelled = false;

    const inside = (pos: { x: number; y: number }) => {
      const el = ref.current;
      if (!el) return false;
      const r = el.getBoundingClientRect();
      // Tauri reports physical pixels; the DOM works in CSS pixels.
      const scale = window.devicePixelRatio || 1;
      const x = pos.x / scale;
      const y = pos.y / scale;
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };

    void (async () => {
      try {
        const { getCurrentWebview } = await import('@tauri-apps/api/webview');
        const un = await getCurrentWebview().onDragDropEvent((event) => {
          const p = event.payload as
            | { type: 'over'; position: { x: number; y: number } }
            | { type: 'drop'; paths: string[]; position: { x: number; y: number } }
            | { type: 'leave' };
          if (p.type === 'over') {
            setOver(inside(p.position));
          } else if (p.type === 'drop') {
            const hit = inside(p.position);
            setOver(false);
            if (hit && p.paths.length) handler.current(p.paths);
          } else {
            setOver(false);
          }
        });
        if (cancelled) un();
        else dispose = un;
      } catch {
        // No native drag-drop available; the HTML fallback still applies.
      }
    })();

    return () => {
      cancelled = true;
      dispose?.();
    };
  }, [ref]);

  return over;
}
