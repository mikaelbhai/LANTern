import type { MediaItem } from './types';

/**
 * What the floating video window calls itself.
 *
 * The system's picture-in-picture window names itself after the page that
 * opened it, and the page is called "LANTern" whatever is playing - so hovering
 * the window said nothing about what was in it, and a file's real name is a
 * release tag nobody wants on a corner of the screen. Short and plain: a
 * series is "Show S01 E05", a film is its title, anything else is the app.
 */
export function pipTitle(item: Pick<MediaItem, 'title' | 'series' | 'season' | 'episode' | 'kind'>): string {
  const episode = item.kind === 'episode' || !!item.series || item.episode != null;
  if (episode && item.series) {
    const pad = (n: number) => String(n).padStart(2, '0');
    const s = item.season != null ? ` S${pad(item.season)}` : '';
    const e = item.episode != null ? ` E${pad(item.episode)}` : '';
    return `${item.series}${s}${e}`.trim();
  }
  const title = item.title?.trim();
  return title ? title : 'LANTern';
}
