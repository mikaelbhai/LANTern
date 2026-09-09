//! A reader for the parts of MP4 that LANTern needs.
//!
//! The sibling of `ebml.rs`, for the other container people actually have.
//! Same remit: list the tracks, and pull a text subtitle track out as WebVTT.
//! It does not decode, and it does not rewrite files.
//!
//! MP4 is a tree of length-prefixed boxes, and the one that matters — `moov`,
//! the index — may sit at either end of the file. In a 20 GB web release it is
//! usually last, behind the whole of `mdat`, so everything here seeks. Reading
//! forwards from the start would mean streaming twenty gigabytes to find a
//! table of contents.

use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

use crate::ebml::{Cue, Probe, Track};

/// A box header: type, total size, and where its body starts.
struct BoxHeader {
    kind: [u8; 4],
    /// Offset of the first byte after the header.
    body: u64,
    /// Offset of the first byte after the whole box.
    end: u64,
}

/// Boxes that contain other boxes rather than data.
const CONTAINERS: [&[u8; 4]; 6] = [b"moov", b"trak", b"mdia", b"minf", b"stbl", b"edts"];

/// Give up rather than follow a malformed tree for ever.
const MAX_DEPTH: usize = 8;

fn read_header<R: Read + Seek>(r: &mut R, limit: u64) -> std::io::Result<Option<BoxHeader>> {
    let start = r.stream_position()?;
    if start + 8 > limit {
        return Ok(None);
    }

    let mut hdr = [0u8; 8];
    if r.read_exact(&mut hdr).is_err() {
        return Ok(None);
    }
    let mut size = u32::from_be_bytes([hdr[0], hdr[1], hdr[2], hdr[3]]) as u64;
    let kind = [hdr[4], hdr[5], hdr[6], hdr[7]];
    let mut body = start + 8;

    match size {
        // 1 means the real size follows as 64 bits.
        1 => {
            let mut ext = [0u8; 8];
            r.read_exact(&mut ext)?;
            size = u64::from_be_bytes(ext);
            body = start + 16;
        }
        // 0 means "to the end of the file".
        0 => size = limit - start,
        _ => {}
    }

    if size < 8 || start + size > limit {
        return Ok(None);
    }
    Ok(Some(BoxHeader {
        kind,
        body,
        end: start + size,
    }))
}

/// ISO 639-2 packed as three 5-bit values, which is how MP4 stores language.
fn unpack_language(raw: u16) -> String {
    let a = ((raw >> 10) & 0x1F) as u8;
    let b = ((raw >> 5) & 0x1F) as u8;
    let c = (raw & 0x1F) as u8;
    // 0x60 is the offset the format uses; anything outside a-z is not a tag.
    let chars = [a + 0x60, b + 0x60, c + 0x60];
    if chars.iter().all(|c| c.is_ascii_lowercase()) {
        String::from_utf8_lossy(&chars).to_string()
    } else {
        "und".into()
    }
}

fn fourcc(v: &[u8; 4]) -> String {
    String::from_utf8_lossy(v).trim_end_matches('\u{0}').to_string()
}

/// Sample table entries needed to find a track's data on disk.
#[derive(Default)]
struct SampleTable {
    /// Duration of each sample, in the track's own timescale.
    durations: Vec<u32>,
    sizes: Vec<u32>,
    chunk_offsets: Vec<u64>,
    /// (first_chunk, samples_per_chunk) runs.
    to_chunk: Vec<(u32, u32)>,
}

impl SampleTable {
    /// Absolute file offset and size of every sample, in order.
    ///
    /// MP4 stores this as four separate tables that have to be walked together:
    /// sizes per sample, offsets per chunk, and a run-length map saying how
    /// many samples each chunk holds.
    fn samples(&self) -> Vec<(u64, u32)> {
        let mut out = Vec::with_capacity(self.sizes.len());
        let mut sample = 0usize;

        for (i, &chunk_offset) in self.chunk_offsets.iter().enumerate() {
            let chunk_no = i as u32 + 1;
            // The last run whose first_chunk is at or before this chunk.
            let per_chunk = self
                .to_chunk
                .iter()
                .rev()
                .find(|(first, _)| *first <= chunk_no)
                .map(|(_, n)| *n)
                .unwrap_or(1);

            let mut offset = chunk_offset;
            for _ in 0..per_chunk {
                let Some(&size) = self.sizes.get(sample) else {
                    return out;
                };
                out.push((offset, size));
                offset += size as u64;
                sample += 1;
            }
        }
        out
    }

