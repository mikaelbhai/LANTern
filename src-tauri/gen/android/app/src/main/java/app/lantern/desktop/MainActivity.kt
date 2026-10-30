package app.lantern.desktop

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.PictureInPictureParams
import android.content.res.Configuration
import androidx.lifecycle.Lifecycle
import android.app.RemoteAction
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import androidx.core.content.ContextCompat
import android.app.UiModeManager
import android.content.pm.ActivityInfo
import android.content.pm.PackageManager
import android.view.KeyEvent
import android.graphics.drawable.Icon
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.media.RingtoneManager
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.os.PowerManager
import android.provider.Settings
import android.util.Log
import android.util.Rational
import android.webkit.WebView
import android.view.WindowManager
import androidx.activity.enableEdgeToEdge
import androidx.core.content.FileProvider
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import java.io.File
import java.lang.ref.WeakReference

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

    activityRef = WeakReference(this)
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

    ContextCompat.registerReceiver(
      this,
      pipReceiver,
      IntentFilter(ACTION_PIP_TOGGLE),
      ContextCompat.RECEIVER_NOT_EXPORTED,
    )
  }

  /**
   * Where the floating window's button lands.
   *
   * It was an activity intent, delivered to `onNewIntent`. Starting an activity
   * is exactly what takes the app out of the floating window, so every press of
   * the button paused the film and, a moment later, threw the window away and
   * brought the whole app to full screen. A broadcast to a receiver registered
   * here does the same work and leaves the window where it is.
   */
  private val pipReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      if (intent?.action == ACTION_PIP_TOGGLE) runCatching { nativePipToggle() }
    }
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

    runCatching { enterPictureInPictureMode(pipParams()) }
  }

  /**
   * Whether this is a television: the system says so, or it is the LANTV build.
   *
   * The package name is in there so the television build can be looked at on a
   * phone, which is how it is tested here.
   */
  private fun isTvDevice(): Boolean {
    val ui = getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager
    return ui?.currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
      packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK) ||
      packageName == "app.lantern.tv"
  }

  /**
   * Back held down on a remote.
   *
   * A short press is Back, and the page decides what that undoes. A long one is
   * "I want out" and is answered by the same question from anywhere - the
   * system only calls this once the press has been held, and consuming it here
   * is what stops the release from also counting as a short press.
   */
  override fun onKeyLongPress(keyCode: Int, event: KeyEvent): Boolean {
    if (keyCode == KeyEvent.KEYCODE_BACK && isTvDevice()) {
      runCatching { nativeBackHold() }
      return true
    }
    return super.onKeyLongPress(keyCode, event)
  }

  override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
    // Asked for explicitly: the long press is only ever reported for a key that
    // is being tracked, and relying on the base class to start tracking is
    // relying on a detail that has moved between Android versions.
    if (keyCode == KeyEvent.KEYCODE_BACK && isTvDevice() && event.repeatCount == 0) {
      event.startTracking()
      return true
    }
    return super.onKeyDown(keyCode, event)
  }

  private external fun nativeBackHold()

  /**
   * What the floating window looks like, for entering it and for updating it
   * while it is up.
   *
   * The shape is the film's own. It was a fixed 16:9, so a 2.39:1 film sat in a
   * box with bars baked into the window and a portrait clip was squeezed into a
   * landscape one. Android refuses anything outside 1:2.39 to 2.39:1, so the
   * ratio is clamped to what it will take rather than left to throw.
   *
   * The button is only offered for a film. A call has nothing to play or pause,
   * and a play button in a call window pauses nothing and says it does.
   */
  private fun pipParams(): PictureInPictureParams {
    val builder = PictureInPictureParams.Builder().setAspectRatio(pipRatio())
    if (!isCallRunning()) builder.setActions(listOf(pipToggleAction()))
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      // Android 12 and later shrink the window as the app is left - with the
      // animation, and without waiting for onUserLeaveHint to be delivered, which
      // gesture navigation does late or not at all. Only while a film is
      // running: a paused one is not something to follow you out of the app.
      builder.setAutoEnterEnabled(mediaPlaying && videoPlaying && !isCallRunning())
      builder.setSeamlessResizeEnabled(false)
    }
    return builder.build()
  }

  private fun pipRatio(): Rational {
    val w = videoWidth
    val h = videoHeight
    if (w <= 0 || h <= 0) return Rational(16, 9)
    val ratio = w.toDouble() / h.toDouble()
    return when {
      ratio > 2.39 -> Rational(239, 100)
      ratio < 1.0 / 2.39 -> Rational(100, 239)
      else -> Rational(w, h)
    }
  }

  /**
   * The page, kept so it can be held awake while the window is floating.
   *
   * Android pauses an activity that has gone into picture-in-picture, and the
   * base class answers that by pausing the WebView with it - which hides the
   * page and, with it, stops the film. The window opened at the right shape and
   * showed black, with the film paused behind it at the second it was left.
   * Nothing is wrong with a paused activity that is still on screen; the page
   * just has to be told it is still being looked at.
   */
  private var pipWebView: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    pipWebView = webView
  }

  private fun keepPageAwake() {
    pipWebView?.let {
      it.onResume()
      it.resumeTimers()
    }
  }

  override fun onPause() {
    super.onPause()
    // The base class has just paused the page. If this is the floating window
    // being entered, undo that; the mode-changed callback below covers the
    // order in which Android delivers the two.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && isInPictureInPictureMode) keepPageAwake()
  }

  /** Re-sends the window's shape, button and auto-enter flag to Android. */
  private fun refreshPipParams() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    runCatching { setPictureInPictureParams(pipParams()) }
  }

  /**
   * The floating window changing state.
   *
   * Three things end it and they are not the same: the app growing back to full
   * size, which is nothing to do; the window being closed with its X, which
   * leaves the activity stopped and must stop the film - the web page cannot
   * tell, and the film carried on playing, sound and all, behind a screen that
   * was no longer there; and the window being entered, which tells the player
   * to put its picture alone in it.
   */
  override fun onPictureInPictureModeChanged(
    isInPictureInPictureMode: Boolean,
    newConfig: Configuration,
  ) {
    super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
    val mode = when {
      isInPictureInPictureMode -> "pip"
      lifecycle.currentState == Lifecycle.State.CREATED -> "dismissed"
      else -> "expanded"
    }
    if (isInPictureInPictureMode) {
      keepPageAwake()
    } else if (mode == "dismissed") {
      // Closed with its X: the page has been told (below), and may now go back
      // to sleep. A beat later, so the telling is delivered first.
      pipWebView?.postDelayed({ pipWebView?.onPause() }, 400)
    }
    runCatching { nativePipMode(mode) }
  }

  private external fun nativePipMode(mode: String)

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
    val intent = Intent(ACTION_PIP_TOGGLE).setPackage(packageName)
    val pending = PendingIntent.getBroadcast(
      this,
      0,
      intent,
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    // Showing what pressing it does, and refreshed whenever the film starts or
    // stops (see `setPipVideo`). A single pause glyph that stayed put while the
    // film was paused read as "it is playing" on a window that was not.
    val glyph = if (videoPlaying) android.R.drawable.ic_media_pause else android.R.drawable.ic_media_play
    val label = if (videoPlaying) "Pause" else "Play"
    return RemoteAction(Icon.createWithResource(this, glyph), label, label, pending)
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
  private fun isPlayingSomething(): Boolean = mediaPlaying && videoPlaying

  /** Implemented in apkinstall.rs. */
  private external fun nativeRegisterInstaller()

  override fun onDestroy() {
    runCatching { unregisterReceiver(pipReceiver) }
    multicastLock?.let { lock ->
      if (lock.isHeld) {
        runCatching { lock.release() }
      }
    }
    multicastLock = null
    if (activityRef?.get() === this) activityRef = null
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
      if (!playing) videoPlaying = false
      val activity = activityRef?.get() ?: return
      activity.runOnUiThread { activity.refreshPipParams() }
    }

    /**
     * Hands a video to another app, VLC by preference.
     *
     * For a film whose sound this phone's WebView cannot decode and which nothing
     * on the phone can convert: VLC brings its own decoders. The address is
     * played where it is - the copy's own loopback address plays with no
     * network at all. `position` is the milliseconds to resume from, which VLC
     * reads from an extra of that name. Returns false when nothing could take it.
     */
    @JvmStatic
    fun openInExternalPlayer(url: String, title: String, positionMs: Long): Boolean {
      val activity = activityRef?.get() ?: return false
      val build = {
        Intent(Intent.ACTION_VIEW)
          .setDataAndType(Uri.parse(url), "video/*")
          .putExtra("title", title)
          .putExtra("position", positionMs)
          .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      }
      // VLC itself first, so a phone with several players does not ask which.
      return runCatching { activity.startActivity(build().setPackage("org.videolan.vlc")); true }
        .recoverCatching { activity.startActivity(build()); true }
        .getOrDefault(false)
    }

    /**
     * Leaves the app for real: the notification that keeps it listening goes, the
     * window goes, and the process with it. "Leave" on the television's prompt.
     */
    @JvmStatic
    fun exitApp() {
      val activity = activityRef?.get() ?: return
      activity.runOnUiThread {
        runCatching {
          activity.startService(
            Intent(activity, LanternService::class.java).setAction(LanternService.ACTION_STOP),
          )
        }
        activity.finishAndRemoveTask()
        // Once the window has had a moment to close. Without this the service's
        // process lingers and the television is still announcing itself.
        android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(
          { android.os.Process.killProcess(android.os.Process.myPid()) },
          500,
        )
      }
    }

    /** Whether the film is running right now, as opposed to merely open. */
    @Volatile
    private var videoPlaying = false

    /** The picture's own size, for the shape of the floating window. */
    @Volatile
    private var videoWidth = 0

    @Volatile
    private var videoHeight = 0

    /**
     * Called from pip.rs whenever the film starts, stops, or turns out to be a
     * different shape. Everything the floating window shows depends on these.
     */
    @JvmStatic
    fun setPipVideo(playing: Boolean, width: Int, height: Int) {
      videoPlaying = playing
      videoWidth = width
      videoHeight = height
      val activity = activityRef?.get() ?: return
      activity.runOnUiThread { activity.refreshPipParams() }
    }

    /**
     * The window itself, for the two things below that need one.
     *
     * Weak, for the reason `appContext` is the application and not this: a
     * static reference to an activity outlives it and keeps the whole window
     * alive. Unlike that one this cannot be the application context, because
     * `requestedOrientation` and window flags belong to an activity.
     */
    private var activityRef: WeakReference<MainActivity>? = null

    /**
     * Who decides which way up the screen is.
     *
     * `sensor` is the point of this: FULL_SENSOR rotates from the
     * accelerometer whatever the system's auto-rotate switch says, which is
     * how a video player behaves and what the switch being off was never
     * meant to prevent there. The web layer cannot do this - `screen.
     * orientation.lock` only works in fullscreen and cannot override that
     * switch at all.
     *
     * `locked` freezes the current orientation (the app's own lock),
     * `landscape` forces sideways but still picks the correct flip from the
     * sensor, and `system` gives rotation back to Android - which is what
     * every screen outside Theatre wants. Anything else is ignored rather
     * than guessed at.
     */
    @JvmStatic
    fun setOrientationMode(mode: String) {
      val activity = activityRef?.get() ?: return
      val requested = when (mode) {
        "sensor" -> ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
        // The sensor again, but through the system's own table of allowed
        // turns, which on a phone leaves out upside-down portrait.
        "noflip" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR
        "locked" -> ActivityInfo.SCREEN_ORIENTATION_LOCKED
        "landscape" -> ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
        "system" -> ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        else -> return
      }
      activity.runOnUiThread { runCatching { activity.requestedOrientation = requested } }
    }

    /**
     * Keeps the screen on while a film is playing.
     *
     * A flag on the window rather than a wake lock: it needs no permission,
     * it is released by the system if the activity goes away, and it only
     * holds while this window is in front - which is exactly the condition
     * a film needs and a background wake lock would get wrong.
     */
    @JvmStatic
    fun setKeepScreenOn(on: Boolean) {
      val activity = activityRef?.get() ?: return
      activity.runOnUiThread {
        runCatching {
          if (on) activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
          else activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
      }
    }

    /**
     * The screen while a film is full screen: full brightness, and the system's
     * own bars out of the way until the player asks for them.
     *
     * `player` is whether the full-screen player is up at all; `bars` is whether
     * the status bar and gesture strip should be showing right now. They follow
     * the player's own controls - gone while only the picture is on screen, back
     * together with the controls when somebody taps - so the phone's clock is
     * never drawn over a film that nobody is touching.
     *
     * Brightness is the window's, not the system setting: it is full while this
     * window is in front and the player is up, and the phone's own level returns
     * the moment it is not. Nothing is written to Settings and nothing needs a
     * permission.
     */
    @JvmStatic
    fun setPlayerScreen(player: Boolean, bars: Boolean) {
      val activity = activityRef?.get() ?: return
      activity.runOnUiThread {
        runCatching {
          val window = activity.window
          val controller = WindowInsetsControllerCompat(window, window.decorView)
          val params = window.attributes
          if (player) {
            params.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_FULL
            // A swipe from the edge brings the bars back for a moment and they
            // leave again by themselves, so the gesture to leave is not lost.
            controller.systemBarsBehavior =
              WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            if (bars) controller.show(WindowInsetsCompat.Type.systemBars())
            else controller.hide(WindowInsetsCompat.Type.systemBars())
            // Under the notch as well, so landscape fills the whole panel.
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
              params.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
          } else {
            params.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE
            controller.show(WindowInsetsCompat.Type.systemBars())
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
              params.layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT
            }
          }
          window.attributes = params
        }
      }
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

    /**
     * Whether this app can see every file, not only its own and its media.
     *
     * Since scoped storage a directory listing silently omits everything an
     * app was not granted - documents, PDFs, other apps' downloads - so a
     * phone browsed from another device looks empty rather than refused.
     * Below Android 11 the ordinary storage permission is all there is.
     */
    @JvmStatic
    fun allFilesAccess(): Boolean = runCatching {
      Build.VERSION.SDK_INT < Build.VERSION_CODES.R || Environment.isExternalStorageManager()
    }.getOrDefault(false)

    /**
     * Opens the Settings page for the "All files access" switch.
     *
     * It is a switch, not a dialog: there is no way to be told yes, only to
     * take the person to where they can say it. The caller re-checks after.
     */
    @JvmStatic
    fun requestAllFilesAccess() {
      val ctx = appContext ?: return
      runCatching {
        ctx.startActivity(
          Intent(
            Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
            Uri.parse("package:${ctx.packageName}"),
          ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
        )
      }.exceptionOrNull()?.let { Log.w("LANTern", "all files access request", it) }
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
