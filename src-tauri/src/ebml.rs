//! A reader for the parts of Matroska that LANTern needs.
//!
//! This is not a general media library. It answers two questions that no
//! browser can answer about an MKV — *what tracks are in here?* and *what do
//! the subtitles say?* — and does nothing else. The player still decodes the
//! video; this only reads the container's table of contents and, on request,
//! the subtitle blocks.
//!
//! Written by hand rather than pulled in: the whole of EBML that matters here
//! is two variable-length integers and a tree walk. A media framework would be
//! tens of megabytes to read a header LANTern is already streaming past.
//!
//! Byte offsets are read lazily and bounded. A malformed or truncated file
//! stops the walk instead of looping — these files come off the network from
//! other people's machines, so nothing here trusts a declared length.

use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

use serde::{Deserialize, Serialize};

/* ------------------------------------------------------------- element ids */

const EBML_HEADER: u64 = 0x1A45_DFA3;
const SEGMENT: u64 = 0x1853_8067;
const INFO: u64 = 0x1549_A966;
const TIMECODE_SCALE: u64 = 0x2AD7_B1;
const DURATION: u64 = 0x4489;
const TRACKS: u64 = 0x1654_AE6B;
const TRACK_ENTRY: u64 = 0xAE;
const TRACK_NUMBER: u64 = 0xD7;
const TRACK_TYPE: u64 = 0x83;
const CODEC_ID: u64 = 0x86;
const LANGUAGE: u64 = 0x22B5_9C;
const LANGUAGE_BCP47: u64 = 0x22B5_9D;
const TRACK_NAME: u64 = 0x536E;
const FLAG_DEFAULT: u64 = 0x88;
const AUDIO: u64 = 0xE1;
const CHANNELS: u64 = 0x9F;
const CLUSTER: u64 = 0x1F43_B675;
const CLUSTER_TIMECODE: u64 = 0xE7;
const SIMPLE_BLOCK: u64 = 0xA3;
const BLOCK_GROUP: u64 = 0xA0;
const BLOCK: u64 = 0xA1;
const BLOCK_DURATION: u64 = 0x9B;

/// Matroska's own track-type numbering.
const TYPE_VIDEO: u64 = 1;
const TYPE_AUDIO: u64 = 2;
const TYPE_SUBTITLE: u64 = 17;

/// Refuse to walk a header for ever on a file that is not really Matroska.
const MAX_HEADER_BYTES: u64 = 64 * 1024 * 1024;

/* ----------------------------------------------------------------- results */

/// One track inside a container.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    /// The container's own track number, used to match blocks to tracks.
    pub number: u64,
    /// "video", "audio" or "subtitle".
    pub kind: String,
    /// Codec identifier as the file states it, e.g. "A_AC3", "S_TEXT/UTF8".
    pub codec: String,
    /// Language tag, "und" when the file does not say.
    pub lang: String,
    /// The name the author gave the track, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// Whether the file marks this as the default for its kind.
    pub default: bool,
    /// Channel count, for audio.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub channels: Option<u64>,
}

impl Track {
    /// A label worth showing in a menu.
    ///
    /// Falls back through name, language and codec, because a file that states
    /// none of them still has to be distinguishable from the track beside it.
    pub fn label(&self) -> String {
        if let Some(name) = self.name.as_ref().filter(|n| !n.trim().is_empty()) {
            return name.clone();
        }
        let lang = if self.lang == "und" { String::new() } else { self.lang.clone() };
        let codec = pretty_codec(&self.codec);
        let channels = match self.channels {
            Some(2) => " stereo".to_string(),
            Some(6) => " 5.1".to_string(),
            Some(8) => " 7.1".to_string(),
            Some(1) => " mono".to_string(),
            _ => String::new(),
        };
        match (lang.is_empty(), codec.is_empty()) {
            (false, false) => format!("{lang} · {codec}{channels}"),
            (false, true) => format!("{lang}{channels}"),
            (true, false) => format!("{codec}{channels}"),
            (true, true) => format!("Track {}", self.number),
        }
    }
}

