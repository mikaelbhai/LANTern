//! Static HTTP server for published folders.
//!
//! One server owns the host port and dispatches on the first path segment,
//! which is the share's slug. That keeps mounting and unmounting a share a
//! pure state change — no listener churn.

use std::collections::HashMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;

use crate::model::{now_ms, ShareMode};
use crate::state::AppState;

pub fn router(state: AppState) -> Router {
    Router::new()
        .route("/", get(index))
        // Registered before the slug routes so a share can never be named
        // "transfer" and shadow a file someone is receiving.
        .route("/transfer/:token", get(serve_transfer))
        // What a peer reads to discover what this device publishes.
        .route("/shares.json", get(shares_json))
        // A peer's profile picture, fetched like any other file this device
        // publishes rather than pushed down the signalling link.
        .route("/avatar.png", get(serve_avatar))
        .route("/:slug", get(serve_root))
        .route("/:slug/*path", get(serve_path))
        .with_state(Arc::new(state))
}

/// This device's profile picture, if one is set.
async fn serve_avatar(State(state): State<Arc<AppState>>) -> Response {
    match state.with(|s| s.avatar.clone()) {
        Some(bytes) => (
            [
                (header::CONTENT_TYPE, HeaderValue::from_static("image/png")),
                (header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*")),
                // Small and rarely changed, but it does change; a short cache
                // keeps a peer list from refetching it on every render.
                (header::CACHE_CONTROL, HeaderValue::from_static("max-age=60")),
            ],
            bytes,
        )
            .into_response(),
        None => (StatusCode::NOT_FOUND, "No picture set").into_response(),
    }
}

/// Lists what this device is publishing, for a peer's Theatre to enumerate.
///
/// Only running shares, and only the fields a peer needs: enough to fetch a
/// media manifest, nothing about where the files live on disk.
async fn shares_json(State(state): State<Arc<AppState>>) -> Response {
    let shares = state.with(|s| {
        s.shares
            .iter()
            .filter(|sh| sh.running)
            .map(|sh| {
                serde_json::json!({
                    "slug": sh.slug,
                    "name": sh.name,
                    "mode": match sh.mode {
                        ShareMode::Files => "files",
                        ShareMode::Site => "site",
                        ShareMode::App => "app",
                        ShareMode::Media => "media",
                    },
                })
            })
            .collect::<Vec<_>>()
    });

    (
        [(header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8"))],
        serde_json::to_string(&shares).unwrap_or_else(|_| "[]".into()),
    )
        .into_response()
}

/// Serves one file offered directly to a peer.
///
/// Deliberately not part of any share: the token is the only thing that grants
/// access, it names exactly one file, and it disappears when the transfer ends.
async fn serve_transfer(
    State(state): State<Arc<AppState>>,
    AxumPath(token): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    let offered = state.with(|s| s.offers.get(&token));
    let Some(offered) = offered else {
        return (StatusCode::NOT_FOUND, "No such transfer").into_response();
    };
    if !offered.path.is_file() {
        return (StatusCode::GONE, "File is no longer available").into_response();
    }
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());
    send_file(&state, "", &offered.path, range.as_deref()).await
}

/// Landing page listing everything currently published.
async fn index(State(state): State<Arc<AppState>>) -> Response {
    let shares = state.with(|s| {
        s.shares
            .iter()
            .filter(|sh| sh.running)
            .map(|sh| (sh.slug.clone(), sh.name.clone()))
            .collect::<Vec<_>>()
    });

    let mut body = String::from(
        "<!doctype html><meta charset=utf-8><title>LANTern</title>\
         <style>body{background:#0C0F14;color:#E6EAF3;font:14px system-ui;padding:40px}\
         a{color:#F5A623}h1{font-size:20px}li{margin:6px 0}</style><h1>LANTern</h1>",
    );
    if shares.is_empty() {
        body.push_str("<p>Nothing is published right now.</p>");
    } else {
        body.push_str("<ul>");
        for (slug, name) in shares {
            body.push_str(&format!(
                "<li><a href=\"/{0}/\">{1}</a></li>",
                escape(&slug),
                escape(&name)
            ));
        }
        body.push_str("</ul>");
    }
    html(body)
}

async fn serve_root(
    State(state): State<Arc<AppState>>,
    AxumPath(slug): AxumPath<String>,
    headers: HeaderMap,
) -> Response {
    respond(state, slug, String::new(), &headers).await
}

async fn serve_path(
    State(state): State<Arc<AppState>>,
    AxumPath((slug, path)): AxumPath<(String, String)>,
    Query(params): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> Response {
    // `?subtitle=N` asks for one of the file's own subtitle tracks, converted
    // to WebVTT. The same URL without it streams the video, which keeps the
    // manifest simple: one address per file, and the track is a parameter.
    if let Some(track) = params.get("subtitle").and_then(|n| n.parse::<u64>().ok()) {
        return serve_embedded_subtitle(&state, &slug, &path, track).await;
    }
    // `?audio=N` streams the file with one chosen audio track, remuxed on the
    // fly. The webview cannot switch tracks itself, so the switch happens
    // before the bytes leave this machine.
    // `?thumb=1` returns a still frame. Generating it here, once, is what
    // stops every client decoding the video itself just to draw a card.
    if params.contains_key("thumb") {
        return serve_thumbnail(&state, &slug, &path).await;
    }
    if let Some(index) = params.get("audio").and_then(|n| n.parse::<u64>().ok()) {
        let seek = params
            .get("t")
            .and_then(|t| t.parse::<f64>().ok())
            .unwrap_or(0.0);
        let codec = params.get("codec").cloned().unwrap_or_default();
        return serve_audio_selection(&state, &slug, &path, index, &codec, seek).await;
    }
    respond(state, slug, path, &headers).await
}

/// Spawns ffmpeg without letting Windows open a console for it.
///
/// A GUI app has no console, so Windows creates one for any child process that
/// wants a terminal — which is why generating a thumbnail flashed a black
/// window over whatever the user was doing. CREATE_NO_WINDOW suppresses it.
fn ffmpeg_command(program: &Path) -> tokio::process::Command {
    // Nothing is mutated off Windows, where there is no console to suppress.
    #[allow(unused_mut)]
    let mut cmd = tokio::process::Command::new(program);
    #[cfg(windows)]
    {
        // tokio's Command carries this method itself, so unlike the
        // std::process call in audiotrack.rs no trait import is needed.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd
}

/// A still frame from a video, generated once and cached on disk.
///
/// The alternative was the browser doing it: loading each title into a hidden
/// video element and drawing a frame to a canvas. That works, but it means
/// every client decodes every title in the library — on a 4K HEVC file that is
/// real GPU load, repeated on every device and after every restart. Doing it
/// once on the machine that holds the file costs a fraction as much and the
/// result is shared.
async fn serve_thumbnail(state: &AppState, slug: &str, rel: &str) -> Response {
    let Some((root, _, running)) = state.with(|s| {
        s.shares
            .iter()
            .find(|sh| sh.slug == slug)
            .map(|sh| (PathBuf::from(&sh.path), sh.mode, sh.running))
    }) else {
        return not_found("No such share");
    };
    if !running {
        return not_found("No such share");
    }
    let Some(target) = resolve(&root, rel) else {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    };

    // Cached beside the app's data, keyed by path so two files with the same
    // name in different folders do not collide.
    let key = {
        use std::hash::{Hash, Hasher};
        let mut h = std::collections::hash_map::DefaultHasher::new();
        target.to_string_lossy().hash(&mut h);
        format!("{:016x}.jpg", h.finish())
    };
    let cache_dir = state.with(|s| s.thumb_dir.clone());
    let cached = cache_dir.as_ref().map(|d| d.join(&key));

    if let Some(path) = cached.as_ref() {
        if let Ok(bytes) = tokio::fs::read(path).await {
            return jpeg(bytes);
        }
    }

    let Some(ffmpeg) = crate::audiotrack::ffmpeg_path() else {
        return (StatusCode::NOT_IMPLEMENTED, "No thumbnailer on this device").into_response();
    };

    // A tenth of the way in, bounded: far enough past the idents to be the
    // film, not so far that a short clip runs out.
    let at = 120.0;
    let args = crate::audiotrack::thumbnail_arguments(&target.to_string_lossy(), at);

    let output = ffmpeg_command(ffmpeg)
        .args(&args)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .output()
        .await;

    match output {
        Ok(out) if out.status.success() && !out.stdout.is_empty() => {
            if let (Some(dir), Some(path)) = (cache_dir.as_ref(), cached.as_ref()) {
                let _ = tokio::fs::create_dir_all(dir).await;
                let _ = tokio::fs::write(path, &out.stdout).await;
            }
            jpeg(out.stdout)
        }
        _ => (StatusCode::NOT_FOUND, "Could not read a frame").into_response(),
    }
}

fn jpeg(bytes: Vec<u8>) -> Response {
    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static("image/jpeg")),
            (header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*")),
            // Generated from a file that rarely changes; a long cache keeps a
            // scrolling library from asking again.
            (header::CACHE_CONTROL, HeaderValue::from_static("max-age=86400")),
        ],
        bytes,
    )
        .into_response()
}

/// Streams the file with one audio track selected.
///
/// The video is copied, so this costs about what serving the file costs; only
/// the audio is re-encoded, and only when the browser could not decode it.
/// The output is fragmented MP4 so playback starts immediately rather than
/// after the whole film has been processed.
///
/// Range requests are deliberately not supported here: the output is generated
/// on demand and has no length until it ends. Seeking is done by restarting
/// the stream at an offset, which is what `?t=` is for.
async fn serve_audio_selection(
    state: &AppState,
    slug: &str,
    rel: &str,
    index: u64,
    codec: &str,
    seek_sec: f64,
) -> Response {
    let Some(ffmpeg) = crate::audiotrack::ffmpeg_path() else {
        return (
            StatusCode::NOT_IMPLEMENTED,
            "Switching audio tracks needs ffmpeg on this device. LANTern works without it; \
             only this one feature depends on it.",
        )
            .into_response();
    };

    let Some((root, _, running)) = state.with(|s| {
        s.shares
            .iter()
            .find(|sh| sh.slug == slug)
            .map(|sh| (PathBuf::from(&sh.path), sh.mode, sh.running))
    }) else {
        return not_found("No such share");
    };
    if !running {
        return not_found("No such share");
    }
    let Some(target) = resolve(&root, rel) else {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    };

    let args = crate::audiotrack::arguments(
        &target.to_string_lossy(),
        index,
        codec,
        seek_sec,
    );

    let mut child = match ffmpeg_command(ffmpeg)
        .args(&args)
        .stdout(std::process::Stdio::piped())
        // ffmpeg writes its progress to stderr; nothing reads it, and leaving
        // it inherited would spray the console during playback.
        .stderr(std::process::Stdio::null())
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("could not start ffmpeg: {e}"),
            )
                .into_response()
        }
    };

    let Some(stdout) = child.stdout.take() else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "no output from ffmpeg").into_response();
    };

    // Hold the child alongside the stream: dropping the response kills the
    // process, so closing the player or picking another track does not leave
    // a transcode running against a 20 GB file.
    tokio::spawn(async move {
        let _ = child.wait().await;
    });

    let stream = tokio_util::io::ReaderStream::with_capacity(stdout, 256 * 1024);

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, HeaderValue::from_static("video/mp4"))
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"))
        // Generated per request; caching it would serve one viewer's chosen
        // language to the next.
        .header(header::CACHE_CONTROL, HeaderValue::from_static("no-store"))
        .body(Body::from_stream(stream))
        .unwrap()
}

