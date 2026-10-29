//! Browser guests: a device with no app on it, using LANTern from a page this
//! machine serves.
//!
//! The landing page is how somebody with no app finds this machine; this is
//! what lets them do something once they are there. A guest is a node for as
//! long as its tab is open and the host allows it, and no longer.
//!
//! It is built out of what a peer already is rather than beside it. A guest
//! registers a virtual link in `Links`, under an id of its own, and whatever
//! the rest of the application sends down a link - a chat message, a file
//! offer - reaches the guest through the same `links.send` with no knowledge
//! that the far end is a browser. What the guest sends comes back through the
//! same inbound queue as a real peer's envelopes, so chat and offers arrive in
//! the window by the path they always did. The only new code is the HTTP edge
//! and the rules about who may use it.
//!
//! What a plain `http://192.168.x.x` page cannot do is not faked here: browsers
//! refuse the microphone, the camera and screen capture outside a secure
//! context, so there are no guest calls. The page says so.
//!
//! Only the application process serves this. The detached host has no window
//! and no inbound queue, so there it answers 503 and says why.

use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use axum::body::{Body, Bytes};
use axum::extract::{ConnectInfo, Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Redirect, Response};
use futures_util::TryStreamExt;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State as TauriState};
use tokio::io::AsyncWriteExt;
use tokio::sync::{mpsc, Notify};
use tokio_util::io::StreamReader;

use crate::model::now_ms;
use crate::signaling::Envelope;
use crate::state::AppState;

/// Cookie that names a guest. Scoped to `/guest` and unreadable by script: it is
/// the only thing standing between a tab and the host's approval.
const COOKIE: &str = "lantern_guest";

/// How many guests at once. A home network does not need more, and each one
/// holds a connection open.
const MAX_GUESTS: usize = 8;

/// A tab that has said nothing for this long has gone: the peer is withdrawn,
/// though the approval is kept so coming back does not ask again.
const IDLE_DETACH: Duration = Duration::from_secs(90);

/// How long an approval lasts without the guest returning.
const APPROVAL_LIFE: Duration = Duration::from_secs(12 * 60 * 60);

/// A request that nobody answered.
const PENDING_LIFE: Duration = Duration::from_secs(10 * 60);

/// Largest chat envelope accepted. Text, not media: a guest sends files through
/// the upload route, where they are offered like any other.
const MAX_ENVELOPE: usize = 256 * 1024;

/// Largest file a guest may hand over. Held on this machine's disk until the
/// host accepts it or the application restarts.
const MAX_UPLOAD: u64 = 2 * 1024 * 1024 * 1024;

/// Messages a guest may send in a window, before it is told to slow down.
const BURST: usize = 60;
const BURST_WINDOW: Duration = Duration::from_secs(10);

/// What a guest's link may carry to it. Everything else sent down a link - a
/// network-wide broadcast of upstream addresses, a pass-phrase result - is for
/// real peers and is dropped on the way.
const FORWARDED: &[&str] = &["chat", "typing", "file"];

/// Whether the host has switched this on. Off by default: opening the door to
/// browsers is a decision somebody makes, not something an update does to them.
static ENABLED: AtomicBool = AtomicBool::new(false);

/// Whether a guest is let in without the host being asked. Also off by default,
/// and only meaningful while guest mode itself is on: it turns "who may come in"
/// from a decision per device into "anybody on this network", which is a fine
/// answer at home and the wrong one anywhere else.
static AUTO: AtomicBool = AtomicBool::new(false);

/// Everything this module needs from the application, as closures.
///
/// Not an `AppHandle`, on purpose. The router that serves these routes is also
/// linked into the detached host, which has no window; touching Tauri's own
/// types from a route pulls its window-system imports into that binary, and it
/// then refuses to start on a machine without the manifest that satisfies them.
/// Closures built where the application is, and called from where it is not
/// needed, keep that dependency on the application's side of the line.
struct Hub {
    emit: Box<dyn Fn(&str, serde_json::Value) + Send + Sync>,
    asset: Box<dyn Fn(&str) -> Option<(Vec<u8>, String)> + Send + Sync>,
    inbound: mpsc::UnboundedSender<Envelope>,
    state: AppState,
}

impl Hub {
    fn emit(&self, event: &str, payload: impl Serialize) {
        if let Ok(value) = serde_json::to_value(payload) {
            (self.emit)(event, value);
        }
    }
}

static HUB: OnceLock<Hub> = OnceLock::new();

