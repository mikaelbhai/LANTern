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
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::AsyncWriteExt;

use crate::model::{now_ms, Share, ShareMode, Transfer};
use crate::signaling::Envelope;
use crate::state::AppState;

/// A file this device has offered, addressable by its token until it expires.
#[derive(Debug, Clone)]
pub struct Outgoing {
    pub path: PathBuf,
    pub transfer_id: String,
    /// An already-open file, when the path is not something that can be
    /// opened again.
    ///
    /// Android's picker names files with `content://` URIs belonging to other
    /// applications. Android will hand over a descriptor for one, but the
    /// descriptor is all there is: `/proc/self/fd/N` looks like a path and is
    /// not one, because opening it re-opens the file it points at, through
    /// the permissions this application does not have. That is why a file
    /// picked on a phone arrived called "443" and then failed.
    ///
    /// So the open file travels with the offer, and is read from directly.
    pub handle: Option<Arc<std::fs::File>>,
    /// What the far side should call it.
    ///
    /// Carried because the path cannot always say: `/proc/self/fd/443` has a
    /// file name, and it is "443".
    pub name: String,
}

/// A file a phone picked and is holding open, waiting to be sent.
#[derive(Clone)]
pub struct Staged {
    pub file: Arc<std::fs::File>,
    pub name: String,
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
    /// See `Transfer::via_chat`.
    #[serde(default)]
    pub via_chat: bool,
}

/// Control messages that travel alongside an offer.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileControl {
    pub transfer_id: String,
    /// "cancel" from either side; "done" from the receiver.
    pub action: String,
}

pub(crate) fn guess_mime(path: &Path) -> String {
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
    via_chat: bool,
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
        // A file staged from a phone's picker is already open, and knows what
        // it should be called. Its path is a descriptor and can say neither.
        let staged = state.with(|s| s.staged.get(&path).cloned());

        let size_and_name = match &staged {
            Some(entry) => entry
                .file
                .metadata()
                .ok()
                .map(|m| (m.len(), entry.name.clone())),
            None => std::fs::metadata(&path).ok().filter(|m| m.is_file()).map(|m| {
                (
                    m.len(),
                    path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("file")
                        .to_string(),
                )
            }),
        };
        let Some((size, name)) = size_and_name else {
            continue;
        };
        let transfer_id = uuid::Uuid::new_v4().to_string();
        let token = uuid::Uuid::new_v4().simple().to_string();
        let mime = guess_mime(&path);

        state.with(|s| {
            s.offers.insert(
                token.clone(),
                Outgoing {
                    path: path.clone(),
                    transfer_id: transfer_id.clone(),
                    handle: staged.as_ref().map(|e| e.file.clone()),
                    name: name.clone(),
                },
            )
        });

        let transfer = Transfer {
            id: transfer_id.clone(),
            name: name.clone(),
            size,
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
            via_chat,
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
                        size,
                        mime,
                        url: format!("http://{my_ip}:{host_port}/transfer/{token}"),
                        bundle_id: bundle_id.clone(),
                        via_chat,
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
        via_chat: offer.via_chat,
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
    // Where the person receiving it said to put it. `accept` carries the
    // choice through: a folder chosen for this transfer, the one set in
    // Settings, or - when neither is set - the platform's downloads folder.
    let chosen = state.with(|s| s.download_into.get(&transfer_id).cloned()).flatten();
    let dir = match chosen {
        Some(path) if !path.trim().is_empty() => std::path::PathBuf::from(path),
        _ => download_dir(&app),
    };
    state.with(|s| {
        s.download_into.remove(&transfer_id);
    });
    let _ = std::fs::create_dir_all(&dir);

    let (name, size) = state.with(|s| {
        s.transfers
            .iter()
            .find(|t| t.id == transfer_id)
            .map(|t| (t.name.clone(), t.size))
            .unwrap_or_else(|| (transfer_id.clone(), 0))
    });
    let resuming = conflicts()
        .lock()
        .expect("conflicts poisoned")
        .partial
        .get(&transfer_id)
        .cloned()
        .filter(|p| p.is_file());
    let target = match resuming {
        Some(path) => path,
        None => {
            let wanted = dir.join(&name);
            if wanted.exists() {
                let existing = std::fs::metadata(&wanted).map(|m| m.len()).unwrap_or(0);
                match decide(&app, &transfer_id, &name, existing, size).await.as_str() {
                    "skip" => {
                        cancel_transfer(&app, &state, &transfer_id);
                        return;
                    }
                    // A file that cannot be removed (open elsewhere) is not
                    // replaced; the new one is kept beside it instead.
                    "replace" if std::fs::remove_file(&wanted).is_ok() => wanted,
                    _ => unique_path(&dir, &name),
                }
            } else {
                wanted
            }
        }
    };
    conflicts()
        .lock()
        .expect("conflicts poisoned")
        .partial
        .insert(transfer_id.clone(), target.clone());

    let mut have = std::fs::metadata(&target).map(|m| m.len()).unwrap_or(0);
    if have > size {
        // A stale file of the wrong length is worse than starting again.
        let _ = std::fs::remove_file(&target);
        have = 0;
    }

    set_state(&app, &state, &transfer_id, "active", have);

    let result = stream_to_file(&|| emit_one(&app, &state, &transfer_id), &state, &transfer_id, &url, &target, have, size, None).await;

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
            conflicts().lock().expect("conflicts poisoned").partial.remove(&transfer_id);
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
    // How to tell the window that something moved. A closure, not the app
    // handle: this is the part worth testing (pausing, resuming from the byte
    // reached) and a test has no window to hand it.
    emit: &(dyn Fn() + Send + Sync),
    state: &AppState,
    transfer_id: &str,
    url: &str,
    target: &Path,
    from: u64,
    size: u64,
    // The name to put back on the transfer once the sender has started
    // sending, for a transfer that was labelled while it waited.
    ready_name: Option<String>,
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
    let mut content_length: Option<u64> = None;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).await? == 0 {
            break;
        }
        if header.trim().is_empty() {
            break;
        }
        if let Some(v) = header.to_ascii_lowercase().strip_prefix("content-length:") {
            content_length = v.trim().parse().ok();
        }
    }

    // What the sender says it is sending beats what the listing said it would
    // be. They differ for a converted copy - same film, different size - and
    // going by the listing made a finished copy look unfinished, or run past
    // 100%.
    let size = match content_length {
        Some(c) if c > 0 => from + c,
        _ => size,
    };
    state.with(|s| {
        if let Some(t) = s.transfers.iter_mut().find(|t| t.id == transfer_id) {
            if size > 0 {
                t.size = size;
            }
            if let Some(name) = ready_name.clone() {
                t.name = name;
            }
        }
    });

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(from > 0)
        .truncate(from == 0)
        .open(target)
        .await?;

    let mut written = from;
    // Matches the sender's own chunk size (see send_open_file's identical
    // comment) for the identical reason, and for a second one specific to
    // this loop: every chunk also takes the state lock once to check for a
    // pause, and 512KB steps mean an eighth as many of those per megabyte
    // moved. On a fast LAN this loop was spending more time on syscalls and
    // lock contention than on the network - reported as a gigabit uplink
    // and a 400Mbps phone topping out around 40Mbps.
    let mut buf = vec![0u8; 512 * 1024];
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
            emit();
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

