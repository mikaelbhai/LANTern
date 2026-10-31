//! Watch history that follows a person between their own devices.
//!
//! Where somebody had got to in a film lived on the device they watched it on.
//! Pick up the phone after an evening on the PC and it knew nothing; "Continue
//! watching" was empty and the film began again. Between devices paired as
//! *one's own* (never merely trusted ones - what somebody watches is nobody
//! else's business) the positions now travel.
//!
//! The unit is the same one resume already uses: a **title key** (its name, the
//! episode, its length), not a file id, so it is the *film* that is followed
//! and not the copy of it. A received position is stored beside the local ones
//! under its own id (`sync:<key>`); `media::resume_for` already picks the newest
//! row for a key, so Continue watching, "Watch again" and the resume position
//! need to know nothing about where a place came from.
//!
//! Three ways for a position to arrive, because each fails differently:
//!
//! 1. **Pushed over the signalling link** - on connecting, after pairing, and a
//!    few seconds after each position is saved. Fast, and gone if the link is.
//! 2. **Pulled over HTTP** (`/sync/progress.json`) - on start, when asked, and
//!    every few minutes, for when a push was lost or the link was down.
//! 3. **Read off the other device's own listing** (`library::refresh_all`) - a
//!    title a companion has been watching shows its position before any of the
//!    above has run.

use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::state::AppState;

/// The id a received position is stored under.
const RECEIVED: &str = "sync:";

/// How far into the future a device's clock may claim a position was saved.
/// A clock that is a day fast would otherwise win every merge until it was
/// corrected, and everything saved on the other device meanwhile would lose.
const CLOCK_SLACK_MS: i64 = 5 * 60 * 1000;

/// A position that is a stray "back to the start" for a film well into it is
/// refused unless it is clearly a later decision (somebody starting over).
const RESET_BELOW_SEC: f64 = 5.0;
const REAL_ABOVE_SEC: f64 = 60.0;
const RESET_GRACE_MS: i64 = 10 * 60 * 1000;

/// One title's place, as it travels. Short names: a library is hundreds of these.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Row {
    #[serde(rename = "k")]
    pub key: String,
    #[serde(rename = "p")]
    pub sec: f64,
    #[serde(rename = "d", default)]
    pub dur: f64,
    #[serde(rename = "t")]
    pub at: i64,
    #[serde(rename = "a", default, skip_serializing_if = "Option::is_none")]
    pub audio: Option<String>,
    #[serde(rename = "s", default, skip_serializing_if = "Option::is_none")]
    pub sub: Option<String>,
}

/// This device's own saved positions newer than `since`, oldest first.
///
/// Only ones this device wrote: what it received from another is not sent on, so
/// two devices cannot bounce a position between them, and a third has its own
/// direct link.
pub fn export_rows(state: &AppState, since: i64, limit: usize) -> Vec<Row> {
    state.with(|s| {
        let Some(db) = s.db.as_ref() else { return Vec::new() };
        let Ok(mut stmt) = db.prepare(
            "SELECT title_key, progress_sec, COALESCE(duration_sec, 0), updated_at, audio_lang, subtitle_lang
             FROM progress
             WHERE title_key IS NOT NULL AND title_key != '' AND id NOT LIKE 'sync:%' AND updated_at > ?1
             ORDER BY updated_at ASC LIMIT ?2",
        ) else {
            return Vec::new();
        };
        stmt.query_map(rusqlite::params![since, limit as i64], |r| {
            Ok(Row {
                key: r.get(0)?,
                sec: r.get(1)?,
                dur: r.get(2)?,
                at: r.get(3)?,
                audio: r.get::<_, Option<String>>(4).unwrap_or(None).filter(|v| !v.is_empty()),
                sub: r.get::<_, Option<String>>(5).unwrap_or(None).filter(|v| !v.is_empty()),
            })
        })
        .map(|rows| rows.flatten().collect())
        .unwrap_or_default()
    })
}

/// The newest place this device holds for a title, from any source.
fn newest_for(state: &AppState, key: &str) -> Option<(f64, i64)> {
    state.with(|s| {
        let db = s.db.as_ref()?;
        db.query_row(
            "SELECT progress_sec, updated_at FROM progress WHERE title_key = ?1
             ORDER BY updated_at DESC LIMIT 1",
            [key],
            |r| Ok((r.get::<_, f64>(0)?, r.get::<_, i64>(1)?)),
        )
        .ok()
    })
}

