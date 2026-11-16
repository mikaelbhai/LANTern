# What must survive shrinking, because something reaches it by name that R8
# cannot see.
#
# The debug build type is minified (see build.gradle.kts), so these rules are in
# force in every APK that ships.

# Rust calls into the app through JNI by class and method name: MainActivity's
# statics (pip.rs, battery.rs, storage.rs, callaudio.rs, incomingcall.rs,
# apkinstall.rs, commands.rs), and Tauri's generated classes. A renamed or
# removed method there is a crash the first time that feature is used, not at
# start, so all of it is kept rather than method by method.
-keep class app.lantern.desktop.** { *; }
-keep class app.tauri.** { *; }

# The page calls these through addJavascriptInterface (TvNativePlayer, Ipc, the
# mirroring classes). R8 cannot see a call that arrives from JavaScript.
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}
-keepattributes JavascriptInterface,*Annotation*

# Stack traces that still name the line, for the crash log.
-keepattributes SourceFile,LineNumberTable
