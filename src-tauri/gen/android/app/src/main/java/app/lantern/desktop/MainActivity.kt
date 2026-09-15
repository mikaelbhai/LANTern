package app.lantern.desktop

import android.app.PictureInPictureParams
import android.content.Context
import android.content.Intent
import android.media.AudioManager
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import android.util.Rational
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import java.io.File

/**
 * LANTern's Android entry point.
 *
 * Two things happen here that the stock Tauri activity does not do, both of
 * them prerequisites for the app being usable on a LAN rather than merely
 * running.
 */
class MainActivity : TauriActivity() {
  private var multicastLock: WifiManager.MulticastLock? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    publishDeviceName()

    enableEdgeToEdge()
    super.onCreate(savedInstanceState)

    acquireMulticastLock()

    // Hand the Java runtime to the Rust side, which has no other way to reach
    // it. Everything it needs - the virtual machine, and a class reference
    // resolved by *this* app's class loader - is only certainly available from
    // in here, on this thread. See apkinstall.rs.
    appContext = applicationContext
    runCatching { nativeRegisterInstaller() }

    // Stay reachable once this window is no longer on screen. Without a
    // foreground service Android suspends the process on background, so the
    // device drops off the network the moment you switch apps.
    runCatching { LanternService.start(this) }
  }

  /**
   * Tells the Rust layer what to call this device.
   *
   * Android sets neither COMPUTERNAME nor HOSTNAME, so without this every
   * phone announces itself as the fallback name and the peer list fills with
   * identical entries. This must run before `super.onCreate`, which is where
   * Tauri starts the Rust side and the first mDNS announcement goes out.
   */
  private fun publishDeviceName() {
    val name = runCatching {
      Settings.Global.getString(contentResolver, Settings.Global.DEVICE_NAME)
    }.getOrNull()?.takeIf { it.isNotBlank() }
      ?: deviceModelName(Build.MANUFACTURER, Build.MODEL)

    runCatching { android.system.Os.setenv("LANTERN_DEVICE_NAME", name, true) }
  }

  /** "Pixel 9a", not "Google Pixel 9a" - the model usually carries the brand. */
  private fun deviceModelName(manufacturer: String?, model: String?): String {
    val m = model?.trim().orEmpty()
    val brand = manufacturer?.trim().orEmpty()
    return when {
      m.isEmpty() && brand.isEmpty() -> "Android device"
      m.isEmpty() -> brand
      brand.isEmpty() || m.startsWith(brand, ignoreCase = true) -> m
      else -> "$brand $m"
    }
  }

  /**
   * Android drops multicast before it reaches an app unless the process holds
   * a lock, and mDNS - the whole basis of peer discovery - is multicast. The
   * manifest permission allows the lock to be taken; it does not take it.
   * Without this the phone is found by desktops but never sees them itself,
   * which looks exactly like a broken network.
   *
   * It costs battery, because the Wi-Fi chip can no longer filter packets in
   * hardware. That is why it is not the default, and why LANTern takes it
   * deliberately rather than leaving discovery quietly broken.
   */
  private fun acquireMulticastLock() {
    val wifi = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
    multicastLock = wifi?.createMulticastLock("lantern-mdns")?.apply {
      setReferenceCounted(true)
      runCatching { acquire() }
    }
  }

  /**
   * Shrinks the call into a floating window when you leave the app.
   *
   * This is what "pop the call out" means on a phone: not a second window -
   * Android does not have those - but the app itself continuing in a small
   * frame above whatever you go to next. The system calls this the moment
   * Home or a task switch takes you away, which is exactly when a call still
   * running needs to stay visible.
   *
   * Whether a call is running is read from the audio mode rather than asked
   * of the web layer. There is no channel from the Rust side into this
   * activity, and inventing one through JNI to answer a single yes-or-no
   * question is a lot of machinery that crashes the app when it is wrong.
   * MODE_IN_COMMUNICATION is set by the media stack while a microphone is
   * captured for a call, so it says the same thing without the bridge.
   *
   * The cost of the heuristic being wrong is small in both directions: no
   * floating window when there should be one, or a floating window when
   * nothing is on the call. Neither breaks anything.
   */
  override fun onUserLeaveHint() {
    super.onUserLeaveHint()
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    if (!isCallRunning() && !isPlayingSomething()) return
    if (isInPictureInPictureMode) return

    runCatching {
      enterPictureInPictureMode(
        PictureInPictureParams.Builder()
          // The shape of a video call. Android clamps anything too extreme.
          .setAspectRatio(Rational(16, 9))
          .build(),
      )
    }
  }

  private fun isCallRunning(): Boolean {
    val audio = applicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
      ?: return false
    return audio.mode == AudioManager.MODE_IN_COMMUNICATION ||
      audio.mode == AudioManager.MODE_IN_CALL
  }

  /**
   * Whether a film is playing, asked the same way a call is.
   *
   * A desktop pops the video itself out into a floating window; Android's
   * WebView cannot do that, so the whole app goes into the corner instead -
   * which comes to the same thing for the one purpose either serves, which is
   * carrying on watching while doing something else.
   *
   * Read from the audio stack rather than from the web layer, for the reason
   * given above: there is no channel from Rust into this activity, and a film
   * playing is a film making sound.
   *
   * Wrong in both directions occasionally - a muted film does not count, and
   * music from another app briefly might - and neither costs anything. The
   * window either appears when it need not have, or does not when it could.
   */
  private fun isPlayingSomething(): Boolean {
    val audio = applicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
      ?: return false
    return runCatching { audio.isMusicActive }.getOrDefault(false)
  }

  /** Implemented in apkinstall.rs. */
  private external fun nativeRegisterInstaller()

  override fun onDestroy() {
    multicastLock?.let { lock ->
      if (lock.isHeld) {
        runCatching { lock.release() }
      }
    }
    multicastLock = null
    super.onDestroy()
  }

  companion object {
    init {
      // Ordinarily already loaded by `Rust`, whose own initialiser does this
      // before the activity gets going. Repeating it costs nothing - the
      // runtime loads a library once per class loader - and means the native
      // methods below cannot be reached before the code behind them exists.
      runCatching { System.loadLibrary("lantern_lib") }
    }

    /**
     * Kept so the installer can be opened from the Rust side, which runs on
     * threads that have no activity and no context of their own.
     *
     * The *application* context, not this activity: an activity reference
     * held statically outlives the activity and leaks the whole window with
     * it. Starting an activity from a non-activity context is what
     * FLAG_ACTIVITY_NEW_TASK below is for.
     */
    private var appContext: Context? = null

    /**
     * Opens the system package installer on a staged APK.
     *
     * Returns an empty string if the installer was launched, or a description
     * of what stopped it. It deliberately does not throw: the caller is JNI,
     * where reading an exception costs far more than reading a string and
     * tells nobody anything more.
     *
     * Launching it is the whole of this app's part. Android asks for the
     * install permission if it does not have it, shows what is being
     * replaced, and can be refused - and none of those answers come back
     * here, so nothing downstream may assume an install happened.
     */
    @JvmStatic
    fun installPackage(path: String): String {
      val context = appContext ?: return "the app is not running"
      return runCatching {
        val file = File(path)
        if (!file.isFile) return "the downloaded file is no longer there"

        // Since Oreo, permission to install is granted per app, and an app
        // that does not have it gets a dead end: a dialogue saying it is not
        // allowed, and no obvious way to allow it. So the settings page that
        // grants it is opened instead, and the update is left to be pressed
        // again afterwards. The decision stays where it belongs - nothing is
        // changed here, the user is only taken to where they can change it.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
          !context.packageManager.canRequestPackageInstalls()
        ) {
          val opened = runCatching {
            context.startActivity(
              Intent(
                Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                Uri.parse("package:${context.packageName}"),
              ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
          }
          opened.exceptionOrNull()?.let { Log.w("LANTern", "install settings", it) }
          return if (opened.isSuccess) {
            "allow LANTern to install apps, then press update again"
          } else {
            "allow LANTern to install apps in Settings, then press update again"
          }
        }

        // The installer is another process and cannot read this app's private
        // storage, so it is given a content URI carrying a read grant instead
        // of a path it would only be refused.
        val uri = FileProvider.getUriForFile(
          context,
          "${context.packageName}.fileprovider",
          file,
        )

        val intent = Intent(Intent.ACTION_VIEW)
          .setDataAndType(uri, "application/vnd.android.package-archive")
          .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)

        context.startActivity(intent)
        ""
      }.getOrElse { error ->
        Log.w("LANTern", "install", error)
        error.message ?: error.toString()
      }
    }
  }
}