/*
 * A file with this name is already where this one is going.
 *
 * Until now the answer was always "keep both", chosen silently: the new one
 * became "name (2)". That is the safe default and stays one of the choices, but
 * it is not the only reasonable one - somebody sending the same document again
 * after fixing it wants it replaced, and somebody receiving two hundred photos
 * does not want to be asked two hundred times. So there is a standing policy
 * (Settings), a question when the policy is to ask, and an "apply to the rest"
 * on that question.
 */
struct Conflicts {
    /// "ask", "keep", "replace" or "skip".
    policy: String,
    /// An answer given to "do this for the rest", and when - it lapses, so a
    /// choice made for one batch does not quietly govern tomorrow's.
    all: Option<(String, u64)>,
    waiters: HashMap<String, tokio::sync::oneshot::Sender<String>>,
    /// Where each transfer that has started is writing. A paused one resumes
    /// into the same file: asking for a free name again would find its own
    /// half-written file in the way and start over under another.
    partial: HashMap<String, PathBuf>,
}

const ALL_LIFE_MS: u64 = 2 * 60 * 1000;
/// How long a question may sit unanswered before the safe choice is made.
const ASK_PATIENCE: std::time::Duration = std::time::Duration::from_secs(5 * 60);

fn conflicts() -> &'static Mutex<Conflicts> {
    static C: std::sync::OnceLock<Mutex<Conflicts>> = std::sync::OnceLock::new();
    C.get_or_init(|| {
        Mutex::new(Conflicts {
            policy: "ask".into(),
            all: None,
            waiters: HashMap::new(),
            partial: HashMap::new(),
        })
    })
}

pub fn set_conflict_policy(policy: &str) {
    if matches!(policy, "ask" | "keep" | "replace" | "skip") {
        conflicts().lock().expect("conflicts poisoned").policy = policy.to_string();
    }
}

/// What to do without asking, if the policy or an earlier "for the rest" says.
fn settled(policy: &str, all: &Option<(String, u64)>, now: u64) -> Option<String> {
    if let Some((choice, at)) = all {
        if now.saturating_sub(*at) < ALL_LIFE_MS {
            return Some(choice.clone());
        }
    }
    (policy != "ask").then(|| policy.to_string())
}

/// The person's answer to a question put by `decide`.
pub fn resolve_conflict(transfer_id: &str, choice: &str, all: bool) {
    if !matches!(choice, "keep" | "replace" | "skip") {
        return;
    }
    let mut c = conflicts().lock().expect("conflicts poisoned");
    if all {
        c.all = Some((choice.to_string(), now_ms()));
    }
    if let Some(waiter) = c.waiters.remove(transfer_id) {
        let _ = waiter.send(choice.to_string());
    }
}

async fn decide(
    app: &AppHandle,
    transfer_id: &str,
    name: &str,
    existing: u64,
    incoming: u64,
) -> String {
    let (rx, immediate) = {
        let mut c = conflicts().lock().expect("conflicts poisoned");
        if let Some(choice) = settled(&c.policy, &c.all, now_ms()) {
            (None, Some(choice))
        } else {
            let (tx, rx) = tokio::sync::oneshot::channel();
            c.waiters.insert(transfer_id.to_string(), tx);
            (Some(rx), None)
        }
    };
    if let Some(choice) = immediate {
        return choice;
    }
    let _ = app.emit(
        "transfer:conflict",
        serde_json::json!({
            "id": transfer_id, "name": name, "existingSize": existing, "size": incoming,
        }),
    );
    let answer = match rx {
        Some(rx) => tokio::time::timeout(ASK_PATIENCE, rx).await.ok().and_then(Result::ok),
        None => None,
    };
    conflicts().lock().expect("conflicts poisoned").waiters.remove(transfer_id);
    // Nobody answered: keep both, which loses nothing.
    answer.unwrap_or_else(|| "keep".to_string())
}

/// Stops an incoming transfer and tells the sender, for the receiver's own
/// reasons - declined, or skipped because the file is already there.
pub fn cancel_transfer(app: &AppHandle, state: &AppState, id: &str) {
    let peer = state.with(|s| {
        s.offers.revoke(id);
        if let Some(t) = s.transfers.iter_mut().find(|t| t.id == id) {
            t.state = "cancelled".into();
            return Some(t.peer_id.clone());
        }
        None
    });
    emit_one(app, state, id);
    conflicts().lock().expect("conflicts poisoned").partial.remove(id);

    if let Some(peer) = peer {
        let (links, me) = state.with(|s| (s.links.clone(), s.device_id.clone()));
        links.send(
            &peer,
            &Envelope {
                v: 1,
                from: me,
                kind: "file".into(),
                payload: serde_json::json!({
                    "control": { "transferId": id, "action": "cancel" }
                }),
            },
        );
    }
}

/// Never silently overwrite something already downloaded.
pub(crate) fn unique_path(dir: &Path, name: &str) -> PathBuf {
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

/// Copies a file this device already has onto a folder somebody chose.
///
/// For a file already sitting in the default download folder that somebody
/// decides, after the fact, belongs somewhere else - the per-transfer
/// destination picker in the chat bubble covers choosing *before* it lands;
/// this covers moving a copy once it already has. A plain copy, not a move:
/// the original stays where the transfer put it, which is what every other
/// "save a copy" affordance in this application already does.
pub fn save_copy(source: &Path, dest_dir: &Path) -> Result<PathBuf, String> {
    if !source.is_file() {
        return Err("that file is no longer there".into());
    }
    std::fs::create_dir_all(dest_dir).map_err(|e| format!("could not use that folder: {e}"))?;
    let name = source
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "that file has no usable name".to_string())?;
    let target = unique_path(dest_dir, name);
    std::fs::copy(source, &target).map_err(|e| format!("could not copy the file: {e}"))?;
    Ok(target)
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
        remember(state, &t);
        let _ = app.emit("transfer:progress", &t);
    }
}