/// Whether a position from another device should replace what is held here.
///
/// The newer word wins - that is what "where I had got to" means across devices
/// - except that a stray return to the very start does not beat a film well
/// into it unless it is a clearly later decision. A rebuilt player reports zero,
/// and that must not travel to the other device and wipe the place there.
pub fn should_take(local: Option<(f64, i64)>, remote: &Row) -> bool {
    if !remote.sec.is_finite() || remote.sec < 0.0 || remote.key.is_empty() {
        return false;
    }
    let Some((local_sec, local_at)) = local else { return true };
    if remote.at <= local_at {
        return false;
    }
    if remote.sec < RESET_BELOW_SEC && local_sec > REAL_ABOVE_SEC && remote.at - local_at < RESET_GRACE_MS {
        return false;
    }
    true
}

/// Stores what should be stored and says how many it took.
pub fn import_rows(state: &AppState, rows: &[Row]) -> usize {
    let now = crate::model::now_ms() as i64;
    let mut taken = 0;
    for row in rows {
        let mut row = row.clone();
        row.at = row.at.min(now + CLOCK_SLACK_MS);
        if !should_take(newest_for(state, &row.key), &row) {
            continue;
        }
        let stored = state.with(|s| {
            let Some(db) = s.db.as_ref() else { return false };
            db.execute(
                "INSERT INTO progress (id, progress_sec, duration_sec, updated_at, title_key, audio_lang, subtitle_lang)
                 VALUES (?7 || ?1, ?2, ?3, ?4, ?1, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                    progress_sec = ?2, duration_sec = ?3, updated_at = ?4, title_key = ?1,
                    audio_lang = COALESCE(?5, audio_lang), subtitle_lang = COALESCE(?6, subtitle_lang)",
                rusqlite::params![row.key, row.sec, row.dur, row.at, row.audio, row.sub, RECEIVED],
            )
            .is_ok()
        });
        if stored {
            taken += 1;
        }
    }
    taken
}

/* ---------------------------------------------------------------- marks */

/// What each paired device has acknowledged, so a reconnect sends only what is
/// new instead of the whole history every time.
pub fn mark(state: &AppState, peer: &str, column: &str) -> i64 {
    let column = if column == "got_upto" { "got_upto" } else { "sent_upto" };
    state.with(|s| {
        s.db.as_ref()
            .and_then(|db| {
                db.query_row(
                    &format!("SELECT {column} FROM sync_marks WHERE peer_id = ?1"),
                    [peer],
                    |r| r.get::<_, i64>(0),
                )
                .ok()
            })
            .unwrap_or(0)
    })
}

/// Moves a mark forward; never back.
pub fn set_mark(state: &AppState, peer: &str, column: &str, upto: i64) {
    let column = if column == "got_upto" { "got_upto" } else { "sent_upto" };
    state.with(|s| {
        if let Some(db) = s.db.as_ref() {
            let _ = db.execute(
                &format!(
                    "INSERT INTO sync_marks (peer_id, {column}) VALUES (?1, ?2)
                     ON CONFLICT(peer_id) DO UPDATE SET {column} = MAX({column}, ?2)"
                ),
                rusqlite::params![peer, upto],
            );
        }
    });
}

/// Notes that something arrived from a device, for the status line.
pub fn record_sync(state: &AppState, peer: &str, rows: usize) {
    state.with(|s| {
        if let Some(db) = s.db.as_ref() {
            let _ = db.execute(
                "INSERT INTO sync_marks (peer_id, synced_at, rows_total) VALUES (?1, ?2, ?3)
                 ON CONFLICT(peer_id) DO UPDATE SET synced_at = ?2, rows_total = rows_total + ?3",
                rusqlite::params![peer, crate::model::now_ms() as i64, rows as i64],
            );
        }
    });
}

/// Whether this device and that one are paired as the same person's.
pub fn is_companion(state: &AppState, peer: &str) -> bool {
    state.with(|s| s.companions.contains(peer))
}

/* -------------------------------------------------------------- sending */

/// Sends a companion everything it has not acknowledged yet.
///
/// In slices, each carrying the newest time in it; the answer for a slice moves
/// the mark, so one that is lost is sent again next time.
pub fn push_to(state: &AppState, peer: &str) {
    if !is_companion(state, peer) {
        return;
    }
    let (links, me) = state.with(|s| (s.links.clone(), s.device_id.clone()));
    let mut since = mark(state, peer, "sent_upto");
    for _ in 0..40 {
        let rows = export_rows(state, since, 300);
        let Some(last) = rows.last().map(|r| r.at) else { break };
        let sent = links.send(
            peer,
            &crate::signaling::Envelope {
                v: 1,
                from: me.clone(),
                kind: "progresssync".into(),
                payload: json!({ "rows": rows, "upto": last }),
            },
        );
        if !sent {
            break;
        }
        since = last;
    }
}

/// To every paired device that is linked now.
pub fn push_all(state: &AppState) {
    let peers: Vec<String> = state.with(|s| {
        s.companions.iter().filter(|id| s.links.has(id)).cloned().collect()
    });
    for peer in peers {
        push_to(state, &peer);
    }
}

/// Called whenever a position is saved: a few seconds later, everything new goes
/// out once - not on every five-second save of a film being watched.
pub fn note_saved(state: &AppState) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static PENDING: AtomicBool = AtomicBool::new(false);
    if PENDING.swap(true, Ordering::SeqCst) {
        return;
    }
    let state = state.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3));
        PENDING.store(false, Ordering::SeqCst);
        push_all(&state);
    });
}

