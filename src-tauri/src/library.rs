//! The shared library: everything published by every device on the network.
//!
//! Each device already serves a manifest of its media shares over HTTP. What
//! was missing was anyone reading them — so Theatre only ever showed titles
//! from the machine you were sitting at, and a phone that publishes nothing
//! showed an empty screen no matter how much its peers were sharing.
//!
//! Peers are polled over plain HTTP rather than pushed over the signalling
//! link. A library can run to thousands of entries, the HTTP server is already
//! there and already handles range requests for the video itself, and keeping
//! the link free of bulk keeps chat and calls responsive.

use std::time::Duration;

use tauri::{AppHandle, Emitter};

use crate::state::AppState;

/// How long to wait on a peer before giving up on its library.
const TIMEOUT: Duration = Duration::from_secs(4);

/// A minimal HTTP GET returning the response body.
///
/// LANTern has no HTTP client dependency and does not want one for this: the
/// requests are two fixed paths against a server we wrote, on a LAN, with no
/// redirects, no TLS and no authentication. `reqwest` would add a megabyte of
/// binary and a TLS stack to fetch a JSON file from the machine next door.
async fn get(host: &str, port: u16, path: &str) -> std::io::Result<String> {
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

    let stream = tokio::time::timeout(
        TIMEOUT,
        tokio::net::TcpStream::connect((host, port)),
    )
    .await
    .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "connect timed out"))??;

    let mut stream = stream;
    stream
        .write_all(
            format!("GET {path} HTTP/1.0\r\nHost: {host}:{port}\r\nConnection: close\r\n\r\n")
                .as_bytes(),
        )
        .await?;

    let mut reader = BufReader::new(stream);

    let mut status = String::new();
    reader.read_line(&mut status).await?;
    if !status.contains(" 200") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::Other,
            format!("peer answered: {}", status.trim()),
        ));
    }
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header).await? == 0 || header.trim().is_empty() {
            break;
        }
    }

    let mut body = String::new();
    tokio::time::timeout(TIMEOUT, reader.read_to_string(&mut body))
        .await
        .map_err(|_| std::io::Error::new(std::io::ErrorKind::TimedOut, "read timed out"))??;
    Ok(body)
}

/// Reads one peer's published media and returns it as library entries.
///
/// Entries are stamped with the peer's id and an absolute stream URL pointing
/// back at that peer, so playing one streams from the device holding the file
/// rather than copying it first.
pub async fn fetch_peer(peer_id: &str, host: &str, port: u16) -> Vec<serde_json::Value> {
    let Ok(body) = get(host, port, "/shares.json").await else {
        return Vec::new();
    };
    let Ok(shares) = serde_json::from_str::<Vec<serde_json::Value>>(&body) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for share in shares {
        let slug = share.get("slug").and_then(|v| v.as_str()).unwrap_or_default();
        let mode = share.get("mode").and_then(|v| v.as_str()).unwrap_or_default();
        if slug.is_empty() || mode != "media" {
            continue;
        }

        let Ok(body) = get(host, port, &format!("/{slug}/index.json")).await else {
            continue;
        };
        let Ok(entries) = serde_json::from_str::<Vec<serde_json::Value>>(&body) else {
            continue;
        };

        for entry in entries {
            let rel = entry.get("relPath").and_then(|v| v.as_str()).unwrap_or_default();
            if rel.is_empty() {
                continue;
            }
            let mut item = entry.clone();
            let Some(fields) = item.as_object_mut() else { continue };

            // Ids must not collide with the same file on another device, and
            // must stay stable so playback positions survive a refresh.
            fields.insert(
                "id".into(),
                serde_json::Value::String(format!("{peer_id}:{slug}:{rel}")),
            );
            fields.insert("peerId".into(), serde_json::Value::String(peer_id.into()));
            if let Some(url) = entry.get("streamUrl").and_then(|v| v.as_str()) {
                // The peer built the URL from its own address; trust the host
                // we actually reached it on instead, which is the one that
                // works from here.
                let path = url.splitn(4, '/').nth(3).unwrap_or_default();
                fields.insert(
                    "streamUrl".into(),
                    serde_json::Value::String(format!("http://{host}:{port}/{path}")),
                );
            }
            out.push(item);
        }
    }
    out
}

/// Refreshes the library from every peer with a live link, then republishes it.
///
/// Local entries are rebuilt first so the two halves cannot drift: this is the
/// one place that decides what Theatre shows.
pub async fn refresh_all(app: AppHandle, state: AppState) {
    let local = crate::media::refresh(&state);

    let (links, peers, default_port) = state.with(|s| {
        (
            s.links.connected(),
            s.peers.values().cloned().collect::<Vec<_>>(),
            s.net.host_port,
        )
    });

    let mut remote = Vec::new();
    for peer in peers {
        if !links.contains(&peer.device_id) {
            continue;
        }
        // A device can answer on several addresses; the first that responds
        // is the one this device can actually stream from.
        let mut addresses = peer.addresses.clone();
        if !peer.ip.is_empty() && !addresses.contains(&peer.ip) {
            addresses.push(peer.ip.clone());
        }
        for address in addresses {
            let items = fetch_peer(&peer.device_id, &address, default_port).await;
            if !items.is_empty() {
                remote.extend(items);
                break;
            }
        }
    }

    let all: Vec<serde_json::Value> = local.into_iter().chain(remote).collect();
    state.with(|s| s.media = all.clone());
    let _ = app.emit("media:changed", &all);
}

/// Kicks off a refresh without making the caller wait for the network.
pub fn spawn_refresh(app: &AppHandle, state: &AppState) {
    let app = app.clone();
    let state = state.clone();
    tauri::async_runtime::spawn(refresh_all(app, state));
}