/// Extracts one subtitle track out of a Matroska file and returns it as VTT.
///
/// This walks the whole file, so it is deliberately not part of a library
/// scan — it happens when a viewer picks the track, once, and the browser
/// caches the result for the rest of the session.
async fn serve_embedded_subtitle(
    state: &AppState,
    slug: &str,
    rel: &str,
    track: u64,
) -> Response {
    let Some((root, _, running)) = state.with(|s| {
        s.shares
            .iter()
            .find(|sh| sh.slug == slug)
            .map(|sh| (PathBuf::from(&sh.path), sh.mode, sh.running))
    }) else {
        return not_found("No such share");
    };
    if !running {
        return not_found("No such share");
    }
    let Some(target) = resolve(&root, rel) else {
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    };

    // Reading a multi-gigabyte container blocks; keep it off the async pool.
    let extracted = tokio::task::spawn_blocking(move || {
        if crate::ebml::is_matroska(&target) {
            crate::ebml::extract_subtitles(&target, track)
        } else {
            crate::mp4::extract_subtitles(&target, track)
        }
    })
    .await;

    match extracted {
        Ok(Ok(vtt)) => (
            [
                (
                    header::CONTENT_TYPE,
                    HeaderValue::from_static("text/vtt; charset=utf-8"),
                ),
                (
                    header::ACCESS_CONTROL_ALLOW_ORIGIN,
                    HeaderValue::from_static("*"),
                ),
            ],
            vtt,
        )
            .into_response(),
        Ok(Err(e)) => (StatusCode::UNPROCESSABLE_ENTITY, e.to_string()).into_response(),
        Err(_) => (StatusCode::INTERNAL_SERVER_ERROR, "extraction failed").into_response(),
    }
}

