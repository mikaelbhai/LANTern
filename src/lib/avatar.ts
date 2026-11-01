/**
 * Turning a photo somebody picked into something a link can carry.
 *
 * A picture chosen on a phone is three to twelve megabytes. The signalling
 * link is one TCP socket per peer carrying newline-delimited JSON, and chat,
 * typing, call setup and game moves all ride it — so a raw photo sent down it
 * would stall every one of those behind itself for seconds.
 *
 * So it is drawn into a 128px square and re-encoded as JPEG before it is
 * stored or sent. 128 is twice the largest avatar the interface draws (the
 * 44px row avatar on a 2x screen is 88), which is enough that it never looks
 * soft and small enough that the result is five to ten kilobytes.
 */

/** The square, in device pixels, every picture is reduced to. */
const SIZE = 128;

/**
 * JPEG rather than PNG.
 *
 * A photograph as PNG is four to six times larger for no visible gain, and a
 * picture of a person is what this is for. Transparency is lost, which does
 * not matter: the result is drawn inside a circle that clips it anyway.
 */
const QUALITY = 0.82;

/** Anything this application will attempt to decode. */
const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

export { ACCEPT as AVATAR_ACCEPT };

/**
 * Reads a picked file and returns a data URL of a 128px square.
 *
 * Centre-cropped rather than squashed. A portrait photo letterboxed into a
 * circle is mostly background, and stretching a face to fit a square is
 * worse than cropping one.
 */
export async function toAvatar(file: File | Blob): Promise<string> {
  const bitmap = await decode(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');

    // The largest centred square the source contains.
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;

    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, SIZE, SIZE);
    return canvas.toDataURL('image/jpeg', QUALITY);
  } finally {
    // A bitmap holds a decoded frame — several megabytes for a phone photo —
    // until it is closed, and picking a few pictures in a row without this
    // is enough to have the webview killed on a phone.
    if ('close' in bitmap) bitmap.close();
  }
}

/**
 * How long a stored picture may be, as a data URL, before it is made smaller.
 *
 * About eighteen kilobytes of picture. A 128px JPEG is five to ten, so anything
 * over this was not made by `toAvatar`: it is a picture saved by an older
 * version, which kept the original or a large PNG. The native side refuses to
 * send one over 96 KB at all - silently, to the person who set it - so a photo
 * that showed on its own device never reached any other.
 */
export const AVATAR_MAX_CHARS = 24_000;

/**
 * Makes a stored picture small enough to send, or returns it unchanged when it
 * already is.
 *
 * The same 128px centred square as a fresh upload, then a lower quality if that
 * is still too big. Never returns something larger than it was given. If the
 * picture cannot be read at all it is returned as it was: a picture that cannot
 * be shrunk is for the caller to leave out of what it sends, not for this to
 * delete.
 */
export async function fitAvatar(dataUrl: string, max = AVATAR_MAX_CHARS): Promise<string> {
  if (!dataUrl || dataUrl.length <= max) return dataUrl;
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('unreadable'));
      i.src = dataUrl;
    });
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return dataUrl;
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const sx = (img.naturalWidth - side) / 2;
    const sy = (img.naturalHeight - side) / 2;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, sx, sy, side, side, 0, 0, SIZE, SIZE);
    for (const quality of [QUALITY, 0.65, 0.5]) {
      const out = canvas.toDataURL('image/jpeg', quality);
      if (out.length <= max) return out.length < dataUrl.length ? out : dataUrl;
    }
    const last = canvas.toDataURL('image/jpeg', 0.4);
    return last.length < dataUrl.length ? last : dataUrl;
  } catch {
    return dataUrl;
  }
}

/**
 * A decoded frame, by whichever route this webview supports.
 *
 * `createImageBitmap` is the cheap one and is what Android's WebView has.
 * The fallback is for anything that does not, and for the simulator running
 * in a plain browser.
 */
async function decode(file: File | Blob): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file);
    } catch {
      // Falls through: a GIF or a CMYK JPEG can refuse here and still decode
      // through an <img>.
    }
  }

  const url = URL.createObjectURL(file);
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('that file is not a picture this can read'));
      img.src = url;
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * Asks for a picture and returns it ready to store.
 *
 * `null` when the person closed the picker, which is not an error and must
 * not raise one — a cancelled file dialog that shows a red toast is the most
 * annoying possible outcome of changing your mind.
 */
export function pickAvatar(): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = ACCEPT;

    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      toAvatar(file).then(resolve, () => resolve(null));
    };

    // A cancelled picker fires `cancel` in a current webview and nothing at
    // all in an older one, so the promise is also resolved by `onchange`
    // above with no file. Neither path rejects.
    input.oncancel = () => resolve(null);
    input.click();
  });
}