/// Writes a finished transfer down, so it is still there after a restart.
///
/// The `transfers` table had been created and never once written to: the list
/// lived only in memory, so closing the app lost the record of everything
/// received - including where each file went, which is the one thing somebody
/// looking for a file they were sent needs. Only finished ones are written
/// (done, failed, cancelled): a transfer still moving belongs to a live
/// connection that will not exist next time, and its progress ticks four times
/// a second.
fn remember(state: &AppState, t: &Transfer) {
    if !matches!(t.state.as_str(), "done" | "failed" | "cancelled") {
        return;
    }
    state.with(|s| {
        let Some(db) = s.db.as_ref() else {
            return;
        };
        let _ = db.execute(
            "INSERT INTO transfers
                (id, name, size, sent, peer_id, direction, state, mime, local_path,
                 started_at, finished_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
                sent = ?4, state = ?7, local_path = ?9, finished_at = ?11",
            rusqlite::params![
                t.id,
                t.name,
                t.size as i64,
                t.sent as i64,
                t.peer_id,
                t.direction,
                t.state,
                t.mime,
                t.local_path,
                t.started_at as i64,
                t.finished_at.map(|f| f as i64),
                t.expires_at.map(|e| e as i64),
            ],
        );
    });
}

/// The finished transfers written down last time, oldest first.
///
/// Capped: the Files list is something to scroll, not an archive, and a
/// long-lived install should not load every file it has ever been sent.
pub fn load_history(conn: &rusqlite::Connection) -> Vec<Transfer> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT id, name, size, sent, peer_id, direction, state, mime, local_path,
                started_at, finished_at, expires_at
         FROM transfers ORDER BY started_at DESC LIMIT 500",
    ) else {
        return Vec::new();
    };
    let Ok(rows) = stmt.query_map([], |r| {
        Ok(Transfer {
            id: r.get(0)?,
            name: r.get(1)?,
            size: r.get::<_, i64>(2)? as u64,
            sent: r.get::<_, i64>(3)? as u64,
            peer_id: r.get(4)?,
            direction: r.get(5)?,
            state: r.get(6)?,
            speed_bps: 0,
            mime: r.get(7)?,
            local_path: r.get(8)?,
            started_at: r.get::<_, i64>(9)? as u64,
            finished_at: r.get::<_, Option<i64>>(10)?.map(|f| f as u64),
            expires_at: r.get::<_, Option<i64>>(11)?.map(|e| e as u64),
            bundle_id: None,
            url: None,
            via_chat: false,
        })
    }) else {
        return Vec::new();
    };
    let mut out: Vec<Transfer> = rows.flatten().collect();
    out.reverse();
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_standing_policy_or_a_recent_for_the_rest_answers_without_asking() {
        let now = 10_000_000;
        assert_eq!(settled("ask", &None, now), None);
        assert_eq!(settled("keep", &None, now), Some("keep".to_string()));
        assert_eq!(settled("replace", &None, now), Some("replace".to_string()));
        // An answer to "for the rest" beats the policy while it is fresh...
        let fresh = Some(("skip".to_string(), now - 1_000));
        assert_eq!(settled("ask", &fresh, now), Some("skip".to_string()));
        // ...and lapses, so one batch's choice does not govern the next.
        let stale = Some(("skip".to_string(), now - ALL_LIFE_MS - 1));
        assert_eq!(settled("ask", &stale, now), None);
    }

    #[test]
    fn an_answer_reaches_the_transfer_that_asked() {
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        conflicts().lock().unwrap().waiters.insert("conflict-test-a".into(), tx);
        resolve_conflict("conflict-test-a", "replace", false);
        assert_eq!(rx.try_recv().ok().as_deref(), Some("replace"));

        // Not a choice this knows: nothing is delivered and nothing remembered.
        let (tx, mut rx) = tokio::sync::oneshot::channel();
        conflicts().lock().unwrap().waiters.insert("conflict-test-b".into(), tx);
        resolve_conflict("conflict-test-b", "delete-everything", true);
        assert!(rx.try_recv().is_err());
        conflicts().lock().unwrap().waiters.remove("conflict-test-b");
    }

    #[test]
    fn an_unknown_policy_changes_nothing() {
        set_conflict_policy("keep");
        set_conflict_policy("whatever");
        assert_eq!(conflicts().lock().unwrap().policy, "keep");
        set_conflict_policy("ask");
    }

    #[test]
    fn save_copy_leaves_the_original_where_it_was() {
        let src_dir = std::env::temp_dir().join(format!("lantern-savecopy-src-{}", std::process::id()));
        let dest_dir = std::env::temp_dir().join(format!("lantern-savecopy-dest-{}", std::process::id()));
        std::fs::create_dir_all(&src_dir).unwrap();
        let source = src_dir.join("note.txt");
        std::fs::write(&source, b"hello").unwrap();

        let saved = save_copy(&source, &dest_dir).unwrap();

        assert!(source.exists(), "the original must not be moved or deleted");
        assert!(saved.exists());
        assert_eq!(std::fs::read(&saved).unwrap(), b"hello");
        assert_eq!(saved.parent(), Some(dest_dir.as_path()));

        let _ = std::fs::remove_dir_all(&src_dir);
        let _ = std::fs::remove_dir_all(&dest_dir);
    }

    #[test]
    fn save_copy_does_not_clobber_a_same_named_file_already_there() {
        let src_dir = std::env::temp_dir().join(format!("lantern-savecopy-src2-{}", std::process::id()));
        let dest_dir = std::env::temp_dir().join(format!("lantern-savecopy-dest2-{}", std::process::id()));
        std::fs::create_dir_all(&src_dir).unwrap();
        std::fs::create_dir_all(&dest_dir).unwrap();
        let source = src_dir.join("note.txt");
        std::fs::write(&source, b"new").unwrap();
        std::fs::write(dest_dir.join("note.txt"), b"already here").unwrap();

        let saved = save_copy(&source, &dest_dir).unwrap();

        assert_ne!(saved, dest_dir.join("note.txt"));
        assert_eq!(std::fs::read(dest_dir.join("note.txt")).unwrap(), b"already here");
        assert_eq!(std::fs::read(&saved).unwrap(), b"new");

        let _ = std::fs::remove_dir_all(&src_dir);
        let _ = std::fs::remove_dir_all(&dest_dir);
    }

    #[test]
    fn save_copy_refuses_a_source_that_is_gone() {
        let missing = std::env::temp_dir().join("lantern-does-not-exist-at-all.bin");
        let dest_dir = std::env::temp_dir().join(format!("lantern-savecopy-dest3-{}", std::process::id()));
        assert!(save_copy(&missing, &dest_dir).is_err());
    }

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

