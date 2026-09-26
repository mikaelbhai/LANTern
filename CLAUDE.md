# LANTern

A fully offline LAN communication suite: chat, calls, files, a shared media
library, and games. Tauri 2 + React + Vite + Tailwind, with a Rust core. No
internet, no accounts, no cloud — every feature has to work with the router
unplugged.

## Token Efficiency

### Code search (CodeGraph)
- If a CodeGraph index exists (`codegraph status`), use `codegraph query "<natural language>"` to locate code before falling back to grep or reading files one by one.
- The index can be stale. Before stating that a function or file does or doesn't exist, confirm by reading the actual file. If results look wrong, re-sync the index.
- When you land in a directory through a query, check for and read that module's CLAUDE.md before editing. Query results skip the automatic parent-directory CLAUDE.md loading that normal file reads trigger.

### Command output (RTK)
- Route noisy commands (test runs, builds, installs, `git log`, long CLI output) through `rtk` to get compressed output.
- Compression is lossy. Run commands raw, without `rtk`, when:
  - debugging a failure or reading server/application logs
  - verifying step-by-step behavior during self-correction
  - the compressed summary hides the line you need

### Response style
- Be terse: no preamble, no restating the question, no recap of what you just did unless asked.
- Keep full detail in plans, error explanations, and anything with nuance where shortening would lose meaning. Brevity must not cost correctness.

### Session hygiene
- When I switch to an unrelated task, suggest `/clear`.
- Use plan mode before multi-file or architectural changes.
- For repetitive, well-defined jobs (scheduled cleanups, simple browser navigation), note if Haiku or Sonnet would be sufficient. Keep the strongest model for planning, deep dives, and significant programming.
- Keep this file and module CLAUDE.md files small. Point to docs rather than inlining them.

## Building

`./rebuild-all.ps1` builds the desktop app and the Android APK and installs to
an attached phone with `-Install`. It deliberately does not use
`tauri android build`; see the comment at the top of the script.

- `-SkipAndroid` / `-SkipDesktop` for one half.
- `-Tv -Split -Installer` for release packages.
- macOS is built by CI on a tag push — it cannot be cross-compiled from here.

Run `cargo` with `--offline` unless a dependency has changed. Without it,
cargo reaches for the registry and can block on the package-cache lock for a
long time with no output, which looks exactly like a slow compile.

## Verifying

Claims about behaviour are checked against the running thing, not the source.
Both apps expose a webview that can be driven over CDP — the desktop with
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`, the
phone through `adb forward` to `webview_devtools_remote_<pid>`. The file
server can be asked directly with `curl`; several faults here were only found
that way, because the code looked right.
