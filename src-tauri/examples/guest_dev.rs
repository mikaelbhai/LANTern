//! A host with no window, for looking at browser guest mode without a second
//! machine.
//!
//! `cargo run --example guest_dev` serves the real routes - the landing page,
//! `/guest/`, the guest API and a small media share - on `127.0.0.1:7981`, with
//! the built frontend read from `../dist` standing in for the app's embedded
//! one. It lets in every guest that asks, and answers every chat message with
//! an echo, which is enough to watch a page join, talk and upload.
//!
//! Run `npm run build` first. Not a test: nothing here is asserted, it exists
//! so the page can be driven in a real browser against the real server code.

use std::path::PathBuf;
use std::time::Duration;

use lantern_lib::guest;
use lantern_lib::hosting;
use lantern_lib::{Envelope, Share, ShareMode};
use lantern_lib::state::AppState;

fn mime(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        "json" => "application/json",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::args().nth(1).and_then(|p| p.parse().ok()).unwrap_or(7981);
    let dist = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist");

    let state = AppState::new();
    let library = std::env::temp_dir().join("lantern-guest-dev-library");
    let _ = std::fs::create_dir_all(&library);
    // A file the scanner will list. It will not play - it is not a film - but it
    // is enough to see the library draw.
    let _ = std::fs::write(library.join("Sample.Film.2020.1080p.mp4"), vec![0u8; 4096]);

    state.with(|s| {
        s.device_id = "dev-host-0000".into();
        s.display_name = "Dev Host".into();
        s.net.ip = "127.0.0.1".into();
        s.net.host_port = port;
        s.trust_local_requests = false;
        s.shares.push(Share {
            id: "dev-library".into(),
            name: "Dev library".into(),
            path: library.to_string_lossy().to_string(),
            slug: "films".into(),
            mode: ShareMode::Media,
            running: true,
            require_phrase: false,
            phrase: None,
            allow_upload: false,
            unlisted: false,
            audience: Vec::new(),
            file_count: 1,
            total_bytes: 4096,
            created_at: 0,
            requests: 0,
            bytes_served: 0,
            active_viewers: 0,
            last_request_at: None,
        });
    });

    let (inbound_tx, mut inbound_rx) = tokio::sync::mpsc::unbounded_channel::<Envelope>();
    guest::attach_with(
        Box::new(|event, payload| println!("[event] {event} {payload}")),
        Box::new(move |path| {
            let bytes = std::fs::read(dist.join(path)).ok()?;
            Some((bytes, mime(path).to_string()))
        }),
        state.clone(),
        inbound_tx,
    );
    guest::force_enabled(true);

    // Let every guest in after a beat, as a host clicking Allow would.
    let admit = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(Duration::from_millis(700)).await;
            for g in guest::list() {
                let v = serde_json::to_value(&g).expect("serialises");
                if v["standing"] == "pending" {
                    let id = v["id"].as_str().unwrap_or_default().to_string();
                    println!("[host] letting {} in", v["name"]);
                    guest::decide(&admit, &id, true);
                }
            }
        }
    });

    // Whatever a guest sends, echoed back down its own link.
    let echo = state.clone();
    tokio::spawn(async move {
        while let Some(envelope) = inbound_rx.recv().await {
            println!("[inbound] {} {} {}", envelope.from, envelope.kind, envelope.payload);
            if envelope.kind != "chat" {
                continue;
            }
            let Some(message) = envelope.payload.get("message") else { continue };
            let text = message.get("body").and_then(|b| b.as_str()).unwrap_or("");
            let room = envelope.payload.get("roomId").cloned().unwrap_or_default();
            let links = echo.with(|s| s.links.clone());
            links.send(
                &envelope.from,
                &Envelope {
                    v: 1,
                    from: "dev-host-0000".into(),
                    kind: "chat".into(),
                    payload: serde_json::json!({
                        "roomId": room,
                        "message": {
                            "id": uuid::Uuid::new_v4().to_string(),
                            "roomId": room,
                            "authorId": "dev-host-0000",
                            "body": format!("Echo: {text}"),
                            "ts": std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0),
                            "reactions": {}, "attachments": [], "mentions": [],
                            "deliveredTo": [], "seenBy": []
                        }
                    }),
                },
            );
        }
    });

    println!("guest dev host on http://127.0.0.1:{port}/  (guest page: /guest/)");
    hosting::serve(state, port).await.expect("server stopped");
}
