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
/// Points every URL in a peer's manifest at the address we reached it on.
///
/// A machine with more than one network interface answers on several
/// addresses, and it builds its manifest using whichever one it considers its
/// own. That is frequently not the one that works from here: a phone on the
/// second interface's subnet cannot reach the first interface's address at
/// all, so the library arrived full of posters, subtitles and audio tracks
/// pointing somewhere unreachable while the peer itself was plainly online.
///
/// Only `streamUrl` used to be corrected, so a film would start and have no
/// artwork, no subtitles and no way to change language.
///
/// Every string in the manifest that addresses the peer's own server is
/// rewritten, so a field added later is covered without anyone remembering to
/// come back here.
fn rehost(value: &mut serde_json::Value, host: &str, port: u16) {
    match value {
        serde_json::Value::String(text) => {
            if let Some(rest) = text.strip_prefix("http://") {
                // Split off the authority; keep the path and query exactly.
                let path = rest.split_once('/').map(|(_, p)| p).unwrap_or("");
                *text = format!("http://{host}:{port}/{path}");
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                rehost(item, host, port);
            }
        }
        serde_json::Value::Object(fields) => {
            for (_, field) in fields.iter_mut() {
                rehost(field, host, port);
            }
        }
        _ => {}
    }
}

/// Reads a peer's shared library.
///
/// `None` means the peer's file server could not be reached at this address;
/// `Some(vec![])` means it answered and is sharing nothing. Collapsing the two
/// into an empty list is what made a blocked port look identical to an empty
/// library, and left Theatre with nothing to say.
pub async fn fetch_peer(
    peer_id: &str,
    host: &str,
    port: u16,
) -> Option<Vec<serde_json::Value>> {
    let body = get(host, port, "/shares.json").await.ok()?;
    let shares = serde_json::from_str::<Vec<serde_json::Value>>(&body).ok()?;

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

            // Every address in the manifest, not just the one to press play on.
            rehost(&mut item, host, port);
            out.push(item);
        }
    }
    Some(out)
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

    // Peers that are linked and talking, but whose library could not be read
    // from any of their addresses. This is worth naming rather than showing an
    // empty Theatre: it means the peer is right there and something between
    // the two devices is dropping the connection to its file server - most
    // often a firewall that allows the app on one network profile and not the
    // other, which looks exactly like "calls work but videos do not".
    let mut unreachable: Vec<String> = Vec::new();

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

        let mut reached = false;
        for address in addresses {
            if let Some(items) = fetch_peer(&peer.device_id, &address, default_port).await {
                remote.extend(items);
                reached = true;
                break;
            }
        }

        // Answered on none of its addresses, while the signalling link to it is
        // live. The peer is there; the path to its file server is not.
        if !reached {
            unreachable.push(peer.name.clone());
        }
    }

    let all: Vec<serde_json::Value> = local.into_iter().chain(remote).collect();
    state.with(|s| {
        s.media = all.clone();
        s.library_unreachable = unreachable.clone();
    });
    let _ = app.emit("media:changed", &all);
    let _ = app.emit("library:unreachable", &unreachable);
}

/// Kicks off a refresh without making the caller wait for the network.
pub fn spawn_refresh(app: &AppHandle, state: &AppState) {
    let app = app.clone();
    let state = state.clone();
    tauri::async_runtime::spawn(refresh_all(app, state));
}

#[cfg(test)]
mod rehost_tests {
    use super::rehost;

    #[test]
    fn every_address_in_the_manifest_is_corrected() {
        let mut item = serde_json::json!({
            "title": "A Film",
            "streamUrl": "http://192.168.1.5:7981/media/A%20Film.mkv",
            "posterUrl": "http://192.168.1.5:7981/media/A%20Film.mkv?thumb=1",
            "subtitles": [
                { "label": "English", "url": "http://192.168.1.5:7981/media/A%20Film.mkv?subtitle=3" }
            ],
            "durationSec": 5971.0
        });

        rehost(&mut item, "10.0.0.9", 7981);

        assert_eq!(
            item["streamUrl"], "http://10.0.0.9:7981/media/A%20Film.mkv",
            "the film itself"
        );
        assert_eq!(
            item["posterUrl"], "http://10.0.0.9:7981/media/A%20Film.mkv?thumb=1",
            "artwork was the field that stayed broken"
        );
        assert_eq!(
            item["subtitles"][0]["url"],
            "http://10.0.0.9:7981/media/A%20Film.mkv?subtitle=3",
            "nested inside an array"
        );
        assert_eq!(item["durationSec"], 5971.0, "non-URL fields are untouched");
        assert_eq!(item["title"], "A Film", "plain strings are untouched");
    }

    #[test]
    fn a_query_string_survives_intact() {
        let mut v = serde_json::Value::String(
            "http://192.168.1.5:7981/media/x.mkv?audio=4&codec=E-AC-3&t=2362".into(),
        );
        rehost(&mut v, "10.0.0.9", 7981);
        assert_eq!(v, "http://10.0.0.9:7981/media/x.mkv?audio=4&codec=E-AC-3&t=2362");
    }
}
