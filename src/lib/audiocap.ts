/**
 * Whether this device can play an audio codec, and so whether the file has to
 * be remuxed before it arrives.
 *
 * The same file can be fine on one device and silent on another: Windows
 * lends its webview the system's Dolby decoders, and Android's webview has
 * none. So this is not a property of the file, and cannot be decided on the
 * machine holding it — it has to be asked here, on the device about to play.
 */

/**
 * The MIME the browser understands, for codecs worth asking about.
 *
 * Only the Dolby family: they are the codecs whose support actually differs
 * between platforms. DTS and TrueHD are supported nowhere a webview runs, and
 * asking would only invite a wrong "maybe".
 */
export function mimeFor(codec: string): string | null {
  const c = codec.toLowerCase();
  // E-AC-3 first — every spelling of it also contains "ac3".
  if (c.includes('eac3') || c.includes('e-ac-3') || c.includes('ec-3')) {
    return 'audio/mp4; codecs="ec-3"';
  }
  if (c.includes('ac3') || c.includes('ac-3')) {
    return 'audio/mp4; codecs="ac-3"';
  }
  return null;
}

/**
 * Whether this track has to be re-encoded for this device.
 *
 * `webSafe` comes from the host, which knows the codec but not the device.
 * When it says the codec is fine, it is fine everywhere. When it says it is
 * not, the browser still gets the last word — a Windows desktop plays E-AC-3
 * perfectly, and re-encoding there would burn CPU to produce worse audio.
 *
 * `canPlay` is injected rather than reached for, so the decision can be
 * exercised without a DOM.
 */
export function needsRemux(
  codec: string,
  webSafe: boolean,
  canPlay: (type: string) => string,
): boolean {
  if (webSafe) return false;
  const mime = mimeFor(codec);
  // Nothing worth asking about: DTS, TrueHD, or something unrecognised. The
  // host already said the browser cannot take it, and there is no second
  // opinion to seek.
  if (!mime) return true;
  return canPlay(mime) === '';
}

/** Asks the real browser, via an element that is never attached. */
export function browserCanPlay(type: string): string {
  try {
    return document.createElement('video').canPlayType(type);
  } catch {
    // A browser that will not answer is one to assume the worst of: a needless
    // remux costs CPU, a missed one costs the audio entirely.
    return '';
  }
}