    /// Start time of every sample, in the track's timescale.
    fn start_times(&self) -> Vec<u64> {
        let mut out = Vec::with_capacity(self.durations.len());
        let mut t = 0u64;
        for &d in &self.durations {
            out.push(t);
            t += d as u64;
        }
        out
    }
}

struct TrackParse {
    track: Track,
    timescale: u32,
    table: SampleTable,
}

fn read_u32<R: Read>(r: &mut R) -> std::io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_be_bytes(b))
}

fn read_track<R: Read + Seek>(r: &mut R, trak: &BoxHeader) -> std::io::Result<Option<TrackParse>> {
    let mut kind = String::new();
    let mut codec = String::new();
    let mut lang = "und".to_string();
    let mut timescale = 1000u32;
    let mut number = 0u64;
    let mut table = SampleTable::default();
    let mut enabled = true;

    fn walk<R: Read + Seek>(
        r: &mut R,
        parent: &BoxHeader,
        depth: usize,
        kind: &mut String,
        codec: &mut String,
        lang: &mut String,
        timescale: &mut u32,
        number: &mut u64,
        enabled: &mut bool,
        table: &mut SampleTable,
    ) -> std::io::Result<()> {
        if depth > MAX_DEPTH {
            return Ok(());
        }
        r.seek(SeekFrom::Start(parent.body))?;

        while let Some(b) = read_header(r, parent.end)? {
            match &b.kind {
                k if CONTAINERS.contains(&k) => {
                    walk(r, &b, depth + 1, kind, codec, lang, timescale, number, enabled, table)?;
                }
                b"tkhd" => {
                    let mut head = [0u8; 4];
                    r.read_exact(&mut head)?;
                    let version = head[0];
                    // Flag bit 0 is "track enabled".
                    *enabled = head[3] & 0x01 != 0;
                    // Skip creation/modification times, then read the id.
                    r.seek(SeekFrom::Current(if version == 1 { 16 } else { 8 }))?;
                    *number = read_u32(r)? as u64;
                }
                b"mdhd" => {
                    let mut head = [0u8; 4];
                    r.read_exact(&mut head)?;
                    let version = head[0];
                    r.seek(SeekFrom::Current(if version == 1 { 16 } else { 8 }))?;
                    *timescale = read_u32(r)?;
                    // Duration, then the packed language.
                    r.seek(SeekFrom::Current(if version == 1 { 8 } else { 4 }))?;
                    let mut packed = [0u8; 2];
                    r.read_exact(&mut packed)?;
                    *lang = unpack_language(u16::from_be_bytes(packed));
                }
                b"hdlr" => {
                    r.seek(SeekFrom::Current(8))?;
                    let mut handler = [0u8; 4];
                    r.read_exact(&mut handler)?;
                    *kind = match &handler {
                        b"vide" => "video",
                        b"soun" => "audio",
                        // sbtl and text are timed text; subt is used too.
                        b"sbtl" | b"text" | b"subt" => "subtitle",
                        _ => "other",
                    }
                    .to_string();
                }
                b"stsd" => {
                    // version/flags, entry count, then the first entry's size
                    // and its four-character codec.
                    r.seek(SeekFrom::Current(8))?;
                    let mut entry = [0u8; 8];
                    if r.read_exact(&mut entry).is_ok() {
                        *codec = fourcc(&[entry[4], entry[5], entry[6], entry[7]]);
                    }
                }
                b"stts" => {
                    r.seek(SeekFrom::Current(4))?;
                    let count = read_u32(r)?.min(1_000_000);
                    for _ in 0..count {
                        let n = read_u32(r)?;
                        let delta = read_u32(r)?;
                        for _ in 0..n.min(500_000) {
                            table.durations.push(delta);
                        }
                    }
                }
                b"stsz" => {
                    r.seek(SeekFrom::Current(4))?;
                    let uniform = read_u32(r)?;
                    let count = read_u32(r)?.min(2_000_000);
                    if uniform > 0 {
                        table.sizes = vec![uniform; count as usize];
                    } else {
                        for _ in 0..count {
                            table.sizes.push(read_u32(r)?);
                        }
                    }
                }
                b"stsc" => {
                    r.seek(SeekFrom::Current(4))?;
                    let count = read_u32(r)?.min(500_000);
                    for _ in 0..count {
                        let first = read_u32(r)?;
                        let per = read_u32(r)?;
                        let _desc = read_u32(r)?;
                        table.to_chunk.push((first, per));
                    }
                }
                b"stco" => {
                    r.seek(SeekFrom::Current(4))?;
                    let count = read_u32(r)?.min(2_000_000);
                    for _ in 0..count {
                        table.chunk_offsets.push(read_u32(r)? as u64);
                    }
                }
                b"co64" => {
                    r.seek(SeekFrom::Current(4))?;
                    let count = read_u32(r)?.min(2_000_000);
                    for _ in 0..count {
                        let mut v = [0u8; 8];
                        r.read_exact(&mut v)?;
                        table.chunk_offsets.push(u64::from_be_bytes(v));
                    }
                }
                _ => {}
            }
            r.seek(SeekFrom::Start(b.end))?;
        }
        Ok(())
    }

    walk(
        r,
        trak,
        0,
        &mut kind,
        &mut codec,
        &mut lang,
        &mut timescale,
        &mut number,
        &mut enabled,
        &mut table,
    )?;

    if kind.is_empty() || kind == "other" {
        return Ok(None);
    }

    Ok(Some(TrackParse {
        track: Track {
            number,
            kind,
            codec: pretty(&codec),
            lang,
            name: None,
            default: enabled,
            channels: None,
        },
        timescale: timescale.max(1),
        table,
    }))
}