/// Called once by the signalling server, which owns the inbound queue.
pub fn attach(app: AppHandle, state: AppState, inbound: mpsc::UnboundedSender<Envelope>) {
    let emitter = app.clone();
    attach_with(
        Box::new(move |event, payload| {
            let _ = emitter.emit(event, payload);
        }),
        Box::new(move |path| {
            app.asset_resolver()
                .get(path.to_string())
                .map(|a| (a.bytes, a.mime_type))
        }),
        state,
        inbound,
    );
}

/// The same, from whatever supplies the three things a window would.
///
/// Public so a development harness (`examples/guest_dev.rs`) can stand a host
/// up with no window and drive the real page against the real routes - which is
/// the only way to see a browser guest work without two machines.
pub fn attach_with(
    emit: Box<dyn Fn(&str, serde_json::Value) + Send + Sync>,
    asset: Box<dyn Fn(&str) -> Option<(Vec<u8>, String)> + Send + Sync>,
    state: AppState,
    inbound: mpsc::UnboundedSender<Envelope>,
) {
    if HUB.set(Hub { emit, asset, inbound, state }).is_err() {
        return;
    }
    // Files a guest handed over last session cannot be offered any more - the
    // offer table lived in memory - so they are only taking up room.
    let _ = std::fs::remove_dir_all(staging_root());
    tokio::spawn(sweep());
}

/// Switches the feature on or off without a command, for the harness.
pub fn force_enabled(on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
}

pub fn enabled() -> bool {
    ENABLED.load(Ordering::Relaxed) && HUB.get().is_some()
}

#[derive(Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum Standing {
    Pending,
    Allowed,
    Denied,
}

struct Guest {
    /// What the rest of the application calls this device.
    id: String,
    name: String,
    agent: String,
    ip: String,
    standing: Standing,
    joined_at: u64,
    last_seen: Instant,
    /// Whether the virtual link and the peer entry exist right now.
    attached: bool,
    generation: Option<u64>,
    seq: u64,
    backlog: VecDeque<(u64, String)>,
    wake: Arc<Notify>,
    recent: VecDeque<Instant>,
}

fn guests() -> &'static Mutex<HashMap<String, Guest>> {
    static G: OnceLock<Mutex<HashMap<String, Guest>>> = OnceLock::new();
    G.get_or_init(|| Mutex::new(HashMap::new()))
}

fn staging_root() -> std::path::PathBuf {
    std::env::temp_dir().join("lantern-guest")
}

/* ------------------------------------------------------------------ routes */

pub fn routes(router: axum::Router<Arc<AppState>>) -> axum::Router<Arc<AppState>> {
    use axum::routing::{get, post};
    router
        // Registered as exact paths so none of them can be shadowed by, or
        // shadow, a published folder: the wildcard below only matches what the
        // API does not.
        .route("/guest", get(|| async { Redirect::permanent("/guest/") }))
        .route("/guest/api/join", post(join))
        .route("/guest/api/status", get(status))
        .route("/guest/api/events", get(events))
        .route("/guest/api/send", post(send))
        .route(
            "/guest/api/upload",
            post(upload).layer(axum::extract::DefaultBodyLimit::disable()),
        )
        .route("/guest/api/leave", post(leave))
        .route("/guest/", get(asset_index))
        .route("/guest/*path", get(asset))
}

fn token_of(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    raw.split(';')
        .filter_map(|part| part.trim().split_once('='))
        .find(|(name, _)| *name == COOKIE)
        .map(|(_, value)| value.to_string())
        .filter(|v| v.len() == 32 && v.bytes().all(|b| b.is_ascii_hexdigit()))
}

fn mint_token() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn cookie_header(token: &str) -> HeaderValue {
    HeaderValue::from_str(&format!(
        "{COOKIE}={token}; Path=/guest; Max-Age=43200; SameSite=Strict; HttpOnly"
    ))
    .expect("cookie is ascii")
}

fn refuse(status: StatusCode, why: &str) -> Response {
    (status, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], why.to_string()).into_response()
}