async fn respond(
    state: Arc<AppState>,
    slug: String,
    rel: String,
    headers: &HeaderMap,
) -> Response {
    let range = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(str::to_owned);

    let Some((root, mode, allow_upload)) = state.with(|s| {
        s.shares
            .iter()
            .find(|sh| sh.slug == slug && sh.running)
            .map(|sh| (PathBuf::from(&sh.path), sh.mode, sh.allow_upload))
    }) else {
        return not_found("No such share");
    };
    let _ = allow_upload;

    // A media share advertises its contents as JSON so a peer's Theatre can
    // enumerate titles without scraping an HTML listing.
    if mode == ShareMode::Media && rel == "index.json" {
        return media_manifest(&state, &slug, &root).await;
    }

    // SubRip is the format everyone has and no browser will load. Converting
    // on the way out means a `<track>` can point straight at the .srt.
    if rel.to_ascii_lowercase().ends_with(".srt") {
        if let Some(target) = resolve(&root, &rel) {
            if let Ok(text) = tokio::fs::read_to_string(&target).await {
                return (
                    [
                        (
                            header::CONTENT_TYPE,
                            HeaderValue::from_static("text/vtt; charset=utf-8"),
                        ),
                        (
                            header::ACCESS_CONTROL_ALLOW_ORIGIN,
                            HeaderValue::from_static("*"),
                        ),
                    ],
                    crate::sidecar::srt_to_vtt(&text),
                )
                    .into_response();
            }
        }
    }

    let Some(target) = resolve(&root, &rel) else {
        // A path that escapes the share root is a traversal attempt, not a miss.
        return (StatusCode::FORBIDDEN, "Forbidden").into_response();
    };

    let meta = tokio::fs::metadata(&target).await.ok();
    let is_dir = meta.as_ref().map(|m| m.is_dir()).unwrap_or(false);

    let file = if is_dir {
        let index = target.join("index.html");
        if tokio::fs::try_exists(&index).await.unwrap_or(false) {
            Some(index)
        } else if mode == ShareMode::Files {
            return listing(&root, &target, &slug).await;
        } else {
            None
        }
    } else if meta.is_some() {
        Some(target.clone())
    } else {
        None
    };

    let file = match file {
        Some(f) => f,
        None => {
            // A single-page app owns its own routing, so unknown paths get the
            // shell rather than a 404.
            if mode == ShareMode::App {
                let shell = root.join("index.html");
                if tokio::fs::try_exists(&shell).await.unwrap_or(false) {
                    shell
                } else {
                    return not_found("Not found");
                }
            } else {
                return not_found("Not found");
            }
        }
    };

    send_file(&state, &slug, &file, range.as_deref()).await
}

