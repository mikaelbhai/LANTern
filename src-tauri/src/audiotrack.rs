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
        // The video can only start on a keyframe, up to a GOP before the
        // request. An accurate seek cuts a re-encoded audio track exactly at
        // the request, so the picture ran silent from the keyframe until the
        // audio's own start - the loss of sound after every skip. Starting
        // both where the file lets them keeps them together; `stream_origin`
        // says where that is.
        args.push("-noaccurate_seek".into());
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
    // Negative timestamps are what a fast seek leaves behind, and they are
    // worse than the thing they come from.
    //
    // `-ss` before `-i` jumps by index, so video resumes at the keyframe
    // *before* the requested point - 0.656s before it, in the file this was
    // found on - while the audio is re-encoded from the point itself. The
    // relationship is correct: that video really does belong two thirds of a
    // second earlier. But it is expressed as a negative timestamp, and a
    // player that clamps those to zero drops the video's head start and slides
    // the two apart by exactly that much. Resuming a film was ten times worse
    // than the fault this was meant to fix.
    //
    // `make_zero` shifts both streams by the same amount instead, so the
    // offset survives as the gap it is rather than being quietly discarded.
    args.push("-avoid_negative_ts".into());
    args.push("make_zero".into());

    args.push("-movflags".into());
    args.push("frag_keyframe+delay_moov+default_base_moof".into());
    args.push("-f".into());
    args.push("mp4".into());
    args.push("pipe:1".into());

    args
}

/// The container a converted copy is written in: the one the file already had.
///
/// Matroska keeps every subtitle track and the order of the tracks as they
/// were; MP4 is only offered for files that were MP4 to begin with, because
/// writing an MKV's subtitles into one fails outright on the picture-based ones.
pub fn sync_container(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("mp4" | "m4v" | "mov") => "mp4",
        _ => "matroska",
    }
}

