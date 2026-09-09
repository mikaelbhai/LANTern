# LANTern

A communication suite for devices on the same local network. Chat, voice and
video calls, screen sharing, file transfer, folder hosting and a shared video
library — with no accounts, no cloud, and no outbound internet connections.

Everything runs on the devices themselves. Peers find each other over mDNS,
talk over a direct TCP link, and stream media straight from the machine holding
the file.

## What is here

| | |
|---|---|
| **Home** | Every peer on the network, which interface reaches it, and what the path costs |
| **Chats** | Rooms and direct messages, delivered peer to peer |
| **Calls** | Voice, video and screen sharing over WebRTC, negotiated on the local link |
| **Files** | Transfers that resume, plus folders published over HTTP |
| **Theatre** | A shared video library assembled from every device's media shares |
| **Network** | What the connection actually is, measured rather than assumed |
| **Games** | Chess and four solitaires |

## Platforms

Windows, Linux, macOS and Android, from one codebase — Tauri 2 with a React
frontend and a Rust core.

## Building

Requires Node 18+, Rust 1.77+, and for Android a JDK 21, the Android SDK and
NDK 27.

```bash
npm install
npm run tauri dev          # desktop, with hot reload
npm run tauri build        # desktop release
```

For Android, `android-env.ps1` pins the toolchain paths, and `rebuild-all.ps1`
builds and installs both targets:

```powershell
. .\android-env.ps1
.\rebuild-all.ps1 -Install            # desktop + APK, installed to a device
.\rebuild-all.ps1 -SkipAndroid -Installer   # Windows setup.exe
```

Two details that are easy to lose:

- The Android core must be built **`--release` with `--features custom-protocol`**.
  A debug Tauri build is a *dev* build: it loads the frontend from the Vite dev
  server instead of embedding it, so the APK opens to a connection error on a
  phone that has no dev server running.
- The native library needs `-C link-arg=-Wl,-z,max-page-size=16384`. Android 15
  requires 16 KB page alignment, and without it the OS warns today and will
  refuse to load the library later.

Both are handled by `rebuild-all.ps1`.

## Tests

```bash
cd src-tauri && cargo test     # Rust core
npx tsc --noEmit               # frontend types
```

## Design notes

**Nothing leaves the local network.** The one exception is the update check in
Settings, which is manual, downloads nothing, and returns a version number and
a link. It runs from the webview rather than the Rust core so that no HTTPS
client exists on the native side at all.

**WebRTC uses no ICE servers.** STUN exists to discover your public address for
traversing the internet; on a LAN both devices already have host candidates
that reach each other. Pointing at a public STUN server would be the one part
of the app that phoned home.

**Media is streamed, never copied.** Playing a title in Theatre opens a range
request against the device holding the file. The same server serves file
transfers, so pause and resume come from `Range` rather than a second protocol.

**Subtitles come out of the container.** A small Matroska reader lists the
tracks in an MKV and converts a chosen text track to WebVTT on the way out.
Audio track switching is *not* possible in a webview — Chromium has never
implemented `HTMLMediaElement.audioTracks` — and the app says so rather than
offering a menu that changes nothing.

## Licence

MIT.