/// Streams a file, honouring a byte range when one is asked for.
///
/// Range support is what makes video usable: without it a browser has to pull
/// the whole file before it can seek, which is hopeless for a multi-gigabyte
/// film. The body is streamed from disk rather than buffered, so serving a
/// large file costs a constant amount of memory.
async fn send_file(state: &AppState, slug: &str, file: &Path, range: Option<&str>) -> Response {
    let Ok(handle) = tokio::fs::File::open(file).await else {
        return not_found("Not found");
    };
    let Ok(meta) = handle.metadata().await else {
        return not_found("Not found");
    };
    let total = meta.len();
    let mime = mime_for(file);

    let (start, end) = match range.and_then(|r| parse_range(r, total)) {
        Some(pair) => pair,
        None if range.is_some() => {
            // A syntactically valid but unsatisfiable range must say so.
            return Response::builder()
                .status(StatusCode::RANGE_NOT_SATISFIABLE)
                .header(header::CONTENT_RANGE, format!("bytes */{total}"))
                .body(Body::empty())
                .unwrap();
        }
        None => (0, total.saturating_sub(1)),
    };

    let partial = range.is_some();
    let length = end.saturating_sub(start) + 1;

    let mut handle = handle;
    if start > 0 {
        use tokio::io::AsyncSeekExt;
        if handle.seek(std::io::SeekFrom::Start(start)).await.is_err() {
            return not_found("Not found");
        }
    }

    // 512 KB chunks rather than the default 8 KB. On a LAN the socket drains
    // far faster than 8 KB at a time can refill it, so the transfer spends
    // most of its life waiting on syscalls instead of the network. Large
    // enough to keep the send buffer full, small enough that one file cannot
    // monopolise memory when several peers stream at once.
    let stream = tokio_util::io::ReaderStream::with_capacity(
        tokio::io::AsyncReadExt::take(handle, length),
        512 * 1024,
    );
    record_hit(state, slug, length);

    let mut builder = Response::builder()
        .status(if partial {
            StatusCode::PARTIAL_CONTENT
        } else {
            StatusCode::OK
        })
        .header(header::CONTENT_TYPE, HeaderValue::from_str(mime).unwrap())
        .header(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"))
        // The webview's origin is tauri://localhost, so every fetch of a peer's
        // file is cross-origin. Without this a `<track>` will not load at all
        // and a canvas cannot read a frame for a thumbnail. The server only
        // ever listens on the LAN and only serves what has been published, so
        // the permissive value is the accurate one rather than a shortcut.
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"))
        .header(header::CONTENT_LENGTH, length);

    if partial {
        builder = builder.header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{total}"),
        );
    }

    builder.body(Body::from_stream(stream)).unwrap()
}