/// Turns a Matroska codec id into something a person would recognise.
fn pretty_codec(codec: &str) -> String {
    match codec {
        "A_AC3" => "AC-3",
        "A_EAC3" => "E-AC-3",
        "A_DTS" => "DTS",
        "A_TRUEHD" => "TrueHD",
        "A_AAC" => "AAC",
        "A_OPUS" => "Opus",
        "A_VORBIS" => "Vorbis",
        "A_FLAC" => "FLAC",
        "A_MPEG/L3" => "MP3",
        "A_PCM/INT/LIT" => "PCM",
        "S_TEXT/UTF8" => "SubRip",
        "S_TEXT/ASS" | "S_TEXT/SSA" => "ASS",
        "S_TEXT/WEBVTT" => "WebVTT",
        "S_HDMV/PGS" => "PGS",
        "S_VOBSUB" => "VobSub",
        "V_MPEG4/ISO/AVC" => "H.264",
        "V_MPEGH/ISO/HEVC" => "HEVC",
        "V_AV1" => "AV1",
        "V_VP9" => "VP9",
        other => return other.trim_start_matches(['A', 'V', 'S']).trim_start_matches('_').to_string(),
    }
    .to_string()
}

/// What a container says about itself.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Probe {
    pub tracks: Vec<Track>,
    /// Nanoseconds per timecode unit; 1 ms is the usual value.
    pub timecode_scale: u64,
    /// Duration in seconds, when the file states one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_sec: Option<f64>,
}

/* -------------------------------------------------------------- primitives */

/// Reads an EBML element id, returning it with the number of bytes consumed.
///
/// The first byte's leading zeros give the total width, and unlike a data
/// size the marker bit is *kept*: ids are conventionally written including it.
fn read_id<R: Read>(r: &mut R) -> std::io::Result<(u64, u64)> {
    let mut first = [0u8; 1];
    r.read_exact(&mut first)?;
    let width = match first[0].leading_zeros() {
        0 => 1,
        1 => 2,
        2 => 3,
        3 => 4,
        _ => {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                "not an EBML id",
            ))
        }
    };
    let mut value = first[0] as u64;
    for _ in 1..width {
        let mut b = [0u8; 1];
        r.read_exact(&mut b)?;
        value = (value << 8) | b[0] as u64;
    }
    Ok((value, width))
}

/// Reads an EBML data size. `None` means "unknown length", which is legal for
/// a live-recorded segment and means "until the next element at this level".
fn read_size<R: Read>(r: &mut R) -> std::io::Result<(Option<u64>, u64)> {
    let mut first = [0u8; 1];
    r.read_exact(&mut first)?;
    let width = (first[0].leading_zeros() + 1) as u64;
    if width > 8 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "oversized EBML length",
        ));
    }
    // Clear the marker bit that encoded the width.
    let mut value = (first[0] as u64) & (0xFF >> width);
    let mut all_ones = value == (0xFF >> width);
    for _ in 1..width {
        let mut b = [0u8; 1];
        r.read_exact(&mut b)?;
        all_ones &= b[0] == 0xFF;
        value = (value << 8) | b[0] as u64;
    }
    Ok((if all_ones { None } else { Some(value) }, width))
}

fn read_uint<R: Read>(r: &mut R, len: u64) -> std::io::Result<u64> {
    let mut value = 0u64;
    for _ in 0..len.min(8) {
        let mut b = [0u8; 1];
        r.read_exact(&mut b)?;
        value = (value << 8) | b[0] as u64;
    }
    Ok(value)
}

fn read_float<R: Read>(r: &mut R, len: u64) -> std::io::Result<f64> {
    match len {
        4 => {
            let mut b = [0u8; 4];
            r.read_exact(&mut b)?;
            Ok(f32::from_be_bytes(b) as f64)
        }
        8 => {
            let mut b = [0u8; 8];
            r.read_exact(&mut b)?;
            Ok(f64::from_be_bytes(b))
        }
        _ => {
            skip(r, len)?;
            Ok(0.0)
        }
    }
}

