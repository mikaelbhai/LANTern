//! The part of LANTern that keeps running.
//!
//! Closing the app — or rebuilding it, which is the case that prompted this —
//! took the file server down with it. Anyone mid-download lost the transfer,
//! and a library that was there a moment ago simply vanished from everyone
//! else's Theatre. That is the wrong shape for something whose whole job is to
//! be reachable.
//!
//! So hosting can outlive the window. This binary is the smallest thing that
//! can serve: it opens the same database, reads the same published folders,
//! and answers on the same port. No interface, no calls, no chat — those need
//! somebody sitting in front of them, and the process would only be holding
//! resources for a person who is not there.
//!
//! It is deliberately a separate process rather than a background thread. A
//! thread dies with its process, which is exactly what we are trying to
//! survive.
//!
//! Handing over is by port. Only one process can hold 7981, so:
//!
//!   * the app, on starting, stops this one and takes over;
//!   * this one, on starting, waits for the port to come free — because it is
//!     usually launched by an app that is in the middle of quitting.
//!
//! Nothing is shared but the database and the port, so neither side can
//! corrupt the other's state.

use std::path::PathBuf;
use std::time::{Duration, Instant};

use lantern_lib::hosting;
use lantern_lib::shares;
use lantern_lib::state::AppState;

/// How long to keep trying the port before giving up.
///
/// The app releases it as it exits, which is quick, but a machine under load
/// can take a few seconds to actually close the socket.
const BIND_TIMEOUT: Duration = Duration::from_secs(20);

struct Args {
    data_dir: PathBuf,
    port: u16,
    name: String,
}

fn parse_args() -> Option<Args> {
    let mut data_dir = None;
    let mut port = 7981u16;
    let mut name = String::from("LANTern");

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--data-dir" => data_dir = args.next().map(PathBuf::from),
            "--port" => port = args.next()?.parse().ok()?,
            "--name" => name = args.next()?,
            _ => {}
        }
    }

    Some(Args {
        // The app passes this, because it is the one that knows where Tauri
        // put it. Guessing the path here would mean reimplementing that logic
        // and getting it subtly wrong on one platform.
        data_dir: data_dir?,
        port,
        name,
    })
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let Some(args) = parse_args() else {
        eprintln!("usage: lantern-host --data-dir <path> [--port 7981] [--name <device>]");
        std::process::exit(2);
    };

    let state = AppState::new();

    match lantern_lib::db::open(&args.data_dir) {
        Ok(conn) => state.with(|s| s.db = Some(conn)),
        Err(e) => {
            eprintln!("lantern-host: cannot open the database at {:?}: {e}", args.data_dir);
            std::process::exit(1);
        }
    }

    // The folders the app published, exactly as it left them.
    let restored = shares::restore(&state);
    let live = restored.iter().filter(|s| s.running).count();
    state.with(|s| {
        s.shares = restored;
        s.net.host_port = args.port;
        s.instance = args.name.clone();
    });

    if live == 0 {
        // Nothing to serve. Exiting is more honest than sitting on a port.
        eprintln!("lantern-host: nothing is published; not starting");
        return;
    }

    // Record the process so the app can stop it again.
    let pid_file = args.data_dir.join("host.pid");
    let _ = std::fs::write(&pid_file, std::process::id().to_string());

    eprintln!("lantern-host: serving {live} folder(s) on port {}", args.port);

    // The app that launched this is usually still exiting, so the port is
    // still held for a moment. Waiting beats failing and leaving nothing up.
    let started = Instant::now();
    loop {
        match hosting::serve(state.clone(), args.port).await {
            Ok(()) => break,
            Err(e) if started.elapsed() < BIND_TIMEOUT => {
                eprintln!("lantern-host: port {} busy ({e}); retrying", args.port);
                tokio::time::sleep(Duration::from_millis(500)).await;
            }
            Err(e) => {
                eprintln!("lantern-host: giving up on port {}: {e}", args.port);
                break;
            }
        }
    }

    let _ = std::fs::remove_file(&pid_file);
}
