//! A read-ahead relay between the player and the device holding the film.
//!
//! A `<video>` pointed straight at a peer buffers about ten seconds ahead and
//! then stops asking, so every hiccup on the wireless link - a neighbour's
//! microwave, a phone that looked away from the router for a second - is a
//! stall, however fast the link is on average. This sits in the middle: the
//! player reads from a loopback address, and behind it a task keeps pulling the
//! file from the peer a long way ahead of where the player is, into memory.
//! The player sees a fast local server; the link's bad second is absorbed by
//! the buffer.
//!
//! It is not a way out of the network and must not become one. It accepts only
//! addresses on a private network (or this machine), listens only on loopback,
//! and the player is the only thing that has the token for a given stream.
//!
//! Two kinds of upstream, told apart once, when a stream is opened:
//! - one that honours `Range` (a published file): cached in 1 MiB chunks, so
//!   seeking back inside what has been read costs nothing, and the prefetcher
//!   restarts at the new position when the player jumps;
//! - one that does not (the audio-track remux, a live fragmented stream): passed
//!   through a bounded buffer, which cannot seek but does decouple the encoder's
//!   stalls from playback.

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{Path, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use futures_util::StreamExt;
use tokio::sync::{mpsc, Notify};

const CHUNK: u64 = 1024 * 1024;
const MAX_SESSIONS: usize = 8;
const IDLE: Duration = Duration::from_secs(300);
/// How long the player waits for one chunk before the stream is given up on.
const CHUNK_PATIENCE: Duration = Duration::from_secs(30);

/// Whether an address is one this relay may reach: this machine, or a network
/// that is not the internet.
pub fn is_local_network(ip: IpAddr) -> bool {
    match ip.to_canonical() {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                // Carrier-grade NAT space, which is what a phone hotspot or a
                // mesh VPN hands out; still not the internet.
                || (v4.octets()[0] == 100 && (64..128).contains(&v4.octets()[1]))
        }
        IpAddr::V6(v6) => {
            v6.is_loopback()
                // fc00::/7 unique-local, fe80::/10 link-local.
                || (v6.segments()[0] & 0xfe00) == 0xfc00
                || (v6.segments()[0] & 0xffc0) == 0xfe80
        }
    }
}

enum Kind {
    Ranged { total: u64 },
    Live,
}

struct Cache {
    chunks: HashMap<u64, Bytes>,
    /// The chunk the player is reading now.
    pos: u64,
    fetching: bool,
}

struct Session {
    upstream: reqwest::Url,
    mime: String,
    kind: Kind,
    /// How many chunks ahead of the player to hold.
    ahead: u64,
    state: Mutex<Cache>,
    changed: Notify,
    touched: Mutex<Instant>,
    closed: AtomicBool,
    client: reqwest::Client,
}

struct Hub {
    port: u16,
    sessions: Mutex<HashMap<String, Arc<Session>>>,
}

static HUB: OnceLock<Arc<Hub>> = OnceLock::new();

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        // The system proxy is for the internet; this is a conversation with a
        // neighbour, and routing it through one would be wrong and slow.
        .no_proxy()
        .connect_timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())
}

/// The relay's own runtime.
///
/// Not whichever one happened to call `open` first: a server started inside a
/// caller's runtime goes away with it, and the player would be left reading from
/// an address nothing answers on. Its own, for the life of the process, also
/// keeps a busy page from starving the buffer that is meant to protect it.
fn runtime() -> &'static tokio::runtime::Runtime {
    static RT: OnceLock<tokio::runtime::Runtime> = OnceLock::new();
    RT.get_or_init(|| {
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("lantern-readahead")
            .build()
            .expect("the relay's runtime could not start")
    })
}

