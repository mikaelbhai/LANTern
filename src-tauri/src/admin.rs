//! What the owner key may change on a machine that agreed to it: hide titles,
//! change ratings, publish or unlist a folder.
//!
//! Every one of these already exists as a command the person at the machine
//! uses on their own screen, and each is only ever meant to be called on the
//! machine holding the files. This is the same change made on their behalf by
//! a key that has proven itself on the live link - `owner_proven` is set only
//! by `ownerkey::on_proof`, per link - and nothing else is reachable: a fixed
//! list of operations, not a way to call any command by name.
//!
//! Nothing it does is invisible. Each change is written to `admin_log` and
//! shown on this machine as it happens.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::oneshot;

use crate::model::now_ms;
use crate::signaling::Envelope;
use crate::state::AppState;

/// A title list this long is a page, not a library: one reply is one line on
/// one link.
const PAGE: usize = 300;
const MAX_PATHS: usize = 2000;
const CALL_TIMEOUT: Duration = Duration::from_secs(20);

type Res<T> = Result<T, String>;

/* ----------------------------------------------------------- machine side */

/// The device that is currently the owner key on a live link.
pub(crate) fn is_owner(state: &AppState, device: &str) -> bool {
    crate::ownerkey::enabled(state) && state.with(|s| s.owner.proven.contains(device))
}

fn reply(state: &AppState, to: &str, id: &str, result: Res<Value>) {
    let (links, me) = state.with(|s| (s.links.clone(), s.device_id.clone()));
    let payload = match result {
        Ok(data) => json!({ "id": id, "ok": true, "data": data }),
        Err(error) => json!({ "id": id, "ok": false, "error": error }),
    };
    links.send(to, &Envelope { v: 1, from: me, kind: "adminres".into(), payload });
}

/// Answers one request. `exec` does the work, and is not called for anybody
/// who has not proven they are the key.
pub(crate) fn serve_request(
    state: &AppState,
    from: &str,
    payload: &Value,
    exec: impl FnOnce(&str, &Value) -> Res<Value>,
) {
    let id = payload.get("id").and_then(|v| v.as_str()).unwrap_or_default().to_string();
    if !is_owner(state, from) {
        reply(state, from, &id, Err("this device is not an owner key here".into()));
        return;
    }
    let op = payload.get("op").and_then(|v| v.as_str()).unwrap_or_default();
    let args = payload.get("args").cloned().unwrap_or(Value::Null);
    reply(state, from, &id, exec(op, &args));
}

fn paths(args: &Value) -> Res<Vec<String>> {
    let list = args.get("paths").and_then(|v| v.as_array()).ok_or("paths is missing")?;
    if list.len() > MAX_PATHS {
        return Err("too many titles at once".into());
    }
    list.iter()
        .map(|p| {
            p.as_str()
                .filter(|s| s.starts_with('/') && !s.contains(".."))
                .map(str::to_string)
                .ok_or_else(|| "a title path is malformed".to_string())
        })
        .collect()
}

fn text(args: &Value, key: &str) -> Res<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .ok_or_else(|| format!("{key} is missing"))
}

/// Hides or shows titles. Takes effect in the serving code at once, and on
/// what peers have cached when the library next refreshes.
pub(crate) fn hide_titles(state: &AppState, paths: &[String], hidden: bool) {
    state.with(|s| {
        for path in paths {
            if hidden {
                s.hidden.insert(path.clone());
                if let Some(db) = s.db.as_ref() {
                    let _ = db.execute(
                        "INSERT OR IGNORE INTO hidden_titles (stream_path) VALUES (?1)",
                        rusqlite::params![path],
                    );
                }
            } else {
                s.hidden.remove(path);
                if let Some(db) = s.db.as_ref() {
                    let _ = db.execute(
                        "DELETE FROM hidden_titles WHERE stream_path = ?1",
                        rusqlite::params![path],
                    );
                }
            }
        }
    });
}

