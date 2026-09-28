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

// `pub(crate)` so tests elsewhere can build an in-memory store with the
// real schema rather than a hand-written subset that drifts from it.
pub(crate) fn migrate(conn: &Connection) -> anyhow::Result<()> {
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

        -- Devices a published folder is for, when it is not for everyone.
        --
        -- No rows for a share means everyone, which is what publishing has
        -- always meant here and stays the default. Rows mean the folder is
        -- unlisted: it is absent from the index and from what peers are told
        -- this device publishes, and asking for it by name gets the same
        -- answer as asking for something that was never there.
        CREATE TABLE IF NOT EXISTS share_audience (
            share_id  TEXT NOT NULL,
            device_id TEXT NOT NULL,
            PRIMARY KEY (share_id, device_id)
        );

        -- One-off permission to watch something the rating would refuse.
        --
        -- Raising a device's allowance is the wrong shape for yes, just this
        -- once: it is a standing change made to answer a question about a
        -- single evening, and nobody ever puts it back. So an approval names
        -- what it covers and when it lapses, and the limit it steps around is
        -- left exactly as it was.
        --
        -- A stream_path of '*' covers everything; an expires_at of 0 never
        -- lapses, which is what approving one title means once it is given.
        CREATE TABLE IF NOT EXISTS approvals (
            device_id   TEXT NOT NULL,
            stream_path TEXT NOT NULL,
            expires_at  INTEGER NOT NULL,
            granted_at  INTEGER NOT NULL,
            PRIMARY KEY (device_id, stream_path)
        );

        -- Devices the host has vouched for: the other half of `blocked`.
        --
        -- Persisted for the same reason a block is. Trust used to live on the
        -- peer record, which is a cache of who has been seen, so it lasted
        -- until that device went quiet and then quietly went away - and the
        -- setting that depends on it, auto-accepting files from trusted
        -- peers, could never come true.
        CREATE TABLE IF NOT EXISTS trusted (
            device_id  TEXT PRIMARY KEY,
            name       TEXT NOT NULL DEFAULT '',
            trusted_at INTEGER NOT NULL
        );

        -- Devices allowed to drive this machine's pointer and keyboard
        -- without being asked again.
        --
        -- Persisted, unlike the grant itself, because that is what always
        -- allow means. It is the most consequential row in this database -
        -- an entry here is standing permission to type into whatever has
        -- focus - so the window lists them and can take one out, and the
        -- banner shows while control is live whether or not it was asked for.
        -- Hardware addresses, kept so a sleeping device can still be woken.
        --
        -- The address is only knowable while the machine is awake, which is
        -- exactly when nobody needs it. Written down every time a peer is
        -- seen, and read back when one is not.
        CREATE TABLE IF NOT EXISTS device_macs (
            device_id TEXT PRIMARY KEY,
            mac       TEXT NOT NULL,
            name      TEXT NOT NULL DEFAULT '',
            seen_at   INTEGER NOT NULL
        );

        -- How old each device is allowed to be, decided here and enforced
        -- here. A device never asks for a raise: it presents a key, and what
        -- that key may see is answered on this side.
        CREATE TABLE IF NOT EXISTS device_ages (
            device_id TEXT PRIMARY KEY,
            max_age   INTEGER NOT NULL
        );

        -- Ratings set by hand, which beat whatever the filename suggested.
        -- Keyed by the address the manifest advertises, so a correction
        -- survives a rescan.
        CREATE TABLE IF NOT EXISTS title_ages (
            stream_path TEXT PRIMARY KEY,
            min_age     INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS control_allowed (
            device_id  TEXT PRIMARY KEY,
            name       TEXT NOT NULL DEFAULT '',
            allowed_at INTEGER NOT NULL
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

    // Ratings and approvals are keyed by a title's path, and that path used to
    // be written down exactly as it appears in an address - brackets and
    // spaces escaped. The server checks them against the path its router hands
    // over, which is already unescaped, so the two only ever matched for a
    // filename with nothing in it worth escaping. Every restriction on a title
    // with a bracket or a space in its name was silently not in force.
    //
    // Rewriting them is the only way an existing library keeps the ratings
    // somebody already set: a fresh scan would not put them back, because
    // nothing rescans a rating.
    decode_title_paths(conn);

    // Whether a published folder is unlisted, which is a different fact from
    // who it is for. Added after the table shipped, so it runs as an
    // alteration; a duplicate-column error is the expected outcome on every
    // run after the first and means the schema is already current.
    //
    // Kept apart from `share_audience` deliberately. An empty audience used to
    // stand for everyone, which conflated two states: a folder published to
    // the network, and an unlisted folder nobody has been named on yet. The
    // second must show nobody, not everybody.
    let _ = conn.execute(
        "ALTER TABLE shares ADD COLUMN unlisted INTEGER NOT NULL DEFAULT 0",
        [],
    );

    // Addresses on a network this one cannot be found from.
    //
    // mDNS does not cross a NAT, so a device on the network above or below
    // this one is never discovered — it has to be dialled, and the address
    // has to survive a restart or the link is set up once and lost at the
    // next reboot. Learned from a person typing it, or from another device on
    // this LAN that already had it; see `upstream` in signaling.rs.
    let _ = conn.execute(
        "CREATE TABLE IF NOT EXISTS upstream_peers (
            address    TEXT NOT NULL,
            port       INTEGER NOT NULL,
            learned_at INTEGER NOT NULL,
            PRIMARY KEY (address, port)
        )",
        [],
    );

    // A pass phrase per rating tier, set by the host.
    //
    // Not in `preferences` with the other settings: these are secrets, and a
    // key/value table that the rest of the application reads freely is the
    // wrong place to keep one. Stored hashed for the same reason - a host who
    // uses the same four digits elsewhere should not have them readable by
    // anything that can open this file.
    let _ = conn.execute(
        "CREATE TABLE IF NOT EXISTS rating_pins (
            age  INTEGER PRIMARY KEY,
            hash TEXT NOT NULL
        )",
        [],
    );

    // Which devices have presented a pass phrase, and for what.
    //
    // Separate from `device_ages`, which is what the host granted. A tier
    // somebody unlocked by typing the PIN is a different fact from one the
    // host set for them, and conflating the two would let an unlock silently
    // outlive the host lowering the grant.
    let _ = conn.execute(
        "CREATE TABLE IF NOT EXISTS rating_unlocked (
            device_id TEXT NOT NULL,
            age       INTEGER NOT NULL,
            at        INTEGER NOT NULL,
            PRIMARY KEY (device_id, age)
        )",
        [],
    );

    // What kind of machine it is, so the offer to wake it can be withheld
    // from the ones that cannot be woken. A phone never answers a magic
    // packet - its radio is off in deep sleep and Android does not implement
    // Wake-on-LAN at all - so offering the button there is offering something
    // that silently does nothing.
    let _ = conn.execute(
        "ALTER TABLE device_macs ADD COLUMN os TEXT NOT NULL DEFAULT ''",
        [],
    );
    // And what the machine calls itself, as opposed to what its owner is
    // called. A row reading `Rehan` when three of his boxes are asleep says
    // nothing about which one you are looking at.
    let _ = conn.execute(
        "ALTER TABLE device_macs ADD COLUMN device_name TEXT NOT NULL DEFAULT ''",
        [],
    );

    // A title pulled from a peer onto this device, for offline viewing.
    //
    // Keyed by the *original* item id (peer share id : relative path), not
    // the synced copy's own id, which belongs to a different share entirely
    // - this is what lets Theatre ask "do I already have this one" about the
    // title someone is looking at, not about the local copy it would become.
    let _ = conn.execute(
        "CREATE TABLE IF NOT EXISTS synced (
            item_id    TEXT PRIMARY KEY,
            local_path TEXT NOT NULL,
            synced_at  INTEGER NOT NULL
        )",
        [],
    );

    Ok(())
}