async fn hub() -> Result<Arc<Hub>, String> {
    if let Some(h) = HUB.get() {
        return Ok(h.clone());
    }
    // Bound inside the relay's runtime, since a listener belongs to the reactor
    // of the one it was made in.
    runtime()
        .spawn(async {
            let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
                .await
                .map_err(|e| e.to_string())?;
            let port = listener.local_addr().map_err(|e| e.to_string())?.port();
            let fresh = Arc::new(Hub { port, sessions: Mutex::new(HashMap::new()) });
            if HUB.set(fresh.clone()).is_err() {
                // Somebody else got there first; use theirs, drop this listener.
                return HUB.get().cloned().ok_or_else(|| "relay unavailable".to_string());
            }
            let app = axum::Router::new()
                .route("/ra/:token", axum::routing::get(serve))
                .with_state(fresh.clone());
            tokio::spawn(async move {
                let _ = axum::serve(listener, app).await;
            });
            Ok(fresh)
        })
        .await
        .map_err(|e| e.to_string())?
}

/// Starts relaying one stream, and returns the address the player should use.
pub async fn open(url: &str, budget_mb: u32) -> Result<String, String> {
    let upstream = reqwest::Url::parse(url).map_err(|e| e.to_string())?;
    if upstream.scheme() != "http" {
        return Err("only plain http streams from this network are relayed".into());
    }
    // An address, never a name: a name is whatever a resolver says it is, and a
    // resolver may say a public one. Peers are found by address anyway.
    let allowed = upstream
        .host_str()
        .map(|h| h.trim_matches(['[', ']']))
        .and_then(|h| h.parse::<IpAddr>().ok())
        .is_some_and(is_local_network);
    if !allowed {
        return Err("that address is not on a local network".into());
    }

    let client = client()?;
    // The remux is a live stream with no Range; asking it for one byte would
    // start an encode just to throw it away.
    let remux = upstream.query_pairs().any(|(k, _)| k == "audio");
    let (kind, mime) = if remux {
        (Kind::Live, String::from("video/mp4"))
    } else {
        let probe = client
            .get(upstream.clone())
            .header(header::RANGE, "bytes=0-0")
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let mime = probe
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("application/octet-stream")
            .to_string();
        let total = (probe.status() == StatusCode::PARTIAL_CONTENT)
            .then(|| {
                probe
                    .headers()
                    .get(header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|v| v.rsplit('/').next())
                    .and_then(|t| t.parse::<u64>().ok())
            })
            .flatten();
        match total {
            Some(total) if total > 0 => (Kind::Ranged { total }, mime),
            _ => {
                if !probe.status().is_success() {
                    return Err(format!("the other device answered {}", probe.status()));
                }
                (Kind::Live, mime)
            }
        }
    };

    let session = Arc::new(Session {
        upstream,
        mime,
        kind,
        ahead: (u64::from(budget_mb.clamp(8, 1024)) * 1024 * 1024 / CHUNK).max(4),
        state: Mutex::new(Cache { chunks: HashMap::new(), pos: 0, fetching: false }),
        changed: Notify::new(),
        touched: Mutex::new(Instant::now()),
        closed: AtomicBool::new(false),
        client,
    });

    let hub = hub().await?;
    let token = uuid::Uuid::new_v4().simple().to_string();
    {
        let mut all = hub.sessions.lock().expect("relay poisoned");
        // Old ones first: a film that was left, and its remux restarts.
        all.retain(|_, s| {
            let stale = s.touched.lock().expect("relay poisoned").elapsed() > IDLE;
            if stale {
                s.closed.store(true, Ordering::Relaxed);
            }
            !stale
        });
        while all.len() >= MAX_SESSIONS {
            let oldest = all
                .iter()
                .min_by_key(|(_, s)| *s.touched.lock().expect("relay poisoned"))
                .map(|(k, _)| k.clone());
            match oldest.and_then(|k| all.remove(&k)) {
                Some(s) => s.closed.store(true, Ordering::Relaxed),
                None => break,
            }
        }
        all.insert(token.clone(), session);
    }
    Ok(format!("http://127.0.0.1:{}/ra/{token}", hub.port))
}