/// Everything a request needs before it is let near a guest: the switch is on,
/// there is a window to talk to, and the cookie names an approved guest.
fn admit(headers: &HeaderMap) -> Result<String, Response> {
    if HUB.get().is_none() {
        return Err(refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "Open the LANTern app on this machine to use guest mode.",
        ));
    }
    if !ENABLED.load(Ordering::Relaxed) {
        return Err(refuse(StatusCode::FORBIDDEN, "Guest mode is off on this machine."));
    }
    let Some(token) = token_of(headers) else {
        return Err(refuse(StatusCode::UNAUTHORIZED, "Join first."));
    };
    let ok = guests()
        .lock()
        .expect("guests poisoned")
        .get(&token)
        .is_some_and(|g| g.standing == Standing::Allowed);
    if ok {
        Ok(token)
    } else {
        Err(refuse(StatusCode::FORBIDDEN, "The host has not allowed this device."))
    }
}

/* -------------------------------------------------------------- the page */

async fn asset_index() -> Response {
    serve_asset("index.html", false)
}

async fn asset(AxumPath(path): AxumPath<String>) -> Response {
    // The API lives under the same prefix; a typo in it must not turn into an
    // HTML page the client then fails to parse.
    if path.starts_with("api/") {
        return refuse(StatusCode::NOT_FOUND, "No such route.");
    }
    serve_asset(&path, path.starts_with("assets/"))
}

fn serve_asset(path: &str, immutable: bool) -> Response {
    let Some(hub) = HUB.get() else {
        return refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "Open the LANTern app on this machine to use guest mode.",
        );
    };
    if !ENABLED.load(Ordering::Relaxed) {
        return refuse(StatusCode::FORBIDDEN, "Guest mode is off on this machine.");
    }
    if path.contains("..") {
        return refuse(StatusCode::NOT_FOUND, "Not found");
    }
    let Some((bytes, mime)) = (hub.asset)(path) else {
        return refuse(StatusCode::NOT_FOUND, "Not found");
    };
    let cache = if immutable {
        "public, max-age=31536000, immutable"
    } else {
        "no-cache"
    };
    (
        [
            (header::CONTENT_TYPE, mime),
            (header::CACHE_CONTROL, cache.to_string()),
        ],
        bytes,
    )
        .into_response()
}

/* ------------------------------------------------------------------- join */

fn agent_label(ua: &str) -> String {
    let device = if ua.contains("iPhone") {
        "iPhone"
    } else if ua.contains("iPad") {
        "iPad"
    } else if ua.contains("Android") {
        "Android"
    } else if ua.contains("Windows") {
        "Windows"
    } else if ua.contains("Macintosh") {
        "Mac"
    } else if ua.contains("Linux") {
        "Linux"
    } else {
        "Browser"
    };
    let browser = if ua.contains("Edg/") {
        "Edge"
    } else if ua.contains("Firefox/") {
        "Firefox"
    } else if ua.contains("Chrome/") || ua.contains("CriOS/") {
        "Chrome"
    } else if ua.contains("Safari/") {
        "Safari"
    } else {
        "browser"
    };
    format!("{device} · {browser}")
}

fn clean_name(raw: &str) -> String {
    let name: String = raw.chars().filter(|c| !c.is_control()).collect();
    let name = name.trim();
    if name.is_empty() {
        "Guest".to_string()
    } else {
        name.chars().take(24).collect()
    }
}

#[derive(serde::Deserialize)]
struct JoinBody {
    #[serde(default)]
    name: String,
}

