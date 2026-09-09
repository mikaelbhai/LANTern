//! Builds the Theatre library from published media shares.
//!
//! Titles come from filenames, because a media folder rarely carries metadata
//! and LANTern will not ask the internet for any. Durations are left at zero
//! and filled in by the player once it reads the file's own headers — probing
//! every file up front would mean decoding gigabytes to show a grid.

use std::path::{Path, PathBuf};

use crate::model::ShareMode;
use crate::state::AppState;

const VIDEO_EXTS: [&str; 7] = ["mp4", "webm", "mkv", "mov", "m4v", "avi", "ogv"];

/// Rescans every running media share and returns the library.
pub fn rebuild(state: &AppState) -> Vec<serde_json::Value> {
    let (shares, ip, host_port) = state.with(|s| {
        (
            s.shares
                .iter()
                .filter(|sh| sh.mode == ShareMode::Media && sh.running)
                .map(|sh| (sh.id.clone(), sh.slug.clone(), PathBuf::from(&sh.path)))
                .collect::<Vec<_>>(),
            s.net.ip.clone(),
            s.net.host_port,
        )
    });

    let mut items = Vec::new();
    for (share_id, slug, root) in shares {
        items.extend(items_for_share(&share_id, &slug, &root, &ip, host_port));
    }
    items
}

/// Every library entry for one media share.
///
/// The single place that decides what a library entry looks like. The HTTP
/// manifest a peer fetches used to walk the same folder with its own weaker
/// implementation, emitting raw filenames with no quality, no subtitles and no
/// episode numbers — and once the two shapes drifted apart, a peer's Theatre
/// received nothing it could read at all.
pub fn items_for_share(
    share_id: &str,
    slug: &str,
    root: &Path,
    ip: &str,
    host_port: u16,
) -> Vec<serde_json::Value> {
    let mut items = Vec::new();

    for rel in walk_videos(root) {
        let meta = std::fs::metadata(root.join(&rel)).ok();
        let size = meta.map(|m| m.len()).unwrap_or(0);
        let parsed = parse_title(&rel);

        let url_path = rel
            .split('/')
            .map(percent_encode)
            .collect::<Vec<_>>()
            .join("/");

        let mut item = serde_json::json!({
            "id": format!("{share_id}:{rel}"),
            "title": parsed.title,
            "shareId": share_id,
            "relPath": rel,
            "durationSec": 0,
            "sizeBytes": size,
            "kind": parsed.kind,
            "genres": Vec::<String>::new(),
            "addedAt": crate::model::now_ms(),
            "progressSec": 0,
            "streamUrl": format!("http://{ip}:{host_port}/{slug}/{url_path}"),
        });

        // Read from the raw relative path, not the cleaned title: cleaning is
        // what removes the very tags this is looking for.
        if let Some(quality) = parse_quality(&rel) {
            if let Some(obj) = item.as_object_mut() {
                obj.insert("quality".into(), serde_json::Value::String(quality));
            }
        }

        let video_path = root.join(&rel);
        let (art, sidecars) = crate::sidecar::beside(&video_path);
        let dir_prefix = match url_path.rfind('/') {
            Some(i) => &url_path[..=i],
            None => "",
        };

        // Duration and subtitle tracks both come out of the container, so the
        // header is read once and used for both.
        let mut embedded: Vec<serde_json::Value> = Vec::new();
        let mut audio_tracks: Vec<serde_json::Value> = Vec::new();
        let mut duration_sec = 0.0f64;

        // Both containers, not just Matroska. Half a typical library is MP4,
        // and a web release routinely carries a dozen subtitle tracks and
        // several audio ones — reading only MKV meant those files showed
        // nothing at all.
        let probed = if crate::ebml::is_matroska(&video_path) {
            crate::ebml::probe(&video_path).ok()
        } else if crate::mp4::is_mp4(&video_path) {
            crate::mp4::probe(&video_path).ok()
        } else {
            None
        };

        if let Some(probed) = probed {
            duration_sec = probed.duration_sec.unwrap_or(0.0);
            for track in &probed.tracks {
                match track.kind.as_str() {
                    "subtitle" => {
                        // Bitmap subtitles would need rendering rather than
                        // converting; offering them would only fail later.
                        if track.codec.contains("PGS")
                            || track.codec.contains("VobSub")
                            || track.codec.contains("CEA")
                        {
                            continue;
                        }
                        embedded.push(serde_json::json!({
                            "label": track.label(),
                            "lang": track.lang,
                            "url": format!(
                                "http://{ip}:{host_port}/{slug}/{url_path}?subtitle={}",
                                track.number
                            ),
                        }));
                    }
                    "audio" => audio_tracks.push(serde_json::json!({
                        "label": track.label(),
                        "lang": track.lang,
                        "codec": track.codec,
                        "default": track.default,
                    })),
                    _ => {}
                }
            }
        }

        if let Some(obj) = item.as_object_mut() {
            if duration_sec > 0.0 {
                obj.insert("durationSec".into(), (duration_sec.round() as u64).into());
            }
            // A generated still, unless the folder already has real artwork.
            // Either way the client never decodes video to draw a card.
            if art.is_none() {
                obj.insert(
                    "posterUrl".into(),
                    serde_json::Value::String(format!(
                        "http://{ip}:{host_port}/{slug}/{url_path}?thumb=1"
                    )),
                );
            }
            if let Some(art) = art {
                obj.insert(
                    "posterUrl".into(),
                    serde_json::Value::String(format!(
                        "http://{ip}:{host_port}/{slug}/{dir_prefix}{}",
                        percent_encode(&art)
                    )),
                );
            }

            // Embedded first, then sidecars: a file's own tracks are the ones
            // the author intended, and a downloaded .srt is the fallback.
            let mut all = embedded;
            all.extend(sidecars.iter().map(|sub| {
                serde_json::json!({
                    "label": sub.label,
                    "lang": sub.lang,
                    "url": format!(
                        "http://{ip}:{host_port}/{slug}/{dir_prefix}{}",
                        percent_encode(&sub.file)
                    ),
                })
            }));
            if !all.is_empty() {
                obj.insert("subtitles".into(), serde_json::Value::Array(all));
            }

            // Listed, not offered. A webview cannot switch between audio
            // tracks muxed into a file — Chromium has never implemented
            // HTMLMediaElement.audioTracks — so these are shown as
            // information about the file rather than as a control that would
            // do nothing.
            if audio_tracks.len() > 1 {
                obj.insert("audioTracks".into(), serde_json::Value::Array(audio_tracks));
            }
        }

        if let (Some(series), Some(season), Some(episode)) =
            (parsed.series, parsed.season, parsed.episode)
        {
            let obj = item.as_object_mut().unwrap();
            obj.insert("series".into(), series.into());
            obj.insert("season".into(), season.into());
            obj.insert("episode".into(), episode.into());
        }

        items.push(item);
    }

    items
}