/// A sensible filename for something named by a `content://` URI.
///
/// Android's picker returns URIs whose last segment is usually an opaque row
/// id — `content://media/external/images/media/1000000174` — so it is only
/// worth using when it actually looks like a name. Everything else falls back
/// to something plain, because a file arriving on the far side called
/// "1000000174" is worse than one called "file".
///
/// The name matters more here than it looks: it is what the receiving device
/// writes to disk, and it is the only description of the file the person on
/// that end ever sees.
pub fn name_from_uri(uri: &str) -> String {
    let last = uri
        .rsplit('/')
        .next()
        .unwrap_or("")
        // A URI may carry a query or fragment; neither belongs in a filename.
        .split(['?', '#'])
        .next()
        .unwrap_or("");

    let decoded = percent_decode(last);
    // The decoded document id is frequently the file's whole relative path
    // from its storage volume - "primary:Download/1DM Torrents/Some Site -
    // Title (2009)/Title.mkv" - not a bare filename. Its internal slashes
    // were hidden as `%2F` until decoding revealed them, one step after the
    // first `rsplit('/')` above already looked. Without this second split,
    // the whole path got welded into one filename by the sanitiser below
    // instead of just its last, real, component - which is what actually
    // arrived on the far side as the file's name.
    let leaf = decoded.rsplit(['/', ':']).next().unwrap_or(&decoded);
    let trimmed = leaf.trim();

    // A name needs an extension to be worth preferring over nothing: it is
    // what tells the far side, and its operating system, what the file is.
    let looks_named = trimmed.contains('.')
        && !trimmed.starts_with('.')
        && trimmed.chars().any(|c| c.is_ascii_alphabetic());

    if !looks_named {
        return "file".into();
    }

    // Anything that could climb out of the download directory on the far side.
    trimmed
        .replace(['/', '\\', ':'], "_")
        .replace("..", "_")
        .chars()
        .take(120)
        .collect()
}

/// Turns `%20` and friends back into characters.
fn percent_decode(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(test)]
mod name_tests {
    use super::name_from_uri;

    #[test]
    fn a_real_name_is_kept() {
        assert_eq!(name_from_uri("content://com.app/docs/holiday.jpg"), "holiday.jpg");
        assert_eq!(name_from_uri("file:///storage/emulated/0/notes.txt"), "notes.txt");
    }

    #[test]
    fn spaces_and_escapes_come_back() {
        assert_eq!(
            name_from_uri("content://com.app/My%20Holiday%20Photo.jpg"),
            "My Holiday Photo.jpg",
        );
    }

    #[test]
    fn an_opaque_row_id_is_not_a_name() {
        // What MediaStore actually returns, and what this exists to catch: a
        // file arriving called "1000000174" tells the far side nothing.
        assert_eq!(name_from_uri("content://media/external/images/media/1000000174"), "file");
        assert_eq!(name_from_uri("content://com.android.providers.media.documents/document/image%3A42"), "file");
    }

    #[test]
    fn a_query_string_is_not_part_of_the_name() {
        assert_eq!(name_from_uri("content://x/report.pdf?take=1"), "report.pdf");
        assert_eq!(name_from_uri("content://x/report.pdf#page2"), "report.pdf");
    }

    #[test]
    fn nothing_can_climb_out_of_the_download_folder() {
        // The far side writes this name to disk, so a name that walks up out
        // of the directory it was meant for is the one thing it must not be.
        for hostile in [
            "content://x/..%2F..%2Fetc%2Fpasswd",
            "content://x/..\\..\\windows\\system32\\a.dll",
            "content://x/a%2F..%2F..%2Fb.txt",
        ] {
            let name = name_from_uri(hostile);
            assert!(!name.contains(".."), "{hostile} -> {name}");
            assert!(!name.contains('/'), "{hostile} -> {name}");
            assert!(!name.contains('\\'), "{hostile} -> {name}");
        }
    }

    #[test]
    fn odd_input_does_not_panic() {
        for odd in ["", "content://", "/", "...", ".hidden", "%", "%zz", "%2"] {
            let name = name_from_uri(odd);
            assert!(!name.is_empty(), "{odd:?} gave nothing");
        }
    }

    #[test]
    fn a_saf_document_id_that_is_a_whole_path_gives_up_only_its_leaf() {
        // What Android's Storage Access Framework actually hands back for a
        // file picked from inside a folder: the document id is the file's
        // full relative path from its storage volume, encoded as one opaque
        // segment - not a bare filename. Decoding it too early, before
        // isolating the last component, welded the whole thing into one
        // filename: this exact input is what arrived as
        // "primary_Download_1DM_Torrents_www.UIndex.org_..._Inglourious_
        // Basterds_2009_Inglourious_Basterds.mkv" and showed up as a
        // Theatre title to match.
        assert_eq!(
            name_from_uri(
                "content://com.android.externalstorage.documents/document/\
                 primary%3ADownload%2F1DM%20Torrents%2Fwww.UIndex.org%20-%20\
                 Inglourious%20Basterds%20(2009)%2FInglourious%20Basterds.mkv"
            ),
            "Inglourious Basterds.mkv",
        );
        // No subfolder at all - just the volume prefix ahead of the name.
        assert_eq!(
            name_from_uri("content://com.android.externalstorage.documents/document/primary%3AMovie.mkv"),
            "Movie.mkv",
        );
    }

    #[test]
    fn a_very_long_name_is_cut_short() {
        let long = format!("content://x/{}.jpg", "a".repeat(500));
        assert!(name_from_uri(&long).len() <= 120);
    }
}

/* -------------------------------------------------------------- syncing */

/// A title pulled from a peer for offline viewing, and the shelf it lands on.
///
/// The destination is a share like any other - unlisted, so nothing here is
/// handed to a peer asking what this device publishes - specifically so the
/// exact scan that builds every other shelf in Theatre (`media::
/// items_for_share`) builds this one too. A synced copy gets a title, a
/// season and episode number, a subtitle menu - everything the original had
/// - because it is read by the same code that read the original.
/// The slug of the share synced copies live on.
pub const SYNCED_SLUG: &str = "lantern-synced";

fn ensure_synced_share(app: &AppHandle, state: &AppState) -> Result<Share, String> {
    const SLUG: &str = SYNCED_SLUG;
    if let Some(existing) = state.with(|s| s.shares.iter().find(|sh| sh.slug == SLUG).cloned()) {
        return Ok(existing);
    }

    let base = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("no app data directory: {e}"))?;
    let root = base.join("synced");
    std::fs::create_dir_all(&root).map_err(|e| format!("could not create the synced folder: {e}"))?;

    let share = Share {
        id: uuid::Uuid::new_v4().to_string(),
        name: "Synced".into(),
        path: root.to_string_lossy().to_string(),
        slug: SLUG.into(),
        mode: ShareMode::Media,
        running: true,
        require_phrase: false,
        phrase: None,
        allow_upload: false,
        // Refuses every peer rather than publishing nothing named - a synced
        // copy is this device's own, not something it is now re-offering.
        unlisted: true,
        audience: Vec::new(),
        file_count: 0,
        total_bytes: 0,
        created_at: now_ms(),
        requests: 0,
        bytes_served: 0,
        active_viewers: 0,
        last_request_at: None,
    };

    crate::shares::save(state, &share);
    let all = state.with(|s| {
        s.shares.push(share.clone());
        s.shares.clone()
    });
    let _ = app.emit("host:changed", &all);
    Ok(share)
}