/* -------------------------------------------------------------- pulling */

/// Asks a companion's file server for what it has newer than the last pull.
///
/// The fallback for a push that was lost, or a link that was down when it was
/// sent. Answered only to a device the other end knows as one of its own.
pub async fn pull_from(state: &AppState, peer: &str) -> usize {
    if !is_companion(state, peer) {
        return 0;
    }
    let Some((host, port)) = crate::library::reachable_address(state, peer).await else {
        return 0;
    };
    let key = state.with(|s| s.held_keys.get(peer).cloned());
    let since = mark(state, peer, "got_upto");
    let route = match key {
        Some(k) => format!("/sync/progress.json?since={since}&k={k}"),
        None => format!("/sync/progress.json?since={since}"),
    };
    let Ok(body) = crate::library::get(&host, port, &route).await else { return 0 };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(&body) else { return 0 };
    let rows: Vec<Row> = value
        .get("rows")
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default();
    let newest = rows.iter().map(|r| r.at).max().unwrap_or(0);
    let taken = import_rows(state, &rows);
    if newest > 0 {
        set_mark(state, peer, "got_upto", newest);
    }
    record_sync(state, peer, taken);
    taken
}

/// Both directions with everyone, now. Returns how many positions came in.
pub async fn sync_now(state: &AppState) -> usize {
    let peers: Vec<String> = state.with(|s| s.companions.iter().cloned().collect());
    let mut taken = 0;
    for peer in peers {
        taken += pull_from(state, &peer).await;
        let owned = state.clone();
        let target = peer.clone();
        let _ = tokio::task::spawn_blocking(move || push_to(&owned, &target)).await;
    }
    taken
}