fn read_string<R: Read>(r: &mut R, len: u64) -> std::io::Result<String> {
    let mut buf = vec![0u8; len.min(4096) as usize];
    r.read_exact(&mut buf)?;
    if len > 4096 {
        skip(r, len - 4096)?;
    }
    // Trailing NULs are legal padding in an EBML string.
    while buf.last() == Some(&0) {
        buf.pop();
    }
    Ok(String::from_utf8_lossy(&buf).to_string())
}

fn skip<R: Read>(r: &mut R, len: u64) -> std::io::Result<()> {
    let mut remaining = len;
    let mut sink = [0u8; 8192];
    while remaining > 0 {
        let want = remaining.min(sink.len() as u64) as usize;
        r.read_exact(&mut sink[..want])?;
        remaining -= want as u64;
    }
    Ok(())
}

/* ------------------------------------------------------------------ probing */

/// Reads the track list out of a Matroska file.
///
/// Only the header is touched: Tracks appears before the first Cluster in any
/// file a muxer produced, so this stops as soon as it reaches media data
/// rather than reading gigabytes to learn nothing more.
pub fn probe(path: &Path) -> std::io::Result<Probe> {
    let file = File::open(path)?;
    let mut r = BufReader::with_capacity(64 * 1024, file);

    let (id, _) = read_id(&mut r)?;
    if id != EBML_HEADER {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "not a Matroska file",
        ));
    }
    let (size, _) = read_size(&mut r)?;
    skip(&mut r, size.unwrap_or(0))?;

    let (id, _) = read_id(&mut r)?;
    if id != SEGMENT {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "no segment",
        ));
    }
    let _ = read_size(&mut r)?;

    let mut probe = Probe {
        timecode_scale: 1_000_000,
        ..Default::default()
    };
    let mut walked = 0u64;
    let mut duration_units: Option<f64> = None;

    // Top level of the segment.
    loop {
        if walked > MAX_HEADER_BYTES {
            break;
        }
        let Ok((id, id_len)) = read_id(&mut r) else { break };
        let Ok((size, size_len)) = read_size(&mut r) else { break };
        walked += id_len + size_len;
        let size = size.unwrap_or(0);

        match id {
            INFO => {
                read_info(&mut r, size, &mut probe, &mut duration_units)?;
            }
            TRACKS => {
                read_tracks(&mut r, size, &mut probe)?;
                // Everything after this is media; nothing left to learn.
                break;
            }
            CLUSTER => break,
            _ => {
                if skip(&mut r, size).is_err() {
                    break;
                }
            }
        }
        walked += size;
    }

    if let Some(units) = duration_units {
        probe.duration_sec = Some(units * probe.timecode_scale as f64 / 1_000_000_000.0);
    }
    Ok(probe)
}

fn read_info<R: Read>(
    r: &mut R,
    size: u64,
    probe: &mut Probe,
    duration_units: &mut Option<f64>,
) -> std::io::Result<()> {
    let mut left = size;
    while left > 0 {
        let Ok((id, id_len)) = read_id(r) else { break };
        let Ok((len, len_len)) = read_size(r) else { break };
        let len = len.unwrap_or(0);
        if id_len + len_len + len > left {
            break;
        }
        left -= id_len + len_len + len;

        match id {
            TIMECODE_SCALE => probe.timecode_scale = read_uint(r, len)?.max(1),
            DURATION => *duration_units = Some(read_float(r, len)?),
            _ => skip(r, len)?,
        }
    }
    if left > 0 {
        skip(r, left)?;
    }
    Ok(())
}