/// Replaces the library and reports whether anything changed.
/// Where the viewer got to in one title, and how they were watching it.
///
/// Languages are stored rather than track numbers. A number means nothing once
/// a file is replaced by a different release of the same film, and it cannot
/// carry to the next episode; "jpn" survives both.
#[derive(Clone, Debug, Default)]
pub struct Resume {
    pub progress_sec: f64,
    pub audio_lang: Option<String>,
    pub subtitle_lang: Option<String>,
}

/// Reads every stored playback position.
///
/// One query rather than one per title: a library of a few thousand entries
/// would otherwise make a scan quadratic in database round trips.
pub fn stored_progress(state: &AppState) -> std::collections::HashMap<String, Resume> {
    state.with(|s| {
        let mut out = std::collections::HashMap::new();
        let Some(db) = s.db.as_ref() else { return out };
        let Ok(mut stmt) =
            db.prepare("SELECT id, progress_sec, audio_lang, subtitle_lang FROM progress")
        else {
            return out;
        };
        if let Ok(rows) = stmt.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                Resume {
                    progress_sec: r.get::<_, f64>(1)?,
                    audio_lang: r.get::<_, Option<String>>(2).unwrap_or(None),
                    subtitle_lang: r.get::<_, Option<String>>(3).unwrap_or(None),
                },
            ))
        }) {
            for (id, resume) in rows.flatten() {
                out.insert(id, resume);
            }
        }
        out
    })
}

