import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// LANTV is the same application wearing a different name.
//
// It is built by passing -PlanternTv=true rather than by adding a product
// flavour: the `rust` plugin already owns a flavour dimension for the ABI, and
// a second dimension would rename every variant and every output path that the
// build script and the release process depend on. A property changes the two
// things that actually differ - the identifier and the label - and leaves the
// build graph alone.
//
// The behaviour is not switched here. The app detects a television at runtime
// (leanback, no pointer) and shows Theatre alone, so the TV build is branding:
// its own icon in the TV launcher, and its own package so it can sit alongside
// the phone build rather than replacing it.
val isTvBuild = project.hasProperty("lanternTv")

android {
    compileSdk = 36
    namespace = "app.lantern.desktop"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "true"
        manifestPlaceholders["appLabel"] = if (isTvBuild) "LANTV" else "LANTern"
        manifestPlaceholders["appIcon"] = if (isTvBuild) "@mipmap/ic_launcher_tv" else "@mipmap/ic_launcher"
        manifestPlaceholders["appRoundIcon"] = if (isTvBuild) "@mipmap/ic_launcher_tv_round" else "@mipmap/ic_launcher_round"
        applicationId = if (isTvBuild) "app.lantern.tv" else "app.lantern.desktop"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    // One APK per processor architecture, alongside the universal one.
    //
    // Four fifths of this package is three copies of the same Rust library,
    // one per architecture, and any given device runs exactly one of them.
    // Splitting turns a 41 MB download into a 16-20 MB one; nothing is
    // removed, each device simply stops carrying the two builds it cannot
    // execute.
    //
    // The universal APK is kept because it installs anywhere, which matters
    // when you are standing in front of a television and do not know what is
    // inside it. It stays the one the build script installs over adb.
    splits {
        abi {
            isEnable = project.hasProperty("lanternSplit")
            reset()
            // No television runs x86_64: that library was 14.5 MB of the LANTV
            // APK for emulators. The phone keeps it for Chromebooks. The TV pass
            // also narrows the universal flavour itself (-PabiList, see
            // rebuild-all.ps1), which this list has to agree with.
            if (isTvBuild) include("arm64-v8a", "armeabi-v7a")
            else include("arm64-v8a", "armeabi-v7a", "x86_64")
            isUniversalApk = true
        }
    }

    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            // A build type's placeholders replace the defaults wholesale, so
            // the label has to be repeated here or the TV build loses its name.
            manifestPlaceholders["appLabel"] = if (isTvBuild) "LANTV" else "LANTern"
            manifestPlaceholders["appIcon"] = if (isTvBuild) "@mipmap/ic_launcher_tv" else "@mipmap/ic_launcher"
            manifestPlaceholders["appRoundIcon"] = if (isTvBuild) "@mipmap/ic_launcher_tv_round" else "@mipmap/ic_launcher_round"
            isDebuggable = true
            isJniDebuggable = true
            // Shrunk, although it is the build type every release ships as (it
            // is debug for its signing, and adb run-as needs it debuggable). Left
            // unshrunk it carried 20 MB of Java - two thirds of the APK that was
            // not the Rust library - for the androidx, Material and Media3 code
            // nothing calls. What Rust and the page reach by name is kept in
            // proguard-rules.pro; resources are not shrunk, since some are looked
            // up by name at run time.
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    // BouncyCastle (for jcifs-ng) and jspecify (from Media3) both ship the same
    // OSGi manifest under META-INF/versions. It is packaging metadata nothing
    // reads on Android, and two copies of it fail the merge.
    packaging {
        resources {
            excludes += setOf("META-INF/versions/*/OSGI-INF/MANIFEST.MF", "META-INF/DEPENDENCIES")
        }
    }
    // The television's manifest, merged over the shared one: it takes back the
    // permissions LANTV never uses (src/tv/AndroidManifest.xml says which, and
    // why). Through the debug source set because that is the build type every
    // APK ships as, and a source set rather than a flavour for the reason given
    // at isTvBuild.
    if (isTvBuild) {
        sourceSets.getByName("debug").manifest.srcFile("src/tv/AndroidManifest.xml")
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    // The television's player (TvNativePlayer.kt). Only the playback engine: its
    // picture goes to a bare SurfaceView and every control is the page's own, so
    // none of Media3's UI artifacts are wanted.
    implementation("androidx.media3:media3-exoplayer:1.8.0")
    // Browsing other computers' shared drives (browse/SmbSource.kt). jcifs-ng
    // speaks SMB 2 and 3, which is what Windows and every current NAS offer, and
    // lists a host's shares as well as what is inside them. It wants slf4j and
    // BouncyCastle for the hashing and ciphers Android's own providers do not have.
    implementation("eu.agno3.jcifs:jcifs-ng:2.1.10")
    implementation("org.slf4j:slf4j-api:1.7.36")
    implementation("org.bouncycastle:bcprov-jdk18on:1.78.1")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")