/// How many chunks of a stream are held, for the tests.
#[cfg(test)]
fn held(address: &str) -> usize {
    let token = address.rsplit('/').next().unwrap_or_default();
    HUB.get()
        .and_then(|h| h.sessions.lock().unwrap().get(token).cloned())
        .map(|s| s.state.lock().unwrap().chunks.len())
        .unwrap_or(0)
}

/// Stops relaying a stream the player has finished with.
pub fn close(address: &str) {
    let Some(hub) = HUB.get() else { return };
    let token = address.rsplit('/').next().unwrap_or_default();
    if let Some(s) = hub.sessions.lock().expect("relay poisoned").remove(token) {
        s.closed.store(true, Ordering::Relaxed);
    }
}

/* ------------------------------------------------------------- the cache */

impl Session {
    fn total(&self) -> u64 {
        match self.kind {
            Kind::Ranged { total } => total,
            Kind::Live => 0,
        }
    }

    fn last_chunk(&self) -> u64 {
        (self.total().saturating_sub(1)) / CHUNK
    }

    fn touch(&self) {
        *self.touched.lock().expect("relay poisoned") = Instant::now();
    }

    /// The first chunk, from the player's position on, that is not held yet.
    fn first_missing(&self, cache: &Cache) -> Option<u64> {
        let end = self.last_chunk().min(cache.pos + self.ahead);
        (cache.pos..=end).find(|i| !cache.chunks.contains_key(i))
    }

    fn insert(&self, idx: u64, chunk: Bytes) {
        let mut cache = self.state.lock().expect("relay poisoned");
        cache.chunks.insert(idx, chunk);
        // Keep the window and a little behind it, so a short step back is free.
        let low = cache.pos.saturating_sub(8);
        let high = cache.pos + self.ahead + 8;
        if cache.chunks.len() as u64 > self.ahead + 24 {
            cache.chunks.retain(|i, _| *i >= low && *i <= high);
        }
        drop(cache);
        self.changed.notify_waiters();
    }

    /// One chunk for the player, waiting for the prefetcher if it is not here.
    async fn chunk(self: &Arc<Self>, idx: u64) -> Result<Bytes, String> {
        let deadline = Instant::now() + CHUNK_PATIENCE;
        loop {
            let (found, need_fetcher) = {
                let mut cache = self.state.lock().expect("relay poisoned");
                // Wherever the player reads is where the window should be.
                cache.pos = idx;
                let found = cache.chunks.get(&idx).cloned();
                let need = !cache.fetching;
                if need {
                    cache.fetching = true;
                }
                (found, need)
            };
            if need_fetcher {
                let me = self.clone();
                runtime().spawn(async move { me.prefetch().await });
            }
            self.touch();
            if let Some(chunk) = found {
                // The player moved on, so the prefetcher may have more to do.
                self.changed.notify_waiters();
                return Ok(chunk);
            }
            if self.closed.load(Ordering::Relaxed) {
                return Err("closed".into());
            }
            if Instant::now() > deadline {
                return Err("the other device stopped answering".into());
            }
            self.changed.notify_waiters();
            tokio::select! {
                _ = self.changed.notified() => {}
                _ = tokio::time::sleep(Duration::from_millis(80)) => {}
            }
        }
    }