fn read_tracks<R: Read>(r: &mut R, size: u64, probe: &mut Probe) -> std::io::Result<()> {
    let mut left = size;
    while left > 0 {
        let Ok((id, id_len)) = read_id(r) else { break };
        let Ok((len, len_len)) = read_size(r) else { break };
        let len = len.unwrap_or(0);
        if id_len + len_len + len > left {
            break;
        }
        left -= id_len + len_len + len;

        if id == TRACK_ENTRY {
            if let Some(track) = read_track_entry(r, len)? {
                probe.tracks.push(track);
            }
        } else {
            skip(r, len)?;
        }
    }
    if left > 0 {
        skip(r, left)?;
    }
    Ok(())
}

fn read_track_entry<R: Read>(r: &mut R, size: u64) -> std::io::Result<Option<Track>> {
    let mut number = 0u64;
    let mut kind = 0u64;
    let mut codec = String::new();
    let mut lang = String::new();
    let mut lang_bcp47 = String::new();
    let mut name = None;
    let mut default = true;
    let mut channels = None;

    let mut left = size;
    while left > 0 {
        let Ok((id, id_len)) = read_id(r) else { break };
        let Ok((len, len_len)) = read_size(r) else { break };
        let len = len.unwrap_or(0);
        if id_len + len_len + len > left {
            break;
        }
        left -= id_len + len_len + len;

        match id {
            TRACK_NUMBER => number = read_uint(r, len)?,
            TRACK_TYPE => kind = read_uint(r, len)?,
            CODEC_ID => codec = read_string(r, len)?,
            LANGUAGE => lang = read_string(r, len)?,
            LANGUAGE_BCP47 => lang_bcp47 = read_string(r, len)?,
            TRACK_NAME => name = Some(read_string(r, len)?),
            FLAG_DEFAULT => default = read_uint(r, len)? != 0,
            AUDIO => {
                let mut inner = len;
                while inner > 0 {
                    let Ok((aid, aid_len)) = read_id(r) else { break };
                    let Ok((alen, alen_len)) = read_size(r) else { break };
                    let alen = alen.unwrap_or(0);
                    if aid_len + alen_len + alen > inner {
                        break;
                    }
                    inner -= aid_len + alen_len + alen;
                    if aid == CHANNELS {
                        channels = Some(read_uint(r, alen)?);
                    } else {
                        skip(r, alen)?;
                    }
                }
                if inner > 0 {
                    skip(r, inner)?;
                }
            }
            _ => skip(r, len)?,
        }
    }
    if left > 0 {
        skip(r, left)?;
    }

    let kind = match kind {
        TYPE_VIDEO => "video",
        TYPE_AUDIO => "audio",
        TYPE_SUBTITLE => "subtitle",
        // Buttons, controls and other things no player here will use.
        _ => return Ok(None),
    };

    Ok(Some(Track {
        number,
        kind: kind.to_string(),
        codec,
        // BCP-47 wins where a file carries both: it is the newer field and the
        // one that distinguishes pt-BR from pt.
        lang: if !lang_bcp47.is_empty() {
            lang_bcp47
        } else if lang.is_empty() {
            "und".into()
        } else {
            lang
        },
        name,
        default,
        channels,
    }))
}

/* --------------------------------------------------- subtitle extraction */

/// One subtitle cue, in milliseconds.
#[derive(Debug, Clone, PartialEq)]
pub struct Cue {
    pub start_ms: u64,
    pub end_ms: u64,
    pub text: String,
}