/// Asks to be let in. Answers at once with where the request stands; the host
/// decides in its own time and the page polls `status`.
async fn join(
    State(state): State<Arc<AppState>>,
    ConnectInfo(from): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let Some(hub) = HUB.get() else {
        return refuse(
            StatusCode::SERVICE_UNAVAILABLE,
            "Open the LANTern app on this machine to use guest mode.",
        );
    };
    if !ENABLED.load(Ordering::Relaxed) {
        return refuse(StatusCode::FORBIDDEN, "Guest mode is off on this machine.");
    }
    let name = clean_name(&serde_json::from_slice::<JoinBody>(&body).map(|b| b.name).unwrap_or_default());
    let agent = agent_label(
        headers
            .get(header::USER_AGENT)
            .and_then(|v| v.to_str().ok())
            .unwrap_or_default(),
    );
    let ip = from.ip().to_canonical().to_string();

    let (token, minted, standing, announce) = {
        let mut all = guests().lock().expect("guests poisoned");
        match token_of(&headers).filter(|t| all.contains_key(t)) {
            Some(token) => {
                let g = all.get_mut(&token).expect("checked above");
                g.last_seen = Instant::now();
                (token, false, g.standing, None)
            }
            None => {
                if all.len() >= MAX_GUESTS {
                    return refuse(StatusCode::SERVICE_UNAVAILABLE, "This machine has as many guests as it allows.");
                }
                let token = mint_token();
                let id = format!("guest:{}", &token[..12]);
                all.insert(
                    token.clone(),
                    Guest {
                        id: id.clone(),
                        name: name.clone(),
                        agent: agent.clone(),
                        ip: ip.clone(),
                        standing: if AUTO.load(Ordering::Relaxed) {
                            Standing::Allowed
                        } else {
                            Standing::Pending
                        },
                        joined_at: now_ms(),
                        last_seen: Instant::now(),
                        attached: false,
                        generation: None,
                        seq: 0,
                        backlog: VecDeque::new(),
                        wake: Arc::new(Notify::new()),
                        recent: VecDeque::new(),
                    },
                );
                let standing = if AUTO.load(Ordering::Relaxed) {
                    Standing::Allowed
                } else {
                    Standing::Pending
                };
                (token, true, standing, Some(id))
            }
        }
    };

    if let Some(id) = announce {
        let who = serde_json::json!({ "id": id, "name": name, "agent": agent, "ip": ip });
        if standing == Standing::Allowed {
            // Let in without asking: the host is told, not asked.
            hub.emit("guest:arrived", who);
        } else {
            // The host's window shows an Allow / Deny prompt for this.
            hub.emit("guest:request", who);
        }
    }
    let _ = &state;

    let mut response = (
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({ "standing": standing }).to_string(),
    )
        .into_response();
    if minted {
        response.headers_mut().insert(header::SET_COOKIE, cookie_header(&token));
    }
    response
}

/// Where this guest stands, and who it is talking to.
async fn status(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    let enabled = HUB.get().is_some() && ENABLED.load(Ordering::Relaxed);
    let (host_id, host_name) = state.with(|s| (s.device_id.clone(), s.display_name.clone()));
    let mine = token_of(&headers).and_then(|t| {
        guests()
            .lock()
            .expect("guests poisoned")
            .get_mut(&t)
            .map(|g| {
                g.last_seen = Instant::now();
                (g.id.clone(), g.name.clone(), g.standing)
            })
    });
    let body = match mine {
        Some((id, name, standing)) => serde_json::json!({
            "enabled": enabled, "standing": standing, "me": id, "name": name,
            "hostId": host_id, "hostName": host_name,
        }),
        None => serde_json::json!({
            "enabled": enabled, "standing": null, "hostId": host_id, "hostName": host_name,
        }),
    };
    ([(header::CONTENT_TYPE, "application/json")], body.to_string()).into_response()
}

/* ---------------------------------------------------- the virtual link */

fn peer_for(state: &AppState, g: &Guest) -> crate::model::Peer {
    let port = state.with(|s| s.net.port);
    crate::model::Peer {
        id: g.id.clone(),
        device_id: g.id.clone(),
        name: g.name.clone(),
        device_name: g.agent.clone(),
        color: "#38BDF8".into(),
        emoji: "🌐".into(),
        os: "unknown".into(),
        ip: g.ip.clone(),
        addresses: Vec::new(),
        local_address: String::new(),
        port,
        layer: crate::model::ConnLayer::Direct,
        latency_ms: -1.0,
        loss_pct: 0.0,
        status: crate::model::PeerStatus::Available,
        status_message: None,
        last_seen: now_ms(),
        trusted: false,
        scope: crate::model::PeerScope::Local,
        initiated_by: crate::model::Initiator::Them,
    }
}

/// Gives an approved guest its link and its place in the peer list.
fn attach_guest(state: &AppState, token: &str) {
    let Some(hub) = HUB.get() else { return };
    let (tx, mut rx) = mpsc::unbounded_channel::<String>();
    let links = state.with(|s| s.links.clone());

    let (peer, wake) = {
        let mut all = guests().lock().expect("guests poisoned");
        let Some(g) = all.get_mut(token) else { return };
        if g.attached {
            return;
        }
        let Some(generation) = links.claim(&g.id, tx, true) else { return };
        g.generation = Some(generation);
        g.attached = true;
        (peer_for(state, g), g.wake.clone())
    };

    state.with(|s| s.peers.insert(peer.id.clone(), peer.clone()));
    hub.emit("peer:joined", &peer);

    let token = token.to_string();
    tokio::spawn(async move {
        while let Some(line) = rx.recv().await {
            let allowed = serde_json::from_str::<serde_json::Value>(&line)
                .ok()
                .and_then(|v| v.get("kind").and_then(|k| k.as_str()).map(str::to_owned))
                .is_some_and(|kind| FORWARDED.contains(&kind.as_str()));
            if !allowed {
                continue;
            }
            let mut all = guests().lock().expect("guests poisoned");
            let Some(g) = all.get_mut(&token) else { break };
            g.seq += 1;
            let seq = g.seq;
            g.backlog.push_back((seq, line));
            while g.backlog.len() > 500 {
                g.backlog.pop_front();
            }
            wake.notify_one();
        }
    });
}

