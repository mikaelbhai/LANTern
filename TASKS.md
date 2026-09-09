# LANTern — outstanding work

Verified against the code on 2026-09-09, not from memory. Games are last by
explicit instruction: everything else works first.

## Done

- [x] v1.1.0 published: github.com/mikaelbhai/LANTern/releases/tag/v1.1.0
- [x] APK version derived from tauri.conf.json by the build script
- [x] Screen share carries system audio, mixed with the microphone
- [x] Watch party — "Watch together" starts one; the player already followed
- [x] Pairing phrases actually work: six words encode IPv4 + port in 48 bits
      (`net_invite` returned one hardcoded phrase for every device, and
      `net_add_by_phrase` ignored what you typed and dialled 0.0.0.0)
- [x] LANTV — TV mode: Theatre alone, D-pad spatial navigation, visible focus
      ring, leanback + touchscreen-optional in the APK
- [x] In-app update check in Settings > About; real version from the build
- [x] Privacy text corrected — it claimed no outbound connections
- [x] Download folder and shared folders open in the file manager
- [x] `peers_ping` times a real handshake instead of echoing a cached number
- [x] `net_scan_upstream` really sweeps the upstream /24 (was reporting a
      254-host scan it had never performed)

- [x] Peer link stability — 90s with zero churn, single-instance guard
- [x] Theatre: multiple audio tracks (MP4 + Matroska), server-side remux
- [x] Theatre: subtitles — parsed in-app, not via `<track>` (three styles)
- [x] Theatre: server-side thumbnails, disk cached (GPU 59% → 3.3%)
- [x] Theatre: quality badges, bracket-stripped titles, duration
- [x] Remember audio/subtitle language with the resume position
- [x] Track menus: language names, de-duplicated, scrollable
- [x] Android: bottom-sheet track menus, 48dp rows, dismiss scrim
- [x] Android: back button no longer skips a layer to Home
- [x] Android: launch crash — clipboard plugin missing from the APK
- [x] Calls: echo cancellation (`echoCancellation` + noise suppression + AGC)
- [x] Windows: no console windows when ffmpeg runs
- [x] Multi-interface display, 500x500 avatars, message copy button

## Now

- [ ] **Screen share carries no audio** — `getDisplayMedia({ audio: false })`
      in `src/lib/webrtc.ts:288`. Asked for explicitly.
- [ ] **In-app update UI** — `src/lib/update.ts` exists and the CSP allows
      `api.github.com`, but nothing calls it. Settings ▸ About also hardcodes
      `1.0.0` and claims LANTern "makes no outbound internet connections",
      which the updater contradicts. Version must come from the build.
- [ ] **Windows setup .exe** — `rebuild-all.ps1 -Installer` exists; never run
      to completion, so the NSIS path is unverified.

## Next

- [ ] **Watch party** — `party_start` is in the bridge and the simulator but
      no screen calls it; `party:changed` is subscribed and dropped.
- [ ] **File directory browser** — "in any platform i cant find a place to
      view open file directories".
- [ ] **Stubbed commands** — `peers_ping` returns a cached 0.0ms,
      `net_add_by_phrase` dials 0.0.0.0, `net_scan_upstream` returns empty.
      Each currently presents as a working control.

## Later

- [ ] **Games** — last, once everything above is working

## Open question

LANTV ships as **TV mode inside the one APK**, not a separately branded
LANTV build: on a television it detects leanback and runs Theatre alone. A
separate APK would mean a Gradle product flavour with its own applicationId,
which is packaging rather than function. Say the word if the separate name
matters.

## Notes that cost time to learn

- `--features custom-protocol` is what embeds `dist/`, **not** the cargo
  profile. A build without it loads from `localhost:1420` and ships no UI.
- Nothing regenerates `gen/android/tauri.settings.gradle` or
  `app/tauri.build.gradle.kts` — not `android init`, not a build. A Tauri
  plugin with an Android half must be added to both by hand or the app dies at
  launch with `ClassNotFoundException`.
- Android 15 needs `-C link-arg=-Wl,-z,max-page-size=16384`.
- Chromium has no `HTMLMediaElement.audioTracks` and cannot decode E-AC-3,
  AC-3 or DTS — hence server-side remuxing.
- Chromium ignores `::cue` styling when the OS has caption settings, and drops
  cross-origin `<track>` files unless the video sets `crossorigin` (which
  breaks playback here). Subtitles are therefore parsed in-app.
