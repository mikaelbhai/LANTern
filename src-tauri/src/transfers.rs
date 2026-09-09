//! Peer-to-peer file transfer.
//!
//! Bytes do not travel over the signalling link. That link is a single
//! newline-delimited JSON stream shared by chat, typing, calls and games — a
//! large file base64'd through it would stall every one of them, and cost a
//! third of the bandwidth to encoding.
//!
//! Instead the sender publishes the file on the HTTP server it is already
//! running and hands the receiver a one-time URL. That server already speaks
//! range requests, so pause and resume come for free: resuming is just another
//! GET with a `Range` header starting where the partial file left off.
//!
//! The offer travels over the signalling link, because that is the only
//! channel that knows which peer is which.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

use crate::model::{now_ms, Transfer};
use crate::signaling::Envelope;
use crate::state::AppState;

/// A file this device has offered, addressable by its token until it expires.
#[derive(Debug, Clone)]
pub struct Outgoing {
    pub path: PathBuf,
    pub transfer_id: String,
}

/// Tokens currently serving a file, keyed by the token in the URL.
#[derive(Clone, Default)]
pub struct Offers(Arc<Mutex<HashMap<String, Outgoing>>>);

impl Offers {
    pub fn insert(&self, token: String, out: Outgoing) {
        self.0.lock().expect("offers poisoned").insert(token, out);
    }

    pub fn get(&self, token: &str) -> Option<Outgoing> {
        self.0.lock().expect("offers poisoned").get(token).cloned()
    }

    pub fn remove(&self, token: &str) {
        self.0.lock().expect("offers poisoned").remove(token);
    }

    /// Drops every offer belonging to one transfer, whatever its token.
    pub fn revoke(&self, transfer_id: &str) {
        self.0
            .lock()
            .expect("offers poisoned")
            .retain(|_, out| out.transfer_id != transfer_id);
    }
}

/// The offer as it goes over the wire.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOffer {
    pub transfer_id: String,
    pub name: String,
    pub size: u64,
    pub mime: String,
    /// Absolute URL on the sender's host server.
    pub url: String,
    /// Present when several files were offered together.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bundle_id: Option<String>,
}

/// Control messages that travel alongside an offer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileControl {
    pub transfer_id: String,
    /// "cancel" from either side; "done" from the receiver.
    pub action: String,
}

fn guess_mime(path: &Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "flac" => "audio/flac",
        "wav" => "audio/wav",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "txt" | "md" | "log" => "text/plain",
        "json" => "application/json",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
    .to_string()
}

