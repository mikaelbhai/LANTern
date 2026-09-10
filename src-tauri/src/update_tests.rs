//! The updater, against the real releases.
//!
//! This is the one thing LANTern downloads and then executes, so "it compiles"
//! is not a standard worth being satisfied by. These tests fetch an actual
//! published asset over the actual network and check the actual digest, which
//! is the only way to know the path works end to end — the last version of it
//! type-checked perfectly and failed on every phone.
//!
//! They need the network, so they are ignored by default. Run them with:
//!
//!     cargo test -p lantern --lib update -- --ignored --nocapture

use crate::commands::fetch_update;

/// The smallest asset on a release that is not going anywhere.
const ASSET: &str =
    "https://github.com/mikaelbhai/LANTern/releases/download/v1.1.7/LANTern_1.1.7_x64-setup.exe";
const DIGEST: &str = "sha256:e5c19358bb6deb328ea9b7103916178c3d01f19dd94c1a7c6c230b6b4cb0e68a";
const SIZE: u64 = 4_072_092;

fn scratch(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join("lantern-update-tests");
    let _ = std::fs::create_dir_all(&dir);
    dir.join(name)
}

#[tokio::test]
#[ignore = "reaches the network"]
async fn downloads_a_real_release_asset() {
    let dest = scratch("real.exe");
    let _ = std::fs::remove_file(&dest);

    let mut last = (0u64, 0u64);
    let result = fetch_update(ASSET, &dest, Some(DIGEST), |done, total| {
        last = (done, total);
    })
    .await;

    assert!(result.is_ok(), "download failed: {result:?}");

    let written = std::fs::metadata(&dest).expect("nothing was written").len();
    assert_eq!(written, SIZE, "wrote {written} bytes, expected {SIZE}");

    // Progress has to actually arrive, or the bar sits at nothing while a
    // forty megabyte file comes down and it looks broken.
    assert_eq!(last.0, SIZE, "final progress was {last:?}");
    assert_eq!(last.1, SIZE, "content length was not reported");

    let _ = std::fs::remove_file(&dest);
}

#[tokio::test]
#[ignore = "reaches the network"]
async fn a_wrong_digest_leaves_nothing_behind() {
    let dest = scratch("wrong.exe");
    let _ = std::fs::remove_file(&dest);

    let wrong = "sha256:0000000000000000000000000000000000000000000000000000000000000000";
    let result = fetch_update(ASSET, &dest, Some(wrong), |_, _| {}).await;

    assert!(result.is_err(), "a wrong digest was accepted");
    assert!(
        result.unwrap_err().contains("checksum"),
        "the error should say what was wrong with it",
    );
    // The point of the exercise: a file that failed its check must not be
    // sitting on disk where the next press could hand it to an installer.
    assert!(!dest.exists(), "the rejected download was left behind");
}

#[tokio::test]
#[ignore = "reaches the network"]
async fn a_missing_asset_is_reported() {
    let dest = scratch("missing.exe");
    let gone = "https://github.com/mikaelbhai/LANTern/releases/download/v1.1.7/no-such-file.exe";
    let result = fetch_update(gone, &dest, None, |_, _| {}).await;
    assert!(result.is_err(), "a missing asset looked like a success");
    let _ = std::fs::remove_file(&dest);
}

#[tokio::test]
async fn only_github_is_reachable() {
    let dest = scratch("nope.bin");

    for url in [
        "https://example.com/installer.exe",
        "http://github.com/x/y",                 // not https
        "https://github.com.evil.test/x",        // a lookalike host
        "https://raw.githubusercontent.com/x/y", // GitHub, but not releases
        "file:///etc/passwd",
    ] {
        let result = fetch_update(url, &dest, None, |_, _| {}).await;
        assert!(result.is_err(), "{url} was allowed");
    }

    assert!(!dest.exists(), "a refused address still wrote a file");
}
