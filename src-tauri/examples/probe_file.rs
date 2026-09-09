//! Prints the tracks LANTern can see in a container.
//!
//! A development aid: `cargo run --example probe_file -- <path>` answers
//! "what does the app think is in this file", without needing the app.

fn main() {
    let Some(path) = std::env::args().nth(1) else {
        eprintln!("usage: probe_file <video file>");
        std::process::exit(2);
    };
    let path = std::path::Path::new(&path);

    let probed = if lantern_lib::is_matroska_path(path) {
        lantern_lib::probe_matroska(path)
    } else {
        lantern_lib::probe_mp4(path)
    };

    match probed {
        Ok(p) => {
            println!("tracks: {}", p.tracks.len());
            for t in &p.tracks {
                println!(
                    "  #{:<3} {:<9} {:<12} lang={:<4} default={}  label={}",
                    t.number,
                    t.kind,
                    t.codec,
                    t.lang,
                    t.default,
                    t.label()
                );
            }
            if let Some(d) = p.duration_sec {
                println!("duration: {d:.0}s");
            }
        }
        Err(e) => {
            eprintln!("could not read: {e}");
            std::process::exit(1);
        }
    }
}