/// Pulls one text subtitle track out of a Matroska file as WebVTT.
///
/// This is the expensive one: subtitle blocks are spread through the whole
/// file, so finding them all means walking every cluster. It is done on
/// request rather than during a library scan, and only for text formats —
/// PGS and VobSub are bitmap subtitles, which would need rendering rather
/// than converting and are reported rather than mangled.
pub fn extract_subtitles(path: &Path, track_number: u64) -> std::io::Result<String> {
    let probe = probe(path)?;
    let track = probe
        .tracks
        .iter()
        .find(|t| t.number == track_number && t.kind == "subtitle")
        .ok_or_else(|| {
            std::io::Error::new(std::io::ErrorKind::NotFound, "no such subtitle track")
        })?;

    let is_ass = track.codec.contains("ASS") || track.codec.contains("SSA");
    if track.codec.contains("PGS") || track.codec.contains("VOBSUB") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "bitmap subtitles cannot be converted to text",
        ));
    }

    let file = File::open(path)?;
    let mut r = BufReader::with_capacity(256 * 1024, file);

    // Back to the start of the segment's children.
    let (_, _) = read_id(&mut r)?;
    let (size, _) = read_size(&mut r)?;
    skip(&mut r, size.unwrap_or(0))?;
    let (_, _) = read_id(&mut r)?;
    let (_, _) = read_size(&mut r)?;

    let mut cues: Vec<Cue> = Vec::new();
    let scale_ms = probe.timecode_scale as f64 / 1_000_000.0;

    loop {
        let Ok((id, _)) = read_id(&mut r) else { break };
        let Ok((size, _)) = read_size(&mut r) else { break };
        let size = size.unwrap_or(0);

        if id != CLUSTER {
            if skip(&mut r, size).is_err() {
                break;
            }
            continue;
        }
        if read_cluster(&mut r, size, track_number, scale_ms, is_ass, &mut cues).is_err() {
            break;
        }
    }

    cues.sort_by_key(|c| c.start_ms);
    Ok(to_vtt(&cues))
}

fn read_cluster<R: Read>(
    r: &mut R,
    size: u64,
    track_number: u64,
    scale_ms: f64,
    is_ass: bool,
    cues: &mut Vec<Cue>,
) -> std::io::Result<()> {
    let mut left = size;
    let mut cluster_time = 0u64;

    while left > 0 {
        let Ok((id, id_len)) = read_id(r) else { break };
        let Ok((len, len_len)) = read_size(r) else { break };
        let len = len.unwrap_or(0);
        if id_len + len_len + len > left {
            break;
        }
        left -= id_len + len_len + len;

        match id {
            CLUSTER_TIMECODE => cluster_time = read_uint(r, len)?,
            SIMPLE_BLOCK => {
                read_block(r, len, track_number, cluster_time, scale_ms, is_ass, None, cues)?;
            }
            BLOCK_GROUP => {
                // A group carries the block plus its duration, which is how a
                // subtitle states how long it stays on screen.
                let mut inner = len;
                let mut pending: Option<(u64, String)> = None;
                let mut duration: Option<u64> = None;

                while inner > 0 {
                    let Ok((gid, gid_len)) = read_id(r) else { break };
                    let Ok((glen, glen_len)) = read_size(r) else { break };
                    let glen = glen.unwrap_or(0);
                    if gid_len + glen_len + glen > inner {
                        break;
                    }
                    inner -= gid_len + glen_len + glen;

                    match gid {
                        BLOCK => {
                            pending = read_block_payload(r, glen, track_number, cluster_time, scale_ms)?;
                        }
                        BLOCK_DURATION => duration = Some(read_uint(r, glen)?),
                        _ => skip(r, glen)?,
                    }
                }
                if inner > 0 {
                    skip(r, inner)?;
                }

                if let Some((start_ms, raw)) = pending {
                    let span = duration.map(|d| (d as f64 * scale_ms) as u64).unwrap_or(2000);
                    let text = if is_ass { strip_ass(&raw) } else { raw };
                    if !text.trim().is_empty() {
                        cues.push(Cue {
                            start_ms,
                            end_ms: start_ms + span.max(200),
                            text,
                        });
                    }
                }
            }
            _ => skip(r, len)?,
        }
    }
    if left > 0 {
        skip(r, left)?;
    }
    Ok(())
}

