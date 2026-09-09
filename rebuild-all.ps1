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
  [switch]$Installer
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
  $bundleArgs = if ($Installer) {
    # NSIS only. The MSI target needs the WiX toolset, a second
    # multi-hundred-megabyte download for an installer nobody asked for.
    @('--bundles', 'nsis')
  } else {
    @('--no-bundle')
  }

  npm run tauri build -- @bundleArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Host "  link failed - clearing the lock and retrying once" -ForegroundColor Yellow
    Stop-Lantern
    npm run tauri build -- @bundleArgs
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

  Write-Host "`n=== android: rust core (aarch64, release) ===" -ForegroundColor Cyan
  Set-Location "$root\src-tauri"

  # --features custom-protocol is what embeds dist/ into the binary. Without
  # it Tauri serves the frontend from the Vite dev server at localhost:1420,
  # and the APK opens to "Failed to request http://localhost:1420/" on a phone
  # that has no dev server. This is the flag the Tauri CLI passes for a
  # production build; the cargo profile alone does not decide it.
  #
  # The APK itself stays debug-signed and sideloadable - only the Rust core
  # is built as production.
  #
  # Android 15 requires shared libraries whose LOAD segments are aligned to
  # 16 KB pages; without this flag the OS shows a compatibility warning and
  # future releases will refuse to load the library at all.
  $env:RUSTFLAGS = "-C link-arg=-Wl,-z,max-page-size=16384"
  cargo build --release --target aarch64-linux-android --lib --features custom-protocol
  if ($LASTEXITCODE -ne 0) { Write-Error "android rust build failed"; exit 1 }
  Remove-Item Env:\RUSTFLAGS -ErrorAction SilentlyContinue

  $apk = "$root\src-tauri\gen\android\app\build\outputs\apk\arm64\debug\app-arm64-debug.apk"
  Write-Host "`n=== android: stripping native library ===" -ForegroundColor Cyan
  $src = "$root\src-tauri\target\aarch64-linux-android\release\liblantern_lib.so"
  $dstDir = "$root\src-tauri\gen\android\app\src\main\jniLibs\arm64-v8a"
  New-Item -ItemType Directory -Force -Path $dstDir | Out-Null
  & "$ndkBin\llvm-strip.exe" --strip-debug -o "$dstDir\liblantern_lib.so" $src
  $mb = [math]::Round((Get-Item "$dstDir\liblantern_lib.so").Length / 1MB, 1)
  Write-Host "  liblantern_lib.so  $mb MB"

  Write-Host "`n=== android: gradle ===" -ForegroundColor Cyan
  # Delete the previous APK first. Gradle packages incrementally, and when
  # the native library changes size it appends the new copy while leaving
  # the old one orphaned inside the archive - unreferenced by the central
  # directory but still occupying its full size. That silently doubled the
  # APK from 53 MB to 101 MB.
  Remove-Item $apk -ErrorAction SilentlyContinue

  Set-Location "$root\src-tauri\gen\android"
  .\gradlew.bat assembleArm64Debug -x rustBuildArm64Debug --no-daemon -q
  if ($LASTEXITCODE -ne 0) { Write-Error "gradle build failed"; exit 1 }

  Write-Host "  APK  $([math]::Round((Get-Item $apk).Length / 1MB, 1)) MB  $apk"

  if ($Install) {
    Write-Host "`n=== installing to device ===" -ForegroundColor Cyan
    & "$env:ANDROID_HOME\platform-tools\adb.exe" install -r $apk
  }
}

Set-Location $root
Write-Host "`ndone." -ForegroundColor Green