/// Publishes files and tells the peer they are waiting.
///
/// Returns the sender's own view of each transfer so the UI can show progress
/// immediately, before the receiver has fetched a single byte.
pub fn offer(
    app: &AppHandle,
    state: &AppState,
    peer_id: &str,
    paths: Vec<PathBuf>,
) -> Vec<Transfer> {
    let (links, me, host_port, my_ip) = state.with(|s| {
        (
            s.links.clone(),
            s.device_id.clone(),
            s.net.host_port,
            s.net.ip.clone(),
        )
    });

    let bundle_id = (paths.len() > 1).then(|| uuid::Uuid::new_v4().to_string());
    let mut created = Vec::new();

    for path in paths {
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if !meta.is_file() {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("file")
            .to_string();
        let transfer_id = uuid::Uuid::new_v4().to_string();
        let token = uuid::Uuid::new_v4().simple().to_string();
        let mime = guess_mime(&path);

        state.with(|s| {
            s.offers.insert(
                token.clone(),
                Outgoing {
                    path: path.clone(),
                    transfer_id: transfer_id.clone(),
                },
            )
        });

        let transfer = Transfer {
            id: transfer_id.clone(),
            name: name.clone(),
            size: meta.len(),
            sent: 0,
            peer_id: peer_id.to_string(),
            direction: "out".into(),
            state: "queued".into(),
            speed_bps: 0,
            started_at: now_ms(),
            finished_at: None,
            mime: mime.clone(),
            local_path: Some(path.to_string_lossy().to_string()),
            expires_at: None,
            bundle_id: bundle_id.clone(),
            url: None,
        };

        let sent = links.send(
            peer_id,
            &Envelope {
                v: 1,
                from: me.clone(),
                kind: "file".into(),
                payload: serde_json::json!({
                    "offer": FileOffer {
                        transfer_id: transfer_id.clone(),
                        name,
                        size: meta.len(),
                        mime,
                        url: format!("http://{my_ip}:{host_port}/transfer/{token}"),
                        bundle_id: bundle_id.clone(),
                    }
                }),
            },
        );

        // No live link means nothing will ever fetch this; say so rather than
        // leaving a transfer sitting at zero for ever.
        let mut transfer = transfer;
        if !sent {
            transfer.state = "failed".into();
            state.with(|s| s.offers.remove(&token));
        }

        state.with(|s| s.transfers.push(transfer.clone()));
        let _ = app.emit("transfer:progress", &transfer);
        created.push(transfer);
    }

    created
}

/// Records a peer's offer so the UI has something to accept.
///
/// Done here rather than in the frontend so the source URL, and every other
/// detail the download needs, stays on the Rust side. The UI only ever needs
/// the transfer id.
pub fn record_offer(app: &AppHandle, state: &AppState, from: &str, offer: FileOffer) -> Transfer {
    let transfer = Transfer {
        id: offer.transfer_id.clone(),
        name: offer.name,
        size: offer.size,
        sent: 0,
        peer_id: from.to_string(),
        direction: "in".into(),
        state: "queued".into(),
        speed_bps: 0,
        started_at: now_ms(),
        finished_at: None,
        mime: offer.mime,
        local_path: None,
        expires_at: None,
        bundle_id: offer.bundle_id,
        url: Some(offer.url),
    };
    state.with(|s| {
        // A link that re-established can replay an offer.
        if let Some(existing) = s.transfers.iter_mut().find(|t| t.id == transfer.id) {
            *existing = transfer.clone();
        } else {
            s.transfers.push(transfer.clone());
        }
    });
    let _ = app.emit("transfer:offer", &transfer);
    transfer
}

/// Applies a control message from the other end of a transfer.
pub fn apply_control(app: &AppHandle, state: &AppState, control: FileControl) {
    state.with(|s| {
        match control.action.as_str() {
            // The receiver finished, so the sender can stop publishing.
            "done" => {
                s.offers.revoke(&control.transfer_id);
                if let Some(t) = s.transfers.iter_mut().find(|t| t.id == control.transfer_id) {
                    t.state = "done".into();
                    t.sent = t.size;
                    t.finished_at = Some(now_ms());
                }
            }
            "cancel" => {
                s.offers.revoke(&control.transfer_id);
                if let Some(t) = s.transfers.iter_mut().find(|t| t.id == control.transfer_id) {
                    t.state = "cancelled".into();
                }
            }
            _ => {}
        }
    });
    emit_one(app, state, &control.transfer_id);
}

/// Fetches an offered file into the downloads directory.
///
/// Resumes from whatever is already on disk, which is what makes pause work:
/// pausing aborts the request, and accepting again picks up from the same
/// byte. Progress is emitted as it goes so the UI has something to show on a
/// slow link.
pub async fn accept(app: AppHandle, state: AppState, transfer_id: String) {
    let url = state.with(|s| {
        s.transfers
            .iter()
            .find(|t| t.id == transfer_id)
            .and_then(|t| t.url.clone())
    });
    let Some(url) = url else {
        eprintln!("transfer {transfer_id}: no source url on file");
        return;
    };
    let dir = download_dir(&app);
    let _ = std::fs::create_dir_all(&dir);

    let (name, size) = state.with(|s| {
        s.transfers
            .iter()
            .find(|t| t.id == transfer_id)
            .map(|t| (t.name.clone(), t.size))
            .unwrap_or_else(|| (transfer_id.clone(), 0))
    });
    let target = unique_path(&dir, &name);

    let mut have = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    if have > size {
        // A stale file of the wrong length is worse than starting again.
        let _ = std::fs::remove_file(&target);
        have = 0;
    }

    set_state(&app, &state, &transfer_id, "active", have);

    let result = stream_to_file(&app, &state, &transfer_id, &url, &target, have, size).await;

    match result {
        Ok(total) => {
            state.with(|s| {
                if let Some(t) = s.transfers.iter_mut().find(|t| t.id == transfer_id) {
                    t.sent = total;
                    t.state = "done".into();
                    t.finished_at = Some(now_ms());
                    t.local_path = Some(target.to_string_lossy().to_string());
                }
            });
            emit_one(&app, &state, &transfer_id);

            // Let the sender stop holding the file open.
            let (links, me) = state.with(|s| (s.links.clone(), s.device_id.clone()));
            let peer = state.with(|s| {
                s.transfers
                    .iter()
                    .find(|t| t.id == transfer_id)
                    .map(|t| t.peer_id.clone())
            });
            if let Some(peer) = peer {
                links.send(
                    &peer,
                    &Envelope {
                        v: 1,
                        from: me,
                        kind: "file".into(),
                        payload: serde_json::json!({
                            "control": FileControl { transfer_id, action: "done".into() }
                        }),
                    },
                );
            }
        }
        Err(e) => {
            eprintln!("transfer {transfer_id} stopped: {e}");
            // A paused transfer is not a failed one; the command already
            // recorded the pause and must not be overwritten here.
            let paused = state.with(|s| {
                s.transfers
                    .iter()
                    .any(|t| t.id == transfer_id && (t.state == "paused" || t.state == "cancelled"))
            });
            if !paused {
                state.with(|s| {
                    if let Some(t) = s.transfers.iter_mut().find(|t| t.id == transfer_id) {
                        t.state = "failed".into();
                    }
                });
                emit_one(&app, &state, &transfer_id);
            }
        }
    }
}

/// Streams the body to disk, appending when resuming.
async fn stream_to_file(
    app: &AppHandle,
    state: &AppState,
    transfer_id: &str,
    url: &str,
    target: &Path,
    from: u64,
    size: u64,
) -> std::io::Result<u64> {
    let (host, port, path) = split_url(url)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad offer url"))?;

    let mut stream = tokio::net::TcpStream::connect((host.as_str(), port)).await?;
    let request = if from > 0 {
        format!(
            "GET {path} HTTP/1.0\r\nHost: {host}:{port}\r\nRange: bytes={from}-\r\nConnection: close\r\n\r\n"
        )
    } else {
        format!("GET {path} HTTP/1.0\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n")
    };
    stream.write_all(request.as_bytes()).await?;

    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
    let mut reader = BufReader::new(stream);

    // Status line, then headers, then the body begins.
    let mut line = String::new();
    reader.read_line(&mut line).await?;
    if !(line.contains(" 200") || line.contains(" 206")) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("sender answered: {}", line.trim()),
        ));
    }
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).await? == 0 {
            break;
        }
        if header.trim().is_empty() {
            break;
        }
    }

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(from > 0)
        .truncate(from == 0)
        .open(target)
        .await?;

    let mut written = from;
    let mut buf = vec![0u8; 64 * 1024];
    let started = std::time::Instant::now();
    let mut last_emit = std::time::Instant::now();

    loop {
        // Pausing and cancelling are cooperative: the command flips the state
        // and this loop notices on its next chunk rather than being killed
        // mid-write, so the partial file stays valid for resuming.
        let stop = state.with(|s| {
            s.transfers
                .iter()
                .any(|t| t.id == transfer_id && (t.state == "paused" || t.state == "cancelled"))
        });
        if stop {
            file.flush().await?;
            return Err(std::io::Error::new(
                std::io::ErrorKind::Interrupted,
                "stopped by request",
            ));
        }

        let n = reader.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).await?;
        written += n as u64;

        if last_emit.elapsed() >= std::time::Duration::from_millis(250) {
            last_emit = std::time::Instant::now();
            let elapsed = started.elapsed().as_secs_f64().max(0.001);
            let speed = ((written - from) as f64 / elapsed) as u64;
            state.with(|s| {
                if let Some(t) = s.transfers.iter_mut().find(|t| t.id == transfer_id) {
                    t.sent = written;
                    t.speed_bps = speed;
                }
            });
            emit_one(app, state, transfer_id);
        }
    }

    file.flush().await?;

    if size > 0 && written < size {
        return Err(std::io::Error::new(
            std::io::ErrorKind::UnexpectedEof,
            format!("ended early at {written} of {size} bytes"),
        ));
    }
    Ok(written)
}