    /// Keeps pulling the file from the peer, ahead of the player, until the
    /// stream is closed.
    async fn prefetch(self: Arc<Self>) {
        'outer: loop {
            if self.closed.load(Ordering::Relaxed) {
                break;
            }
            let start = {
                let cache = self.state.lock().expect("relay poisoned");
                self.first_missing(&cache)
            };
            let Some(start) = start else {
                // Everything in the window is held: sleep until the player moves.
                tokio::select! {
                    _ = self.changed.notified() => {}
                    _ = tokio::time::sleep(Duration::from_millis(250)) => {}
                }
                if self.touched.lock().expect("relay poisoned").elapsed() > IDLE {
                    break;
                }
                continue;
            };

            let response = self
                .client
                .get(self.upstream.clone())
                .header(header::RANGE, format!("bytes={}-", start * CHUNK))
                .send()
                .await;
            let response = match response {
                Ok(r) if r.status() == StatusCode::PARTIAL_CONTENT => r,
                _ => {
                    // A hiccup, not the end: try again shortly. The player's own
                    // patience decides when it is over.
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                }
            };

            let last = self.last_chunk();
            let total = self.total();
            let mut stream = response.bytes_stream();
            let mut buf: Vec<u8> = Vec::new();
            let mut idx = start;
            while let Some(piece) = stream.next().await {
                let Ok(piece) = piece else { continue 'outer };
                buf.extend_from_slice(&piece);
                loop {
                    let want = (if idx == last { total - idx * CHUNK } else { CHUNK }) as usize;
                    if buf.len() < want || want == 0 {
                        break;
                    }
                    let rest = buf.split_off(want);
                    let chunk = Bytes::from(std::mem::replace(&mut buf, rest));
                    self.insert(idx, chunk);
                    idx += 1;
                }
                if self.closed.load(Ordering::Relaxed) || idx > last {
                    continue 'outer;
                }
                // Stop reading this response when it is no longer where the
                // window needs it: the player jumped, or the window is full.
                let wanted = {
                    let cache = self.state.lock().expect("relay poisoned");
                    self.first_missing(&cache)
                };
                if wanted != Some(idx) {
                    continue 'outer;
                }
            }
        }
        self.state.lock().expect("relay poisoned").fetching = false;
    }
}

/* ------------------------------------------------------------- the server */

fn parse_range(value: &str, total: u64) -> Option<(u64, u64)> {
    let spec = value.strip_prefix("bytes=")?;
    let first = spec.split(',').next()?;
    let (from, to) = first.split_once('-')?;
    let (start, end) = if from.is_empty() {
        let n: u64 = to.parse().ok()?;
        if n == 0 {
            return None;
        }
        (total.saturating_sub(n), total - 1)
    } else {
        let start: u64 = from.parse().ok()?;
        let end = if to.is_empty() { total - 1 } else { to.parse::<u64>().ok()?.min(total - 1) };
        (start, end)
    };
    (start <= end && start < total).then_some((start, end))
}

fn base_headers(mime: &str) -> HeaderMap {
    let mut h = HeaderMap::new();
    if let Ok(v) = HeaderValue::from_str(mime) {
        h.insert(header::CONTENT_TYPE, v);
    }
    // The Web Audio graph that boosts the volume needs the picture to be
    // fetched with CORS, and the page's origin is not this one.
    h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h
}

async fn serve(
    State(hub): State<Arc<Hub>>,
    Path(token): Path<String>,
    headers: HeaderMap,
) -> Response {
    let session = hub.sessions.lock().expect("relay poisoned").get(&token).cloned();
    let Some(session) = session else {
        return (StatusCode::NOT_FOUND, "No such stream").into_response();
    };
    session.touch();

    match session.kind {
        Kind::Live => serve_live(session).await,
        Kind::Ranged { total } => {
            let asked = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
            let (start, end, partial) = match asked {
                None => (0, total - 1, false),
                Some(value) => match parse_range(value, total) {
                    Some((s, e)) => (s, e, true),
                    None => {
                        let mut h = base_headers(&session.mime);
                        if let Ok(v) = HeaderValue::from_str(&format!("bytes */{total}")) {
                            h.insert(header::CONTENT_RANGE, v);
                        }
                        return (StatusCode::RANGE_NOT_SATISFIABLE, h).into_response();
                    }
                },
            };

            let first = start / CHUNK;
            let last = end / CHUNK;
            let me = session.clone();
            let body = Body::from_stream(async_stream::stream! {
                for idx in first..=last {
                    let chunk = match me.chunk(idx).await {
                        Ok(c) => c,
                        Err(e) => {
                            yield Err(std::io::Error::other(e));
                            return;
                        }
                    };
                    let from = if idx == first { (start - idx * CHUNK) as usize } else { 0 };
                    let to = if idx == last { ((end - idx * CHUNK) + 1) as usize } else { chunk.len() };
                    yield Ok::<Bytes, std::io::Error>(chunk.slice(from..to.min(chunk.len())));
                }
            });

            let mut h = base_headers(&session.mime);
            h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("bytes"));
            h.insert(header::CONTENT_LENGTH, HeaderValue::from(end - start + 1));
            let status = if partial {
                if let Ok(v) = HeaderValue::from_str(&format!("bytes {start}-{end}/{total}")) {
                    h.insert(header::CONTENT_RANGE, v);
                }
                StatusCode::PARTIAL_CONTENT
            } else {
                StatusCode::OK
            };
            (status, h, body).into_response()
        }
    }
}

