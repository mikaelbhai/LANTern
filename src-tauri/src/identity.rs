//! Stable identity for this device.
//!
//! An address is not an identity. A machine with Ethernet and Wi-Fi announces
//! on both, and any machine's address changes when it moves between networks
//! or its DHCP lease turns over. Keying peers by address therefore produces
//! duplicates and phantom departures.
//!
//! So each device mints a UUID once, keeps it on disk, and advertises it in its
//! mDNS TXT record. Peers are tracked by that instead.

use std::path::Path;

/// Reads the device id, creating one on first run.
///
/// A failure to persist is not fatal: the app still works for the session, it
/// just will not be recognised as the same device after a restart.
pub fn load_or_create(dir: &Path) -> String {
    let path = dir.join("device-id");

    if let Ok(existing) = std::fs::read_to_string(&path) {
        let trimmed = existing.trim();
        if !trimmed.is_empty() {
            return trimmed.to_string();
        }
    }

    let fresh = uuid::Uuid::new_v4().to_string();
    if let Err(e) = std::fs::create_dir_all(dir).and_then(|_| std::fs::write(&path, &fresh)) {
        eprintln!("could not persist device id: {e}");
    }
    fresh
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_directory_yields_the_same_id() {
        let dir = std::env::temp_dir().join(format!("lantern-id-{}", uuid::Uuid::new_v4()));
        let first = load_or_create(&dir);
        let second = load_or_create(&dir);
        assert_eq!(first, second, "device id changed between reads");
        assert!(!first.is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn different_devices_get_different_ids() {
        let a = std::env::temp_dir().join(format!("lantern-id-{}", uuid::Uuid::new_v4()));
        let b = std::env::temp_dir().join(format!("lantern-id-{}", uuid::Uuid::new_v4()));
        assert_ne!(load_or_create(&a), load_or_create(&b));
        let _ = std::fs::remove_dir_all(&a);
        let _ = std::fs::remove_dir_all(&b);
    }
}