/// Splits `http://host:port/path` without pulling in a URL crate.
fn split_url(url: &str) -> Option<(String, u16, String)> {
    let rest = url.strip_prefix("http://")?;
    let (authority, path) = match rest.find('/') {
        Some(i) => (&rest[..i], &rest[i..]),
        None => (rest, "/"),
    };
    let (host, port) = match authority.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.parse().ok()?),
        None => (authority.to_string(), 80u16),
    };
    Some((host, port, path.to_string()))
}

/// Never silently overwrite something already downloaded.
fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(name);
    let stem = path.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
    let ext = path.extension().and_then(|e| e.to_str());
    for n in 2..10_000 {
        let next = match ext {
            Some(e) => dir.join(format!("{stem} ({n}).{e}")),
            None => dir.join(format!("{stem} ({n})")),
        };
        if !next.exists() {
            return next;
        }
    }
    candidate
}

fn download_dir(app: &AppHandle) -> PathBuf {
    use tauri::Manager;
    // The platform downloads folder where there is one; on Android that is not
    // writable without the Storage Access Framework, so app-local storage is
    // both correct and the only thing that works.
    #[cfg(desktop)]
    if let Ok(dir) = app.path().download_dir() {
        return dir.join("LANTern");
    }
    app.path()
        .app_data_dir()
        .map(|d| d.join("downloads"))
        .unwrap_or_else(|_| PathBuf::from("."))
}

