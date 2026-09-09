//! Serving a file with a chosen audio track.
//!
//! A webview cannot switch between audio tracks muxed into a file: Chromium
//! has never implemented `HTMLMediaElement.audioTracks`, and it cannot decode
//! E-AC-3 or DTS at all, which is what most multi-language releases carry. So
//! the switch happens before the bytes arrive: the file is remuxed on the fly
//! with exactly one audio track selected.
//!
//! The video stream is **copied**, never re-encoded. Transcoding 4K HEVC to
//! change the language would cost more CPU than the rest of the app combined
//! and would visibly degrade the picture. Only the audio is touched, and only
//! when its codec is one the browser cannot play.
//!
//! This is the one feature that depends on an external program. LANTern works
//! without ffmpeg — every other path is self-contained — and says so plainly
//! rather than offering a control that would fail.

use std::path::Path;
use std::process::Stdio;

/// Audio codecs a Chromium-based webview can decode directly.
///
/// Anything outside this list has to be re-encoded. AC-3 is deliberately
/// absent: Chromium dropped it, and a file that plays in VLC will not play
/// here.
const WEB_SAFE_AUDIO: [&str; 4] = ["AAC", "Opus", "Vorbis", "FLAC"];

/// Where ffmpeg is, if it is anywhere.
///
/// Resolved once and cached: the answer does not change during a session, and
/// probing the filesystem on every request would show up as a stutter when
/// someone scrubs.
pub fn ffmpeg_path() -> Option<&'static Path> {
    use std::sync::OnceLock;
    static FOUND: OnceLock<Option<std::path::PathBuf>> = OnceLock::new();

    FOUND
        .get_or_init(|| {
            // PATH first, then the places Windows package managers put it.
            let candidates = [
                "ffmpeg",
                #[cfg(windows)]
                r"C:\ffmpeg\bin\ffmpeg.exe",
                #[cfg(windows)]
                r"C:\Program Files\ffmpeg\bin\ffmpeg.exe",
            ];

            for candidate in candidates {
                let mut probe = std::process::Command::new(candidate);
                probe
                    .arg("-version")
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .stdin(Stdio::null());

                // A GUI process has no console, so Windows opens one for any
                // child that asks for a terminal. Without this the check
                // flashes a black window on screen every time it runs.
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
                    probe.creation_flags(CREATE_NO_WINDOW);
                }

                if probe.status().map(|s| s.success()).unwrap_or(false) {
                    return Some(std::path::PathBuf::from(candidate));
                }
            }
            None
        })
        .as_deref()
}

/// True when the browser can play this audio codec as-is.
pub fn is_web_safe(codec: &str) -> bool {
    WEB_SAFE_AUDIO.iter().any(|safe| codec.contains(safe))
}

/// Builds the ffmpeg invocation for one track.
///
/// Split out from spawning so the argument list can be asserted in a test:
/// getting `-c:v copy` wrong would silently re-encode a 20 GB film.
pub fn arguments(path: &str, track_index: u64, codec: &str, seek_sec: f64) -> Vec<String> {
    let mut args: Vec<String> = Vec::new();

    // Seeking before -i lets ffmpeg jump by index instead of decoding up to
    // the point, which is the difference between instant and minutes.
    if seek_sec > 0.5 {
        args.push("-ss".into());
        args.push(format!("{seek_sec:.3}"));
    }

    args.push("-i".into());
    args.push(path.into());

    // First video stream, and the one audio track that was asked for.
    args.push("-map".into());
    args.push("0:v:0".into());
    args.push("-map".into());
    args.push(format!("0:a:{track_index}"));

    args.push("-c:v".into());
    args.push("copy".into());

    if is_web_safe(codec) {
        // Already playable: remux only, which costs almost nothing.
        args.push("-c:a".into());
        args.push("copy".into());
    } else {
        // Re-encode to something the webview can actually decode. Stereo at
        // 192k: a surround mix downmixed for a laptop or a phone, which is
        // where this is being watched.
        args.push("-c:a".into());
        args.push("aac".into());
        args.push("-b:a".into());
        args.push("192k".into());
        args.push("-ac".into());
        args.push("2".into());
    }

    // Fragmented MP4 so playback can start before the file ends — a normal
    // MP4 puts its index last, which would mean transcoding the whole film
    // before the first frame appeared.
    args.push("-movflags".into());
    args.push("frag_keyframe+empty_moov+default_base_moof".into());
    args.push("-f".into());
    args.push("mp4".into());
    args.push("pipe:1".into());

    args
}