/// Takes the link and the peer entry away. The approval stays.
fn detach_guest(state: &AppState, token: &str) {
    let Some(hub) = HUB.get() else { return };
    let (id, generation) = {
        let mut all = guests().lock().expect("guests poisoned");
        let Some(g) = all.get_mut(token) else { return };
        if !g.attached {
            return;
        }
        g.attached = false;
        (g.id.clone(), g.generation.take())
    };
    if let Some(generation) = generation {
        state.with(|s| s.links.clone()).remove(&id, generation);
    }
    state.with(|s| s.peers.remove(&id));
    hub.emit("peer:left", &id);
}

async fn sweep() {
    loop {
        tokio::time::sleep(Duration::from_secs(30)).await;
        let Some(hub) = HUB.get() else { continue };
        let state = &hub.state;

        let (idle, gone): (Vec<String>, Vec<String>) = {
            let all = guests().lock().expect("guests poisoned");
            let now = Instant::now();
            let idle = all
                .iter()
                .filter(|(_, g)| g.attached && now.duration_since(g.last_seen) > IDLE_DETACH)
                .map(|(t, _)| t.clone())
                .collect();
            let gone = all
                .iter()
                .filter(|(_, g)| {
                    let age = now.duration_since(g.last_seen);
                    match g.standing {
                        Standing::Pending => age > PENDING_LIFE,
                        _ => age > APPROVAL_LIFE,
                    }
                })
                .map(|(t, _)| t.clone())
                .collect();
            (idle, gone)
        };
        for token in idle {
            detach_guest(state, &token);
        }
        for token in gone {
            detach_guest(state, &token);
            guests().lock().expect("guests poisoned").remove(&token);
        }
    }
}

/* ------------------------------------------------------------------ events */

#[derive(serde::Deserialize)]
struct EventsQuery {
    #[serde(default)]
    since: Option<u64>,
}

/// The stream of everything sent to this guest. `EventSource` reconnects on its
/// own and says where it got to, so a phone that locked its screen for a minute
/// picks up what it missed rather than finding the conversation short.
async fn events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<EventsQuery>,
) -> Response {
    let token = match admit(&headers) {
        Ok(t) => t,
        Err(refusal) => return refusal,
    };
    attach_guest(&state, &token);

    let since = headers
        .get("last-event-id")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .or(q.since)
        .unwrap_or(0);
    let wake = guests()
        .lock()
        .expect("guests poisoned")
        .get(&token)
        .map(|g| g.wake.clone());
    let Some(wake) = wake else {
        return refuse(StatusCode::FORBIDDEN, "The host has not allowed this device.");
    };

    let stream = async_stream::stream! {
        let mut next = since;
        loop {
            let batch: Option<Vec<(u64, String)>> = {
                let mut all = guests().lock().expect("guests poisoned");
                match all.get_mut(&token) {
                    // Removed by the host, or timed out: end the stream, and the
                    // page finds out from the next `status`.
                    None => None,
                    Some(g) if g.standing != Standing::Allowed => None,
                    Some(g) => {
                        g.last_seen = Instant::now();
                        Some(g.backlog.iter().filter(|(seq, _)| *seq > next).cloned().collect())
                    }
                }
            };
            let Some(batch) = batch else { break };
            for (seq, line) in batch {
                next = seq;
                yield Ok::<Event, Infallible>(Event::default().id(seq.to_string()).data(line));
            }
            tokio::select! {
                _ = wake.notified() => {}
                _ = tokio::time::sleep(Duration::from_secs(20)) => {}
            }
        }
    };

    let mut response = Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(Duration::from_secs(15)))
        .into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

/* -------------------------------------------------------------------- send */

#[derive(serde::Deserialize)]
struct SendBody {
    kind: String,
    #[serde(default)]
    payload: serde_json::Value,
}