/// A stream that cannot be addressed by offset: copied through a buffer that
/// holds a good deal more than the player would have.
async fn serve_live(session: Arc<Session>) -> Response {
    let response = match session.client.get(session.upstream.clone()).send().await {
        Ok(r) if r.status().is_success() => r,
        Ok(r) => return (StatusCode::BAD_GATEWAY, format!("upstream answered {}", r.status())).into_response(),
        Err(e) => return (StatusCode::BAD_GATEWAY, e.to_string()).into_response(),
    };
    let mime = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or(&session.mime)
        .to_string();

    // Network reads are tens of kilobytes, not a chunk, so the channel is
    // sized in those.
    let (tx, mut rx) = mpsc::channel::<Result<Bytes, std::io::Error>>((session.ahead * 24) as usize);
    let watched = session.clone();
    tokio::spawn(async move {
        let mut stream = response.bytes_stream();
        while let Some(piece) = stream.next().await {
            if watched.closed.load(Ordering::Relaxed) {
                break;
            }
            let item = piece.map_err(std::io::Error::other);
            if tx.send(item).await.is_err() {
                // The player went away; stop pulling from the encoder.
                break;
            }
        }
    });
    let body = Body::from_stream(async_stream::stream! {
        while let Some(item) = rx.recv().await {
            yield item;
        }
    });

    let mut h = base_headers(&mime);
    h.insert(header::ACCEPT_RANGES, HeaderValue::from_static("none"));
    (StatusCode::OK, h, body).into_response()
}

/* ---------------------------------------------------------------- commands */

/// Relays a stream from another device through a deep local buffer.
#[tauri::command]
pub async fn readahead_open(url: String, budget_mb: u32) -> Result<String, String> {
    open(&url, budget_mb).await
}