/// Parses a single-range `bytes=` header. Multi-range requests are declined by
/// returning the whole file, which is a legal response.
fn parse_range(header: &str, total: u64) -> Option<(u64, u64)> {
    let spec = header.strip_prefix("bytes=")?.trim();
    if spec.contains(',') || total == 0 {
        return None;
    }
    let (from, to) = spec.split_once('-')?;

    let (start, end) = if from.is_empty() {
        // "-500" means the final 500 bytes.
        let n: u64 = to.parse().ok()?;
        if n == 0 {
            return None;
        }
        (total.saturating_sub(n), total - 1)
    } else {
        let start: u64 = from.parse().ok()?;
        let end = if to.is_empty() {
            total - 1
        } else {
            to.parse::<u64>().ok()?.min(total - 1)
        };
        (start, end)
    };

    (start <= end && start < total).then_some((start, end))
}


/// Walks a media share and returns every video file it holds.
///
/// Recursion is bounded so a share pointed at a deep or looping tree cannot
/// stall the request.
async fn media_manifest(state: &AppState, slug: &str, root: &Path) -> Response {
    let (share_id, ip, host_port) = state.with(|s| {
        (
            s.shares
                .iter()
                .find(|sh| sh.slug == slug)
                .map(|sh| sh.id.clone())
                .unwrap_or_default(),
            s.net.ip.clone(),
            s.net.host_port,
        )
    });

    // Exactly what this device's own Theatre shows for the same share. Walking
    // the folder a second time here is how the two views drifted apart.
    let root = root.to_path_buf();
    let slug_captured = slug.to_string();
    let items = tokio::task::spawn_blocking(move || {
        crate::media::items_for_share(&share_id, &slug_captured, &root, &ip, host_port)
    })
    .await
    .unwrap_or_default();

    (
        [
            (header::CONTENT_TYPE, HeaderValue::from_static("application/json; charset=utf-8")),
            (header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*")),
        ],
        // A bare array. It was wrapped in {"items": [...]}, which the peer-side
        // reader could not parse, so a peer's library came back empty.
        serde_json::to_string(&items).unwrap_or_else(|_| "[]".into()),
    )
        .into_response()
}

fn record_hit(state: &AppState, slug: &str, bytes: u64) {
    state.with(|s| {
        if let Some(sh) = s.shares.iter_mut().find(|sh| sh.slug == slug) {
            sh.requests += 1;
            sh.bytes_served += bytes;
            sh.last_request_at = Some(now_ms());
        }
    });
}

/// Joins `rel` onto `root`, refusing anything that leaves the share.
///
/// Rejecting `..` and absolute components before touching the filesystem means
/// a traversal never even gets a chance to resolve; the final `starts_with`
/// check then also catches symlinks pointing outside the share.
fn resolve(root: &Path, rel: &str) -> Option<PathBuf> {
    let mut out = root.to_path_buf();
    for part in rel.split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        let candidate = Path::new(part);
        for comp in candidate.components() {
            match comp {
                Component::Normal(seg) => out.push(seg),
                // Anything else is either a traversal or an absolute path.
                _ => return None,
            }
        }
    }

    match (out.canonicalize(), root.canonicalize()) {
        (Ok(full), Ok(base)) if full.starts_with(&base) => Some(full),
        // A path that does not exist yet is still safe to report as a miss, so
        // long as its lexical form stayed inside the root.
        (Err(_), Ok(_)) => Some(out),
        _ => None,
    }
}

