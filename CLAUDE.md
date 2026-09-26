# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

LANTern is an offline LAN communication suite — chat, calls, files, a shared
media library and games — for Windows, macOS, Linux and Android from one
codebase. Tauri 2 + React + Vite + Tailwind over a Rust core. No accounts, no
cloud, no outbound connections: every feature has to work with the router
unplugged. The one exception is the manual update check, which runs from the
webview so that no HTTPS client exists on the native side at all.

## Commands

```bash
npm run tauri dev                 # desktop, hot reload
npm run build                     # tsc --noEmit && vite build
npx tsc --noEmit                  # frontend types on their own

cd src-tauri && cargo test --lib --offline          # the whole Rust suite
cd src-tauri && cargo test --lib --offline rating   # one module
cd src-tauri && cargo test --lib --offline a_stream_address_reduces_to_its_path
cargo test -p lantern --lib update -- --ignored     # the network-touching ones
```

**Pass `--offline` unless a dependency actually changed.** Without it cargo
reaches for the registry and can block on the package-cache lock for half an
hour with no output and no `rustc` running — which looks exactly like a slow
compile. If a build seems stuck, check CPU time on the `cargo` process before
assuming it is working.

Builds go through `rebuild-all.ps1`, not `tauri android build` (see the
comment at the top of the script):

```powershell
. .\android-env.ps1                          # pins JDK 21, SDK, NDK
.\rebuild-all.ps1 -Install                   # desktop + APK to an attached phone
.\rebuild-all.ps1 -SkipAndroid -Installer    # Windows setup.exe
.\rebuild-all.ps1 -Tv -Split -Installer      # release packages
```

Never run `cargo build --bin lantern` and ship the result: that skips Tauri's
frontend step, so the binary points at a dev server that is not running.
macOS is built by CI on a tag push; it cannot be cross-compiled from here.

## Verifying

Claims about behaviour are checked against the running thing, not the source.
Several faults in this repository were found only that way, while the code
read correctly:

- **Desktop**: start with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`, then drive the webview over CDP. `Runtime.evaluate` needs `userGesture: true` for anything gated on one.
- **Phone**: `adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>`.
- **The file server**: ask it with `curl`. It is the enforcement point for every access rule, and the only way to be sure a rule is in force.

`window.__TAURI_INTERNALS__.invoke` is non-writable and non-configurable — it
cannot be monkey-patched, and an empty log from trying proves nothing.

## Architecture

**Two processes.** The Tauri app (`src-tauri`) and `lantern-host`
(`src-tauri/host`), a detached file server that keeps serving published
folders after the window closes. It links the main crate as a library, which
is why a few modules there are `pub`.

**Three layers, and the boundaries matter.**

- `src/lib/bridge.ts` is the only path from the frontend to Rust. In a plain browser (`npm run dev` with no shell) it falls through to `src/lib/sim.ts`, so the whole UI is exercisable without the Rust toolchain.
- `src/lib/store.ts` is the single frontend state — zustand, including which screen is showing, because things that are not screens need to navigate.
- Rust commands live in `src-tauri/src/commands.rs` and are registered in `lib.rs`. Adding a command means touching both, plus `bridge.ts`.

**Peers.** `discovery.rs` finds them over mDNS; `signaling.rs` holds one TCP
link per peer carrying line-delimited JSON envelopes. `deliver()` maps an
envelope `kind` to a frontend event (`chat` → `message:received`, `game` →
`game:session`, and so on) — that table is the contract between the two
sides. Links are generation-guarded: both ends dial, so two links to one peer
exist briefly and the loser's teardown must not evict the winner.

**Identity — the trap.** A device has three names and they are not
interchangeable:

- `deviceId` — what peers call it. Seats in a game, ratings, trust, approvals and every access rule key off this.
- `profile.id` — minted in the browser, meaningful only locally. Chat authorship and display.
- `peer.id` — equals `deviceId` in practice, but read as a separate field.

Use `useSeatId()` / `state.deviceId` for anything another device will compare
against. Checking a seat against `profile.id` silently works on the host,
where the two coincide, and fails everywhere else.

**Media and access control.** `hosting.rs` is an axum server publishing
folders over plain HTTP — any browser on the LAN can open them, which is a
feature. It is also the single enforcement point:

- A title is identified by its **decoded** stream path. Ratings stored escaped and checked unescaped is a bug this code has already had, and it silently disabled nearly every restriction.
- The rating and audience checks run at the **top** of `serve_path`, before the request is sorted into a kind. `?audio=`, `?subtitle=` and `?thumb=` are all the same title by another door.
- A request from this machine's own address bypasses both: the publisher is not one of its own guests.
- `for_this_caller` takes its inputs precomputed. It is called from inside the lock that reads the share list, and reaching for that lock again deadlocks the index and `/shares.json`.

**Games.** `turns.tsx` (`useTurnGame`) and `hosted.tsx` carry every game
except chess, which has its own networking. Only moves travel; each client
replays them. `game_move` refuses to send for a session the *native* side
does not hold, so a guest has to record the session when it is dealt in —
and the host writes itself down as `"me"`, which must be rewritten to the
sender's device id on arrival or the guest believes it is the host.

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

## Conventions

Comments explain why, not what, and name the fault they exist to prevent —
most of this codebase's comments are the record of something that went wrong
once. Commit messages are written the same way: what was broken, how it was
found, and what it now does instead.
