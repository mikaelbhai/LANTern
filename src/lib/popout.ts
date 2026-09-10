/**
 * Taking a call out of the application.
 *
 * There is a hard limit worth stating: a second window is a second webview
 * with its own javascript context, and a `MediaStream` cannot cross between
 * them. So "move the call into another window" is not a thing that can be
 * built — the peer connection lives where it was opened and the video element
 * has to live beside it.
 *
 * Two things can be done instead, and together they are what people mean.
 *
 * The picture goes out through the browser's own Picture-in-Picture, which is
 * an operating-system window floating above every other application, made for
 * exactly this and costing nothing to use. It is the same mechanism a video
 * site uses, and the system — not this application — decides where it sits and
 * how it is dismissed.
 *
 * The controls go out through the corner window LANTern already has, which
 * knows how to show a call in progress and how to mute and hang up. On a voice
 * call, where there is no picture, that window is the whole of it.
 */

/** Whether the system will float a video for us. */
export function canPopOutVideo(): boolean {
  if (typeof document === 'undefined') return false;
  // Both matter: the API can exist while the document forbids it, which is
  // what an iframe without the permission looks like.
  return (
    'pictureInPictureEnabled' in document &&
    (document as Document & { pictureInPictureEnabled: boolean }).pictureInPictureEnabled
  );
}

type PiPVideo = HTMLVideoElement & {
  requestPictureInPicture?: () => Promise<unknown>;
  disablePictureInPicture?: boolean;
};

/**
 * Floats a video above everything else.
 *
 * Returns false rather than throwing when the system says no — which it does
 * for a video with no frames yet, and on platforms that have the API and no
 * intention of honouring it.
 */
export async function popOutVideo(video: HTMLVideoElement | null): Promise<boolean> {
  const el = video as PiPVideo | null;
  if (!el || !canPopOutVideo() || el.disablePictureInPicture) return false;
  if (typeof el.requestPictureInPicture !== 'function') return false;

  // A video with no dimensions has nothing to show yet, and asking anyway
  // fails in a way that reads as the feature being broken.
  if (!el.videoWidth || !el.videoHeight) return false;

  try {
    await el.requestPictureInPicture();
    return true;
  } catch {
    return false;
  }
}

/** Brings it back, if it is out there. */
export async function bringVideoBack(): Promise<void> {
  const doc = document as Document & {
    pictureInPictureElement?: Element | null;
    exitPictureInPicture?: () => Promise<void>;
  };
  if (!doc.pictureInPictureElement || typeof doc.exitPictureInPicture !== 'function') return;
  try {
    await doc.exitPictureInPicture();
  } catch {
    /* it was already gone */
  }
}

/** True while a video of ours is floating. */
export const videoIsPoppedOut = (): boolean =>
  typeof document !== 'undefined' &&
  !!(document as Document & { pictureInPictureElement?: Element | null }).pictureInPictureElement;