/// Records the languages chosen for one title.
///
/// Written separately from the position: the position changes every few
/// seconds while a language changes when someone decides it does, and a
/// language must not be lost if the app closes before the next progress tick.
pub fn save_tracks(state: &AppState, id: &str, audio: Option<&str>, subtitle: Option<&str>) {
    state.with(|s| {
        let Some(db) = s.db.as_ref() else { return };
        // The row may not exist yet: a language can be chosen in the first
        // seconds, before any progress has been written.
        let _ = db.execute(
            "INSERT INTO progress (id, progress_sec, duration_sec, updated_at, audio_lang, subtitle_lang)
             VALUES (?1, 0, 0, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET audio_lang = ?3, subtitle_lang = ?4, updated_at = ?2",
            rusqlite::params![id, crate::model::now_ms() as i64, audio, subtitle],
        );

        // The same choice becomes the default for anything not yet watched.
        for (key, value) in [("audio_lang", audio), ("subtitle_lang", subtitle)] {
            let _ = db.execute(
                "INSERT INTO preferences (key, value) VALUES (?1, ?2)
                 ON CONFLICT(key) DO UPDATE SET value = ?2",
                rusqlite::params![key, value.unwrap_or("")],
            );
        }
    });
}

/// The languages to start a title in when it has never been opened.
pub fn preferred_languages(state: &AppState) -> (Option<String>, Option<String>) {
    state.with(|s| {
        let Some(db) = s.db.as_ref() else {
            return (None, None);
        };
        let read = |key: &str| -> Option<String> {
            db.query_row(
                "SELECT value FROM preferences WHERE key = ?1",
                rusqlite::params![key],
                |r| r.get::<_, String>(0),
            )
            .ok()
            .filter(|v| !v.is_empty())
        };
        (read("audio_lang"), read("subtitle_lang"))
    })
}

/// Records where the viewer got to, so it survives a restart.
pub fn save_progress(state: &AppState, id: &str, progress_sec: f64, duration_sec: f64) {
    state.with(|s| {
        let Some(db) = s.db.as_ref() else { return };
        let _ = db.execute(
            "INSERT INTO progress (id, progress_sec, duration_sec, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO UPDATE SET
                progress_sec = ?2, duration_sec = ?3, updated_at = ?4",
            rusqlite::params![id, progress_sec, duration_sec, crate::model::now_ms() as i64],
        );
    });
}

pub fn refresh(state: &AppState) -> Vec<serde_json::Value> {
    let mut built = rebuild(state);

    // Positions saved in an earlier session. Applied before the in-memory
    // carry-over below, so a live value still wins for a title being watched
    // right now.
    let saved = stored_progress(state);
    let (default_audio, default_subtitle) = preferred_languages(state);
    for item in built.iter_mut() {
        let Some(id) = item.get("id").and_then(|v| v.as_str()).map(str::to_string) else {
            continue;
        };
        let resume = saved.get(&id);
        let Some(obj) = item.as_object_mut() else { continue };

        if let Some(resume) = resume {
            obj.insert(
                "progressSec".into(),
                serde_json::Value::from(resume.progress_sec),
            );
        }

        // This title's own choice if it has one, otherwise the last choice
        // made anywhere — which is what makes the next episode open the way
        // the previous one was watched.
        let audio = resume
            .and_then(|r| r.audio_lang.clone())
            .or_else(|| default_audio.clone());
        let subtitle = resume
            .and_then(|r| r.subtitle_lang.clone())
            .or_else(|| default_subtitle.clone());

        if let Some(lang) = audio {
            obj.insert("audioLang".into(), serde_json::Value::from(lang));
        }
        if let Some(lang) = subtitle {
            obj.insert("subtitleLang".into(), serde_json::Value::from(lang));
        }
    }

    state.with(|s| {
        // Carry over playback positions so a rescan does not lose someone's place.
        for item in built.iter_mut() {
            let id = item.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            if let Some(previous) = s
                .media
                .iter()
                .find(|m| m.get("id").and_then(|v| v.as_str()) == Some(id))
            {
                if let Some(progress) = previous.get("progressSec").cloned() {
                    item.as_object_mut().unwrap().insert("progressSec".into(), progress);
                }
                for key in ["audioLang", "subtitleLang"] {
                    if let Some(lang) = previous.get(key).cloned() {
                        item.as_object_mut().unwrap().insert(key.into(), lang);
                    }
                }
            }
        }
        s.media = built.clone();
    });

    built
}

fn walk_videos(root: &Path) -> Vec<String> {
    let mut out = Vec::new();
    let mut queue: Vec<(PathBuf, usize)> = vec![(root.to_path_buf(), 0)];

    while let Some((dir, depth)) = queue.pop() {
        if depth > 8 || out.len() > 5000 {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                queue.push((path, depth + 1));
                continue;
            }
            let ext = path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !VIDEO_EXTS.contains(&ext.as_str()) {
                continue;
            }
            if let Ok(rel) = path.strip_prefix(root) {
                out.push(rel.to_string_lossy().replace('\\', "/"));
            }
        }
    }
    out.sort();
    out
}

