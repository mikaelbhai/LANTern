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
///
/// Compared without case, because the names arrive in two spellings: the
/// Matroska ids are `A_OPUS` and `A_VORBIS` while this list is written the way
/// a person writes them. Matching exactly meant Opus and Vorbis - both
/// perfectly playable - were re-encoded for no reason, which is expensive and
/// silent about it.
pub fn is_web_safe(codec: &str) -> bool {
    let codec = codec.to_ascii_lowercase();
    WEB_SAFE_AUDIO
        .iter()
        .any(|safe| codec.contains(&safe.to_ascii_lowercase()))
}

/// Builds the ffmpeg invocation for one track.
///
/// Split out from spawning so the argument list can be asserted in a test:
/// getting `-c:v copy` wrong would silently re-encode a 20 GB film.
pub fn arguments(
    path: &str,
    track_index: u64,
    codec: &str,
    seek_sec: f64,
    // Milliseconds to move the audio by, positive to make it later. Zero for
    // the ordinary case, which is nearly always.
    delay_ms: i64,
) -> Vec<String> {
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

    // A filter cannot be applied to a stream that is only being copied, so
    // asking for a shift is asking for a re-encode. Worth saying out loud:
    // a viewer who nudges the slider on an already-playable file pays for it
    // in CPU, and gets nothing else in return.
    let shifting = delay_ms != 0;

    if shifting {
        args.push("-af".into());
        args.push(if delay_ms > 0 {
            // Later: pad the front with silence. `all=1` so it applies to
            // every channel without naming how many there are.
            format!("adelay={delay_ms}:all=1")
        } else {
            // Earlier: drop that much from the front and restamp, because a
            // trim alone leaves the timestamps where they were.
            let seconds = (-delay_ms) as f64 / 1000.0;
            format!("atrim=start={seconds:.3},asetpts=PTS-STARTPTS")
        });
    }

    if is_web_safe(codec) && !shifting {
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
    //
    // `delay_moov` rather than `empty_moov`, and the difference is audible.
    // A copied H.264 stream carries B-frames, so its first frame presents
    // later than it decodes: PTS 0.083 against DTS 0. An ordinary MP4 hides
    // that with an edit list, which `empty_moov` cannot write because the
    // header is emitted before any of it is known — leaving video starting
    // 83ms after audio, for the whole film. That is twice the threshold where
    // audio arriving first becomes obvious, and it is what made a fixed
    // soundtrack sound wrong in a new way.
    //
    // `delay_moov` waits for the first fragment, not the whole film, so the
    // edit list survives and playback still starts in a moment rather than
    // after a transcode.
    args.push("-movflags".into());
    args.push("frag_keyframe+delay_moov+default_base_moof".into());
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

    /// The case that played in silence: a lone E-AC-3 track. Chromium has no
    /// Dolby decoder, so this must come back false or the remux is skipped
    /// and the file arrives unplayable.
    #[test]
    fn dolby_and_dts_are_not_web_safe() {
        for codec in ["A_EAC3", "A_AC3", "E-AC-3", "AC-3", "A_DTS", "A_TRUEHD"] {
            assert!(!is_web_safe(codec), "{codec} was treated as playable");
        }
    }

    /// And the ones that are playable must not be re-encoded, in either
    /// spelling - the container writes A_OPUS where a person writes Opus.
    #[test]
    fn the_playable_codecs_are_left_alone() {
        for codec in [
            "A_AAC", "AAC", "A_OPUS", "Opus", "A_VORBIS", "Vorbis", "A_FLAC", "FLAC",
        ] {
            assert!(is_web_safe(codec), "{codec} would have been re-encoded");
        }
    }

    use super::*;

    #[test]
    fn copies_the_video_stream_always() {
        for codec in ["AAC", "E-AC-3", "DTS", "TrueHD"] {
            let args = arguments("f.mkv", 1, codec, 0.0, 0);
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
        let aac = arguments("f.mp4", 0, "AAC", 0.0, 0);
        let at = aac.iter().position(|a| a == "-c:a").unwrap();
        assert_eq!(aac[at + 1], "copy", "AAC already plays; do not touch it");

        let eac3 = arguments("f.mp4", 2, "E-AC-3", 0.0, 0);
        let at = eac3.iter().position(|a| a == "-c:a").unwrap();
        assert_eq!(eac3[at + 1], "aac", "E-AC-3 cannot be decoded by the webview");
    }

    #[test]
    fn selects_the_requested_track() {
        let args = arguments("f.mp4", 3, "AAC", 0.0, 0);
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
        let args = arguments("f.mkv", 0, "AAC", 90.0, 0);
        let ss = args.iter().position(|a| a == "-ss").expect("seek present");
        let input = args.iter().position(|a| a == "-i").expect("input present");
        assert!(ss < input, "-ss must precede -i to seek by index");

        assert!(
            !arguments("f.mkv", 0, "AAC", 0.0, 0).contains(&"-ss".to_string()),
            "no seek argument when starting from the beginning"
        );
    }

    #[test]
    fn output_is_streamable() {
        let args = arguments("f.mkv", 0, "DTS", 0.0, 0);
        let at = args.iter().position(|a| a == "-movflags").unwrap();
        assert!(
            args[at + 1].contains("frag_keyframe"),
            "a plain MP4 would need the whole film transcoded before playback"
        );
    }

    /// Moving the audio, which is what the player's delay control asks for.
    #[test]
    fn a_shift_moves_the_audio_either_way() {
        let later = arguments("f.mkv", 0, "A_EAC3", 0.0, 120);
        let at = later.iter().position(|a| a == "-af").expect("no filter");
        assert_eq!(later[at + 1], "adelay=120:all=1");

        let earlier = arguments("f.mkv", 0, "A_EAC3", 0.0, -120);
        let at = earlier.iter().position(|a| a == "-af").expect("no filter");
        assert_eq!(earlier[at + 1], "atrim=start=0.120,asetpts=PTS-STARTPTS");

        // The ordinary case asks for no filter at all.
        assert!(!arguments("f.mkv", 0, "A_EAC3", 0.0, 0).contains(&"-af".to_string()));
    }

    /// A filter cannot be applied to a copied stream, so a shift on an
    /// already-playable file has to re-encode. Copying it anyway would drop
    /// the shift silently and leave the control looking broken.
    #[test]
    fn shifting_a_playable_codec_stops_copying_it() {
        let plain = arguments("f.mkv", 0, "AAC", 0.0, 0);
        let at = plain.iter().position(|a| a == "-c:a").unwrap();
        assert_eq!(plain[at + 1], "copy", "nothing asked for, nothing re-encoded");

        let shifted = arguments("f.mkv", 0, "AAC", 0.0, 200);
        let at = shifted.iter().position(|a| a == "-c:a").unwrap();
        assert_eq!(shifted[at + 1], "aac", "a copied stream cannot be filtered");
    }

    /// The header has to be late enough to carry an edit list.
    ///
    /// With `empty_moov` there is nowhere to record that a copied stream's
    /// first frame presents after it decodes, so video ran 83ms behind audio
    /// for the length of the film. Measured, not guessed: first video PTS was
    /// 0.083 against audio at 0.000, and moving to `delay_moov` put both at
    /// zero.
    #[test]
    fn the_header_can_still_describe_the_offset() {
        let args = arguments("f.mkv", 0, "A_EAC3", 0.0, 0);
        let at = args.iter().position(|a| a == "-movflags").unwrap();
        assert!(
            args[at + 1].contains("delay_moov"),
            "empty_moov cannot write the edit list, and the audio drifts ahead"
        );
        assert!(
            !args[at + 1].contains("empty_moov"),
            "empty_moov is the thing that caused the drift"
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