/// Turns an MP4 sample-entry code into something recognisable.
fn pretty(codec: &str) -> String {
    match codec {
        "mp4a" => "AAC",
        "ac-3" => "AC-3",
        "ec-3" => "E-AC-3",
        "dtsc" | "dtse" | "dtsh" => "DTS",
        "Opus" => "Opus",
        "fLaC" => "FLAC",
        "avc1" | "avc3" => "H.264",
        "hvc1" | "hev1" => "HEVC",
        "av01" => "AV1",
        "vp09" => "VP9",
        "tx3g" => "Timed text",
        "wvtt" => "WebVTT",
        "c608" | "c708" => "CEA captions",
        other => other,
    }
    .to_string()
}

/// Finds `moov` without reading what comes before it.
fn find_moov<R: Read + Seek>(r: &mut R, size: u64) -> std::io::Result<Option<BoxHeader>> {
    r.seek(SeekFrom::Start(0))?;
    while let Some(b) = read_header(r, size)? {
        if &b.kind == b"moov" {
            return Ok(Some(b));
        }
        // The point of seeking: mdat can be twenty gigabytes.
        r.seek(SeekFrom::Start(b.end))?;
    }
    Ok(None)
}

/// Reads the track list out of an MP4.
pub fn probe(path: &Path) -> std::io::Result<Probe> {
    let file = File::open(path)?;
    let size = file.metadata()?.len();
    let mut r = BufReader::with_capacity(64 * 1024, file);

    let Some(moov) = find_moov(&mut r, size)? else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "no moov box; not an MP4",
        ));
    };

    let mut tracks = Vec::new();
    let mut duration_sec = None;

    r.seek(SeekFrom::Start(moov.body))?;
    while let Some(b) = read_header(&mut r, moov.end)? {
        match &b.kind {
            b"trak" => {
                if let Some(parsed) = read_track(&mut r, &b)? {
                    tracks.push(parsed.track);
                }
            }
            // The movie header carries the overall length, so the library can
            // show a runtime without opening the file in a player first.
            b"mvhd" => {
                let mut head = [0u8; 4];
                r.read_exact(&mut head)?;
                let version = head[0];
                r.seek(SeekFrom::Current(if version == 1 { 16 } else { 8 }))?;
                let timescale = read_u32(&mut r)?.max(1);
                let units = if version == 1 {
                    let mut v = [0u8; 8];
                    r.read_exact(&mut v)?;
                    u64::from_be_bytes(v)
                } else {
                    read_u32(&mut r)? as u64
                };
                if units > 0 {
                    duration_sec = Some(units as f64 / timescale as f64);
                }
            }
            _ => {}
        }
        r.seek(SeekFrom::Start(b.end))?;
    }

    Ok(Probe {
        tracks,
        timecode_scale: 1_000_000,
        duration_sec,
    })
}