struct Parsed {
    title: String,
    kind: &'static str,
    series: Option<String>,
    season: Option<u32>,
    episode: Option<u32>,
}

/// Reads what it can from a filename: `Show.Name.S01E02.mkv` and friends.
fn parse_title(rel: &str) -> Parsed {
    let stem = rel
        .rsplit('/')
        .next()
        .unwrap_or(rel)
        .rsplit_once('.')
        .map(|(s, _)| s)
        .unwrap_or(rel);

    if let Some((season, episode, at)) = find_episode_marker(stem) {
        let prefix = clean(&stem[..at]);
        let series = if prefix.is_empty() {
            // No show name in the filename — borrow the parent folder's.
            rel.rsplit('/')
                .nth(1)
                .map(clean)
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "Series".into())
        } else {
            prefix
        };
        return Parsed {
            title: series.clone(),
            kind: "episode",
            series: Some(series),
            season: Some(season),
            episode: Some(episode),
        };
    }

    let title = clean(stem);
    Parsed {
        // Short files read as clips; the distinction only drives which row
        // they land in, so filename length is a good enough signal on its own.
        kind: "film",
        title: if title.is_empty() { stem.to_string() } else { title },
        series: None,
        season: None,
        episode: None,
    }
}

/// Finds an `s01e02` / `S1E2` marker and where it starts.
fn find_episode_marker(stem: &str) -> Option<(u32, u32, usize)> {
    let lower = stem.to_ascii_lowercase();
    let bytes = lower.as_bytes();

    for (i, _) in lower.match_indices('s') {
        let mut j = i + 1;
        let season_start = j;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j == season_start || j >= bytes.len() || bytes[j] != b'e' {
            continue;
        }
        let season: u32 = lower[season_start..j].parse().ok()?;
        j += 1;
        let ep_start = j;
        while j < bytes.len() && bytes[j].is_ascii_digit() {
            j += 1;
        }
        if j == ep_start {
            continue;
        }
        let episode: u32 = lower[ep_start..j].parse().ok()?;
        return Some((season, episode, i));
    }
    None
}

/// Turns `Some.Show.Name-1080p_x264` into `Some Show Name`.
/// The resolution and HDR flavour a filename is advertising.
///
/// Release names carry this and nothing else does: there is no way to know a
/// file is 2160p without decoding it, and decoding every title to scan a
/// library is not something anyone wants to wait for.
pub fn parse_quality(raw: &str) -> Option<String> {
    let lower = raw.to_ascii_lowercase();

    // Ordered widest-first so "2160p" is not matched as "60p" by a looser
    // pattern later, and so 4K wins over an incidental 1080 elsewhere.
    const RESOLUTIONS: [(&str, &str); 8] = [
        ("2160p", "4K"),
        ("4320p", "8K"),
        ("uhd", "4K"),
        ("4k", "4K"),
        ("1440p", "1440p"),
        ("1080p", "1080p"),
        ("720p", "720p"),
        ("480p", "480p"),
    ];

    let resolution = RESOLUTIONS
        .iter()
        .find(|(needle, _)| lower.contains(needle))
        .map(|(_, label)| *label);

    // Dolby Vision outranks HDR10+ outranks HDR: a file is tagged with all
    // three often enough that picking the best one is what a viewer means.
    let dynamic = if lower.contains(" dv ") || lower.contains(".dv.") || lower.contains("dolby vision") {
        Some("DV")
    } else if lower.contains("hdr10+") {
        Some("HDR10+")
    } else if lower.contains("hdr") {
        Some("HDR")
    } else {
        None
    };

    match (resolution, dynamic) {
        (Some(r), Some(d)) => Some(format!("{r} {d}")),
        (Some(r), None) => Some(r.to_string()),
        (None, Some(d)) => Some(d.to_string()),
        (None, None) => None,
    }
}