/// Keeps a relative path a relative path. `relPath` and a subtitle's decoded
/// URL both come from a peer's own listing - trusted enough to stream from,
/// not enough to let dictate where a write lands on this device's disk.
fn safe_relative(rel: &str) -> PathBuf {
    let mut out = PathBuf::new();
    for part in rel.split(['/', '\\']) {
        if part.is_empty() || part == "." || part == ".." {
            continue;
        }
        out.push(part);
    }
    out
}

/// Downloads a title - and any subtitle sidecars it lists - from a peer's
/// stream URL into the synced share, then rescans so it shows up in Theatre
/// immediately.
///
/// The video comes from `video_url` untouched: no `?audio=` remux, so every
/// embedded audio track in the original container survives the copy exactly
/// as it would crossing on a USB drive. Only a track the browser cannot
/// decode at all still needs the remux endpoint, same as it does live.
///
/// `transfer_id` is generated by the caller rather than in here, so the
/// command that spawns this can hand it back immediately - the frontend
/// needs it to watch progress before a single byte has moved, the same
/// reason `files_accept` never waits for `accept` to finish either.
/// What a sync needs in order to carry on after it has been paused.
#[derive(Clone)]
struct SyncJob {
    item_id: String,
    video_url: String,
    /// The path inside the synced share, as the sender listed it.
    rel: String,
    subtitle_urls: Vec<String>,
    min_age: Option<u8>,
    /// Where the finished copy goes, and where it is written until it is whole.
    target: PathBuf,
    part: PathBuf,
    /// The size the listing gave, for a copy made from the file as it is.
    size: u64,
    /// Asked for the sound to be converted first.
    convert: bool,
    /// The other device could not convert, so the file is taken as it is.
    plain: bool,
    /// How long the sender said the copy would be, once it has said.
    expected: Option<u64>,
    /// Something is writing to the part file right now.
    running: bool,
}

fn sync_jobs() -> &'static Mutex<HashMap<String, SyncJob>> {
    static JOBS: std::sync::OnceLock<Mutex<HashMap<String, SyncJob>>> = std::sync::OnceLock::new();
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Whether this transfer is a sync, which pauses, resumes and cancels by its
/// own rules (see `resume_sync` and `cancel_sync`).
pub fn is_sync(id: &str) -> bool {
    sync_jobs().lock().expect("sync jobs poisoned").contains_key(id)
}

/// The name a copy is written under until it is whole.
///
/// Not a video extension, so a rescan while it is still arriving does not list a
/// half-film as a title - which it did, because the copy was written straight
/// to its final name.
fn part_path(target: &Path) -> PathBuf {
    let name = target.file_name().and_then(|n| n.to_str()).unwrap_or("video");
    target.with_file_name(format!("{name}.part"))
}

/// Removes half-written copies left by a sync that never finished - the app was
/// closed part-way. Nothing can continue them (the job lived in memory), and
/// they would only take up space.
fn sweep_stale_parts(root: &Path) {
    fn walk(dir: &Path) {
        let Ok(entries) = std::fs::read_dir(dir) else { return };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                walk(&path);
            } else if path.extension().and_then(|e| e.to_str()) == Some("part") {
                let _ = std::fs::remove_file(&path);
            }
        }
    }
    walk(root);
}

fn converted_address(video_url: &str) -> String {
    format!("{video_url}{}syncaudio=1", if video_url.contains('?') { '&' } else { '?' })
}

pub async fn sync_media(
    app: AppHandle,
    state: AppState,
    transfer_id: String,
    item_id: String,
    video_url: String,
    video_rel_path: String,
    size: u64,
    subtitle_urls: Vec<String>,
    min_age: Option<u8>,
    // Ask the sharing device to convert the film's sound first. Set by the
    // receiver, which is the only one that knows what it cannot play.
    convert_audio: bool,
) -> Result<(), String> {
    let share = ensure_synced_share(&app, &state)?;
    let root = PathBuf::from(&share.path);
    {
        // Once per run, before the first copy of this one: whatever is still
        // here from an earlier run was left by a sync that cannot be continued.
        static SWEPT: std::sync::Once = std::sync::Once::new();
        SWEPT.call_once(|| sweep_stale_parts(&root));
    }
    let target = root.join(safe_relative(&video_rel_path));
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("video")
        .to_string();
    let shown_name = if convert_audio {
        format!("{name} (preparing the sound)")
    } else {
        name.clone()
    };

    let transfer = Transfer {
        id: transfer_id.clone(),
        name: shown_name,
        size,
        sent: 0,
        peer_id: String::new(),
        direction: "in".into(),
        state: "active".into(),
        speed_bps: 0,
        started_at: now_ms(),
        finished_at: None,
        mime: guess_mime(&target),
        local_path: None,
        expires_at: None,
        bundle_id: None,
        url: Some(if convert_audio { converted_address(&video_url) } else { video_url.clone() }),
        via_chat: false,
    };
    state.with(|s| s.transfers.push(transfer));
    emit_one(&app, &state, &transfer_id);

    sync_jobs().lock().expect("sync jobs poisoned").insert(
        transfer_id.clone(),
        SyncJob {
            item_id,
            video_url,
            rel: video_rel_path,
            subtitle_urls,
            min_age,
            part: part_path(&target),
            target,
            size,
            convert: convert_audio,
            plain: false,
            expected: None,
            running: false,
        },
    );

    run_sync(app, state, transfer_id).await
}

/// Starts (or carries on) the download for a sync, once at a time.
async fn run_sync(app: AppHandle, state: AppState, transfer_id: String) -> Result<(), String> {
    let job = {
        let mut jobs = sync_jobs().lock().expect("sync jobs poisoned");
        let Some(job) = jobs.get_mut(&transfer_id) else {
            return Err("that sync is gone".into());
        };
        if job.running {
            return Ok(());
        }
        job.running = true;
        job.clone()
    };
    let result = sync_download(&app, &state, &transfer_id, job).await;
    if let Some(job) = sync_jobs().lock().expect("sync jobs poisoned").get_mut(&transfer_id) {
        job.running = false;
    }
    result
}

fn with_job(id: &str, change: impl FnOnce(&mut SyncJob)) {
    if let Some(job) = sync_jobs().lock().expect("sync jobs poisoned").get_mut(id) {
        change(job);
    }
}