/// Rewrites rating and approval keys from escaped paths to plain ones.
///
/// Runs on every start and does nothing after the first: a path that is
/// already plain decodes to itself. Rows that would collide with one already
/// carrying the right spelling are dropped rather than replacing it - the
/// plain one is the one in force, and keeping it is what makes this safe to
/// run twice.
fn decode_title_paths(conn: &Connection) {
    for (table, column) in [("title_ages", "stream_path"), ("approvals", "stream_path")] {
        let Ok(mut stmt) = conn.prepare(&format!("SELECT DISTINCT {column} FROM {table}")) else {
            continue;
        };
        let Ok(rows) = stmt.query_map([], |r| r.get::<_, String>(0)) else {
            continue;
        };
        let paths: Vec<String> = rows.flatten().collect();
        for path in paths {
            let plain = crate::rating::decode(&path);
            if plain == path {
                continue;
            }
            let moved = conn.execute(
                &format!("UPDATE OR IGNORE {table} SET {column} = ?1 WHERE {column} = ?2"),
                rusqlite::params![plain, path],
            );
            // Left behind by OR IGNORE because the plain spelling was already
            // there. The escaped one is then a duplicate of a row in force.
            if moved.is_ok() {
                let _ = conn.execute(
                    &format!("DELETE FROM {table} WHERE {column} = ?1"),
                    rusqlite::params![path],
                );
            }
        }
    }
}
