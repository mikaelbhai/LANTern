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
        applicationId = if (isTvBuild) "app.lantern.tv" else "app.lantern.desktop"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            // A build type's placeholders replace the defaults wholesale, so
            // the label has to be repeated here or the TV build loses its name.
            manifestPlaceholders["appLabel"] = if (isTvBuild) "LANTV" else "LANTern"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
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
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")