async fn sync_download(
    app: &AppHandle,
    state: &AppState,
    transfer_id: &str,
    job: SyncJob,
) -> Result<(), String> {
    let name = job
        .target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("video")
        .to_string();
    let emit = || emit_one(app, state, transfer_id);

    let converting = job.convert && !job.plain;
    let have = std::fs::metadata(&job.part).map(|m| m.len()).unwrap_or(0);
    set_state(app, state, transfer_id, "active", have);

    let url = if converting { converted_address(&job.video_url) } else { job.video_url.clone() };
    let mut result = stream_to_file(
        &emit,
        state,
        transfer_id,
        &url,
        &job.part,
        have,
        // The size of the original means nothing for a converted copy; the
        // sender's own length is read from its answer.
        if converting { 0 } else { job.size },
        (converting && have == 0).then(|| name.clone()),
    )
    .await;

    // The sharing device cannot convert (no ffmpeg there): the copy is made
    // from the file as it is, which is what syncing did before this existed.
    // It plays, without its sound, and says so.
    if converting {
        if let Err(e) = &result {
            if e.to_string().contains("501") {
                with_job(transfer_id, |j| j.plain = true);
                state.with(|s| {
                    if let Some(t) = s.transfers.iter_mut().find(|t| t.id == transfer_id) {
                        t.name = name.clone();
                        t.url = Some(job.video_url.clone());
                    }
                });
                result =
                    stream_to_file(&emit, state, transfer_id, &job.video_url, &job.part, 0, job.size, None).await;
            }
        }
    }

    // What the sender said it would send. A copy made again from scratch (the
    // other device had to convert once more) need not be the same bytes as the
    // one the first part came from, so a resumed one that comes out a different
    // length starts over rather than being joined to the wrong file.
    let announced = state.with(|s| {
        s.transfers.iter().find(|t| t.id == transfer_id).map(|t| t.size).unwrap_or(0)
    });
    if converting && announced > 0 {
        match job.expected {
            Some(before) if before != announced && have > 0 => {
                let _ = std::fs::remove_file(&job.part);
                with_job(transfer_id, |j| j.expected = None);
                return Box::pin(sync_download(
                    app,
                    state,
                    transfer_id,
                    SyncJob { expected: None, ..job },
                ))
                .await;
            }
            None => with_job(transfer_id, |j| j.expected = Some(announced)),
            _ => {}
        }
    }

    match result {
        Ok(total) => {
            // Whole now: take its real name, replacing an earlier copy.
            let _ = std::fs::remove_file(&job.target);
            if let Err(e) = std::fs::rename(&job.part, &job.target) {
                state.with(|s| {
                    if let Some(t) = s.transfers.iter_mut().find(|t| t.id == transfer_id) {
                        t.state = "failed".into();
                    }
                });
                emit();
                return Err(format!("could not finish the copy: {e}"));
            }
            state.with(|s| {
                if let Some(t) = s.transfers.iter_mut().find(|t| t.id == transfer_id) {
                    t.sent = total;
                    t.state = "done".into();
                    t.finished_at = Some(now_ms());
                    t.local_path = Some(job.target.to_string_lossy().to_string());
                }
            });
            emit();
        }
        Err(e) => {
            let now = state.with(|s| {
                s.transfers.iter().find(|t| t.id == transfer_id).map(|t| t.state.clone())
            });
            match now.as_deref() {
                // Cancelled while it ran: nothing worth keeping.
                Some("cancelled") => {
                    let _ = std::fs::remove_file(&job.part);
                    sync_jobs().lock().expect("sync jobs poisoned").remove(transfer_id);
                    emit();
                    return Ok(());
                }
                // Paused is not failed: the part stays, and resuming continues it.
                Some("paused") => {
                    emit();
                    return Ok(());
                }
                _ => {
                    state.with(|s| {
                        if let Some(t) = s.transfers.iter_mut().find(|t| t.id == transfer_id) {
                            t.state = "failed".into();
                        }
                    });
                    emit();
                    return Err(e.to_string());
                }
            }
        }
    }

    // Subtitle sidecars: best-effort, and not tracked as transfers of their
    // own - a season sync would otherwise leave twenty tiny completed
    // entries in Files' history for every episode's language tracks.
    if let Some(dir) = job.target.parent() {
        let prefix_len = job.video_url.rfind('/').map(|i| i + 1).unwrap_or(0);
        let base = &job.video_url[..prefix_len];
        for sub_url in &job.subtitle_urls {
            let Some(rel) = sub_url.strip_prefix(base) else { continue };
            let decoded = percent_decode(rel);
            let sub_target = dir.join(safe_relative(&decoded));
            if let Some(parent) = sub_target.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            if let Err(e) = fetch_whole(sub_url, &sub_target).await {
                eprintln!("sync {}: subtitle {sub_url} failed: {e}", job.item_id);
            }
        }
    }

    save_synced(state, &job.item_id, &job.target);

    // The host's rating goes with the file. The copy is a title of its own on
    // a share of its own, so nothing linked it to the original and it came out
    // unrated - listed with no age on it, and playable by anyone holding the
    // phone, whatever the host had decided about the film it was copied from.
    if let Some(age) = job.min_age {
        let path = synced_stream_path(&job.rel);
        state.with(|s| {
            s.title_ages.insert(path.clone(), age);
            if let Some(db) = s.db.as_ref() {
                let _ = db.execute(
                    "INSERT INTO title_ages (stream_path, min_age) VALUES (?1, ?2)
                     ON CONFLICT(stream_path) DO UPDATE SET min_age = ?2",
                    rusqlite::params![path, age as i64],
                );
            }
        });
    }

    sync_jobs().lock().expect("sync jobs poisoned").remove(transfer_id);
    let items = crate::media::refresh(state);
    let _ = app.emit("media:changed", &items);

    Ok(())
}

/// Carries on a sync that was paused, or retries one that failed.
///
/// From the byte the part file reached, by a Range request. If it is already
/// running (paused and resumed within one chunk) there is nothing to start: the
/// loop never noticed.
pub async fn resume_sync(app: AppHandle, state: AppState, id: String) {
    state.with(|s| {
        if let Some(t) = s.transfers.iter_mut().find(|t| t.id == id) {
            if matches!(t.state.as_str(), "paused" | "failed" | "queued") {
                t.state = "active".into();
            }
        }
    });
    emit_one(&app, &state, &id);
    let _ = run_sync(app, state, id).await;
}

/// Stops a sync and throws away what has arrived of it.
pub fn cancel_sync(app: &AppHandle, state: &AppState, id: &str) {
    state.with(|s| {
        if let Some(t) = s.transfers.iter_mut().find(|t| t.id == id) {
            t.state = "cancelled".into();
        }
    });
    emit_one(app, state, id);
    let idle = {
        let mut jobs = sync_jobs().lock().expect("sync jobs poisoned");
        match jobs.get(id) {
            // A loop that is running notices and cleans up after itself.
            Some(job) if job.running => None,
            Some(_) => jobs.remove(id),
            None => None,
        }
    };
    if let Some(job) = idle {
        let _ = std::fs::remove_file(&job.part);
    }
}

