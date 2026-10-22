import React from 'react';

import { languageName } from './tracks';
import { detectLanguage, type Detected } from './subtitleLanguage';

/** What each track's text turned out to be. Kept for the session: a file does not change. */
const cache = new Map<string, Detected | null>();

const undetermined = (lang: string | undefined) => {
  const name = languageName(lang ?? '');
  return !name || name === 'Undetermined';
};

/**
 * Reads the subtitle tracks whose language the file did not state, once the
 * menu is open, and returns what they turned out to be.
 *
 * Not at load: it is a request for every such track to the device sharing the
 * file, which has to convert each to WebVTT, and most films are watched
 * without anyone opening the menu. The first look at the menu shows the
 * plain names and fills the better ones in a moment later.
 */
export function useDetectedSubtitles(
  subs: { url: string; lang?: string }[],
  active: boolean,
): Map<string, Detected | null> {
  const [, refresh] = React.useState(0);

  React.useEffect(() => {
    if (!active) return;
    const todo = subs.filter((s) => undetermined(s.lang) && !cache.has(s.url));
    if (todo.length === 0) return;

    let live = true;
    void Promise.all(
      todo.map(async (s) => {
        try {
          const response = await fetch(s.url);
          cache.set(s.url, response.ok ? detectLanguage(await response.text()) : null);
        } catch {
          // Not remembered as a failure: a device that was briefly unreachable
          // should be asked again next time the menu opens.
        }
      }),
    ).then(() => {
      if (live) refresh((n) => n + 1);
    });
    return () => {
      live = false;
    };
  }, [subs, active]);

  return cache;
}
