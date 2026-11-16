package app.lantern.desktop

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.pm.PackageManager
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.AudioFormat
import android.media.AudioPlaybackCaptureConfiguration
import android.media.AudioRecord
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Display
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.content.ContextCompat
import java.io.BufferedOutputStream
import java.io.DataOutputStream
import java.io.IOException
import java.net.InetSocketAddress
import java.net.Socket
import org.json.JSONObject

/**
 * A phone's end of screen mirroring: its screen and sound, to a television.
 *
 * The WebView cannot capture the screen (`getDisplayMedia` does not exist there),
 * so this does it natively: Android's own consent, a virtual display feeding the
 * hardware H.264 encoder, and - on Android 10 and later - the sound other apps
 * play, through AAC. Both go to the television over the connection it opened
 * (MirrorProtocol), which then decodes them with its own hardware.
 *
 * Sound is best effort. Android lets an app refuse to be captured, and capturing
 * at all needs the microphone permission (that is how Android names "hear other
 * apps"); without either the picture still goes.
 *
 * Phones only (registered in MainActivity). Must be constructed in onCreate, since
 * the consent and permission launchers can only be registered before the activity
 * starts. Reports to the page through `window.__mirrorEvent`.
 */
class ScreenMirror(private val activity: ComponentActivity) {
  companion object {
    /** The mirror running now, for LanternService to reach (it promotes, and its Stop action ends it). */
    @Volatile var active: ScreenMirror? = null

    fun onServicePromoted(ok: Boolean) {
      active?.promoted(ok)
    }

    fun stopFromNotification() {
      active?.let { Thread({ it.stopNow("stopped") }, "mirror-stop").start() }
    }

    private const val FPS = 30
    private const val VIDEO_BITRATE = 8_000_000
    private const val SAMPLE_RATE = 48_000
    private const val CHANNELS = 2
  }

  private class Target(val host: String, val port: Int, val token: String, val label: String)

  var webView: WebView? = null
  private val main = Handler(Looper.getMainLooper())
  private val sendLock = Any()
  private val videoLock = Any()

  private var target: Target? = null
  private var consent: ActivityResult? = null
  @Volatile private var running = false
  private var projection: MediaProjection? = null
  private var display: VirtualDisplay? = null
  @Volatile private var encoder: MediaCodec? = null
  private var size = 0 to 0
  private var socket: Socket? = null
  private var out: DataOutputStream? = null
  @Volatile private var recorder: AudioRecord? = null
  @Volatile private var audioEncoder: MediaCodec? = null

  private val askPermission =
    activity.registerForActivityResult(ActivityResultContracts.RequestPermission()) { askConsent() }
  private val askCapture =
    activity.registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { onConsent(it) }

  /** Starts mirroring to a television that accepted: its address, the port it opened and its token. */
  @JavascriptInterface
  fun start(host: String, port: Int, token: String, label: String) {
    main.post {
      if (running || target != null) return@post
      target = Target(host, port, token, label)
      val needsMic = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q &&
        ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED
      if (needsMic) askPermission.launch(Manifest.permission.RECORD_AUDIO) else askConsent()
    }
  }

  @JavascriptInterface
  fun stop() {
    Thread({ stopNow("stopped") }, "mirror-stop").start()
  }

  private fun askConsent() {
    val manager = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
    emit("consent", "")
    askCapture.launch(manager.createScreenCaptureIntent())
  }

  private fun onConsent(result: ActivityResult) {
    val t = target
    if (t == null || result.resultCode != Activity.RESULT_OK || result.data == null) {
      target = null
      emit("declined", "")
      return
    }
    consent = result
    active = this
    // Android 14 hands over the screen only to a foreground service already
    // running as a screen-capture one; LanternService says when it is.
    LanternService.mirroring(activity, true, t.label)
  }

