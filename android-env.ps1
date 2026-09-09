# LANTern — Android build environment.
#
# The Android toolchain lives on the E: drive rather than C:, because the SDK,
# NDK and Gradle caches together run to several gigabytes and C: has little
# room. Nothing here is global: dot-source this script in a terminal and the
# variables apply to that terminal only.
#
#   . .\android-env.ps1
#   npm run android:build -- --debug --target aarch64
#
# To make it permanent instead, set the same variables under
# System Properties -> Environment Variables -> User variables.

$env:JAVA_HOME        = "E:\android\jdk21"
$env:ANDROID_HOME     = "E:\android\sdk"
$env:ANDROID_SDK_ROOT = "E:\android\sdk"
$env:NDK_HOME         = "E:\android\sdk\ndk\27.3.13750724"

# Gradle's cache is large and grows; keep it off C: as well.
$env:GRADLE_USER_HOME = "E:\android\gradle-home"

# rusqlite bundles SQLite as C source, so the build needs a C cross-compiler.
# Cargo will not find the NDK's clang on its own, and the failure it gives when
# it cannot ("failed to run custom build command for libsqlite3-sys") does not
# mention the NDK at all. 24 is minSdk; the wrapper name encodes the API level.
$ndkBin = "$env:NDK_HOME\toolchains\llvm\prebuilt\windows-x86_64\bin"

$env:CC_aarch64_linux_android  = "$ndkBin\aarch64-linux-android24-clang.cmd"
$env:CXX_aarch64_linux_android = "$ndkBin\aarch64-linux-android24-clang++.cmd"
$env:AR_aarch64_linux_android  = "$ndkBin\llvm-ar.exe"
$env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = "$ndkBin\aarch64-linux-android24-clang.cmd"

# The 32-bit and x86 targets need the same treatment if you build them.
$env:CC_armv7_linux_androideabi  = "$ndkBin\armv7a-linux-androideabi24-clang.cmd"
$env:CXX_armv7_linux_androideabi = "$ndkBin\armv7a-linux-androideabi24-clang++.cmd"
$env:AR_armv7_linux_androideabi  = "$ndkBin\llvm-ar.exe"
$env:CARGO_TARGET_ARMV7_LINUX_ANDROIDEABI_LINKER = "$ndkBin\armv7a-linux-androideabi24-clang.cmd"

$env:CC_x86_64_linux_android  = "$ndkBin\x86_64-linux-android24-clang.cmd"
$env:CXX_x86_64_linux_android = "$ndkBin\x86_64-linux-android24-clang++.cmd"
$env:AR_x86_64_linux_android  = "$ndkBin\llvm-ar.exe"
$env:CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER = "$ndkBin\x86_64-linux-android24-clang.cmd"

$env:PATH = "$env:JAVA_HOME\bin;$env:ANDROID_HOME\platform-tools;$ndkBin;$env:PATH"

Write-Host "Android environment ready:" -ForegroundColor Green
Write-Host "  JDK   $env:JAVA_HOME"
Write-Host "  SDK   $env:ANDROID_HOME"
Write-Host "  NDK   $env:NDK_HOME"
Write-Host ""
Write-Host "Gradle needs JDK 21 - the system JDK 25 is too new for the Android" -ForegroundColor DarkGray
Write-Host "Gradle plugin, which is why a second JDK is pinned here." -ForegroundColor DarkGray
