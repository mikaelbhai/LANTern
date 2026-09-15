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
    "https://github.com/mikaelbhai/LANTern/releases/download/v1.1.9/LANTern_1.1.9_x64-setup.exe";
const DIGEST: &str = "sha256:a7b94a1014421dbbed6d2268b480be3d3aca58842b9c89699c799d92a27615a4";
const SIZE: u64 = 4_120_502;

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
    let gone = "https://github.com/mikaelbhai/LANTern/releases/download/v1.1.9/no-such-file.exe";
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

/// The staging directory, which holds the installer between downloading it and
/// handing it to the system.
#[cfg(test)]
mod staging {
    use crate::commands::prune_staged;

    /// A directory of its own per test, so two running at once cannot delete
    /// each other's files - which is the very thing being tested.
    fn empty_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join("lantern-staging-tests").join(name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create the scratch directory");
        dir
    }

    fn names_in(dir: &std::path::Path) -> Vec<String> {
        let mut names: Vec<_> = std::fs::read_dir(dir)
            .expect("read the scratch directory")
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// The fault this was written for: three installers from three attempts,
    /// eighty megabytes, none of them ever deleted.
    #[test]
    fn leaves_only_the_file_being_fetched() {
        let dir = empty_dir("three-attempts");
        for name in ["LANTern-1.2.0.apk", "LANTern-1.2.5.apk", "LANTern-1.2.6.apk"] {
            std::fs::write(dir.join(name), b"x").expect("write");
        }

        prune_staged(&dir, "LANTern-1.2.6.apk");

        assert_eq!(names_in(&dir), vec!["LANTern-1.2.6.apk"]);
    }

    /// Pruning runs before the download, so the file being kept is usually not
    /// there yet. That must not stop the rest being cleared.
    #[test]
    fn clears_up_even_when_the_kept_name_is_not_there_yet() {
        let dir = empty_dir("nothing-to-keep");
        std::fs::write(dir.join("LANTern-1.2.5.apk"), b"x").expect("write");

        prune_staged(&dir, "LANTern-1.2.6.apk");

        assert!(names_in(&dir).is_empty());
    }

    /// A missing directory is the state before the first update, not an error.
    #[test]
    fn says_nothing_about_a_directory_that_is_not_there() {
        prune_staged(
            &std::env::temp_dir().join("lantern-staging-tests-absent"),
            "x.apk",
        );
    }
}