/// A plain GET to a file, no progress tracking - for the small sidecar files
/// beside a synced video, which finish before a progress bar would matter.
async fn fetch_whole(url: &str, target: &Path) -> std::io::Result<()> {
    let (host, port, path) = split_url(url)
        .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "bad url"))?;

    let mut stream = tokio::net::TcpStream::connect((host.as_str(), port)).await?;
    let request =
        format!("GET {path} HTTP/1.0\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).await?;

    use tokio::io::{AsyncBufReadExt, AsyncReadExt, BufReader};
    let mut reader = BufReader::new(stream);

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

    let mut body = Vec::new();
    reader.read_to_end(&mut body).await?;
    tokio::fs::write(target, body).await
}

/* ------------------------------------------------------- synced bookkeeping */

fn save_synced(state: &AppState, item_id: &str, local_path: &Path) {
    state.with(|s| {
        let Some(db) = s.db.as_ref() else { return };
        let _ = db.execute(
            "INSERT INTO synced (item_id, local_path, synced_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(item_id) DO UPDATE SET local_path = ?2, synced_at = ?3",
            rusqlite::params![item_id, local_path.to_string_lossy(), now_ms() as i64],
        );
    });
}

/// Every title that has a local copy already, by its original id.
pub fn synced_ids(state: &AppState) -> Vec<String> {
    state.with(|s| {
        let Some(db) = s.db.as_ref() else { return Vec::new() };
        let Ok(mut stmt) = db.prepare("SELECT item_id FROM synced") else {
            return Vec::new();
        };
        stmt.query_map([], |r| r.get::<_, String>(0))
            .map(|rows| rows.flatten().collect())
            .unwrap_or_default()
    })
}

/// Deletes a synced copy - the file and the record of it - and reports
/// whether there was one. A title still not there is not an error; the
/// button that calls this does not know whether it already ran.
pub fn remove_synced(state: &AppState, item_id: &str) -> bool {
    let path = state.with(|s| {
        let db = s.db.as_ref()?;
        db.query_row(
            "SELECT local_path FROM synced WHERE item_id = ?1",
            rusqlite::params![item_id],
            |r| r.get::<_, String>(0),
        )
        .ok()
    });
    let Some(path) = path else { return false };

    let _ = std::fs::remove_file(&path);
    state.with(|s| {
        if let Some(db) = s.db.as_ref() {
            let _ = db.execute(
                "DELETE FROM synced WHERE item_id = ?1",
                rusqlite::params![item_id],
            );
        }
    });
    true
}

/// The path a synced copy is streamed from, in the form ratings are keyed by:
/// decoded, with the share's slug in front.
fn synced_stream_path(video_rel_path: &str) -> String {
    let rel = safe_relative(video_rel_path);
    format!("/lantern-synced/{}", rel.to_string_lossy().replace('\\', "/"))
}

/// Deletes the synced copy that lives at `rel_path` inside the synced share.
///
/// Matched on the end of the stored path with separators normalised: the row
/// keeps the absolute path in whatever form this platform wrote it, and the
/// shelf knows only the share-relative one, with forward slashes.
pub fn remove_synced_copy(state: &AppState, rel_path: &str) -> bool {
    let rel = rel_path.replace('\\', "/");
    if rel.is_empty() {
        return false;
    }
    let found = state.with(|s| {
        let db = s.db.as_ref()?;
        let mut stmt = db.prepare("SELECT item_id, local_path FROM synced").ok()?;
        let rows: Vec<(String, String)> = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .ok()?
            .flatten()
            .collect();
        rows.into_iter()
            .find(|(_, path)| path.replace('\\', "/").ends_with(&format!("/{rel}")))
            .map(|(id, _)| id)
    });
    match found {
        Some(id) => remove_synced(state, &id),
        None => false,
    }
}

#[cfg(test)]
mod sync_tests {
    use super::{safe_relative, synced_stream_path};

    /// The rating is looked up by the path a viewer's request resolves to, so
    /// the one written at sync time has to come out identical.
    #[test]
    fn a_copy_is_rated_under_the_path_it_is_served_from() {
        assert_eq!(
            synced_stream_path("Movies/Deadpool 2016.mp4"),
            crate::rating::stream_path("http://192.168.1.5:7981/lantern-synced/Movies/Deadpool%202016.mp4"),
        );
    }
    use std::path::Path;

    #[test]
    fn an_ordinary_relative_path_is_kept_whole() {
        assert_eq!(safe_relative("Subnet/S01E01.mkv"), Path::new("Subnet/S01E01.mkv"));
    }

    #[test]
    fn climbing_out_is_stripped() {
        assert_eq!(safe_relative("../../etc/passwd"), Path::new("etc/passwd"));
        assert_eq!(safe_relative("Show/../../../S01E01.mkv"), Path::new("Show/S01E01.mkv"));
    }

    #[test]
    fn a_bare_filename_survives() {
        assert_eq!(safe_relative("Film (2020).mkv"), Path::new("Film (2020).mkv"));
    }

    #[test]
    fn backslashes_are_a_separator_too() {
        // A Windows-style relative path from a subtitle URL's decoded tail
        // should split the same way a forward-slash one does.
        assert_eq!(safe_relative("Subs\\Film.en.srt"), Path::new("Subs/Film.en.srt"));
    }
}

#[cfg(test)]
mod history_tests {
    use super::*;

    fn transfer(id: &str, state: &str) -> Transfer {
        Transfer {
            id: id.into(),
            name: format!("{id}.mp4"),
            size: 1_500_000_000,
            sent: 1_500_000_000,
            peer_id: "phone".into(),
            direction: "in".into(),
            state: state.into(),
            speed_bps: 0,
            started_at: 1_000,
            finished_at: Some(2_000),
            mime: "video/mp4".into(),
            local_path: Some("/home/me/Downloads/LANTern/film.mp4".into()),
            expires_at: None,
            bundle_id: None,
            url: Some("http://x/y".into()),
            via_chat: true,
        }
    }

