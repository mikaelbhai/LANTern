//! Names this binary to Windows.
//!
//! The detached host is the one part of LANTern that a person meets outside
//! the application: it appears in the firewall prompt, in Task Manager, and in
//! whatever security tool they run. Anonymous there, it is indistinguishable
//! from something that installed itself — and the correct response to that is
//! to block it, which turns the feature off in a way nobody can then diagnose.
//!
//! So it carries the same name and icon as the app it belongs to, and says in
//! its own description what it is for.

fn main() {
    #[cfg(windows)]
    {
        let mut res = tauri_winres::WindowsResource::new();
        res.set_icon("../icons/icon.ico");
        // What the firewall dialog and Task Manager show.
        res.set("FileDescription", "LANTern File Server");
        res.set("ProductName", "LANTern");
        res.set("OriginalFilename", "lantern-host.exe");
        res.set("CompanyName", "LANTern");
        // An apostrophe comes back out of the resource compiler with its
        // escape still attached, so this sentence is written without one.
        res.set(
            "Comments",
            "Keeps published folders reachable while LANTern is closed. Serves files on the local network only.",
        );
        res.set("LegalCopyright", "LANTern");
        if let Err(e) = res.compile() {
            // Not fatal: an unnamed binary still works, it just introduces
            // itself badly. Failing the build over it would be worse.
            println!("cargo:warning=could not embed version info: {e}");
        }
    }
}