  private fun promoted(ok: Boolean) {
    main.post {
      val result = consent
      val t = target
      consent = null
      if (!ok || result == null || t == null) {
        target = null
        active = null
        emit("error", "Android would not allow the screen to be captured")
        return@post
      }
      val manager = activity.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
      val p = try {
        manager.getMediaProjection(result.resultCode, result.data!!)
      } catch (e: SecurityException) {
        null
      }
      if (p == null) {
        stopNow("error")
        return@post
      }
      projection = p
      // Required before a virtual display can be made (Android 14), and how a stop
      // from the system's own "stop sharing" chip reaches here.
      p.registerCallback(object : MediaProjection.Callback() {
        override fun onStop() {
          Thread({ stopNow("stopped") }, "mirror-stop").start()
        }
      }, main)
      running = true
      Thread({ connectAndRun(t, p) }, "mirror-send").start()
    }
  }

  private fun connectAndRun(t: Target, p: MediaProjection) {
    try {
      val s = Socket()
      s.connect(InetSocketAddress(t.host, t.port), 5_000)
      s.tcpNoDelay = true
      s.sendBufferSize = 1 shl 20
      socket = s
      val stream = DataOutputStream(BufferedOutputStream(s.getOutputStream(), 1 shl 16))
      out = stream
      MirrorProtocol.writeHello(stream, t.token)
      main.post {
        if (!running) return@post
        try {
          startVideo(p)
          watchRotation()
          emit("live", "")
        } catch (e: Exception) {
          Log.w("ScreenMirror", "could not start the picture", e)
          Thread({ stopNow("error") }, "mirror-stop").start()
        }
      }
      startAudio(p)
    } catch (e: IOException) {
      Log.w("ScreenMirror", "could not reach the television", e)
      stopNow("unreachable")
    }
  }

  /* ---------------------------------------------------------------- picture */