/// Reads a block's header and returns its timestamp and text, if it is ours.
fn read_block_payload<R: Read>(
    r: &mut R,
    len: u64,
    track_number: u64,
    cluster_time: u64,
    scale_ms: f64,
) -> std::io::Result<Option<(u64, String)>> {
    if len < 4 {
        skip(r, len)?;
        return Ok(None);
    }
    // The block's own track number is an EBML-style varint.
    let (track, track_len) = read_size(r)?;
    let track = track.unwrap_or(u64::MAX);

    let mut rel = [0u8; 2];
    r.read_exact(&mut rel)?;
    let mut flags = [0u8; 1];
    r.read_exact(&mut flags)?;

    let consumed = track_len + 3;
    let remaining = len.saturating_sub(consumed);

    if track != track_number {
        skip(r, remaining)?;
        return Ok(None);
    }

    let relative = i16::from_be_bytes(rel) as i64;
    let absolute = ((cluster_time as i64 + relative).max(0) as f64 * scale_ms) as u64;

    let mut payload = vec![0u8; remaining.min(64 * 1024) as usize];
    r.read_exact(&mut payload)?;
    if remaining > 64 * 1024 {
        skip(r, remaining - 64 * 1024)?;
    }

    Ok(Some((absolute, String::from_utf8_lossy(&payload).to_string())))
}

#[allow(clippy::too_many_arguments)]
fn read_block<R: Read>(
    r: &mut R,
    len: u64,
    track_number: u64,
    cluster_time: u64,
    scale_ms: f64,
    is_ass: bool,
    duration_ms: Option<u64>,
    cues: &mut Vec<Cue>,
) -> std::io::Result<()> {
    if let Some((start_ms, raw)) = read_block_payload(r, len, track_number, cluster_time, scale_ms)? {
        let text = if is_ass { strip_ass(&raw) } else { raw };
        if !text.trim().is_empty() {
            cues.push(Cue {
                start_ms,
                // A SimpleBlock carries no duration; subtitles muxed this way
                // rely on the next cue replacing them, so a sensible span is
                // better than none.
                end_ms: start_ms + duration_ms.unwrap_or(2500),
                text,
            });
        }
    }
    Ok(())
}

/// Strips ASS/SSA dialogue formatting down to the spoken text.
///
/// An ASS block is comma-separated fields with the text last, and the text
/// carries inline override tags in braces. Neither means anything to WebVTT.
fn strip_ass(raw: &str) -> String {
    // Dialogue lines have nine fields before the text.
    let text = raw.splitn(9, ',').nth(8).unwrap_or(raw);

    let mut out = String::with_capacity(text.len());
    let mut depth = 0usize;
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '{' => depth += 1,
            '}' => depth = depth.saturating_sub(1),
            '\\' if depth == 0 => {
                // \N and \n are ASS line breaks.
                match chars.peek() {
                    Some('N') | Some('n') => {
                        chars.next();
                        out.push('\n');
                    }
                    Some('h') => {
                        chars.next();
                        out.push(' ');
                    }
                    _ => {}
                }
            }
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    out.trim().to_string()
}

fn stamp(ms: u64) -> String {
    let h = ms / 3_600_000;
    let m = (ms % 3_600_000) / 60_000;
    let s = (ms % 60_000) / 1000;
    let milli = ms % 1000;
    format!("{h:02}:{m:02}:{s:02}.{milli:03}")
}

fn to_vtt(cues: &[Cue]) -> String {
    let mut out = String::from("WEBVTT\n\n");
    for (i, cue) in cues.iter().enumerate() {
        // A cue that outlives its successor covers it up; clamp so overlapping
        // blocks do not leave two lines on screen at once.
        let end = cues
            .get(i + 1)
            .map(|next| cue.end_ms.min(next.start_ms.max(cue.start_ms + 200)))
            .unwrap_or(cue.end_ms);
        out.push_str(&format!("{}\n", i + 1));
        out.push_str(&format!("{} --> {}\n", stamp(cue.start_ms), stamp(end)));
        out.push_str(cue.text.trim());
        out.push_str("\n\n");
    }
    out
}