/// Chat from a guest. Same envelope as a peer's, delivered by the same queue.
async fn send(State(state): State<Arc<AppState>>, headers: HeaderMap, body: Bytes) -> Response {
    let token = match admit(&headers) {
        Ok(t) => t,
        Err(refusal) => return refusal,
    };
    if body.len() > MAX_ENVELOPE {
        return refuse(StatusCode::PAYLOAD_TOO_LARGE, "That message is too large.");
    }
    let Ok(parsed) = serde_json::from_slice::<SendBody>(&body) else {
        return refuse(StatusCode::BAD_REQUEST, "Not a message.");
    };
    // Chat and the typing dots. Not "file" (that has its own route, where the
    // bytes are checked), and above all not "control" or "input": a guest is a
    // browser, and nothing it sends may drive this machine.
    if parsed.kind != "chat" && parsed.kind != "typing" {
        return refuse(StatusCode::FORBIDDEN, "Guests can chat; that is all this carries.");
    }

    let Some(hub) = HUB.get() else {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, "Open the LANTern app on this machine.");
    };

    let id = {
        let mut all = guests().lock().expect("guests poisoned");
        let Some(g) = all.get_mut(&token) else {
            return refuse(StatusCode::FORBIDDEN, "The host has not allowed this device.");
        };
        let now = Instant::now();
        g.last_seen = now;
        while g.recent.front().is_some_and(|t| now.duration_since(*t) > BURST_WINDOW) {
            g.recent.pop_front();
        }
        if g.recent.len() >= BURST {
            return refuse(StatusCode::TOO_MANY_REQUESTS, "Slow down.");
        }
        g.recent.push_back(now);
        g.id.clone()
    };
    let _ = &state;

    let _ = hub.inbound.send(Envelope { v: 1, from: id, kind: parsed.kind, payload: parsed.payload });
    StatusCode::NO_CONTENT.into_response()
}

/* ------------------------------------------------------------------ upload */

#[derive(serde::Deserialize)]
struct UploadQuery {
    name: String,
}

/// A file from a guest, offered to the host like any other.
///
/// The bytes are written to disk first and only then offered, through the same
/// token table a peer's outgoing files use. The host sees an ordinary incoming
/// offer and accepts or declines it; accepting fetches from this machine's own
/// server. Nothing lands in the downloads folder without that.
async fn upload(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(q): Query<UploadQuery>,
    body: Body,
) -> Response {
    let token = match admit(&headers) {
        Ok(t) => t,
        Err(refusal) => return refusal,
    };
    let Some(hub) = HUB.get() else {
        return refuse(StatusCode::SERVICE_UNAVAILABLE, "Open the LANTern app on this machine.");
    };

    let declared = headers
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok());
    if declared.is_some_and(|n| n > MAX_UPLOAD) {
        return refuse(StatusCode::PAYLOAD_TOO_LARGE, "That file is too large.");
    }

    // A name, never a path: whatever the browser sent is reduced to its last
    // component before it is joined onto anything.
    let name = std::path::Path::new(q.name.trim())
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n.chars().filter(|c| !c.is_control() && !matches!(c, '/' | '\\' | ':')).collect::<String>())
        .filter(|n| !n.is_empty() && n != "." && n != "..")
        .unwrap_or_else(|| "file".to_string());

    let (id, in_dir) = {
        let all = guests().lock().expect("guests poisoned");
        let Some(g) = all.get(&token) else {
            return refuse(StatusCode::FORBIDDEN, "The host has not allowed this device.");
        };
        (g.id.clone(), staging_root().join(&token[..12]).join(uuid::Uuid::new_v4().simple().to_string()))
    };
    if tokio::fs::create_dir_all(&in_dir).await.is_err() {
        return refuse(StatusCode::INTERNAL_SERVER_ERROR, "Could not make room for that file.");
    }
    let path = in_dir.join(&name);

    let Ok(mut out) = tokio::fs::File::create(&path).await else {
        return refuse(StatusCode::INTERNAL_SERVER_ERROR, "Could not store that file.");
    };
    let reader = StreamReader::new(body.into_data_stream().map_err(std::io::Error::other));
    let mut limited = tokio::io::AsyncReadExt::take(reader, MAX_UPLOAD + 1);
    let copied = tokio::io::copy(&mut limited, &mut out).await;
    let _ = out.flush().await;
    drop(out);

    let size = match copied {
        Ok(n) if n <= MAX_UPLOAD => n,
        Ok(_) => {
            let _ = tokio::fs::remove_dir_all(&in_dir).await;
            return refuse(StatusCode::PAYLOAD_TOO_LARGE, "That file is too large.");
        }
        Err(_) => {
            let _ = tokio::fs::remove_dir_all(&in_dir).await;
            return refuse(StatusCode::BAD_REQUEST, "The upload was interrupted.");
        }
    };
    if size == 0 {
        let _ = tokio::fs::remove_dir_all(&in_dir).await;
        return refuse(StatusCode::BAD_REQUEST, "That file is empty.");
    }

    let transfer_id = uuid::Uuid::new_v4().to_string();
    let offer_token = uuid::Uuid::new_v4().simple().to_string();
    let host_port = state.with(|s| {
        s.offers.insert(
            offer_token.clone(),
            crate::transfers::Outgoing {
                path: path.clone(),
                transfer_id: transfer_id.clone(),
                handle: None,
                name: name.clone(),
            },
        );
        s.net.host_port
    });
    let mime = crate::transfers::guess_mime(&path);

    let offer = crate::transfers::FileOffer {
        transfer_id: transfer_id.clone(),
        name,
        size,
        mime,
        url: format!("http://127.0.0.1:{host_port}/transfer/{offer_token}"),
        bundle_id: None,
        via_chat: false,
    };
    let _ = hub.inbound.send(Envelope {
        v: 1,
        from: id,
        kind: "file".into(),
        payload: serde_json::json!({ "offer": offer }),
    });

    (
        [(header::CONTENT_TYPE, "application/json")],
        serde_json::json!({ "transferId": transfer_id, "size": size }).to_string(),
    )
        .into_response()
}