async fn listing(root: &Path, dir: &Path, slug: &str) -> Response {
    let rel = dir.strip_prefix(root).unwrap_or(Path::new(""));
    let rel_str = rel.to_string_lossy().replace('\\', "/");

    let mut entries: Vec<(String, bool, u64)> = Vec::new();
    if let Ok(mut rd) = tokio::fs::read_dir(dir).await {
        while let Ok(Some(entry)) = rd.next_entry().await {
            let name = entry.file_name().to_string_lossy().to_string();
            let (is_dir, size) = match entry.metadata().await {
                Ok(m) => (m.is_dir(), m.len()),
                Err(_) => (false, 0),
            };
            entries.push((name, is_dir, size));
        }
    }
    entries.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.to_lowercase().cmp(&b.0.to_lowercase())));

    let base = if rel_str.is_empty() {
        format!("/{}", slug)
    } else {
        format!("/{}/{}", slug, rel_str)
    };

    let mut body = format!(
        "<!doctype html><meta charset=utf-8><title>{0}</title>\
         <style>body{{background:#0C0F14;color:#E6EAF3;font:14px system-ui;padding:32px}}\
         a{{color:#F5A623;text-decoration:none}}a:hover{{text-decoration:underline}}\
         h1{{font-size:16px;color:#8C97AE;font-weight:500}}\
         table{{border-collapse:collapse;margin-top:16px;width:100%;max-width:720px}}\
         td{{padding:6px 12px 6px 0;border-bottom:1px solid #252E3F}}\
         .s{{color:#4B566A;text-align:right;font-variant-numeric:tabular-nums}}</style>\
         <h1>{0}</h1><table>",
        escape(&base)
    );

    if !rel_str.is_empty() {
        let parent = base.rsplit_once('/').map(|(p, _)| p).unwrap_or("");
        body.push_str(&format!(
            "<tr><td><a href=\"{}/\">../</a></td><td class=s></td></tr>",
            escape(parent)
        ));
    }
    for (name, is_dir, size) in entries {
        body.push_str(&format!(
            "<tr><td><a href=\"{}/{}\">{}{}</a></td><td class=s>{}</td></tr>",
            escape(&base),
            escape(&name),
            escape(&name),
            if is_dir { "/" } else { "" },
            if is_dir { String::new() } else { human(size) }
        ));
    }
    body.push_str("</table>");
    html(body)
}

fn human(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 {
        format!("{} {}", n, UNITS[0])
    } else {
        format!("{:.1} {}", v, UNITS[i])
    }
}

fn escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn html(body: String) -> Response {
    Response::builder()
        .status(StatusCode::OK)
        .header(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/html; charset=utf-8"),
        )
        .body(Body::from(body))
        .unwrap()
}