/// Pulls one timed-text track out as WebVTT.
pub fn extract_subtitles(path: &Path, track_number: u64) -> std::io::Result<String> {
    let file = File::open(path)?;
    let size = file.metadata()?.len();
    let mut r = BufReader::with_capacity(256 * 1024, file);

    let Some(moov) = find_moov(&mut r, size)? else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "no moov box",
        ));
    };

    let mut wanted: Option<TrackParse> = None;
    r.seek(SeekFrom::Start(moov.body))?;
    while let Some(b) = read_header(&mut r, moov.end)? {
        if &b.kind == b"trak" {
            if let Some(parsed) = read_track(&mut r, &b)? {
                if parsed.track.number == track_number && parsed.track.kind == "subtitle" {
                    wanted = Some(parsed);
                    r.seek(SeekFrom::Start(b.end))?;
                    break;
                }
            }
        }
        r.seek(SeekFrom::Start(b.end))?;
    }

    let Some(parsed) = wanted else {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "no such subtitle track",
        ));
    };

    // CEA-608/708 are drawn into the picture, not stored as text.
    if parsed.track.codec.contains("CEA") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "embedded caption streams cannot be converted to text",
        ));
    }

    let samples = parsed.table.samples();
    let starts = parsed.table.start_times();
    let scale = parsed.timescale as f64;

    let mut cues = Vec::with_capacity(samples.len());
    for (i, (offset, len)) in samples.iter().enumerate() {
        if *len == 0 || *len > 64 * 1024 {
            continue;
        }
        r.seek(SeekFrom::Start(*offset))?;
        let mut buf = vec![0u8; *len as usize];
        if r.read_exact(&mut buf).is_err() {
            break;
        }

        // tx3g: a 16-bit length then UTF-8. wvtt wraps cue payloads in boxes.
        let text = if parsed.track.codec == "WebVTT" {
            payload_from_vtt_sample(&buf)
        } else if buf.len() > 2 {
            let n = u16::from_be_bytes([buf[0], buf[1]]) as usize;
            String::from_utf8_lossy(&buf[2..(2 + n).min(buf.len())]).to_string()
        } else {
            String::new()
        };

        if text.trim().is_empty() {
            continue;
        }

        let start_ms = (starts.get(i).copied().unwrap_or(0) as f64 / scale * 1000.0) as u64;
        let dur_ms = (parsed.table.durations.get(i).copied().unwrap_or(0) as f64 / scale * 1000.0)
            as u64;
        cues.push(Cue {
            start_ms,
            end_ms: start_ms + dur_ms.max(200),
            text,
        });
    }

    Ok(crate::ebml::cues_to_vtt(&cues))
}

