/**
 * Subtitle rendering, done by hand rather than by the browser.
 *
 * The obvious approach — `<track>` with `mode = "showing"` and a `::cue`
 * rule — does not survive contact with Chromium. If the operating system has
 * any closed-caption preference set, Chromium and Edge apply *that* and ignore
 * page styling entirely, which is how subtitles end up either unstyled or, on
 * a dark player with a white OS default, effectively invisible.
 *
 * So the track is set to `hidden`: the browser still parses the file and fires
 * `cuechange`, but draws nothing. The active cues are read out and rendered as
 * ordinary DOM, which styles predictably on every platform and makes the
 * appearance a setting rather than an accident.
 *
 * See jellyfin/jellyfin-web#4742 for the same conclusion reached the hard way.
 */
import React from 'react';
import { cn } from '../../lib/utils';

export type SubtitleStyle = 'classic' | 'boxed' | 'large';

export const SUBTITLE_STYLES: { id: SubtitleStyle; label: string; hint: string }[] = [
  { id: 'classic', label: 'Classic', hint: 'White text with a soft outline' },
  { id: 'boxed', label: 'Boxed', hint: 'White on a dark band, for bright scenes' },
  { id: 'large', label: 'Large', hint: 'Bigger and yellow, easier at a distance' },
];

/**
 * Turns one cue's markup into React nodes.
 *
 * WebVTT allows a small set of inline tags. Only italic, bold and underline
 * carry meaning worth keeping; voice and class spans are dropped rather than
 * rendered as literal angle brackets. Nothing is passed to `innerHTML` — the
 * text comes from a file on someone else's machine.
 */
function renderCue(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /<(\/?)([ibu])(?:\.[^>]*)?>|<[^>]*>|\n/g;

  let index = 0;
  let last = 0;
  const open: string[] = [];

  const push = (chunk: string) => {
    if (!chunk) return;
    let node: React.ReactNode = chunk;
    // Wrap from the inside out, so nested tags nest.
    for (let i = open.length - 1; i >= 0; i--) {
      const Tag = open[i] as 'i' | 'b' | 'u';
      node = <Tag key={`${keyPrefix}-w-${index}-${i}`}>{node}</Tag>;
    }
    nodes.push(<React.Fragment key={`${keyPrefix}-${index++}`}>{node}</React.Fragment>);
  };

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text))) {
    push(text.slice(last, match.index));
    last = match.index + match[0].length;

    if (match[0] === '\n') {
      nodes.push(<br key={`${keyPrefix}-br-${index++}`} />);
    } else if (match[2]) {
      if (match[1]) {
        const at = open.lastIndexOf(match[2]);
        if (at !== -1) open.splice(at, 1);
      } else {
        open.push(match[2]);
      }
    }
    // Any other tag is dropped.
  }
  push(text.slice(last));

  return nodes;
}

/** One line of dialogue, with the window of film it belongs to. */
export type Cue = { start: number; end: number; text: string };

/** `00:01:08.527` or `01:08.527` into seconds. */
function stamp(raw: string): number {
  const parts = raw.trim().replace(',', '.').split(':').map(Number);
  if (parts.some((n) => !Number.isFinite(n))) return NaN;
  const [h, m, sec] = parts.length === 3 ? parts : [0, parts[0], parts[1]];
  return h * 3600 + m * 60 + sec;
}

/**
 * Reads WebVTT into cues.
 *
 * Deliberately not the browser's job. A `<track>` element brings three
 * problems with it: cross-origin files are dropped unless the video carries
 * `crossorigin`, which breaks playback here; Chromium overrides `::cue`
 * styling whenever the OS has a caption preference, which is how these went
 * invisible; and cue timings are matched against the *element's* clock, which
 * restarts at zero on a remuxed audio stream and would put every line 40
 * minutes out. Parsing here sidesteps all three, and the format is simple.
 */
export function parseVtt(text: string): Cue[] {
  const cues: Cue[] = [];

  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.split('\n');
    // An optional numeric or textual id may precede the timing line.
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at === -1) continue;

    const [from, to] = lines[at].split('-->');
    if (!from || !to) continue;

    const start = stamp(from);
    // Cue settings (align, position) trail the end stamp; take the stamp only.
    const end = stamp(to.trim().split(/\s+/)[0]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    const body = lines.slice(at + 1).join('\n').trim();
    if (body) cues.push({ start, end, text: body });
  }

  return cues;
}

/**
 * Fetches a subtitle file and parses it.
 *
 * Subtitles are small — a full film is around 60 KB — so the whole track is
 * held in memory and no further requests are made while it plays.
 */
export function useSubtitleCues(url: string | null): Cue[] {
  const [cues, setCues] = React.useState<Cue[]>([]);

  React.useEffect(() => {
    if (!url) {
      setCues([]);
      return;
    }

    let live = true;
    setCues([]);

    void fetch(url)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(String(r.status)))))
      .then((text) => {
        if (live) setCues(parseVtt(text));
      })
      .catch(() => {
        if (live) setCues([]);
      });

    return () => {
      live = false;
    };
  }, [url]);

  return cues;
}

/**
 * Draws whichever cues are active right now.
 *
 * Positioned above the controls rather than at the very bottom, so the last
 * line of dialogue is not hidden behind the scrubber the moment someone
 * touches the screen.
 */
export function SubtitleOverlay({
  cues,
  time,
  style,
  chromeVisible,
}: {
  cues: Cue[];
  /**
   * Position in the film, in seconds. The player's own clock, which already
   * accounts for a remuxed stream starting partway in — the video element's
   * `currentTime` would not.
   */
  time: number;
  style: SubtitleStyle;
  /** Lifts the text clear of the controls while they are on screen. */
  chromeVisible: boolean;
}) {
  // Usually one line, occasionally two overlapping. Recomputed per frame of
  // the clock, which ticks about four times a second — cheap enough at this
  // size that an index would be more code than it saves.
  const lines = React.useMemo(
    () => cues.filter((c) => time >= c.start && time <= c.end).map((c) => c.text),
    [cues, time],
  );

  if (!lines.length) return null;

  return (
    <div
      className={cn(
        'pointer-events-none absolute inset-x-0 z-20 flex flex-col items-center gap-1 px-6 text-center transition-all duration-200',
        chromeVisible ? 'bottom-24' : 'bottom-10',
      )}
      aria-live="polite"
    >
      {lines.map((line, i) => (
        <span
          key={i}
          className={cn(
            'max-w-[90%] leading-snug',
            style === 'classic' &&
              'text-white font-medium [text-shadow:0_2px_4px_rgba(0,0,0,0.95),0_0_2px_rgba(0,0,0,0.9)] text-[clamp(15px,2.4vw,30px)]',
            style === 'boxed' &&
              'text-white font-medium bg-black/75 rounded px-2.5 py-1 text-[clamp(15px,2.2vw,28px)]',
            style === 'large' &&
              'text-[#F7E14A] font-semibold [text-shadow:0_2px_5px_rgba(0,0,0,0.98),0_0_3px_rgba(0,0,0,0.95)] text-[clamp(19px,3.2vw,40px)]',
          )}
        >
          {renderCue(line, `cue-${i}`)}
        </span>
      ))}
    </div>
  );
}