async fn leave(State(state): State<Arc<AppState>>, headers: HeaderMap) -> Response {
    if let Some(token) = token_of(&headers) {
        detach_guest(&state, &token);
        guests().lock().expect("guests poisoned").remove(&token);
    }
    StatusCode::NO_CONTENT.into_response()
}

/* ----------------------------------------------------- the host's controls */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GuestInfo {
    id: String,
    name: String,
    agent: String,
    ip: String,
    standing: Standing,
    joined_at: u64,
    online: bool,
}

#[tauri::command]
pub fn guest_enabled() -> bool {
    ENABLED.load(Ordering::Relaxed)
}

/// Turns guest mode on or off, and remembers which. Off sends everybody away:
/// a switch that left the tabs already open working would not be off.
#[tauri::command]
pub fn guest_set_enabled(state: TauriState<'_, AppState>, on: bool) {
    set_enabled(&state, on);
}

pub fn set_enabled(state: &AppState, on: bool) {
    ENABLED.store(on, Ordering::Relaxed);
    state.with(|s| {
        if let Some(db) = s.db.as_ref() {
            let _ = db.execute(
                "INSERT INTO preferences (key, value) VALUES ('guest_mode', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = ?1",
                rusqlite::params![if on { "1" } else { "0" }],
            );
        }
    });
    if !on {
        let tokens: Vec<String> = guests().lock().expect("guests poisoned").keys().cloned().collect();
        for token in tokens {
            detach_guest(state, &token);
            guests().lock().expect("guests poisoned").remove(&token);
        }
    }
}

#[tauri::command]
pub fn guest_auto_allowed() -> bool {
    AUTO.load(Ordering::Relaxed)
}

/// Lets guests in without asking, and remembers which. Turning it on also lets
/// in whoever is already waiting: a request that was pending when the host
/// said "yes to everyone" should not be the one left standing at the door.
#[tauri::command]
pub fn guest_set_auto(state: TauriState<'_, AppState>, on: bool) {
    set_auto(&state, on);
}

pub fn set_auto(state: &AppState, on: bool) {
    AUTO.store(on, Ordering::Relaxed);
    state.with(|s| {
        if let Some(db) = s.db.as_ref() {
            let _ = db.execute(
                "INSERT INTO preferences (key, value) VALUES ('guest_auto', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = ?1",
                rusqlite::params![if on { "1" } else { "0" }],
            );
        }
    });
    if on {
        for g in guests().lock().expect("guests poisoned").values_mut() {
            if g.standing == Standing::Pending {
                g.standing = Standing::Allowed;
            }
        }
    }
}

/// Puts the remembered switch back at startup, before the server answers.
pub fn load_setting(state: &AppState) {
    let on = state.with(|s| {
        s.db.as_ref().and_then(|db| {
            db.query_row("SELECT value FROM preferences WHERE key = 'guest_mode'", [], |r| {
                r.get::<_, String>(0)
            })
            .ok()
        })
    });
    ENABLED.store(on.as_deref() == Some("1"), Ordering::Relaxed);

    let auto = state.with(|s| {
        s.db.as_ref().and_then(|db| {
            db.query_row("SELECT value FROM preferences WHERE key = 'guest_auto'", [], |r| {
                r.get::<_, String>(0)
            })
            .ok()
        })
    });
    AUTO.store(auto.as_deref() == Some("1"), Ordering::Relaxed);
}

