package app.lantern.desktop

import android.app.PictureInPictureParams
import android.content.Context
import android.media.AudioManager
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Rational
import androidx.activity.enableEdgeToEdge

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
    if (!isCallRunning()) return
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

  override fun onDestroy() {
    multicastLock?.let { lock ->
      if (lock.isHeld) {
        runCatching { lock.release() }
      }
    }
    multicastLock = null
    super.onDestroy()
  }
}