fn not_found(msg: &'static str) -> Response {
    (StatusCode::NOT_FOUND, msg).into_response()
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain; charset=utf-8",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

/// Binds the host port and serves until the process exits.
pub async fn serve(state: AppState, port: u16) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    axum::serve(listener, router(state)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{now_ms, Share};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    /// Serves a temp directory and returns the address it is reachable on.
    async fn serve_fixture(mode: ShareMode) -> (std::net::SocketAddr, std::path::PathBuf) {
        let root = std::env::temp_dir().join(format!("lantern-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("nested")).unwrap();
        std::fs::write(root.join("hello.txt"), b"0123456789").unwrap();
        std::fs::write(root.join("index.html"), b"<h1>home</h1>").unwrap();
        std::fs::write(root.join("nested/deep.txt"), b"nested body").unwrap();
        // A file the share must never expose, one level above its root.
        std::fs::write(root.parent().unwrap().join("secret.txt"), b"do not serve").unwrap();

        let state = AppState::new();
        state.with(|s| {
            s.shares.push(Share {
                id: "t".into(),
                name: "Test".into(),
                path: root.to_string_lossy().to_string(),
                slug: "test".into(),
                mode,
                running: true,
                require_phrase: false,
                phrase: None,
                allow_upload: false,
                file_count: 3,
                total_bytes: 34,
                created_at: now_ms(),
                requests: 0,
                bytes_served: 0,
                active_viewers: 0,
                last_request_at: None,
            })
        });

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            let _ = axum::serve(listener, router(state)).await;
        });
        (addr, root)
    }

    async fn get(addr: std::net::SocketAddr, path: &str, extra: &str) -> String {
        let mut stream = tokio::net::TcpStream::connect(addr).await.unwrap();
        let request =
            format!("GET {path} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n{extra}\r\n");
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut out = Vec::new();
        stream.read_to_end(&mut out).await.unwrap();
        String::from_utf8_lossy(&out).into_owned()
    }

    #[tokio::test]
    async fn serves_a_file_from_a_shared_folder() {
        let (addr, _root) = serve_fixture(ShareMode::Files).await;
        let response = get(addr, "/test/hello.txt", "").await;
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.contains("0123456789"), "{response}");
    }

    #[tokio::test]
    async fn lists_a_directory() {
        let (addr, _root) = serve_fixture(ShareMode::Files).await;
        let response = get(addr, "/test/nested", "").await;
        assert!(response.contains("deep.txt"), "{response}");
    }

    #[tokio::test]
    async fn honours_a_byte_range() {
        let (addr, _root) = serve_fixture(ShareMode::Files).await;
        let response = get(addr, "/test/hello.txt", "Range: bytes=2-5\r\n").await;
        assert!(response.starts_with("HTTP/1.1 206"), "{response}");
        // Header names arrive lowercased from hyper, so compare case-insensitively.
        let lower = response.to_ascii_lowercase();
        assert!(lower.contains("content-range: bytes 2-5/10"), "{response}");
        assert!(lower.contains("content-length: 4"), "{response}");
        // Body is exactly the requested slice, not the whole file.
        assert!(response.ends_with("2345"), "{response}");
    }

    #[tokio::test]
    async fn refuses_to_escape_the_share_root() {
        let (addr, _root) = serve_fixture(ShareMode::Files).await;
        for attempt in [
            "/test/../secret.txt",
            "/test/nested/../../secret.txt",
            "/test/..%2Fsecret.txt",
        ] {
            let response = get(addr, attempt, "").await;
            assert!(
                !response.contains("do not serve"),
                "traversal succeeded for {attempt}: {response}"
            );
        }
    }

    #[tokio::test]
    async fn single_page_app_falls_back_to_the_shell() {
        let (addr, _root) = serve_fixture(ShareMode::App).await;
        let response = get(addr, "/test/some/client/route", "").await;
        assert!(response.starts_with("HTTP/1.1 200"), "{response}");
        assert!(response.contains("<h1>home</h1>"), "{response}");
    }

    #[tokio::test]
    async fn media_shares_publish_a_manifest() {
        let (addr, root) = serve_fixture(ShareMode::Media).await;
        std::fs::write(root.join("clip.mp4"), b"fake video").unwrap();
        let response = get(addr, "/test/index.json", "").await;
        assert!(response.contains("clip.mp4"), "{response}");
    }
}
