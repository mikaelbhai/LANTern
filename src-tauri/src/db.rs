//! Local SQLite store. Nothing here ever leaves the device.

use std::path::Path;

use rusqlite::Connection;

pub fn open(dir: &Path) -> anyhow::Result<Connection> {
    std::fs::create_dir_all(dir)?;
    let conn = Connection::open(dir.join("lantern.db"))?;
    // WAL keeps reads from blocking the transfer writer.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.pragma_update(None, "synchronous", "NORMAL")?;
    migrate(&conn)?;
    Ok(conn)
}

fn migrate(conn: &Connection) -> anyhow::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS transfers (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            size        INTEGER NOT NULL,
            sent        INTEGER NOT NULL DEFAULT 0,
            peer_id     TEXT NOT NULL,
            direction   TEXT NOT NULL,
            state       TEXT NOT NULL,
            mime        TEXT NOT NULL DEFAULT '',
            local_path  TEXT,
            started_at  INTEGER NOT NULL,
            finished_at INTEGER,
            expires_at  INTEGER
        );
        CREATE INDEX IF NOT EXISTS transfers_started ON transfers(started_at DESC);

        CREATE TABLE IF NOT EXISTS shares (
            id            TEXT PRIMARY KEY,
            name          TEXT NOT NULL,
            path          TEXT NOT NULL,
            slug          TEXT NOT NULL UNIQUE,
            mode          TEXT NOT NULL,
            running       INTEGER NOT NULL DEFAULT 1,
            require_phrase INTEGER NOT NULL DEFAULT 0,
            phrase        TEXT,
            allow_upload  INTEGER NOT NULL DEFAULT 0,
            file_count    INTEGER NOT NULL DEFAULT 0,
            total_bytes   INTEGER NOT NULL DEFAULT 0,
            created_at    INTEGER NOT NULL,
            requests      INTEGER NOT NULL DEFAULT 0,
            bytes_served  INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS peers (
            id       TEXT PRIMARY KEY,
            name     TEXT NOT NULL,
            ip       TEXT NOT NULL,
            port     INTEGER NOT NULL,
            trusted  INTEGER NOT NULL DEFAULT 1,
            last_seen INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS calls (
            id          TEXT PRIMARY KEY,
            kind        TEXT NOT NULL,
            peers       TEXT NOT NULL,
            started_at  INTEGER NOT NULL,
            duration_ms INTEGER NOT NULL,
            outcome     TEXT NOT NULL
        );",
    )?;
    Ok(())
}
