# LANTern — rebuild desktop and Android, then install to the attached phone.
#
# The Android half deliberately does not use `tauri android build`: that task
# symlinks the built .so into jniLibs, and Windows refuses to create symlinks
# without Developer Mode or elevation. Copying the stripped library into place
# achieves the same thing with no privilege change, and strips ~170 MB of debug
# symbols off the APK on the way.

param(
  [switch]$SkipDesktop,
  [switch]$SkipAndroid,
  [switch]$Install,
  # Produce a Windows setup .exe as well as the bare binary. Slower, because
  # Tauri fetches the NSIS toolchain on first use.
  [switch]$Installer,
  # Also build LANTV: the same application under its own name and package, so
  # it can sit on a television beside the phone build rather than replacing it.
  [switch]$Tv
)

# Deliberately NOT "Stop": Windows PowerShell turns any native command's
# stderr into a terminating error, and both npm and cargo write ordinary
# progress there. Exit codes are checked explicitly instead.
$ErrorActionPreference = "Continue"
$root = $PSScriptRoot
. "$root\android-env.ps1" | Out-Null

# Stop LANTern and wait for Windows to actually release the binary.
#
# Killing the process is not enough: the handle lingers for a moment, and the
# linker's "Access is denied (os error 5)" arrives well into a two-minute
# release build. The app also lives in the tray, so a copy is often running
# from earlier testing.
function Stop-Lantern {
  Get-Process lantern -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  $exe = Join-Path $PSScriptRoot "src-tauri/target/release/lantern.exe"
  if (-not (Test-Path $exe)) { return }
  for ($i = 0; $i -lt 40; $i++) {
    try {
      $fs = [System.IO.File]::Open($exe, 'Open', 'ReadWrite', 'None')
      $fs.Close()
      return
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  Write-Warning "lantern.exe is still locked; the build may fail to link"
}

Stop-Lantern

if (-not $SkipDesktop) {
  Write-Host "`n=== desktop (release) ===" -ForegroundColor Cyan
  Set-Location $root
  # The link step is the only part that touches lantern.exe, and it happens
  # minutes after the build starts — long enough for the app to have been
  # reopened in the meantime, which fails the whole build with
  # "Access is denied (os error 5)". Clear the lock and try once more rather
  # than throwing away two minutes of compilation.
  # Written out rather than splatted: PowerShell eats the "--" separator when
  # an array follows it, and npm then sees a bare "-" as an argument.
  # NSIS only for the installer - the MSI target needs the WiX toolset, a
  # second multi-hundred-megabyte download for an installer nobody asked for.
  function Invoke-DesktopBuild {
    if ($Installer) {
      npm run tauri build -- --bundles nsis
    } else {
      npm run tauri build -- --no-bundle
    }
  }

  Invoke-DesktopBuild
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  link failed - clearing the lock and retrying once" -ForegroundColor Yellow
    Stop-Lantern
    Invoke-DesktopBuild
  }
  if ($LASTEXITCODE -ne 0) { Write-Error "desktop build failed"; exit 1 }

  if ($Installer) {
    $nsisDir = Join-Path $root "src-tauri/target/release/bundle/nsis"
    $setup = Get-ChildItem $nsisDir -Filter "*-setup.exe" -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($setup) {
      Write-Host ("  setup  {0:N1} MB  {1}" -f ($setup.Length / 1MB), $setup.FullName) -ForegroundColor Green
    } else {
      Write-Warning "installer requested but no setup.exe was produced"
    }
  }
}

if (-not $SkipAndroid) {
  # A release build embeds dist/, so dist/ has to be current. With
  # -SkipDesktop nothing else would have built it.
  Write-Host "`n=== android: frontend ===" -ForegroundColor Cyan
  Set-Location $root
  npm run build
  if ($LASTEXITCODE -ne 0) { Write-Error "frontend build failed"; exit 1 }

  # The APK's version comes from app/tauri.properties, which only
  # `tauri android build` regenerates - and this script deliberately does not
  # use that task (see the note at the top). Left alone the file goes stale and
  # every release ships an APK still claiming the previous version, which is
  # exactly what happened going from 1.0.0 to 1.1.0. Writing it here keeps
  # tauri.conf.json the single source of the version.
  Write-Host "`n=== android: version ===" -ForegroundColor Cyan
  $conf = Get-Content "$root\src-tauri\tauri.conf.json" -Raw | ConvertFrom-Json
  $v = $conf.version
  $parts = $v.Split('.')
  # Monotonic and readable: 1.1.0 becomes 1001000, which sorts above 1000000.
  $code = ([int]$parts[0] * 1000000) + ([int]$parts[1] * 1000) + [int]$parts[2]
  $props = @(
    "// Written by rebuild-all.ps1 from src-tauri/tauri.conf.json.",
    "tauri.android.versionName=$v",
    "tauri.android.versionCode=$code"
  )
  $propPath = "$root\src-tauri\gen\android\app\tauri.properties"
  Set-Content -Path $propPath -Value $props -Encoding utf8
  Write-Host "  $v (code $code)"

  # The native core, once per architecture.
  #
  # An APK only runs where it has a matching library. Building for arm64 alone
  # produced an APK that most phones accept and a good many other devices
  # refuse outright as "incompatible", with nothing on screen to say why - a
  # 32-bit ARM television being the case that found this. Since there is no way
  # for someone sideloading to know which build they need, every APK now
  # carries all three.
  #
  #   arm64-v8a     every phone of the last decade, most modern TV boxes
  #   armeabi-v7a   32-bit ARM: budget TV boxes, older tablets
  #   x86_64        Chromebooks and emulators
  #
  # i686 is deliberately absent: nothing shipping today is 32-bit x86, and it
  # would be another 7 MB in every download.
  $abis = @(
    @{ target = "aarch64-linux-android";   jni = "arm64-v8a" },
    @{ target = "armv7-linux-androideabi"; jni = "armeabi-v7a" },
    @{ target = "x86_64-linux-android";    jni = "x86_64" }
  )

  Set-Location "$root\src-tauri"

  foreach ($abi in $abis) {
    Write-Host "`n=== android: rust core ($($abi.jni), release) ===" -ForegroundColor Cyan

    # --features custom-protocol is what embeds dist/ into the binary. Without
    # it Tauri serves the frontend from the Vite dev server at localhost:1420,
    # and the APK opens to "Failed to request http://localhost:1420/" on a
    # device that has no dev server. This is the flag the Tauri CLI passes for
    # a production build; the cargo profile alone does not decide it.
    #
    # The APK itself stays debug-signed and sideloadable - only the Rust core
    # is built as production.
    #
    # Android 15 requires shared libraries whose LOAD segments are aligned to
    # 16 KB pages; without this flag the OS shows a compatibility warning and
    # future releases will refuse to load the library at all.
    $env:RUSTFLAGS = "-C link-arg=-Wl,-z,max-page-size=16384"
    cargo build --release --target $abi.target --lib --features custom-protocol
    if ($LASTEXITCODE -ne 0) { Write-Error "$($abi.jni) rust build failed"; exit 1 }
    Remove-Item Env:\RUSTFLAGS -ErrorAction SilentlyContinue

    $dstDir = "$root\src-tauri\gen\android\app\src\main\jniLibs\$($abi.jni)"
    New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
    & "$ndkBin\llvm-strip.exe" --strip-debug -o "$dstDir\liblantern_lib.so" `
      "$root\src-tauri\target\$($abi.target)\release\liblantern_lib.so"
    $mb = [math]::Round((Get-Item "$dstDir\liblantern_lib.so").Length / 1MB, 1)
    Write-Host "  $($abi.jni)  $mb MB"
  }

  $apk = "$root\src-tauri\gen\android\app\build\outputs\apk\universal\debug\app-universal-debug.apk"

  Write-Host "`n=== android: gradle ===" -ForegroundColor Cyan
  # Delete the previous APK first. Gradle packages incrementally, and when
  # the native library changes size it appends the new copy while leaving
  # the old one orphaned inside the archive - unreferenced by the central
  # directory but still occupying its full size. That silently doubled the
  # APK from 53 MB to 101 MB.
  Remove-Item $apk -ErrorAction SilentlyContinue

  Set-Location "$root\src-tauri\gen\android"
  .\gradlew.bat assembleUniversalDebug -x rustBuildUniversalDebug --no-daemon -q
  if ($LASTEXITCODE -ne 0) { Write-Error "gradle build failed"; exit 1 }

  Write-Host "  APK  $([math]::Round((Get-Item $apk).Length / 1MB, 1)) MB  $apk"

  if ($Tv) {
    # The same application and the same native libraries, under its own name
    # and package (see app/build.gradle.kts). Gradle writes to the same output
    # path, so the phone APK is copied aside first.
    Write-Host "`n=== android: LANTV ===" -ForegroundColor Cyan
    $phoneApk = "$root\src-tauri\gen\android\LANTern-phone.apk"
    Copy-Item $apk $phoneApk -Force

    Remove-Item $apk -ErrorAction SilentlyContinue
    .\gradlew.bat assembleUniversalDebug -PlanternTv=true -x rustBuildUniversalDebug --no-daemon -q
    if ($LASTEXITCODE -ne 0) { Write-Error "LANTV build failed"; exit 1 }

    $tvApk = "$root\src-tauri\gen\android\LANTV.apk"
    Copy-Item $apk $tvApk -Force
    Write-Host "  LANTV  $([math]::Round((Get-Item $tvApk).Length / 1MB, 1)) MB  $tvApk"

    # Leave the phone APK where the rest of the script expects it.
    Copy-Item $phoneApk $apk -Force
    Remove-Item $phoneApk -Force
  }

  if ($Install) {
    Write-Host "`n=== installing to device ===" -ForegroundColor Cyan
    & "$env:ANDROID_HOME\platform-tools\adb.exe" install -r $apk
  }
}

Set-Location $root
Write-Host "`ndone." -ForegroundColor Green