/// Digs the text out of a WebVTT-in-MP4 sample, which is a little box tree.
fn payload_from_vtt_sample(buf: &[u8]) -> String {
    let mut out = String::new();
    let mut i = 0usize;
    while i + 8 <= buf.len() {
        let size = u32::from_be_bytes([buf[i], buf[i + 1], buf[i + 2], buf[i + 3]]) as usize;
        if size < 8 || i + size > buf.len() {
            break;
        }
        if &buf[i + 4..i + 8] == b"payl" {
            out.push_str(&String::from_utf8_lossy(&buf[i + 8..i + size]));
        }
        i += size;
    }
    out
}

/// True when this looks like an MP4 by extension.
pub fn is_mp4(path: &Path) -> bool {
    matches!(
        path.extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase()
            .as_str(),
        "mp4" | "m4v" | "mov" | "m4a"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpacks_iso639_language_codes() {
        // 'e','n','g' packed as 5-bit offsets from 0x60.
        let eng = ((b'e' - 0x60) as u16) << 10 | ((b'n' - 0x60) as u16) << 5 | (b'g' - 0x60) as u16;
        assert_eq!(unpack_language(eng), "eng");
        // 0 is the "undetermined" convention, and must not become "```".
        assert_eq!(unpack_language(0), "und");
    }

    #[test]
    fn names_codecs_people_recognise() {
        assert_eq!(pretty("mp4a"), "AAC");
        assert_eq!(pretty("ec-3"), "E-AC-3");
        assert_eq!(pretty("hvc1"), "HEVC");
        assert_eq!(pretty("tx3g"), "Timed text");
        assert_eq!(pretty("zzzz"), "zzzz", "an unknown code passes through");
    }

    #[test]
    fn walks_the_four_sample_tables_together() {
        // Two chunks, two samples each, sizes 10/20/30/40.
        let table = SampleTable {
            durations: vec![100; 4],
            sizes: vec![10, 20, 30, 40],
            chunk_offsets: vec![1000, 5000],
            to_chunk: vec![(1, 2)],
        };
        assert_eq!(
            table.samples(),
            vec![(1000, 10), (1010, 20), (5000, 30), (5030, 40)],
            "samples run consecutively inside a chunk, then jump to the next"
        );
        assert_eq!(table.start_times(), vec![0, 100, 200, 300]);
    }

    #[test]
    fn a_chunk_run_applies_until_the_next_one() {
        // Chunk 1 holds one sample; chunks 2 onward hold two.
        let table = SampleTable {
            durations: vec![50; 5],
            sizes: vec![1, 2, 3, 4, 5],
            chunk_offsets: vec![0, 100, 200],
            to_chunk: vec![(1, 1), (2, 2)],
        };
        let got = table.samples();
        assert_eq!(got[0], (0, 1), "chunk 1 has one sample");
        assert_eq!(got[1], (100, 2), "chunk 2 starts its own run");
        assert_eq!(got[2], (102, 3), "and continues inside the chunk");
    }

    #[test]
    fn reads_a_payl_box_out_of_a_vtt_sample() {
        let mut sample = Vec::new();
        let text = b"Hello there";
        sample.extend_from_slice(&((8 + text.len()) as u32).to_be_bytes());
        sample.extend_from_slice(b"payl");
        sample.extend_from_slice(text);
        assert_eq!(payload_from_vtt_sample(&sample), "Hello there");
    }

    #[test]
    fn recognises_mp4_by_extension() {
        assert!(is_mp4(Path::new("a/b.mp4")));
        assert!(is_mp4(Path::new("a/b.MOV")));
        assert!(!is_mp4(Path::new("a/b.mkv")));
    }

    #[test]
    fn refuses_a_file_with_no_moov() {
        let dir = std::env::temp_dir().join(format!("lantern-mp4-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("empty.mp4");
        // A valid ftyp box and nothing else.
        let mut data = Vec::new();
        data.extend_from_slice(&16u32.to_be_bytes());
        data.extend_from_slice(b"ftypisom");
        data.extend_from_slice(&[0u8; 4]);
        std::fs::write(&path, data).unwrap();

        assert!(probe(&path).is_err(), "a file without moov is not readable");
        std::fs::remove_dir_all(&dir).ok();
    }
}