/// What the interface shows: who is paired, when each last sent something.
pub fn status(state: &AppState) -> serde_json::Value {
    state.with(|s| {
        let Some(db) = s.db.as_ref() else {
            return json!({ "devices": [], "held": 0 });
        };
        let mut devices = Vec::new();
        for id in &s.companions {
            let (at, rows) = db
                .query_row(
                    "SELECT synced_at, rows_total FROM sync_marks WHERE peer_id = ?1",
                    [id],
                    |r| Ok((r.get::<_, i64>(0).unwrap_or(0), r.get::<_, i64>(1).unwrap_or(0))),
                )
                .unwrap_or((0, 0));
            devices.push(json!({ "deviceId": id, "syncedAt": at, "rows": rows, "linked": s.links.has(id) }));
        }
        let held: i64 = db
            .query_row("SELECT COUNT(*) FROM progress WHERE id LIKE 'sync:%'", [], |r| r.get(0))
            .unwrap_or(0);
        json!({ "devices": devices, "held": held })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn state_with_db() -> (AppState, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("lantern-history-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = AppState::new();
        state.with(|s| s.db = Some(crate::db::open(&dir).unwrap()));
        (state, dir)
    }

    fn row(key: &str, sec: f64, at: i64) -> Row {
        Row { key: key.into(), sec, dur: 6000.0, at, audio: None, sub: None }
    }

    #[test]
    fn the_newer_word_wins_and_the_older_does_not() {
        assert!(should_take(None, &row("film", 100.0, 5)), "nothing here yet");
        assert!(should_take(Some((100.0, 1000)), &row("film", 3000.0, 2000)), "later and further on");
        assert!(should_take(Some((3000.0, 1000)), &row("film", 100.0, 2000_000)), "a later rewatch is a later decision");
        assert!(!should_take(Some((3000.0, 2000)), &row("film", 100.0, 1000)), "older loses");
        assert!(!should_take(Some((3000.0, 2000)), &row("film", 3100.0, 2000)), "a tie stays as it is");
    }

    #[test]
    fn a_stray_return_to_the_start_does_not_wipe_a_place() {
        // What a rebuilt player reports, a moment after the real position.
        assert!(!should_take(Some((3600.0, 1_000_000)), &row("film", 0.0, 1_000_500)));
        // But somebody starting over, long after, is allowed.
        assert!(should_take(Some((3600.0, 1_000_000)), &row("film", 0.0, 1_000_000 + 11 * 60 * 1000)));
    }

    #[test]
    fn nonsense_is_not_taken() {
        assert!(!should_take(None, &row("", 10.0, 1)));
        assert!(!should_take(None, &row("film", f64::NAN, 1)));
        assert!(!should_take(None, &row("film", -5.0, 1)));
    }

    #[test]
    fn a_place_made_on_one_device_arrives_on_the_other_and_is_not_sent_back() {
        let (pc, d1) = state_with_db();
        let (phone, d2) = state_with_db();
        assert!(crate::media::save_progress(&pc, "pc:Films/Q.mkv", 2400.0, 6000.0, Some("thequietharbour"), false));

        let rows = export_rows(&pc, 0, 100);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].key, "thequietharbour");

        assert_eq!(import_rows(&phone, &rows), 1);
        // The same film under another device's id and another file name.
        let saved = crate::media::stored_progress(&phone);
        let resume = crate::media::resume_for(&saved, "phone:copy/Q.mkv", Some("thequietharbour"), 6000.0)
            .expect("the place followed the film");
        assert_eq!(resume.progress_sec, 2400.0);

        // And what arrived is not exported again: no bouncing between devices.
        assert!(export_rows(&phone, 0, 100).is_empty());
        let _ = std::fs::remove_dir_all(d1);
        let _ = std::fs::remove_dir_all(d2);
    }

    #[test]
    fn a_later_place_here_beats_an_older_one_that_arrives() {
        let (phone, dir) = state_with_db();
        assert!(crate::media::save_progress(&phone, "phone:Q.mkv", 4000.0, 6000.0, Some("film"), false));
        // The PC's, from long ago.
        assert_eq!(import_rows(&phone, &[row("film", 900.0, 1000)]), 0);
        let saved = crate::media::stored_progress(&phone);
        let resume = crate::media::resume_for(&saved, "phone:Q.mkv", Some("film"), 6000.0).unwrap();
        assert_eq!(resume.progress_sec, 4000.0);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn a_clock_a_day_fast_does_not_win_for_a_day() {
        let (phone, dir) = state_with_db();
        let now = crate::model::now_ms() as i64;
        assert_eq!(import_rows(&phone, &[row("film", 500.0, now + 24 * 3600 * 1000)]), 1);
        let at = newest_for(&phone, "film").unwrap().1;
        assert!(at <= now + CLOCK_SLACK_MS + 1000, "its claimed time was clamped, not believed");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn marks_only_move_forward_and_the_two_directions_are_separate() {
        let (state, dir) = state_with_db();
        assert_eq!(mark(&state, "pc", "sent_upto"), 0);
        set_mark(&state, "pc", "sent_upto", 500);
        set_mark(&state, "pc", "sent_upto", 100);
        assert_eq!(mark(&state, "pc", "sent_upto"), 500);
        set_mark(&state, "pc", "got_upto", 900);
        assert_eq!(mark(&state, "pc", "got_upto"), 900);
        assert_eq!(mark(&state, "pc", "sent_upto"), 500);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn only_companions_count_as_companions() {
        let state = AppState::new();
        assert!(!is_companion(&state, "stranger"));
        state.with(|s| {
            s.companions.insert("mine".into());
        });
        assert!(is_companion(&state, "mine"));
    }
}
