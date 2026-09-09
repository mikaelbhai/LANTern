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

        -- Where the viewer got to in each title.
        --
        -- Kept in its own table rather than on the library rows: the library
        -- is rebuilt from disk on every scan, and a position that vanished
        -- when a folder was rescanned would be worse than none at all.
        CREATE TABLE IF NOT EXISTS progress (
            id           TEXT PRIMARY KEY,
            progress_sec REAL NOT NULL,
            duration_sec REAL,
            updated_at   INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS calls (
            id          TEXT PRIMARY KEY,
            kind        TEXT NOT NULL,
            peers       TEXT NOT NULL,
            started_at  INTEGER NOT NULL,
            duration_ms INTEGER NOT NULL,
            outcome     TEXT NOT NULL
        );

        -- Choices that are not about one title: the language someone reaches
        -- for by default. Kept apart from `progress` so a title with no saved
        -- position still opens in the right language.
        -- Devices refused outright. Kept apart from `peers`, which is a cache
        -- of who has been seen: a block has to outlive a peer disappearing
        -- from the list, or blocking someone would last until they reconnect.
        CREATE TABLE IF NOT EXISTS blocked (
            device_id  TEXT PRIMARY KEY,
            name       TEXT NOT NULL DEFAULT '',
            blocked_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS preferences (
            key   TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )?;

    // Which audio and subtitle track was chosen, alongside the position it was
    // chosen at. Added after the table shipped, so this runs as an alteration
    // rather than a column in the CREATE above — an existing library must keep
    // the positions it already has.
    for column in ["audio_lang", "subtitle_lang"] {
        // A duplicate-column error is the expected outcome on every run after
        // the first, and means the schema is already current.
        let _ = conn.execute(
            &format!("ALTER TABLE progress ADD COLUMN {column} TEXT"),
            [],
        );
    }

    Ok(())
}
