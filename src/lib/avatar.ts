/**
 * Profile pictures.
 *
 * Every picture is normalised to 500x500 PNG before it goes anywhere. Phones
 * produce 12-megapixel images and people will happily pick one; storing that
 * and serving it to every peer on every render would cost more than the rest
 * of the app's traffic combined. Cropping to a square here also means the UI
 * never has to reason about aspect ratio — an avatar is a circle at every size
 * it appears in.
 *
 * The bytes live on the Rust side and are served over the same HTTP server as
 * everything else, so a peer fetches a picture the way it fetches a video.
 */
import { api, isTauri } from './bridge';

export const AVATAR_SIZE = 500;

/**
 * Reads an image file and returns a square 500x500 PNG.
 *
 * Crops to the centre rather than squashing: a face stretched to fit a square
 * is worse than a face with its edges trimmed.
 */
export async function toSquarePng(file: File | Blob): Promise<Uint8Array | null> {
  const bitmap = await createImageBitmap(file).catch(() => null);
  if (!bitmap) return null;

  try {
    const side = Math.min(bitmap.width, bitmap.height);
    const sx = (bitmap.width - side) / 2;
    const sy = (bitmap.height - side) / 2;

    const canvas = document.createElement('canvas');
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Smoothing matters here: the source is almost always larger than the
    // target, and nearest-neighbour downscaling of a photograph looks broken.
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bitmap, sx, sy, side, side, 0, 0, AVATAR_SIZE, AVATAR_SIZE);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/png'),
    );
    if (!blob) return null;
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    bitmap.close();
  }
}

/** Opens a picker, normalises the choice, and stores it. */
export async function pickAvatar(): Promise<boolean> {
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.oncancel = () => resolve(null);
    input.click();
  });
  if (!file) return false;

  const png = await toSquarePng(file);
  if (!png) return false;

  if (isTauri()) {
    await api.profile.setAvatar(Array.from(png));
  }
  return true;
}

export async function clearAvatar(): Promise<void> {
  if (isTauri()) await api.profile.setAvatar([]);
}

/**
 * Where a peer's picture lives.
 *
 * `version` busts the cache when a peer changes theirs — without it the
 * browser would keep showing the old one for as long as it holds the entry.
 */
export function peerAvatarUrl(
  ip: string,
  hostPort: number,
  version?: number | string,
): string {
  const bust = version ? `?v=${version}` : '';
  return `http://${ip}:${hostPort}/avatar.png${bust}`;
}