/// Arguments for a copy of a film whose sound the receiving device cannot play.
///
/// For syncing, not streaming: the result is a whole, seekable file. The video
/// and the subtitles are copied byte for byte, so this costs about what reading
/// the file costs; every audio track is re-encoded to stereo AAC, which every
/// browser and every phone can play. Written to a file and not to a pipe
/// because a pipe has no length and cannot be seeked, and a copy that cannot
/// be seeked is not one anybody would keep.
pub fn sync_arguments(path: &str, out: &str) -> Vec<String> {
    let container = sync_container(path);
    let mut args: Vec<String> = ["-y", "-nostdin", "-i", path]
        .iter()
        .map(|s| s.to_string())
        .collect();
    for part in [
        "-map", "0:v:0", "-map", "0:a", "-map", "0:s?",
        "-c:v", "copy", "-c:s", "copy",
        "-c:a", "aac", "-b:a", "192k", "-ac", "2",
    ] {
        args.push(part.into());
    }
    if container == "mp4" {
        // The index first, so the copy can start playing before it has all
        // arrived and seeks without reading to the end.
        args.push("-movflags".into());
        args.push("+faststart".into());
    }
    args.push("-f".into());
    args.push(container.into());
    args.push(out.into());
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

/// Arguments that print the first video packet ffmpeg lands on when it seeks
/// to `at_sec`, and nothing else.
///
/// Same `-ss` before `-i` as `arguments`, so it makes the same jump - which is
/// the point. See `stream_origin`.
pub fn keyframe_arguments(path: &str, at_sec: f64) -> Vec<String> {
    vec![
        "-v".into(),
        "error".into(),
        "-ss".into(),
        format!("{at_sec:.3}"),
        "-i".into(),
        path.into(),
        "-map".into(),
        "0:v:0".into(),
        "-c".into(),
        "copy".into(),
        "-frames:v".into(),
        "1".into(),
        "-f".into(),
        "framecrc".into(),
        "-".into(),
    ]
}

/// The point in the file at which a stream asked to begin at `at_sec` reads
/// zero on its own clock.
///
/// The video is copied, and a copied stream can only start on a keyframe, so
/// `-ss` lands on the one *before* the request - five seconds early in a film
/// with a ten second GOP. The player took the request for the start, so its
/// clock and its subtitles ran that far ahead of the picture after every seek.
///
/// This reads the true start from the first packet's decode timestamp, which
/// ffmpeg prints relative to the seek point and therefore negative. The decode
/// time rather than the presentation time: the stream is shifted so that the
/// first *decode* is zero, and the picture appears a frame or two after it.
pub fn stream_origin(framecrc: &str, at_sec: f64) -> Option<f64> {
    let tick = framecrc
        .lines()
        .find_map(|l| l.strip_prefix("#tb 0:"))?
        .trim()
        .split_once('/')
        .and_then(|(n, d)| Some(n.trim().parse::<f64>().ok()? / d.trim().parse::<f64>().ok()?))?;

    // "stream, dts, pts, duration, size, crc"
    let dts: f64 = framecrc
        .lines()
        .find(|l| !l.starts_with('#') && !l.trim().is_empty())?
        .split(',')
        .nth(1)?
        .trim()
        .parse()
        .ok()?;

    let origin = at_sec + dts * tick;
    if !origin.is_finite() {
        return None;
    }
    Some((origin.max(0.0) * 1000.0).round() / 1000.0)
}

#[cfg(test)]
mod tests {

    /// The numbers from a real file: `-ss 25` into a stream with a keyframe
    /// every ten seconds, which ffmpeg answers with the keyframe at 20 -
    /// decoded at 19.917, a frame of B-frame delay before it is shown.
    const FRAMECRC: &str = "#extradata 0:       46, 0x6e1910c8\n#software: Lavf62.12.101\n\
        #tb 0: 1/1000\n#media_type 0: video\n#codec_id 0: h264\n\
        0,      -5083,      -5000,       41,     2869, 0x7181b694\n";

    #[test]
    fn the_start_of_a_seek_is_read_from_the_first_packet() {
        assert_eq!(stream_origin(FRAMECRC, 25.0), Some(19.917));
    }

    #[test]
    fn a_fractional_timebase_is_converted_to_seconds() {
        // 123123 / 24000 = 5.130125 s before the seek point.
        let text = "#tb 0: 1/24000\n0, -123123, -120120, 1001, 1000, 0x0\n";
        assert_eq!(stream_origin(text, 25.0), Some(19.87));
    }

    #[test]
    fn a_start_before_the_file_begins_is_the_beginning() {
        let text = "#tb 0: 1/1000\n0, -9000, -9000, 41, 1000, 0x0\n";
        assert_eq!(stream_origin(text, 5.0), Some(0.0));
    }

    #[test]
    fn output_that_is_not_a_packet_gives_no_answer() {
        assert_eq!(stream_origin("", 25.0), None);
        assert_eq!(stream_origin("#tb 0: 1/1000\n", 25.0), None);
        assert_eq!(stream_origin("0, 1, 2, 3, 4, 5\n", 25.0), None);
    }

    #[test]
    fn the_keyframe_probe_makes_the_same_jump_as_the_stream() {
        let args = keyframe_arguments("f.mkv", 25.0);
        let ss = args.iter().position(|a| a == "-ss").unwrap();
        let input = args.iter().position(|a| a == "-i").unwrap();
        assert!(ss < input, "-ss must precede -i or this is a different seek");
    }

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
            args.contains(&"-noaccurate_seek".to_string()),
            "audio must start with the video, not at the request"
        );

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

    /// A fast seek must not hand the player negative timestamps.
    ///
    /// Measured on a real resume: video came back at -0.656 against audio at
    /// -0.021, and clamping those to zero is a 635ms slide. The flag shifts
    /// both together so the gap stays the gap.
    #[test]
    fn a_resume_does_not_leave_negative_timestamps() {
        let args = arguments("f.mkv", 0, "A_EAC3", 345.0, 0);
        let at = args
            .iter()
            .position(|a| a == "-avoid_negative_ts")
            .expect("a fast seek can produce negative timestamps");
        assert_eq!(args[at + 1], "make_zero");
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

#[cfg(test)]
mod sync_tests {
    use super::*;

    #[test]
    fn a_synced_copy_keeps_the_picture_and_subtitles_untouched() {
        let args = sync_arguments("/films/Loki.mkv", "/cache/x.part");
        let at = |flag: &str| args.iter().position(|a| a == flag).map(|i| args[i + 1].clone());
        // Getting either of these wrong would re-encode a 20 GB film.
        assert_eq!(at("-c:v").as_deref(), Some("copy"));
        assert_eq!(at("-c:s").as_deref(), Some("copy"));
        assert_eq!(at("-c:a").as_deref(), Some("aac"));
        assert!(args.windows(2).any(|w| w == ["-map", "0:a"]), "every audio track is kept");
        assert_eq!(args.last().map(String::as_str), Some("/cache/x.part"));
    }

    #[test]
    fn the_container_follows_the_file() {
        assert_eq!(sync_container("a/b/Film.mkv"), "matroska");
        assert_eq!(sync_container("Film.MP4"), "mp4");
        assert_eq!(sync_container("Film.m4v"), "mp4");
        assert_eq!(sync_container("Film.webm"), "matroska");
        let mp4 = sync_arguments("Film.mp4", "out.part");
        assert!(mp4.contains(&"+faststart".to_string()), "an MP4 copy has its index first");
        let mkv = sync_arguments("Film.mkv", "out.part");
        assert!(!mkv.contains(&"+faststart".to_string()));
    }
}

#[cfg(test)]
mod sample_film_tests {
    use super::*;
    use std::path::PathBuf;

    fn scan(dir: &Path) -> Vec<serde_json::Value> {
        crate::media::items_for_share("t", "t", dir, "127.0.0.1:1")
    }

    fn track_of(url: &str) -> Option<u64> {
        url.split("?subtitle=").nth(1)?.split('&').next()?.parse().ok()
    }

    fn cues(path: &Path, track: u64) -> usize {
        let vtt = if crate::ebml::is_matroska(path) {
            crate::ebml::extract_subtitles(path, track)
        } else {
            crate::mp4::extract_subtitles(path, track)
        }
        .unwrap_or_default();
        vtt.lines().filter(|l| l.contains("-->")).count()
    }

    /// Converts real films' excerpts the way syncing does and checks what a
    /// viewer would check: the subtitles are still listed, still say the same
    /// thing, and the sound is now something a browser can play.
    ///
    /// Ignored: it needs ffmpeg and sample files (`LANTERN_SAMPLE_DIR` holds a
    /// \`src\` folder of them, and an empty \`out\` for the results).
    #[test]
    #[ignore = "needs ffmpeg and sample films"]
    fn converted_copies_keep_their_subtitles_and_gain_playable_sound() {
        let base = PathBuf::from(std::env::var("LANTERN_SAMPLE_DIR").expect("LANTERN_SAMPLE_DIR"));
        let (src, out) = (base.join("src"), base.join("out"));
        let ffmpeg = ffmpeg_path().expect("ffmpeg");

        for entry in std::fs::read_dir(&src).unwrap().flatten() {
            let name = entry.file_name();
            let target = out.join(&name);
            let args = sync_arguments(&entry.path().to_string_lossy(), &target.to_string_lossy());
            let status = std::process::Command::new(ffmpeg).args(&args).output().unwrap();
            assert!(status.status.success(), "{name:?}: {}", String::from_utf8_lossy(&status.stderr));
        }

        let before = scan(&src);
        let after = scan(&out);
        assert_eq!(before.len(), after.len());
        for b in &before {
            let rel = b["relPath"].as_str().unwrap();
            let a = after.iter().find(|a| a["relPath"] == b["relPath"]).expect(rel);
            let subs = |i: &serde_json::Value| -> Vec<(String, String)> {
                i["subtitles"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default()
                    .iter()
                    .map(|s| (s["label"].as_str().unwrap_or("").to_string(), s["lang"].as_str().unwrap_or("").to_string()))
                    .collect()
            };
            println!("{rel}: {} subtitle tracks before, {} after", subs(b).len(), subs(a).len());
            assert!(!subs(b).is_empty(), "{rel}: the sample has no subtitles to lose");
            assert_eq!(subs(b), subs(a), "{rel}: the subtitle list changed");

            // Playable sound: every listed track must now be web-safe.
            for t in a["audioTracks"].as_array().cloned().unwrap_or_default() {
                assert_ne!(t["webSafe"], false, "{rel}: {t} is still not playable");
            }
            println!("{rel}: audio tracks after: {}", a["audioTracks"]);

            // The words themselves, for the first few tracks.
            let urls = |i: &serde_json::Value| -> Vec<u64> {
                i["subtitles"].as_array().cloned().unwrap_or_default().iter().filter_map(|s| s["url"].as_str().and_then(track_of)).collect()
            };
            let (bt, at) = (urls(b), urls(a));
            // Tracks with nothing in a short excerpt (a "forced" track, mostly)
            // prove nothing either way; the rest must come out word for word.
            let mut compared = 0;
            for (x, y) in bt.iter().zip(at.iter()) {
                let n_before = cues(&src.join(rel), *x);
                if n_before == 0 {
                    continue;
                }
                let n_after = cues(&out.join(rel), *y);
                println!("{rel}: track {x}->{y}: {n_before} cues before, {n_after} after");
                assert_eq!(n_before, n_after, "{rel}: cue count changed for track {x}");
                compared += 1;
                if compared == 4 {
                    break;
                }
            }
            assert!(compared > 0, "{rel}: no track had any cues to compare");
        }
    }
}
