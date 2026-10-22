/**
 * Where a remuxed stream asked to begin at `at` really begins.
 *
 * The video in a remuxed stream is copied, so it can only start on a keyframe,
 * and the host's `-ss` lands on the one before the request - up to a GOP
 * earlier. The player's clock and the subtitles are measured from the start of
 * the stream, so they need to know where that is; assuming it was `at` put
 * them as far out as the keyframe was early.
 *
 * A host that cannot answer (an older build, no ffmpeg, a slow disk) gets the
 * request back unchanged, which is how it behaved before and only costs the
 * offset it always cost.
 */
export async function streamOrigin(streamUrl: string, at: number): Promise<number> {
  const asked = Math.max(0, at);
  if (asked <= 0.5) return 0;
  try {
    // The same digits the stream's own URL will carry, so both make one jump.
    const url = `${streamUrl}${streamUrl.includes('?') ? '&' : '?'}keyframe=${asked.toFixed(3)}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) return asked;
    const body = await response.json();
    const start = Number(body?.start);
    // Never later than asked, never absurdly earlier: a wrong answer here
    // would put the clock minutes from the picture.
    return Number.isFinite(start) && start <= asked + 0.01 && asked - start < 60 ? start : asked;
  } catch {
    return asked;
  }
}
