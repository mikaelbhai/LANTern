# LANTern — outstanding work

Verified against the code, not from memory. Anything marked done was checked
by a test or by looking at it; where neither was possible, that is said.

## Now

- [ ] **macOS build** — cannot be produced on this machine. Tauri links against
      the macOS SDK, so it needs a Mac or a CI runner. Plan: a GitHub Actions
      workflow building a `.dmg` on `macos-latest` and attaching it to the
      release, so one tag produces all four artifacts.
- [ ] **Receiving files** — the receiving device should be asked before a file
      lands, and should choose where it goes: a default folder in Settings, and
      a "save as" for the transfer in front of you.
- [ ] **Detached hosting service** — a small always-on process that keeps
      serving files and holding peer links while the app is restarted or
      rebuilt. The app attaches on start and leaves it running on exit.

## Next

- [ ] **Mobile polish, continued** — pull-to-refresh is on Home and Theatre;
      Files and Chats still want it. Touch targets under 44px and press
      feedback still to audit.
- [ ] **File directory browser** — "in any platform i cant find a place to view
      open file directories". Folders open in the system file manager now, but
      there is still no browser inside the app.

## Done this session

- [x] **TV selection logic** — cards were `div`s with an `onClick`: not
      focusable, so a D-pad could never land on a film. They take focus now and
      Enter plays. Movement prefers the same row or column, and left/right
      traverse a row and stop at its ends rather than flying into the header.
      Verified live by element identity, and by unit tests on the geometry.
- [x] **TV interface size** — root font 24px, ~19rem cards, 4px focus ring,
      overscan padding. `?tv=1` previews it without a television.
- [x] **Collapsed sidebar** — every icon collapsed into one horizontal strip.
      Items are tooltip-wrapped when collapsed and the Tooltip root is
      `inline-flex`, which ignores `space-y`. The nav is an explicit flex
      column now. Verified in the browser.
- [x] **Mute** — the button changed its icon and nothing else; the microphone
      carried on transmitting.
- [x] **Second-interface discovery** — every URL in a peer's manifest is
      rehosted to the address it was reached on, not only `streamUrl`.
- [x] **A library that cannot be read says so** — "unreachable" and "shares
      nothing" used to be the same empty list.
- [x] **Public network warning** — LANTern detects a Public network profile and
      offers to make it Private, with Windows' own consent prompt.
- [x] Pull to refresh (Home, Theatre); voice call becomes a video call; zoom
      and pan on call video and screen shares; video fitted rather than
      cropped; in-app updates with checksum verification; LANTV as its own APK;
      three ABIs in every APK.
- [x] Screen share carries system audio, mixed with the microphone.
- [x] Watch party — "Watch together" starts one; the player already followed.
- [x] Pairing phrases work: six words encode IPv4 + port in 48 bits.
      `net_invite` had returned one hardcoded phrase for every device, and
      `net_add_by_phrase` ignored what you typed and dialled 0.0.0.0.
- [x] `peers_ping` times a real handshake; `net_scan_upstream` really sweeps
      the upstream /24 (it used to report 254 hosts scanned, having contacted
      none).
- [x] Theatre: multiple audio tracks, in-app subtitles, server-side thumbnails,
      quality badges, remembered language, readable track menus.
- [x] Android: launch crash (clipboard plugin missing from the APK), back
      button skipping a layer, bottom-sheet track menus.
- [x] Games — all five existed; now verified rather than assumed. Chess passes
      perft to depth 4 (20 / 400 / 8,902 / 197,281, matching published values),
      which exercises castling, en passant, promotion and pins together. Every
      deal is a complete deck, and numbered deals reproduce exactly. Not
      verified: playing each solitaire by hand.

## Notes that cost time to learn

- `--features custom-protocol` embeds `dist/`, **not** the cargo profile. A
  build without it loads from `localhost:1420` and ships no UI.
- Nothing regenerates `gen/android/tauri.settings.gradle`,
  `app/tauri.build.gradle.kts` or `app/tauri.properties` — not `android init`,
  not a build. A plugin with an Android half, or a version bump, has to be
  written into them by hand or by `rebuild-all.ps1`, or the app dies at launch
  with `ClassNotFoundException` and ships the previous version number.
- An arm64-only APK is refused by 32-bit ARM devices as "incompatible" with no
  indication of why. Every APK carries arm64-v8a, armeabi-v7a and x86_64.
- Android 15 needs `-C link-arg=-Wl,-z,max-page-size=16384`.
- Chromium has no `HTMLMediaElement.audioTracks` and cannot decode E-AC-3, AC-3
  or DTS — hence server-side remuxing.
- Chromium ignores `::cue` styling when the OS has caption settings, and drops
  cross-origin `<track>` files unless the video sets `crossorigin` (which
  breaks playback here). Subtitles are parsed in-app.
- A Public network profile on Windows blocks inbound connections while leaving
  outbound alone: discovery, messages and calls all work, file serving does
  not, and nothing anywhere says so.
- A Tooltip whose root is `inline-flex` turns a block column into a row.