/// Removes every bracketed group from a name.
///
/// Release groups, quality tags and tracker names all live in brackets, and
/// none of them belong in a title on screen. The quality is read out first and
/// shown as its own badge, so nothing useful is lost.
fn strip_brackets(raw: &str) -> String {
    let mut out = String::with_capacity(raw.len());
    let mut depth = 0usize;
    for c in raw.chars() {
        match c {
            '[' | '{' => depth += 1,
            ']' | '}' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out
}

fn clean(raw: &str) -> String {
    let raw = &strip_brackets(raw);

    /// Tags that are exactly one token.
    const NOISE: [&str; 20] = [
        "1080p", "720p", "2160p", "1440p", "480p", "4k", "8k", "uhd", "x264", "x265", "h264",
        "h265", "hevc", "av1", "bluray", "webrip", "web", "webdl", "hdtv", "10bit",
    ];

    /// Audio formats, which arrive with a channel count welded on: AAC5,
    /// DDP5, DTS, EAC3. Matching on the prefix catches every variation
    /// without listing them, and is why the channel count is handled below.
    const AUDIO: [&str; 10] = [
        "aac", "ac3", "eac3", "ddp", "dd", "dts", "truehd", "atmos", "flac", "opus",
    ];

    let is_audio = |t: &str| {
        let lower = t.to_ascii_lowercase();
        AUDIO.iter().any(|a| {
            lower.starts_with(a) && lower[a.len()..].chars().all(|c| c.is_ascii_digit() || c == '.')
        })
    };

    let tokens: Vec<&str> = raw
        .split(|c: char| c == '.' || c == '_' || c == '-' || c == ' ')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect();

    let mut out: Vec<&str> = Vec::with_capacity(tokens.len());
    let mut dropped_audio = false;

    for token in tokens {
        let lower = token.to_ascii_lowercase();

        if NOISE.contains(&lower.as_str()) {
            dropped_audio = false;
            continue;
        }
        if is_audio(token) {
            // "AAC5 1" is one tag split by the separator; remember so the
            // stray channel count that follows goes with it.
            dropped_audio = true;
            continue;
        }
        // The ".1" of a 5.1 mix, now orphaned.
        if dropped_audio && token.len() == 1 && token.chars().all(|c| c.is_ascii_digit()) {
            dropped_audio = false;
            continue;
        }
        dropped_audio = false;

        // A bare four-digit year: the release year, not part of the name.
        // A year the author wrote in parentheses is kept, since that is how
        // people actually distinguish two films of the same name.
        if token.len() == 4 && token.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }

        out.push(token);
    }

    out.join(" ").trim().to_string()
}


/// Percent-encodes a single path segment for use in a URL.
fn percent_encode(segment: &str) -> String {
    let mut out = String::with_capacity(segment.len());
    for byte in segment.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::{clean, parse_quality};

    /// Real names from a real library — the ones that were showing verbatim.
    #[test]
    fn strips_bracketed_noise_from_titles() {
        assert_eq!(
            clean("Top Gun Maverick (2022) [1080p]"),
            "Top Gun Maverick (2022)",
            "a quality tag in brackets is not part of the title"
        );
        assert_eq!(
            clean("Jujutsu Kaisen 0 The Movie JAPANESE AAC5 1 [YTS MX]"),
            "Jujutsu Kaisen 0 The Movie JAPANESE",
            "the release group goes, the film name stays"
        );
        assert_eq!(clean("La La Land 10bit AAC5 1 [YTS MX]"), "La La Land");
    }

    #[test]
    fn reads_resolution_and_dynamic_range() {
        assert_eq!(parse_quality("Spider Man [2160p]").as_deref(), Some("4K"));
        assert_eq!(parse_quality("Logan (2017) [1080p]").as_deref(), Some("1080p"));
        assert_eq!(parse_quality("Show.S01E01.720p.mkv").as_deref(), Some("720p"));
        assert_eq!(
            parse_quality("Chainsaw Man The Movie iT WEB DL DV HDR10+ MULTi").as_deref(),
            Some("DV"),
            "Dolby Vision wins when several tags are present"
        );
        assert_eq!(
            parse_quality("Film 2160p HDR10+").as_deref(),
            Some("4K HDR10+"),
        );
    }

    #[test]
    fn a_plain_name_advertises_no_quality() {
        assert_eq!(parse_quality("Home Video.mp4"), None);
    }

    use super::*;
    use crate::model::{now_ms, Share};

    /// The whole point: a published media folder must appear in the library.
    #[test]
    fn a_published_media_folder_becomes_library_entries() {
        let root = std::env::temp_dir().join(format!("lantern-media-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("Subnet")).unwrap();
        std::fs::write(root.join("The.Quiet.Harbour.2023.mp4"), b"x").unwrap();
        std::fs::write(root.join("Subnet/S01E02.mkv"), b"x").unwrap();
        std::fs::write(root.join("notes.txt"), b"not a video").unwrap();

        let state = AppState::new();
        state.with(|s| {
            s.net.ip = "192.168.1.5".into();
            s.net.host_port = 7981;
            s.shares.push(Share {
                id: "sh".into(),
                name: "Videos".into(),
                path: root.to_string_lossy().to_string(),
                slug: "videos".into(),
                mode: ShareMode::Media,
                running: true,
                require_phrase: false,
                phrase: None,
                allow_upload: false,
                file_count: 3,
                total_bytes: 3,
                created_at: now_ms(),
                requests: 0,
                bytes_served: 0,
                active_viewers: 0,
                last_request_at: None,
            });
        });

        let items = refresh(&state);
        assert_eq!(items.len(), 2, "expected 2 videos, got {}", items.len());

        let titles: Vec<String> = items
            .iter()
            .map(|i| i["title"].as_str().unwrap_or("").to_string())
            .collect();
        assert!(titles.contains(&"The Quiet Harbour".to_string()), "{titles:?}");
        assert!(titles.contains(&"Subnet".to_string()), "{titles:?}");

        // Stream URLs must point at this device's host server.
        let url = items[0]["streamUrl"].as_str().unwrap();
        assert!(url.starts_with("http://192.168.1.5:7981/videos/"), "{url}");

        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn a_stopped_share_contributes_nothing() {
        let root = std::env::temp_dir().join(format!("lantern-media-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join("clip.mp4"), b"x").unwrap();

        let state = AppState::new();
        state.with(|s| {
            s.shares.push(Share {
                id: "sh".into(),
                name: "Videos".into(),
                path: root.to_string_lossy().to_string(),
                slug: "videos".into(),
                mode: ShareMode::Media,
                running: false,
                require_phrase: false,
                phrase: None,
                allow_upload: false,
                file_count: 1,
                total_bytes: 1,
                created_at: now_ms(),
                requests: 0,
                bytes_served: 0,
                active_viewers: 0,
                last_request_at: None,
            });
        });

        assert!(refresh(&state).is_empty());
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn reads_series_markers_from_filenames() {
        let p = parse_title("Subnet.S01E03.1080p.mkv");
        assert_eq!(p.kind, "episode");
        assert_eq!(p.series.as_deref(), Some("Subnet"));
        assert_eq!(p.season, Some(1));
        assert_eq!(p.episode, Some(3));
    }

    #[test]
    fn falls_back_to_the_folder_name_for_bare_episodes() {
        let p = parse_title("Copper Signal/s02e10.mp4");
        assert_eq!(p.series.as_deref(), Some("Copper Signal"));
        assert_eq!(p.season, Some(2));
        assert_eq!(p.episode, Some(10));
    }

    #[test]
    fn strips_release_noise_from_film_titles() {
        let p = parse_title("The.Quiet.Harbour.2023.1080p.x265.mp4");
        assert_eq!(p.kind, "film");
        assert_eq!(p.title, "The Quiet Harbour");
    }

    #[test]
    fn encodes_paths_that_need_it() {
        assert_eq!(percent_encode("a file.mp4"), "a%20file.mp4");
        assert_eq!(percent_encode("clip.mp4"), "clip.mp4");
    }
}