  private fun screenSize(): Pair<Int, Int> {
    val wm = activity.getSystemService(Context.WINDOW_SERVICE) as WindowManager
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      val bounds = wm.maximumWindowMetrics.bounds
      bounds.width() to bounds.height()
    } else {
      val metrics = android.util.DisplayMetrics()
      @Suppress("DEPRECATION")
      wm.defaultDisplay.getRealMetrics(metrics)
      metrics.widthPixels to metrics.heightPixels
    }
  }

  private fun startVideo(p: MediaProjection) {
    val (screenW, screenH) = screenSize()
    val fitted = MirrorProtocol.fitSize(screenW, screenH)
    val codec = newEncoder(fitted)
    val dpi = activity.resources.displayMetrics.densityDpi
    display = p.createVirtualDisplay(
      "LANTern mirror", fitted.first, fitted.second, dpi,
      DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, codec.createInputSurface().also { surfaceOf[codec] = it }, null, null,
    )
    synchronized(videoLock) {
      encoder = codec
      size = fitted
    }
    codec.start()
    Thread({ drainVideo(codec, fitted) }, "mirror-encode").start()
  }

  private val surfaceOf = HashMap<MediaCodec, android.view.Surface>()

  private fun newEncoder(fitted: Pair<Int, Int>): MediaCodec {
    val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, fitted.first, fitted.second).apply {
      setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface)
      setInteger(MediaFormat.KEY_BIT_RATE, VIDEO_BITRATE)
      setInteger(MediaFormat.KEY_FRAME_RATE, FPS)
      // A keyframe a second, so a television that drops a packet recovers quickly.
      setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
      // A still screen produces no frames at all; repeat the last so the
      // television's decoder keeps showing it and a late joiner gets a picture.
      setLong(MediaFormat.KEY_REPEAT_PREVIOUS_FRAME_AFTER, 100_000)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
      setInteger(MediaFormat.KEY_PRIORITY, 0)
    }
    val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
    codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
    return codec
  }

  private fun drainVideo(codec: MediaCodec, fitted: Pair<Int, Int>) {
    val info = MediaCodec.BufferInfo()
    var configSent = false
    try {
      while (running && encoder === codec) {
        val index = codec.dequeueOutputBuffer(info, 10_000)
        when {
          index == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED && !configSent -> {
            // Some encoders put SPS/PPS only in the format, never in a buffer.
            val format = codec.outputFormat
            val csd = bytes(format.getByteBuffer("csd-0")) + bytes(format.getByteBuffer("csd-1"))
            if (csd.isNotEmpty()) {
              send(MirrorProtocol.VIDEO_CONFIG, 0, MirrorProtocol.videoConfig(fitted.first, fitted.second, csd))
              configSent = true
            }
          }
          index >= 0 -> {
            val buffer = codec.getOutputBuffer(index)
            if (buffer != null && info.size > 0) {
              val data = ByteArray(info.size)
              buffer.position(info.offset)
              buffer.get(data)
              if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
                send(MirrorProtocol.VIDEO_CONFIG, 0, MirrorProtocol.videoConfig(fitted.first, fitted.second, data))
                configSent = true
              } else {
                send(MirrorProtocol.VIDEO_FRAME, info.presentationTimeUs, data)
              }
            }
            codec.releaseOutputBuffer(index, false)
          }
        }
      }
    } catch (_: IllegalStateException) {
      // Replaced (the phone turned) or stopped.
    } catch (e: IOException) {
      stopNow("lost")
    }
  }

  private fun bytes(buffer: java.nio.ByteBuffer?): ByteArray {
    buffer ?: return ByteArray(0)
    val copy = buffer.duplicate()
    copy.position(0)
    val out = ByteArray(copy.remaining())
    copy.get(out)
    return out
  }

  /** The phone turned: a new encoder at the new shape, sent as a new configuration. */
  private val rotation = object : DisplayManager.DisplayListener {
    override fun onDisplayAdded(displayId: Int) {}
    override fun onDisplayRemoved(displayId: Int) {}
    override fun onDisplayChanged(displayId: Int) {
      if (displayId != Display.DEFAULT_DISPLAY || !running) return
      val fitted = MirrorProtocol.fitSize(screenSize().first, screenSize().second)
      if (fitted == size) return
      restartVideo(fitted)
    }
  }

  private fun watchRotation() {
    val dm = activity.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager
    dm.registerDisplayListener(rotation, main)
  }

  private fun restartVideo(fitted: Pair<Int, Int>) {
    val vd = display ?: return
    try {
      val codec = newEncoder(fitted)
      val surface = codec.createInputSurface()
      val old: MediaCodec?
      synchronized(videoLock) {
        old = encoder
        encoder = codec
        size = fitted
      }
      vd.resize(fitted.first, fitted.second, activity.resources.displayMetrics.densityDpi)
      vd.surface = surface
      codec.start()
      Thread({ drainVideo(codec, fitted) }, "mirror-encode").start()
      old?.let { o ->
        runCatching { o.stop() }
        runCatching { o.release() }
        surfaceOf.remove(o)?.release()
      }
      surfaceOf[codec] = surface
    } catch (e: Exception) {
      Log.w("ScreenMirror", "could not follow the rotation", e)
    }
  }

  /* ------------------------------------------------------------------ sound */

  private fun startAudio(p: MediaProjection) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    if (ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      emit("nosound", "Sound needs the microphone permission, which is how Android lets an app hear other apps.")
      return
    }
    try {
      val capture = AudioPlaybackCaptureConfiguration.Builder(p)
        .addMatchingUsage(android.media.AudioAttributes.USAGE_MEDIA)
        .addMatchingUsage(android.media.AudioAttributes.USAGE_GAME)
        .addMatchingUsage(android.media.AudioAttributes.USAGE_UNKNOWN)
        .build()
      val pcm = AudioFormat.Builder()
        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
        .setSampleRate(SAMPLE_RATE)
        .setChannelMask(AudioFormat.CHANNEL_IN_STEREO)
        .build()
      val minimum = AudioRecord.getMinBufferSize(SAMPLE_RATE, AudioFormat.CHANNEL_IN_STEREO, AudioFormat.ENCODING_PCM_16BIT)
      @Suppress("MissingPermission")
      val record = AudioRecord.Builder()
        .setAudioFormat(pcm)
        .setBufferSizeInBytes(maxOf(minimum, 8192) * 2)
        .setAudioPlaybackCaptureConfig(capture)
        .build()
      val aac = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, SAMPLE_RATE, CHANNELS).apply {
        setInteger(MediaFormat.KEY_AAC_PROFILE, MediaCodecInfo.CodecProfileLevel.AACObjectLC)
        setInteger(MediaFormat.KEY_BIT_RATE, 128_000)
        setInteger(MediaFormat.KEY_MAX_INPUT_SIZE, 16_384)
      }
      val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
      codec.configure(aac, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
      codec.start()
      record.startRecording()
      recorder = record
      audioEncoder = codec
      Thread({ pumpAudio(record, codec) }, "mirror-sound-in").start()
      Thread({ drainAudio(codec) }, "mirror-sound-out").start()
    } catch (e: Exception) {
      Log.w("ScreenMirror", "no sound for this mirror", e)
      emit("nosound", "This phone did not let its sound be captured; the picture still goes.")
    }
  }

  private fun pumpAudio(record: AudioRecord, codec: MediaCodec) {
    val chunk = ByteArray(4096)
    var frames = 0L
    try {
      while (running && recorder === record) {
        val read = record.read(chunk, 0, chunk.size)
        if (read <= 0) continue
        val index = codec.dequeueInputBuffer(10_000)
        if (index < 0) continue
        val buffer = codec.getInputBuffer(index) ?: continue
        buffer.clear()
        val length = minOf(read, buffer.capacity())
        buffer.put(chunk, 0, length)
        val pts = frames * 1_000_000L / SAMPLE_RATE
        frames += length / (2 * CHANNELS)
        codec.queueInputBuffer(index, 0, length, pts, 0)
      }
    } catch (_: IllegalStateException) {
    }
  }

  private fun drainAudio(codec: MediaCodec) {
    val info = MediaCodec.BufferInfo()
    try {
      while (running && audioEncoder === codec) {
        val index = codec.dequeueOutputBuffer(info, 10_000)
        if (index < 0) continue
        val buffer = codec.getOutputBuffer(index)
        if (buffer != null && info.size > 0) {
          val data = ByteArray(info.size)
          buffer.position(info.offset)
          buffer.get(data)
          if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) {
            send(MirrorProtocol.AUDIO_CONFIG, 0, MirrorProtocol.audioConfig(SAMPLE_RATE, CHANNELS, data))
          } else {
            send(MirrorProtocol.AUDIO_FRAME, info.presentationTimeUs, data)
          }
        }
        codec.releaseOutputBuffer(index, false)
      }
    } catch (_: IllegalStateException) {
    } catch (_: IOException) {
      stopNow("lost")
    }
  }

  /* ------------------------------------------------------------------ the rest */

  private fun send(kind: Int, ptsUs: Long, data: ByteArray) {
    val stream = out ?: throw IOException("not connected")
    synchronized(sendLock) { MirrorProtocol.write(stream, kind, ptsUs, data) }
  }

  /** Ends the mirror from wherever it is: the page, the notification, the system, a dropped connection. */
  fun stopNow(reason: String) {
    val was = running || target != null
    running = false
    target = null
    consent = null
    runCatching { socket?.close() }
    socket = null
    out = null
    recorder?.let { runCatching { it.stop() }; runCatching { it.release() } }
    recorder = null
    audioEncoder?.let { runCatching { it.stop() }; runCatching { it.release() } }
    audioEncoder = null
    synchronized(videoLock) {
      encoder?.let { runCatching { it.stop() }; runCatching { it.release() } }
      encoder = null
    }
    main.post {
      runCatching {
        (activity.getSystemService(Context.DISPLAY_SERVICE) as DisplayManager).unregisterDisplayListener(rotation)
      }
      display?.release()
      display = null
      surfaceOf.values.forEach { runCatching { it.release() } }
      surfaceOf.clear()
      projection?.let { runCatching { it.stop() } }
      projection = null
      if (active === this) {
        active = null
        LanternService.mirroring(activity, false, "")
      }
    }
    if (was) emit("stopped", reason)
  }

  private fun emit(state: String, message: String) {
    val view = webView ?: return
    val event = JSONObject().put("type", "state").put("state", state).put("message", message)
    val script = "window.__mirrorEvent && window.__mirrorEvent($event)"
    main.post { view.evaluateJavascript(script, null) }
  }
}