/// True when this looks like a Matroska file by extension.
pub fn is_matroska(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "mkv" | "mka" | "webm"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_ebml_ids_of_every_width() {
        // 0x83 is one byte; 0x1654AE6B is four.
        let mut one: &[u8] = &[0x83];
        assert_eq!(read_id(&mut one).unwrap(), (0x83, 1));

        let mut four: &[u8] = &[0x16, 0x54, 0xAE, 0x6B];
        assert_eq!(read_id(&mut four).unwrap(), (0x1654_AE6B, 4));
    }

    #[test]
    fn reads_sizes_and_strips_the_marker_bit() {
        // 0x81 => width 1, value 1.
        let mut one: &[u8] = &[0x81];
        assert_eq!(read_size(&mut one).unwrap(), (Some(1), 1));

        // 0x41 0x23 => width 2, value 0x123.
        let mut two: &[u8] = &[0x41, 0x23];
        assert_eq!(read_size(&mut two).unwrap(), (Some(0x123), 2));

        // All value bits set means "unknown length", not a huge one.
        let mut unknown: &[u8] = &[0xFF];
        assert_eq!(read_size(&mut unknown).unwrap(), (None, 1));
    }

    #[test]
    fn labels_a_track_a_person_can_choose_between() {
        let ac3 = Track {
            number: 2,
            kind: "audio".into(),
            codec: "A_AC3".into(),
            lang: "eng".into(),
            name: None,
            default: true,
            channels: Some(6),
        };
        assert_eq!(ac3.label(), "eng · AC-3 5.1");

        let named = Track { name: Some("Director's commentary".into()), ..ac3.clone() };
        assert_eq!(named.label(), "Director's commentary", "an authored name wins");

        let bare = Track { lang: "und".into(), codec: String::new(), channels: None, name: None, ..ac3 };
        assert_eq!(bare.label(), "Track 2", "something distinguishable, always");
    }

    #[test]
    fn strips_ass_dialogue_to_its_text() {
        // The form a *block* carries: ReadOrder, Layer, Style, Name, three
        // margins, Effect, then the text. Start and end times are absent -
        // they live in the block header, not the payload.
        let line = r"1,0,Default,,0,0,0,,{\i1}Hello{\i0}\Nthere";
        assert_eq!(strip_ass(line), "Hello\nthere");
    }

    #[test]
    fn writes_webvtt_timestamps() {
        let cues = vec![Cue { start_ms: 3_661_500, end_ms: 3_663_000, text: "Late".into() }];
        let vtt = to_vtt(&cues);
        assert!(vtt.starts_with("WEBVTT\n\n"));
        assert!(vtt.contains("01:01:01.500 --> 01:01:03.000"), "got: {vtt}");
    }

    #[test]
    fn clamps_a_cue_that_would_outlive_the_next() {
        let cues = vec![
            Cue { start_ms: 0, end_ms: 9_000, text: "first".into() },
            Cue { start_ms: 1_000, end_ms: 2_000, text: "second".into() },
        ];
        let vtt = to_vtt(&cues);
        assert!(
            vtt.contains("00:00:00.000 --> 00:00:01.000"),
            "the first cue should end where the second begins: {vtt}"
        );
    }

    #[test]
    fn recognises_matroska_by_extension() {
        assert!(is_matroska(Path::new("a/b.mkv")));
        assert!(is_matroska(Path::new("a/b.WEBM")));
        assert!(!is_matroska(Path::new("a/b.mp4")));
    }

    #[test]
    fn refuses_a_file_that_is_not_matroska() {
        let dir = std::env::temp_dir().join(format!("lantern-ebml-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("not-really.mkv");
        std::fs::write(&path, b"this is not an EBML header at all").unwrap();

        assert!(probe(&path).is_err(), "a non-Matroska file must not parse");
        std::fs::remove_dir_all(&dir).ok();
    }
}