    fn state_with_table() -> AppState {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE transfers (
                id TEXT PRIMARY KEY, name TEXT NOT NULL, size INTEGER NOT NULL,
                sent INTEGER NOT NULL DEFAULT 0, peer_id TEXT NOT NULL,
                direction TEXT NOT NULL, state TEXT NOT NULL,
                mime TEXT NOT NULL DEFAULT '', local_path TEXT,
                started_at INTEGER NOT NULL, finished_at INTEGER, expires_at INTEGER);",
        )
        .unwrap();
        let state = AppState::default();
        state.with(|s| s.db = Some(conn));
        state
    }

    #[test]
    fn a_finished_transfer_is_still_there_after_a_restart_with_its_path() {
        let state = state_with_table();
        remember(&state, &transfer("a", "done"));

        let loaded = state.with(|s| load_history(s.db.as_ref().unwrap()));
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].state, "done");
        // The reason this exists: where the file went.
        assert_eq!(
            loaded[0].local_path.as_deref(),
            Some("/home/me/Downloads/LANTern/film.mp4")
        );
        assert_eq!(loaded[0].size, 1_500_000_000);
    }

    #[test]
    fn a_transfer_still_moving_is_not_written_down() {
        let state = state_with_table();
        remember(&state, &transfer("moving", "active"));
        remember(&state, &transfer("waiting", "queued"));
        remember(&state, &transfer("paused", "paused"));

        assert!(state.with(|s| load_history(s.db.as_ref().unwrap())).is_empty());
    }

    #[test]
    fn writing_the_same_transfer_twice_updates_it_rather_than_failing() {
        let state = state_with_table();
        remember(&state, &transfer("a", "failed"));
        remember(&state, &transfer("a", "done"));

        let loaded = state.with(|s| load_history(s.db.as_ref().unwrap()));
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].state, "done");
    }
}

#[cfg(test)]
mod sync_control_tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// A server that honours \`Range: bytes=N-\` and sends in small slices, so a
    /// pause can land in the middle of the body.
    async fn range_server(body: Vec<u8>) -> u16 {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let body = body.clone();
                tokio::spawn(async move {
                    let mut buf = vec![0u8; 4096];
                    let n = socket.read(&mut buf).await.unwrap_or(0);
                    let request = String::from_utf8_lossy(&buf[..n]).to_string();
                    let from = request
                        .lines()
                        .find_map(|l| l.strip_prefix("Range: bytes="))
                        .and_then(|r| r.split('-').next()?.trim().parse::<usize>().ok())
                        .unwrap_or(0);
                    let (status, slice) = if from > 0 {
                        ("206 Partial Content", &body[from..])
                    } else {
                        ("200 OK", &body[..])
                    };
                    let head = format!("HTTP/1.0 {status}\r\nContent-Length: {}\r\n\r\n", slice.len());
                    let _ = socket.write_all(head.as_bytes()).await;
                    for chunk in slice.chunks(32 * 1024) {
                        if socket.write_all(chunk).await.is_err() {
                            break;
                        }
                        tokio::time::sleep(Duration::from_millis(4)).await;
                    }
                });
            }
        });
        port
    }

    fn row(id: &str, size: u64) -> Transfer {
        Transfer {
            id: id.into(),
            name: "film.mkv".into(),
            size,
            sent: 0,
            peer_id: String::new(),
            direction: "in".into(),
            state: "active".into(),
            speed_bps: 0,
            started_at: 0,
            finished_at: None,
            mime: "video/x-matroska".into(),
            local_path: None,
            expires_at: None,
            bundle_id: None,
            url: None,
            via_chat: false,
        }
    }

    fn set(state: &AppState, id: &str, to: &str) {
        state.with(|s| {
            if let Some(t) = s.transfers.iter_mut().find(|t| t.id == id) {
                t.state = to.into();
            }
        });
    }

    /// The point of pausing: what had arrived is kept and the rest is asked for
    /// from the next byte, and the two halves are the film.
    #[tokio::test]
    async fn a_paused_download_continues_from_the_byte_it_reached() {
        let body: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        let port = range_server(body.clone()).await;
        let url = format!("http://127.0.0.1:{port}/film.mkv");
        let dir = std::env::temp_dir().join(format!("lantern-pause-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let part = dir.join("film.mkv.part");

        let state = AppState::new();
        state.with(|s| s.transfers.push(row("t1", body.len() as u64)));

        // Pause shortly after it starts.
        let pauser = {
            let state = state.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(60)).await;
                set(&state, "t1", "paused");
            })
        };
        let first = stream_to_file(&|| {}, &state, "t1", &url, &part, 0, body.len() as u64, None).await;
        pauser.await.unwrap();
        assert!(first.is_err(), "a pause stops the download");
        let kept = std::fs::metadata(&part).unwrap().len();
        assert!(kept > 0 && (kept as usize) < body.len(), "it paused part-way: {kept} bytes");

        // Resumed: from where it was.
        set(&state, "t1", "active");
        let total = stream_to_file(&|| {}, &state, "t1", &url, &part, kept, body.len() as u64, None)
            .await
            .expect("the rest arrives");
        assert_eq!(total as usize, body.len());
        assert_eq!(std::fs::read(&part).unwrap(), body, "the two parts make the film, byte for byte");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn a_cancelled_download_stops_and_is_not_reported_as_a_failure_to_resume() {
        let body: Vec<u8> = vec![7; 2_000_000];
        let port = range_server(body.clone()).await;
        let url = format!("http://127.0.0.1:{port}/x");
        let dir = std::env::temp_dir().join(format!("lantern-cancel-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let part = dir.join("x.part");
        let state = AppState::new();
        state.with(|s| s.transfers.push(row("t2", body.len() as u64)));

        let canceller = {
            let state = state.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                set(&state, "t2", "cancelled");
            })
        };
        let result = stream_to_file(&|| {}, &state, "t2", &url, &part, 0, body.len() as u64, None).await;
        canceller.await.unwrap();
        assert!(result.is_err());
        // The state the caller reads to decide what to clean up.
        let now = state.with(|s| s.transfers[0].state.clone());
        assert_eq!(now, "cancelled");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_copy_arrives_under_a_name_no_rescan_lists() {
        let target = Path::new("/synced/Shows/Loki/S01E01.mkv");
        let part = part_path(target);
        assert_eq!(part, Path::new("/synced/Shows/Loki/S01E01.mkv.part"));
        assert_ne!(part.extension().and_then(|e| e.to_str()), Some("mkv"));
    }

    #[test]
    fn half_films_left_by_a_closed_app_are_swept_and_whole_ones_are_not() {
        let dir = std::env::temp_dir().join(format!("lantern-sweep-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(dir.join("Shows")).unwrap();
        std::fs::write(dir.join("Shows/a.mkv.part"), b"half").unwrap();
        std::fs::write(dir.join("Shows/b.mkv"), b"whole").unwrap();
        std::fs::write(dir.join("c.mkv.part"), b"half").unwrap();
        sweep_stale_parts(&dir);
        assert!(!dir.join("Shows/a.mkv.part").exists());
        assert!(!dir.join("c.mkv.part").exists());
        assert!(dir.join("Shows/b.mkv").exists(), "a finished copy must survive the sweep");
        let _ = std::fs::remove_dir_all(dir);
    }
}