/// Every rule and every title, one page of titles at a time.
pub(crate) fn library_list(state: &AppState, offset: usize, limit: usize) -> Value {
    let (media, by_hand, hidden, shares, device_ages, default_age) = state.with(|s| {
        let default_age = s
            .db
            .as_ref()
            .and_then(|db| {
                db.query_row(
                    "SELECT value FROM preferences WHERE key = 'default_max_age'",
                    [],
                    |r| r.get::<_, String>(0),
                )
                .ok()
            })
            .and_then(|v| v.parse::<u8>().ok())
            .unwrap_or(crate::rating::DEFAULT_MAX_AGE);
        (
            s.media
                .iter()
                .filter(|m| m.get("peerId").map(|v| v.is_null()).unwrap_or(true))
                .cloned()
                .collect::<Vec<_>>(),
            s.title_ages.clone(),
            s.hidden.clone(),
            s.shares
                .iter()
                .map(|sh| {
                    json!({
                        "id": sh.id,
                        "name": sh.name,
                        "slug": sh.slug,
                        "unlisted": sh.unlisted,
                        "audience": sh.audience,
                        "running": sh.running,
                    })
                })
                .collect::<Vec<_>>(),
            s.device_ages
                .iter()
                .map(|(id, age)| {
                    let name = s
                        .peers
                        .values()
                        .find(|p| &p.device_id == id)
                        .map(|p| p.name.clone())
                        .unwrap_or_default();
                    json!({ "deviceId": id, "name": name, "maxAge": age })
                })
                .collect::<Vec<_>>(),
            default_age,
        )
    });

    let mut titles: Vec<Value> = media
        .into_iter()
        .map(|mut item| {
            crate::rating::annotate_with(&by_hand, &mut item);
            let path = item.get("streamPath").and_then(|v| v.as_str()).unwrap_or_default().to_string();
            json!({
                "streamPath": path,
                "title": item.get("title").cloned().unwrap_or(Value::Null),
                "relPath": item.get("relPath").cloned().unwrap_or(Value::Null),
                "minAge": item.get("minAge").cloned().unwrap_or(Value::Null),
                "ratedByHost": item.get("ratedByHost").cloned().unwrap_or(Value::Bool(false)),
                "hidden": hidden.contains(&path),
                "shareId": item.get("shareId").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    titles.sort_by(|a, b| {
        a["title"]
            .as_str()
            .unwrap_or_default()
            .to_lowercase()
            .cmp(&b["title"].as_str().unwrap_or_default().to_lowercase())
    });
    let total = titles.len();
    let page: Vec<Value> = titles.into_iter().skip(offset).take(limit.clamp(1, PAGE)).collect();

    json!({
        "total": total,
        "offset": offset,
        "titles": page,
        "folders": shares,
        "devices": device_ages,
        "defaultAge": default_age,
    })
}

/// The one list of things the key may do.
fn run(app: &AppHandle, state: &AppState, op: &str, args: &Value) -> Res<Value> {
    match op {
        "library.list" => {
            let offset = args.get("offset").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
            let limit = args.get("limit").and_then(|v| v.as_u64()).unwrap_or(PAGE as u64) as usize;
            Ok(library_list(state, offset, limit))
        }
        "rating.titles" => {
            let list = paths(args)?;
            let age = args.get("minAge").and_then(|v| v.as_u64()).map(|a| a.min(21) as u8);
            let n = crate::commands::ratings_set_titles_apply(app, state, list, age)?;
            Ok(json!({ "changed": n }))
        }
        "rating.device" => {
            let id = text(args, "deviceId")?;
            let age = args.get("maxAge").and_then(|v| v.as_u64()).ok_or("maxAge is missing")?;
            crate::commands::ratings_set_device_apply(app, state, id, age.min(21) as u8)?;
            Ok(Value::Null)
        }
        "rating.default" => {
            let age = args.get("maxAge").and_then(|v| v.as_u64()).ok_or("maxAge is missing")?;
            crate::commands::ratings_set_default_apply(app, state, age.min(21) as u8)?;
            Ok(Value::Null)
        }
        "rating.approve" => {
            let minutes = args.get("minutes").and_then(|v| v.as_u64()).map(|m| m as u32);
            crate::commands::ratings_approve_apply(
                app,
                state,
                text(args, "deviceId")?,
                text(args, "path")?,
                minutes,
            )?;
            Ok(Value::Null)
        }
        "rating.revoke" => {
            crate::commands::ratings_revoke_apply(
                app,
                state,
                text(args, "deviceId")?,
                text(args, "path")?,
            )?;
            Ok(Value::Null)
        }
        "audience.share" => {
            let ids: Vec<String> = args
                .get("deviceIds")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
                .unwrap_or_default();
            let unlisted = args.get("unlisted").and_then(|v| v.as_bool()).unwrap_or(false);
            crate::commands::host_set_audience_apply(app, state, text(args, "shareId")?, unlisted, ids)?;
            Ok(Value::Null)
        }
        "hide.titles" => {
            let list = paths(args)?;
            let hidden = args.get("hidden").and_then(|v| v.as_bool()).unwrap_or(true);
            hide_titles(state, &list, hidden);
            crate::library::spawn_refresh(app, state);
            Ok(json!({ "changed": list.len() }))
        }
        other => Err(format!("unknown operation {other}")),
    }
}

/// Leaves a record of a change, in the log and on this machine's screen.
fn record(app: &AppHandle, state: &AppState, from: &str, op: &str, args: &Value) {
    let by = state.with(|s| {
        s.owner
            .enrolled
            .as_ref()
            .map(|e| e.name.clone())
            .filter(|n| !n.is_empty())
            .or_else(|| s.peers.values().find(|p| p.device_id == from).map(|p| p.name.clone()))
            .unwrap_or_else(|| "The owner key".into())
    });
    let detail = {
        let mut d = args.to_string();
        d.truncate(400);
        d
    };
    state.with(|s| {
        if let Some(db) = s.db.as_ref() {
            let _ = db.execute(
                "INSERT INTO admin_log (at, by_name, op, detail) VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![now_ms() as i64, by, op, detail],
            );
        }
    });
    let _ = app.emit("admin:changed", json!({ "by": by, "op": op }));
}

pub(crate) fn on_envelope(app: &AppHandle, state: &AppState, envelope: &Envelope) -> bool {
    // Silent when switched off: not even a refusal, which would say the code is here.
    if !crate::ownerkey::enabled(state) {
        return envelope.kind.starts_with("admin");
    }
    match envelope.kind.as_str() {
        "adminreq" => {
            let from = envelope.from.clone();
            serve_request(state, &from, &envelope.payload, |op, args| {
                let result = run(app, state, op, args);
                if result.is_ok() && op != "library.list" {
                    record(app, state, &from, op, args);
                }
                result
            });
            true
        }
        "adminres" => {
            let id = envelope.payload.get("id").and_then(|v| v.as_str()).unwrap_or_default();
            let waiting = pending().lock().ok().and_then(|mut p| p.remove(id));
            if let Some(tx) = waiting {
                let _ = tx.send(envelope.payload.clone());
            }
            true
        }
        _ => false,
    }
}

/* --------------------------------------------------------------- key side */

fn pending() -> &'static Mutex<HashMap<String, oneshot::Sender<Value>>> {
    static PENDING: OnceLock<Mutex<HashMap<String, oneshot::Sender<Value>>>> = OnceLock::new();
    PENDING.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Asks a machine that accepted this key to make a change, and waits for its
/// answer. The machine decides: a refusal comes back as an error.
#[tauri::command]
pub async fn admin_call(
    state: State<'_, AppState>,
    peer_id: String,
    op: String,
    args: Value,
) -> Res<Value> {
    if !crate::ownerkey::enabled(&state) {
        return Err("not switched on".into());
    }
    let (links, me, device) = state.with(|s| {
        (
            s.links.clone(),
            s.device_id.clone(),
            s.peers
                .values()
                .find(|p| p.device_id == peer_id || p.id == peer_id)
                .map(|p| p.device_id.clone())
                .unwrap_or_else(|| peer_id.clone()),
        )
    });
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (tx, rx) = oneshot::channel();
    pending().lock().map_err(|_| "busy")?.insert(id.clone(), tx);
    let sent = links.send(
        &device,
        &Envelope {
            v: 1,
            from: me,
            kind: "adminreq".into(),
            payload: json!({ "id": id, "op": op, "args": args }),
        },
    );
    if !sent {
        let _ = pending().lock().map(|mut p| p.remove(&id));
        return Err("that device is not connected".into());
    }
    match tokio::time::timeout(CALL_TIMEOUT, rx).await {
        Ok(Ok(answer)) => {
            if answer.get("ok").and_then(|v| v.as_bool()).unwrap_or(false) {
                Ok(answer.get("data").cloned().unwrap_or(Value::Null))
            } else {
                Err(answer.get("error").and_then(|v| v.as_str()).unwrap_or("refused").to_string())
            }
        }
        _ => {
            let _ = pending().lock().map(|mut p| p.remove(&id));
            Err("no answer from that device".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    fn machine() -> (AppState, mpsc::UnboundedReceiver<String>) {
        let st = AppState::default();
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        crate::db::migrate(&conn).unwrap();
        let (tx, rx) = mpsc::unbounded_channel();
        st.with(|s| {
            s.db = Some(conn);
            s.device_id = "pc".into();
            s.links.insert("phone".into(), tx);
        });
        crate::ownerkey::tests::switch_on(&st);
        (st, rx)
    }

    fn persisted_hidden(st: &AppState, path: &str) -> bool {
        st.with(|s| {
            s.db.as_ref()
                .unwrap()
                .query_row("SELECT 1 FROM hidden_titles WHERE stream_path = ?1", [path], |_| Ok(()))
                .is_ok()
        })
    }

    fn answer(rx: &mut mpsc::UnboundedReceiver<String>) -> Value {
        let line = rx.try_recv().expect("no reply was sent");
        serde_json::from_str::<Envelope>(&line).unwrap().payload
    }

    #[test]
    fn a_request_from_anybody_but_the_proven_key_is_refused_and_does_nothing() {
        let (st, mut rx) = machine();
        let mut ran = false;
        serve_request(&st, "phone", &json!({ "id": "1", "op": "hide.titles" }), |_, _| {
            ran = true;
            Ok(Value::Null)
        });
        assert!(!ran, "the operation ran for a device that is not the key");
        let reply = answer(&mut rx);
        assert_eq!(reply["ok"], false);
        assert_eq!(reply["id"], "1");
    }

    #[test]
    fn a_claimed_id_without_a_proof_is_not_the_key() {
        let (st, mut rx) = machine();
        // Trusted and a companion, as a paired device would be, but never proven.
        st.with(|s| {
            s.trusted.insert("phone".into());
            s.companions.insert("phone".into());
        });
        serve_request(&st, "phone", &json!({ "id": "2", "op": "hide.titles" }), |_, _| {
            panic!("ran")
        });
        assert_eq!(answer(&mut rx)["ok"], false);
    }

    #[test]
    fn the_proven_key_is_served_and_its_answer_comes_back_under_its_id() {
        let (st, mut rx) = machine();
        crate::ownerkey::grant(&st, "phone");
        serve_request(&st, "phone", &json!({ "id": "3", "op": "x", "args": { "a": 1 } }), |op, args| {
            assert_eq!(op, "x");
            assert_eq!(args["a"], 1);
            Ok(json!({ "done": true }))
        });
        let reply = answer(&mut rx);
        assert_eq!(reply["ok"], true);
        assert_eq!(reply["id"], "3");
        assert_eq!(reply["data"]["done"], true);
    }

    #[test]
    fn hiding_is_remembered_and_can_be_undone() {
        let (st, _rx) = machine();
        hide_titles(&st, &["/m/a.mkv".to_string()], true);
        assert!(st.with(|s| s.hidden.contains("/m/a.mkv")));
        assert!(persisted_hidden(&st, "/m/a.mkv"));
        hide_titles(&st, &["/m/a.mkv".to_string()], false);
        assert!(!st.with(|s| s.hidden.contains("/m/a.mkv")));
        assert!(!persisted_hidden(&st, "/m/a.mkv"));
    }

    #[test]
    fn paths_that_climb_or_are_not_paths_are_refused() {
        assert!(paths(&json!({ "paths": ["/m/a.mkv"] })).is_ok());
        assert!(paths(&json!({ "paths": ["m/a.mkv"] })).is_err());
        assert!(paths(&json!({ "paths": ["/m/../x"] })).is_err());
        assert!(paths(&json!({ "paths": [1] })).is_err());
        assert!(paths(&json!({})).is_err());
    }

    #[test]
    fn the_list_says_what_is_hidden_and_what_was_rated_by_hand() {
        let (st, _rx) = machine();
        st.with(|s| {
            s.media.push(json!({
                "title": "Film A", "relPath": "Film A.mkv",
                "streamUrl": "http://10.0.0.2:7981/media/Film%20A.mkv", "shareId": "s1",
            }));
            s.media.push(json!({
                "title": "Film B", "relPath": "Film B.mkv",
                "streamUrl": "http://10.0.0.2:7981/media/Film%20B.mkv", "shareId": "s1",
            }));
            s.title_ages.insert("/media/Film A.mkv".into(), 18);
            s.hidden.insert("/media/Film B.mkv".into());
        });
        let list = library_list(&st, 0, 50);
        assert_eq!(list["total"], 2);
        let a = &list["titles"][0];
        assert_eq!(a["title"], "Film A");
        assert_eq!(a["minAge"], 18);
        assert_eq!(a["ratedByHost"], true);
        assert_eq!(a["hidden"], false);
        assert_eq!(list["titles"][1]["hidden"], true);
        // And a page is a page.
        assert_eq!(library_list(&st, 1, 1)["titles"].as_array().unwrap().len(), 1);
    }
}
