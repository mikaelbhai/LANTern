//! Artwork and subtitles that sit beside a video file.
//!
//! LANTern does not demux. Reading subtitle or audio tracks out of an MKV
//! means shipping a media parser, and the browser cannot switch between
//! embedded tracks anyway — Chromium has never implemented
//! `HTMLMediaElement.audioTracks`. What it *can* do is play a `<track>`
//! element, so what this module finds is the files people already keep next to
//! their videos: `Film.srt`, `Film.en.srt`, `poster.jpg`.
//!
//! That covers the common case honestly, rather than showing a track menu that
//! cannot actually switch anything.

use std::path::Path;

/// Image names that mean "this is the artwork for this folder".
const FOLDER_ART: [&str; 6] = [
    "poster.jpg",
    "poster.png",
    "folder.jpg",
    "folder.png",
    "cover.jpg",
    "cover.png",
];

const IMAGE_EXTS: [&str; 4] = ["jpg", "jpeg", "png", "webp"];
const SUBTITLE_EXTS: [&str; 2] = ["srt", "vtt"];

/// One subtitle file found next to a video.
#[derive(Debug, Clone, PartialEq)]
pub struct Subtitle {
    /// File name, relative to the same directory as the video.
    pub file: String,
    /// What to show in the menu — the language tag where there is one.
    pub label: String,
    /// BCP-47-ish tag pulled from the name, empty when there is none.
    pub lang: String,
}

fn stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or_default()
        .to_string()
}

fn ext_of(name: &str) -> String {
    Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

/// Turns "Film.en.srt" beside "Film.mkv" into the label "en".
///
/// Returns `None` when the file does not belong to this video at all.
fn subtitle_for(video_stem: &str, name: &str) -> Option<Subtitle> {
    let ext = ext_of(name);
    if !SUBTITLE_EXTS.contains(&ext.as_str()) {
        return None;
    }
    let base = &name[..name.len() - ext.len() - 1];

    // Exactly the video's name: an untagged subtitle.
    if base.eq_ignore_ascii_case(video_stem) {
        return Some(Subtitle {
            file: name.to_string(),
            label: "Subtitles".into(),
            lang: String::new(),
        });
    }

    // The video's name plus a suffix: "Film.en", "Film.en.forced".
    let prefix = format!("{video_stem}.");
    if base.len() > prefix.len() && base[..prefix.len()].eq_ignore_ascii_case(&prefix) {
        let tag = base[prefix.len()..].trim().to_string();
        if tag.is_empty() {
            return None;
        }
        // The first dotted segment is the language; the rest is a qualifier
        // like "forced" or "sdh" that belongs in the label but not the tag.
        let lang = tag.split('.').next().unwrap_or_default().to_string();
        return Some(Subtitle {
            file: name.to_string(),
            label: tag.replace('.', " · "),
            lang,
        });
    }

    None
}

/// Artwork and subtitles belonging to one video.
///
/// Both are returned as bare file names in the video's own directory, so the
/// caller can build whatever URL it serves them under.
pub fn beside(video: &Path) -> (Option<String>, Vec<Subtitle>) {
    let Some(dir) = video.parent() else {
        return (None, Vec::new());
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return (None, Vec::new());
    };

    let video_stem = stem(video);
    let mut named_art: Option<String> = None;
    let mut folder_art: Option<String> = None;
    let mut subtitles = Vec::new();

    for entry in entries.flatten() {
        let Some(name) = entry.file_name().to_str().map(|s| s.to_string()) else {
            continue;
        };
        if !entry.path().is_file() {
            continue;
        }

        if let Some(found) = subtitle_for(&video_stem, &name) {
            subtitles.push(found);
            continue;
        }

        let ext = ext_of(&name);
        if !IMAGE_EXTS.contains(&ext.as_str()) {
            continue;
        }
        // Art named after the file beats art named after the folder: a folder
        // of episodes has one folder.jpg but a poster each.
        let base = &name[..name.len() - ext.len() - 1];
        if base.eq_ignore_ascii_case(&video_stem) {
            named_art = Some(name);
        } else if folder_art.is_none()
            && FOLDER_ART.iter().any(|f| f.eq_ignore_ascii_case(&name))
        {
            folder_art = Some(name);
        }
    }

    subtitles.sort_by(|a, b| a.label.to_lowercase().cmp(&b.label.to_lowercase()));
    (named_art.or(folder_art), subtitles)
}

/// Rewrites SubRip as WebVTT, which is what a `<track>` can actually load.
///
/// The formats are close enough that this is a header plus a comma: SubRip
/// separates milliseconds with `,` and WebVTT with `.`. Doing it in the server
/// means the browser never has to know the difference, and nobody has to
/// convert their subtitle files by hand.
pub fn srt_to_vtt(srt: &str) -> String {
    let mut out = String::from("WEBVTT\n\n");
    for line in srt.lines() {
        if line.contains("-->") {
            out.push_str(&line.replace(',', "."));
        } else {
            out.push_str(line);
        }
        out.push('\n');
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_an_untagged_subtitle() {
        let got = subtitle_for("Film", "Film.srt").expect("should match");
        assert_eq!(got.label, "Subtitles");
        assert_eq!(got.lang, "");
    }

    #[test]
    fn reads_the_language_from_the_name() {
        let got = subtitle_for("Film", "Film.en.srt").expect("should match");
        assert_eq!(got.lang, "en");
        assert_eq!(got.label, "en");

        let forced = subtitle_for("Film", "Film.en.forced.vtt").expect("should match");
        assert_eq!(forced.lang, "en", "the qualifier is not part of the tag");
        assert_eq!(forced.label, "en · forced");
    }

    #[test]
    fn ignores_files_belonging_to_another_video() {
        assert_eq!(subtitle_for("Film", "Other.srt"), None);
        assert_eq!(subtitle_for("Film", "Film.mkv"), None);
        // A longer name that merely starts with the same letters.
        assert_eq!(subtitle_for("Film", "Filmography.srt"), None);
    }

    #[test]
    fn converts_subrip_timestamps() {
        let srt = "1\n00:00:01,000 --> 00:00:04,500\nHello\n";
        let vtt = srt_to_vtt(srt);
        assert!(vtt.starts_with("WEBVTT\n\n"), "needs the WebVTT header");
        assert!(vtt.contains("00:00:01.000 --> 00:00:04.500"), "commas become dots");
        assert!(vtt.contains("Hello"));
    }
}