#[tauri::command]
pub fn readahead_close(address: String) {
    close(&address);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicU64;

    const SIZE: u64 = 5 * CHUNK + 123;

    fn byte_at(i: u64) -> u8 {
        ((i * 31 + 7) % 251) as u8
    }

    fn slice(from: u64, to: u64) -> Vec<u8> {
        (from..=to).map(byte_at).collect()
    }

    #[derive(Clone)]
    struct Origin {
        size: u64,
        ranged: bool,
        served: Arc<AtomicU64>,
        requests: Arc<AtomicU64>,
    }

    async fn origin_handler(
        State(o): State<Origin>,
        headers: HeaderMap,
    ) -> Response {
        o.requests.fetch_add(1, Ordering::Relaxed);
        let range = headers.get(header::RANGE).and_then(|v| v.to_str().ok());
        let (start, end, partial) = match (o.ranged, range) {
            (true, Some(v)) => match parse_range(v, o.size) {
                Some((s, e)) => (s, e, true),
                None => return StatusCode::RANGE_NOT_SATISFIABLE.into_response(),
            },
            _ => (0, o.size - 1, false),
        };
        o.served.fetch_add(end - start + 1, Ordering::Relaxed);
        let mut h = HeaderMap::new();
        h.insert(header::CONTENT_TYPE, HeaderValue::from_static("video/mp4"));
        if partial {
            h.insert(
                header::CONTENT_RANGE,
                HeaderValue::from_str(&format!("bytes {start}-{end}/{}", o.size)).unwrap(),
            );
        }
        let status = if partial { StatusCode::PARTIAL_CONTENT } else { StatusCode::OK };
        (status, h, slice(start, end)).into_response()
    }

    async fn origin(ranged: bool) -> (String, Origin) {
        origin_sized(ranged, SIZE).await
    }

    async fn origin_sized(ranged: bool, size: u64) -> (String, Origin) {
        let o = Origin {
            size,
            ranged,
            served: Arc::new(AtomicU64::new(0)),
            requests: Arc::new(AtomicU64::new(0)),
        };
        let app = axum::Router::new()
            .route("/film.mp4", axum::routing::get(origin_handler))
            .with_state(o.clone());
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        (format!("http://127.0.0.1:{port}/film.mp4"), o)
    }

    async fn get(url: &str, range: Option<&str>) -> reqwest::Response {
        let c = reqwest::Client::builder().no_proxy().build().unwrap();
        let mut r = c.get(url);
        if let Some(v) = range {
            r = r.header(header::RANGE, v);
        }
        r.send().await.unwrap()
    }

    #[test]
    fn only_a_local_network_is_reachable() {
        for ok in ["10.1.2.3", "192.168.100.117", "172.16.0.5", "169.254.9.9", "127.0.0.1", "100.100.1.1", "fd00::1", "fe80::1", "::1"] {
            assert!(is_local_network(ok.parse().unwrap()), "{ok} should be allowed");
        }
        for no in ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.63.0.1", "2001:4860:4860::8888"] {
            assert!(!is_local_network(no.parse().unwrap()), "{no} must be refused");
        }
    }

    #[tokio::test]
    async fn an_address_off_the_network_is_refused_before_anything_is_fetched() {
        assert!(open("http://8.8.8.8/film.mp4", 64).await.is_err());
        assert!(open("http://example.com/film.mp4", 64).await.is_err());
        assert!(open("https://192.168.1.2/film.mp4", 64).await.is_err());
    }

    #[tokio::test]
    async fn ranges_come_back_exact_including_across_chunks_and_backwards() {
        let (url, _) = origin(true).await;
        let local = open(&url, 16).await.unwrap();

        let r = get(&local, Some("bytes=0-99")).await;
        assert_eq!(r.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(r.headers()[header::CONTENT_RANGE], format!("bytes 0-99/{SIZE}"));
        assert_eq!(r.bytes().await.unwrap().to_vec(), slice(0, 99));

        // Straddles a chunk boundary.
        let (a, b) = (CHUNK - 10, CHUNK + 9);
        let r = get(&local, Some(&format!("bytes={a}-{b}"))).await;
        assert_eq!(r.bytes().await.unwrap().to_vec(), slice(a, b));

        // A jump forward, then back to the start.
        let tail = SIZE - 50;
        let r = get(&local, Some(&format!("bytes={tail}-"))).await;
        assert_eq!(r.bytes().await.unwrap().to_vec(), slice(tail, SIZE - 1));
        let r = get(&local, Some("bytes=5-24")).await;
        assert_eq!(r.bytes().await.unwrap().to_vec(), slice(5, 24));

        // No Range at all is the whole file.
        let r = get(&local, None).await;
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.bytes().await.unwrap().len() as u64, SIZE);

        let r = get(&local, Some(&format!("bytes={SIZE}-"))).await;
        assert_eq!(r.status(), StatusCode::RANGE_NOT_SATISFIABLE);
    }

    #[tokio::test]
    async fn it_reads_ahead_of_the_player_and_does_not_fetch_the_same_thing_twice() {
        let (url, o) = origin(true).await;
        let local = open(&url, 16).await.unwrap();

        // The player asks for a few bytes at the start and nothing more.
        let r = get(&local, Some("bytes=0-9")).await;
        assert_eq!(r.bytes().await.unwrap().len(), 10);

        // The whole file is within the window, so every chunk of it should be
        // held without another request from the player.
        let chunks = SIZE.div_ceil(CHUNK) as usize;
        let deadline = Instant::now() + Duration::from_secs(10);
        while held(&local) < chunks && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        assert_eq!(held(&local), chunks, "the rest of the file was not read ahead");

        // Reading it back is served from memory: the origin is not asked again.
        let before = o.requests.load(Ordering::Relaxed);
        let r = get(&local, Some(&format!("bytes={}-", CHUNK * 2))).await;
        assert_eq!(r.bytes().await.unwrap().to_vec(), slice(CHUNK * 2, SIZE - 1));
        assert_eq!(
            o.requests.load(Ordering::Relaxed),
            before,
            "a cached range went back to the origin"
        );
        // One probe and one long read-ahead, however many times it was read.
        assert_eq!(before, 2);
    }

    #[tokio::test]
    async fn a_jump_past_the_window_restarts_the_read_ahead_there() {
        // Forty chunks and a window of eight: the end of the file is far outside
        // anything read ahead from the start.
        let size = 40 * CHUNK + 5;
        let (url, o) = origin_sized(true, size).await;
        let local = open(&url, 8).await.unwrap();

        let r = get(&local, Some("bytes=0-9")).await;
        assert_eq!(r.bytes().await.unwrap().to_vec(), slice(0, 9));
        let deadline = Instant::now() + Duration::from_secs(10);
        while held(&local) < 8 && Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(held(&local) >= 8, "the window was not filled");
        assert!(held(&local) < 40, "read ahead went far past its budget");

        // Jump to near the end: correct bytes, and the window moves there.
        let at = size - 3 * CHUNK;
        let r = get(&local, Some(&format!("bytes={at}-{}", at + 99))).await;
        assert_eq!(r.bytes().await.unwrap().to_vec(), slice(at, at + 99));
        let last = (size - 1) / CHUNK;
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let reached = HUB
                .get()
                .and_then(|h| h.sessions.lock().unwrap().get(local.rsplit('/').next().unwrap()).cloned())
                .map(|s| s.state.lock().unwrap().chunks.contains_key(&last))
                .unwrap_or(false);
            if reached || Instant::now() > deadline {
                assert!(reached, "the read-ahead did not follow the jump");
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }

        // And back to the start, which was dropped from the window: still exact.
        let r = get(&local, Some("bytes=1000-1099")).await;
        assert_eq!(r.bytes().await.unwrap().to_vec(), slice(1000, 1099));
        assert!(o.requests.load(Ordering::Relaxed) >= 3, "a seek should have reopened the origin");
    }

    #[tokio::test]
    async fn a_stream_with_no_ranges_is_passed_through_whole() {
        let (url, _) = origin(false).await;
        // Marked as the remux, which is what is never probed.
        let local = open(&format!("{url}?audio=1"), 16).await.unwrap();
        let r = get(&local, None).await;
        assert_eq!(r.status(), StatusCode::OK);
        assert_eq!(r.headers()[header::ACCEPT_RANGES], "none");
        assert_eq!(r.bytes().await.unwrap().to_vec(), slice(0, SIZE - 1));
    }

    #[tokio::test]
    async fn an_unknown_token_is_not_a_stream() {
        let (url, _) = origin(true).await;
        let local = open(&url, 8).await.unwrap();
        let port = local.split(':').nth(2).unwrap().split('/').next().unwrap().to_string();
        let r = get(&format!("http://127.0.0.1:{port}/ra/nothing"), None).await;
        assert_eq!(r.status(), StatusCode::NOT_FOUND);
    }

    #[test]
    fn range_headers_are_read_the_way_players_send_them() {
        assert_eq!(parse_range("bytes=0-", 100), Some((0, 99)));
        assert_eq!(parse_range("bytes=10-20", 100), Some((10, 20)));
        assert_eq!(parse_range("bytes=90-500", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=-10", 100), Some((90, 99)));
        assert_eq!(parse_range("bytes=100-", 100), None);
        assert_eq!(parse_range("bytes=20-10", 100), None);
        assert_eq!(parse_range("items=0-1", 100), None);
    }
}
