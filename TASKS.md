# LANTern — outstanding work

Verified against the code, not from memory. Anything marked done was checked
by a test or by looking at it; where neither was possible, that is said.

## Now

- [ ] **The TV's split video** — cannot be reproduced without the television.
      "Cut in half and stitched together" is the signature of a stride or
      offset mismatch in the decoder, not a layout fault, so guessing at a fix
      would be dishonest. What would settle it: the file's resolution and
      codec, and whether a 1080p file does the same. If it is only 4K HEVC it
      is the TV's decoder, and the answer is transcoding on the host.
- [ ] **In-app updates, end to end** — the check is verified against the live
      release; the download path is not, because verifying it needs a release
      newer than the running build. Next release proves it.

## Next

- [ ] **Mobile polish, continued** — pull-to-refresh is on Home and Theatre;
      Files and Chats still want it. Touch targets under 44px and press
      feedback still to audit.
- [ ] **File directory browser** — "in any platform i cant find a place to view
      open file directories". Folders open in the system file manager now, but
      there is still no browser inside the app.

## Done this session

- [x] **macOS build on CI** — a tagged release builds a universal `.dmg` on a
      real Mac, which this machine cannot do at all.
- [x] **Detached hosting service** — `lantern-host`, its own package and its
      own process, serving the published folders after the app closes.
      Verified against the real database before being wired up.
- [x] **Receiving files** — an offer asks first, and takes Accept or Save to…
      The download folder in Settings was previously never read by the backend.
- [x] **Browsing other devices' folders** — they had nowhere to appear before.
- [x] **Updates download natively** — GitHub serves release assets with no
      CORS header, so a webview fetch could never have worked. Scoped to four
      GitHub hosts rather than opening a general HTTP client.
- [x] **`0.0 ms` was not a measurement** — an untimed peer shows a dash, and a
      new link is timed as soon as it exists.

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
- GitHub serves release assets with no `Access-Control-Allow-Origin` on either
  hop of the 302, so a webview `fetch` for one can never work, whatever the
  CSP says. The download has to be native.
- Two binaries in one package make Tauri's main-binary detection ambiguous: it
  wrote the 1.9 MB host over the 7.9 MB app and packaged that. One binary per
  package; `mainBinaryName` does not settle it.
- `tauri-plugin-http` costs about 6.4 MB per APK — rustls, hyper and reqwest —
  which is the price of being able to download an update at all.