/// For the harness: the same, without a database.
pub fn force_auto(on: bool) {
    AUTO.store(on, Ordering::Relaxed);
}

#[tauri::command]
pub fn guest_list() -> Vec<GuestInfo> {
    list()
}

pub fn list() -> Vec<GuestInfo> {
    let mut list: Vec<GuestInfo> = guests()
        .lock()
        .expect("guests poisoned")
        .values()
        .map(|g| GuestInfo {
            id: g.id.clone(),
            name: g.name.clone(),
            agent: g.agent.clone(),
            ip: g.ip.clone(),
            standing: g.standing,
            joined_at: g.joined_at,
            online: g.attached,
        })
        .collect();
    list.sort_by_key(|g| g.joined_at);
    list
}

/// The host's answer to a request to join.
#[tauri::command]
pub fn guest_decide(state: TauriState<'_, AppState>, id: String, allow: bool) {
    decide(&state, &id, allow);
}

pub fn decide(state: &AppState, id: &str, allow: bool) {
    let token = guests()
        .lock()
        .expect("guests poisoned")
        .iter()
        .find(|(_, g)| g.id == id)
        .map(|(t, _)| t.clone());
    let Some(token) = token else { return };
    if let Some(g) = guests().lock().expect("guests poisoned").get_mut(&token) {
        g.standing = if allow { Standing::Allowed } else { Standing::Denied };
        g.last_seen = Instant::now();
    }
    if !allow {
        detach_guest(state, &token);
    }
}

/// Sends a guest away and forgets it. It can ask again, and the host decides
/// again.
#[tauri::command]
pub fn guest_remove(state: TauriState<'_, AppState>, id: String) {
    remove(&state, &id);
}

pub fn remove(state: &AppState, id: &str) {
    let token = guests()
        .lock()
        .expect("guests poisoned")
        .iter()
        .find(|(_, g)| g.id == id)
        .map(|(t, _)| t.clone());
    if let Some(token) = token {
        detach_guest(state, &token);
        guests().lock().expect("guests poisoned").remove(&token);
    }
}

/// Whether anything at all is waiting, for the landing page.
pub fn landing_open() -> bool {
    enabled()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_cookie_is_read_only_when_it_is_a_token() {
        let mut headers = HeaderMap::new();
        let token = mint_token();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("a=b; {COOKIE}={token}; c=d")).unwrap(),
        );
        assert_eq!(token_of(&headers), Some(token));

        // Anything that is not 32 hex digits is no token, so a crafted value
        // cannot be used to probe the table.
        headers.insert(header::COOKIE, HeaderValue::from_str(&format!("{COOKIE}=../x")).unwrap());
        assert_eq!(token_of(&headers), None);
    }

    #[test]
    fn names_are_trimmed_and_bounded() {
        assert_eq!(clean_name("  \n "), "Guest");
        assert_eq!(clean_name("Sam\u{0007}"), "Sam");
        assert_eq!(clean_name(&"x".repeat(80)).chars().count(), 24);
    }

    #[test]
    fn a_browser_is_named_by_device_and_engine() {
        let ua = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
        assert_eq!(agent_label(ua), "iPhone · Safari");
        let ua = "Mozilla/5.0 (Linux; Android 14; Pixel 9a) AppleWebKit/537.36 Chrome/126.0 Mobile Safari/537.36";
        assert_eq!(agent_label(ua), "Android · Chrome");
    }

    #[test]
    fn nothing_is_let_in_without_the_switch_or_a_window() {
        // No hub in a test process, so even a well-formed cookie is refused.
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_str(&format!("{COOKIE}={}", mint_token())).unwrap(),
        );
        let refusal = admit(&headers).unwrap_err();
        assert_eq!(refusal.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    #[test]
    fn only_chat_kinds_are_forwarded_to_a_guest() {
        for kind in ["chat", "typing", "file"] {
            assert!(FORWARDED.contains(&kind));
        }
        for kind in ["upstream", "pinresult", "key", "control", "input", "game", "signal", "profile"] {
            assert!(!FORWARDED.contains(&kind), "{kind} must not reach a browser");
        }
    }
}