/// Arguments for a single still frame, encoded as JPEG on stdout.
///
/// One frame, scaled down, at a point far enough in to be past the studio
/// idents. `-ss` before `-i` again: seeking by index rather than decoding two
/// minutes of 4K to reach the frame.
pub fn thumbnail_arguments(path: &str, at_sec: f64) -> Vec<String> {
    vec![
        "-ss".into(),
        format!("{at_sec:.3}"),
        "-i".into(),
        path.into(),
        "-frames:v".into(),
        "1".into(),
        // 480 wide is more than a card ever shows; -2 keeps the aspect ratio
        // and an even height, which the encoder requires.
        "-vf".into(),
        "scale=480:-2".into(),
        "-q:v".into(),
        "4".into(),
        "-f".into(),
        "image2".into(),
        "-vcodec".into(),
        "mjpeg".into(),
        "pipe:1".into(),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn copies_the_video_stream_always() {
        for codec in ["AAC", "E-AC-3", "DTS", "TrueHD"] {
            let args = arguments("f.mkv", 1, codec, 0.0);
            let at = args.iter().position(|a| a == "-c:v").expect("video codec set");
            assert_eq!(
                args[at + 1],
                "copy",
                "video must never be re-encoded, even for {codec}"
            );
        }
    }

    #[test]
    fn remuxes_a_playable_codec_and_re_encodes_the_rest() {
        let aac = arguments("f.mp4", 0, "AAC", 0.0);
        let at = aac.iter().position(|a| a == "-c:a").unwrap();
        assert_eq!(aac[at + 1], "copy", "AAC already plays; do not touch it");

        let eac3 = arguments("f.mp4", 2, "E-AC-3", 0.0);
        let at = eac3.iter().position(|a| a == "-c:a").unwrap();
        assert_eq!(eac3[at + 1], "aac", "E-AC-3 cannot be decoded by the webview");
    }

    #[test]
    fn selects_the_requested_track() {
        let args = arguments("f.mp4", 3, "AAC", 0.0);
        assert!(
            args.windows(2).any(|w| w[0] == "-map" && w[1] == "0:a:3"),
            "the chosen audio track must be the one mapped: {args:?}"
        );
        assert!(
            args.windows(2).any(|w| w[0] == "-map" && w[1] == "0:v:0"),
            "the video stream must still be included"
        );
    }

    #[test]
    fn seeks_before_the_input_so_it_is_not_a_decode() {
        let args = arguments("f.mkv", 0, "AAC", 90.0);
        let ss = args.iter().position(|a| a == "-ss").expect("seek present");
        let input = args.iter().position(|a| a == "-i").expect("input present");
        assert!(ss < input, "-ss must precede -i to seek by index");

        assert!(
            !arguments("f.mkv", 0, "AAC", 0.0).contains(&"-ss".to_string()),
            "no seek argument when starting from the beginning"
        );
    }

    #[test]
    fn output_is_streamable() {
        let args = arguments("f.mkv", 0, "DTS", 0.0);
        let at = args.iter().position(|a| a == "-movflags").unwrap();
        assert!(
            args[at + 1].contains("empty_moov"),
            "a plain MP4 would need the whole film transcoded before playback"
        );
    }

    #[test]
    fn a_thumbnail_is_one_scaled_frame() {
        let args = thumbnail_arguments("f.mkv", 120.0);
        assert!(args.windows(2).any(|w| w[0] == "-frames:v" && w[1] == "1"));
        assert!(args.iter().any(|a| a.contains("scale=480")));

        let ss = args.iter().position(|a| a == "-ss").unwrap();
        let input = args.iter().position(|a| a == "-i").unwrap();
        assert!(ss < input, "seek by index, not by decoding to the frame");
    }

    #[test]
    fn knows_what_the_browser_can_decode() {
        assert!(is_web_safe("AAC"));
        assert!(is_web_safe("Opus"));
        assert!(!is_web_safe("E-AC-3"));
        assert!(!is_web_safe("DTS"));
        // AC-3 is not playable in Chromium even though many players handle it.
        assert!(!is_web_safe("AC-3"));
    }
}