fn set_state(app: &AppHandle, state: &AppState, transfer_id: &str, next: &str, sent: u64) {
    state.with(|s| {
        if let Some(t) = s.transfers.iter_mut().find(|t| t.id == transfer_id) {
            t.state = next.to_string();
            t.sent = sent;
        }
    });
    emit_one(app, state, transfer_id);
}

pub fn emit_one(app: &AppHandle, state: &AppState, transfer_id: &str) {
    let t = state.with(|s| s.transfers.iter().find(|t| t.id == transfer_id).cloned());
    if let Some(t) = t {
        let _ = app.emit("transfer:progress", &t);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_an_offer_url() {
        assert_eq!(
            split_url("http://192.168.1.5:7981/transfer/abc"),
            Some(("192.168.1.5".into(), 7981, "/transfer/abc".into()))
        );
        assert_eq!(split_url("https://example/x"), None, "only plain http is served");
        assert_eq!(
            split_url("http://host:7981"),
            Some(("host".into(), 7981, "/".into()))
        );
    }

    #[test]
    fn never_overwrites_an_existing_download() {
        let dir = std::env::temp_dir().join(format!("lantern-dl-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();

        let first = unique_path(&dir, "clip.mp4");
        assert_eq!(first.file_name().unwrap(), "clip.mp4");
        std::fs::write(&first, b"x").unwrap();

        let second = unique_path(&dir, "clip.mp4");
        assert_eq!(second.file_name().unwrap(), "clip (2).mp4");

        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn guesses_mime_from_extension() {
        assert_eq!(guess_mime(Path::new("a/b.mp4")), "video/mp4");
        assert_eq!(guess_mime(Path::new("a/b.PNG")), "image/png");
        assert_eq!(guess_mime(Path::new("a/b.unknown")), "application/octet-stream");
        assert_eq!(guess_mime(Path::new("noext")), "application/octet-stream");
    }
}
