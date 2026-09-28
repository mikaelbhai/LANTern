package app.lantern.desktop

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.app.RemoteAction
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.RingtoneManager
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.PowerManager
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
          .setActions(listOf(pipToggleAction()))
          .build(),
      )
    }
  }

  /**
   * The one button a PiP window gets: toggle play/pause.
   *
   * Without this, entering picture-in-picture opened a window with nothing
   * on it Android would draw a control for - the web page's own play button
   * is exactly what a thumbnail-sized floating window has no room for and no
   * accurate way to tap, and the system only draws its own overlay button
   * when a `RemoteAction` asks for one.
   *
   * One icon for both directions rather than two swapping with playback
   * state: doing that live needs the player reporting its state back up to
   * here on every change, for a button that is only ever looked at for the
   * half second it takes to tap it. A single glyph that means "toggle" is
   * the honest one.
   */
  private fun pipToggleAction(): RemoteAction {
    val intent = Intent(this, MainActivity::class.java).setAction(ACTION_PIP_TOGGLE)
    val pending = PendingIntent.getActivity(
      this,
      0,
      intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    return RemoteAction(
      Icon.createWithResource(this, android.R.drawable.ic_media_pause),
      "Play or pause",
      "Play or pause",
      pending,
    )
  }

  /**
   * Where the PiP button's tap actually lands.
   *
   * `singleTask` means Android delivers it here rather than starting a
   * second copy of the activity, which is what makes a PendingIntent back
   * into this same window the simplest route in - no separate receiver
   * component to declare and keep alive for as long as the window is open.
   */
  override fun onNewIntent(intent: Intent) {
    super.onNewIntent(intent)
    if (intent.action == ACTION_PIP_TOGGLE) {
      runCatching { nativePipToggle() }
    }
  }

  private external fun nativePipToggle()

  private fun isCallRunning(): Boolean {
    val audio = applicationContext.getSystemService(Context.AUDIO_SERVICE) as? AudioManager
      ?: return false
    return audio.mode == AudioManager.MODE_IN_COMMUNICATION ||
      audio.mode == AudioManager.MODE_IN_CALL
  }

  /**
   * Whether a film is on screen.
   *
   * A desktop pops the video itself out into a floating window; Android's
   * WebView cannot do that, so the whole app goes into the corner instead -
   * which comes to the same thing for the one purpose either serves, which is
   * carrying on watching while doing something else.
   *
   * Told to us by the player rather than sniffed from the audio stack.
   * `isMusicActive` is true of *any* sound on the device - a game's effects,
   * another app's music - so leaving LANTern while a game beeped put the whole
   * application in a floating window, which is picture-in-picture for
   * something with no picture worth keeping.
   */
  private fun isPlayingSomething(): Boolean = mediaPlaying

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
    /** The PiP window's play/pause button, routed back through onNewIntent. */
    private const val ACTION_PIP_TOGGLE = "app.lantern.desktop.PIP_TOGGLE"

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
     * Set by the player while a film is on screen. See `isPlayingSomething`.
     *
     * Volatile because it is written from whichever thread the Rust side
     * happens to be on and read on the main thread as the app is left.
     */
    @Volatile
    private var mediaPlaying = false

    /** Called from pip.rs when the player opens and when it closes. */
    @JvmStatic
    fun setMediaPlaying(playing: Boolean) {
      mediaPlaying = playing
    }

    private const val CALL_CHANNEL_ID = "lantern-incoming-call"
    private const val CALL_NOTIFICATION_ID = 2

    /**
     * Rings, full screen, over whatever is already on the glass.
     *
     * Called from incomingcall.rs the moment a call offer arrives over the
     * signalling link - native, so it runs whether or not the WebView's own
     * JS is currently being let run at all. `setFullScreenIntent` is what
     * does the actual taking-over: with the screen off or locked Android
     * launches it directly, full screen, the way a real phone call does:
     * with the screen already on and something else in front, Android
     * turns it into a heads-up banner with these same two actions instead,
     * rather than yanking a different app away from whoever is using it.
     * Either way this is the one alerting path in this app that does not
     * depend on a single line of JS having executed.
     */
    @JvmStatic
    fun showIncomingCall(from: String, callId: String, caller: String, video: Boolean) {
      val ctx = appContext ?: return
      runCatching {
        val manager = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
          manager.getNotificationChannel(CALL_CHANNEL_ID) == null
        ) {
          val channel = NotificationChannel(
            CALL_CHANNEL_ID,
            "Incoming calls",
            NotificationManager.IMPORTANCE_HIGH,
          ).apply {
            description = "Rings full-screen for a voice or video call from the network."
            enableVibration(true)
            setSound(
              RingtoneManager.getActualDefaultRingtoneUri(ctx, RingtoneManager.TYPE_RINGTONE),
              AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_NOTIFICATION_RINGTONE)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build(),
            )
          }
          manager.createNotificationChannel(channel)
        }

        // Same target either way - answering and just opening the app both
        // land on the ringing screen the frontend is already showing from
        // its own `call:state` event, so there is nothing separate for
        // "Answer" to do beyond getting the window in front of the person.
        val open = PendingIntent.getActivity(
          ctx,
          callId.hashCode(),
          Intent(ctx, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP
          },
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val decline = PendingIntent.getBroadcast(
          ctx,
          callId.hashCode(),
          Intent(ctx, CallDeclineReceiver::class.java).apply {
            putExtra("from", from)
            putExtra("callId", callId)
          },
          PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
          Notification.Builder(ctx, CALL_CHANNEL_ID)
        } else {
          @Suppress("DEPRECATION")
          Notification.Builder(ctx)
        }

        @Suppress("DEPRECATION") // pre-O has no channel to carry priority instead
        val notification = builder
          .setContentTitle(caller)
          .setContentText(if (video) "Incoming video call" else "Incoming voice call")
          .setSmallIcon(android.R.drawable.sym_call_incoming)
          .setCategory(Notification.CATEGORY_CALL)
          .setPriority(Notification.PRIORITY_MAX)
          .setFullScreenIntent(open, true)
          .setContentIntent(open)
          .setOngoing(true)
          .setAutoCancel(false)
          .addAction(Notification.Action.Builder(null, "Decline", decline).build())
          .addAction(Notification.Action.Builder(null, "Answer", open).build())
          .build()

        manager.notify(CALL_NOTIFICATION_ID, notification)
      }.exceptionOrNull()?.let { Log.w("LANTern", "incoming call notification", it) }
    }

    /**
     * The call ended before it was answered - hung up, declined from the
     * far end, or picked up on a different device. Clears the notification
     * so a call that is over does not keep ringing.
     *
     * Takes the call id even though only one incoming-call notification
     * exists at a time and there is nothing to disambiguate yet - matching
     * showIncomingCall's signature is what keeps a second concurrent call
     * from being a signature change on both sides of the JNI boundary
     * later, rather than a one-line diff.
     */
    @JvmStatic
    fun cancelIncomingCall(@Suppress("UNUSED_PARAMETER") callId: String) {
      val ctx = appContext ?: return
      runCatching {
        (ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager)
          .cancel(CALL_NOTIFICATION_ID)
      }
    }

    /**
     * Routes a call to the earpiece, the way a phone call goes.
     *
     * A voice call with no picture is held against the ear, and everything
     * about the phone is already built for that: the small speaker at the top
     * is aimed at an ear rather than a room, and the microphone the call
     * stack picks in this mode is the one at the bottom, near the mouth, with
     * the echo cancelling and noise suppression that come with it.
     *
     * Out loud is right for a video call, where the phone is held away and
     * being looked at. So the picture decides, and this is told which.
     *
     * `setCommunicationDevice` is the modern way and the only one that works
     * reliably from Android 12; `isSpeakerphoneOn` is what there was before
     * and is still what those versions listen to.
     */
    @JvmStatic
    fun setEarpiece(earpiece: Boolean): Boolean = runCatching {
      val ctx = appContext ?: return false
      val audio = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return false

      // The mode is what makes this a call rather than media playback: it
      // picks the communication microphone and turns on the echo canceller.
      audio.mode = AudioManager.MODE_IN_COMMUNICATION

      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val want =
          if (earpiece) AudioDeviceInfo.TYPE_BUILTIN_EARPIECE
          else AudioDeviceInfo.TYPE_BUILTIN_SPEAKER
        val device = audio.availableCommunicationDevices.firstOrNull { it.type == want }
        // A device with no earpiece - a tablet, a television - simply has
        // nothing to route to, and is left as it was rather than silenced.
        if (device == null) false else audio.setCommunicationDevice(device)
      } else {
        @Suppress("DEPRECATION")
        run {
          audio.isSpeakerphoneOn = !earpiece
          true
        }
      }
    }.getOrDefault(false)

    /**
     * Hands the audio stack back when the call ends.
     *
     * Leaving the mode set keeps the phone in call routing afterwards, which
     * is how a device ends up playing music through the earpiece.
     */
    /**
     * Whether Android's battery optimizer is currently free to doze this
     * process. The foreground service is what is supposed to keep LANTern
     * reachable in the background, but the optimizer can still suspend it
     * between wakeups on top of that - this is the other half.
     */
    @JvmStatic
    fun batteryUnrestricted(): Boolean = runCatching {
      val ctx = appContext ?: return false
      val power = ctx.getSystemService(Context.POWER_SERVICE) as? PowerManager ?: return false
      power.isIgnoringBatteryOptimizations(ctx.packageName)
    }.getOrDefault(false)

    /**
     * Asks the user to exempt LANTern from battery optimization.
     *
     * Unlike `installPackage`'s settings deep-link, `ACTION_REQUEST_IGNORE_
     * BATTERY_OPTIMIZATIONS` shows the grant itself as a system dialog - one
     * Allow/Deny, no navigating through Settings to find the right toggle.
     */
    @JvmStatic
    fun requestBatteryUnrestricted() {
      val ctx = appContext ?: return
      runCatching {
        ctx.startActivity(
          Intent(
            Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
            Uri.parse("package:${ctx.packageName}"),
          ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
      }.exceptionOrNull()?.let { Log.w("LANTern", "battery optimization request", it) }
    }

    @JvmStatic
    fun clearCallAudio() {
      val ctx = appContext ?: return
      val audio = ctx.getSystemService(Context.AUDIO_SERVICE) as? AudioManager ?: return
      runCatching {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
          audio.clearCommunicationDevice()
        } else {
          @Suppress("DEPRECATION")
          run { audio.isSpeakerphoneOn = false }
        }
        audio.mode = AudioManager.MODE_NORMAL
      }
    }

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
