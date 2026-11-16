package app.lantern.desktop

import android.app.Activity
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.Surface
import android.webkit.JavascriptInterface
import android.webkit.WebView
import java.io.BufferedInputStream
import java.io.DataInputStream
import java.io.IOException
import java.net.ServerSocket
import java.net.Socket
import java.nio.ByteBuffer
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import org.json.JSONObject

/**
 * The television's end of screen mirroring: shows a phone's screen, with its sound.
 *
 * The page accepts an offer and calls `listen` with a one-time token; this opens a
 * port, hands it back for the page to send the phone, and waits for that phone to
 * connect and present the token (MirrorProtocol). From then on every H.264 packet
 * goes straight into the television's hardware decoder, drawn behind the
 * see-through page, and the AAC into an AudioTrack. Nothing is buffered beyond
 * what the decoders hold: a mirror is worth having only if it is close to live.
 *
 * Television only (registered in MainActivity.onWebViewCreate). Reports to the page
 * through `window.__mirrorEvent`.
 */
class MirrorReceiver(private val activity: Activity, private val webView: WebView) {
  private val main = Handler(Looper.getMainLooper())
  private val lock = Any()

  @Volatile private var running = false
  @Volatile private var server: ServerSocket? = null
  @Volatile private var client: Socket? = null
  private var page: BehindPage? = null
  @Volatile private var surface: Surface? = null

  @Volatile private var video: MediaCodec? = null
  @Volatile private var audio: MediaCodec? = null
  @Volatile private var track: AudioTrack? = null
  @Volatile private var shown = false

  /** Opens a port for one phone, which must present `token`. Returns the port, or -1. */
  @JavascriptInterface
  fun listen(token: String): Int {
    stopNow()
    return try {
      val socket = ServerSocket(0)
      // Long enough for somebody to answer Android's "start recording?" on the phone.
      socket.soTimeout = 90_000
      server = socket
      running = true
      Thread({ serve(socket, token) }, "mirror-receive").start()
      socket.localPort
    } catch (e: IOException) {
      emit("error", e.message ?: "could not listen")
      -1
    }
  }

  @JavascriptInterface
  fun stop() {
    Thread({ stopNow(); emit("stopped", "") }, "mirror-stop").start()
  }

  /** The window left the foreground: the picture has nowhere to go. */
  fun hostPaused() {
    if (running) stop()
  }

  private fun serve(socket: ServerSocket, token: String) {
    try {
      val phone = socket.accept()
      try { socket.close() } catch (_: IOException) {}
      client = phone
      phone.tcpNoDelay = true
      // A phone that stops sending for this long has gone, whatever the socket says.
      phone.soTimeout = 15_000
      val input = DataInputStream(BufferedInputStream(phone.getInputStream(), 1 shl 16))
      if (!MirrorProtocol.tokenMatches(token, MirrorProtocol.readHello(input))) {
        emit("error", "refused a connection that did not have the token")
        return
      }
      if (!openPicture()) {
        emit("error", "no place for the picture")
        return
      }
      emit("connected", "")
      while (running) {
        val packet = MirrorProtocol.read(input)
        when (packet.kind) {
          MirrorProtocol.VIDEO_CONFIG -> configureVideo(packet.payload)
          MirrorProtocol.VIDEO_FRAME -> feed(video, packet)
          MirrorProtocol.AUDIO_CONFIG -> configureAudio(packet.payload)
          MirrorProtocol.AUDIO_FRAME -> feed(audio, packet)
        }
      }
    } catch (e: IOException) {
      if (running) Log.i("MirrorReceiver", "phone went: ${e.message}")
    } catch (e: RuntimeException) {
      Log.w("MirrorReceiver", "mirror failed", e)
      if (running) emit("error", e.message ?: "mirror failed")
    } finally {
      val was = running
      stopNow()
      if (was) emit("stopped", "")
    }
  }

  /** Puts the surface up behind the page and waits for it to exist. */
  private fun openPicture(): Boolean {
    val ready = CountDownLatch(1)
    main.post {
      val behind = BehindPage(activity, webView)
      page = behind
      val opened = behind.open { s ->
        surface = s
        if (s != null) ready.countDown()
      }
      if (!opened) ready.countDown()
    }
    return ready.await(5, TimeUnit.SECONDS) && surface != null
  }

  private fun configureVideo(payload: ByteArray) {
    val (width, height, csd) = MirrorProtocol.parseVideoConfig(payload)
    val target = surface ?: return
    synchronized(lock) {
      // A new configuration is a new picture (the phone was turned): a new decoder.
      video?.let { releaseQuietly(it) }
      video = null
      main.post { page?.fit(width, height) }
      val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) format.setInteger(MediaFormat.KEY_LOW_LATENCY, 1)
      val codec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
      codec.configure(format, target, null, 0)
      codec.start()
      video = codec
      queue(codec, csd, 0, MediaCodec.BUFFER_FLAG_CODEC_CONFIG)
      Thread({ drainVideo(codec) }, "mirror-video").start()
    }
  }

  private fun drainVideo(codec: MediaCodec) {
    val info = MediaCodec.BufferInfo()
    try {
      while (running && video === codec) {
        val index = codec.dequeueOutputBuffer(info, 10_000)
        if (index >= 0) {
          // Drawn the moment it is decoded: no clock to wait for in a mirror.
          codec.releaseOutputBuffer(index, true)
          if (!shown) {
            shown = true
            emit("live", "")
          }
        }
      }
    } catch (_: IllegalStateException) {
      // Released under us by a reconfiguration or a stop.
    }
  }

  private fun configureAudio(payload: ByteArray) {
    val (sampleRate, channels, csd) = MirrorProtocol.parseAudioConfig(payload)
    synchronized(lock) {
      audio?.let { releaseQuietly(it) }
      track?.let { runCatching { it.release() } }
      val format = MediaFormat.createAudioFormat(MediaFormat.MIMETYPE_AUDIO_AAC, sampleRate, channels)
      format.setByteBuffer("csd-0", ByteBuffer.wrap(csd))
      val codec = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_AUDIO_AAC)
      codec.configure(format, null, null, 0)
      codec.start()
      val mask = if (channels == 1) AudioFormat.CHANNEL_OUT_MONO else AudioFormat.CHANNEL_OUT_STEREO
      val minimum = AudioTrack.getMinBufferSize(sampleRate, mask, AudioFormat.ENCODING_PCM_16BIT)
      val out = AudioTrack.Builder()
        .setAudioAttributes(
          AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_MOVIE)
            .build(),
        )
        .setAudioFormat(
          AudioFormat.Builder()
            .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
            .setSampleRate(sampleRate)
            .setChannelMask(mask)
            .build(),
        )
        .setBufferSizeInBytes(maxOf(minimum, 1) * 2)
        .setTransferMode(AudioTrack.MODE_STREAM)
        .build()
      out.play()
      audio = codec
      track = out
      Thread({ drainAudio(codec, out) }, "mirror-audio").start()
    }
  }

  private fun drainAudio(codec: MediaCodec, out: AudioTrack) {
    val info = MediaCodec.BufferInfo()
    try {
      while (running && audio === codec) {
        val index = codec.dequeueOutputBuffer(info, 10_000)
        if (index >= 0) {
          val buffer = codec.getOutputBuffer(index)
          if (buffer != null && info.size > 0) {
            val pcm = ByteArray(info.size)
            buffer.position(info.offset)
            buffer.get(pcm)
            out.write(pcm, 0, pcm.size)
          }
          codec.releaseOutputBuffer(index, false)
        }
      }
    } catch (_: IllegalStateException) {
    }
  }

  private fun feed(codec: MediaCodec?, packet: MirrorProtocol.Packet) {
    codec ?: return
    queue(codec, packet.payload, packet.ptsUs, 0)
  }

  private fun queue(codec: MediaCodec, bytes: ByteArray, ptsUs: Long, flags: Int) {
    try {
      var index = -1
      while (running && index < 0) {
        index = codec.dequeueInputBuffer(10_000)
      }
      if (index < 0) return
      val buffer = codec.getInputBuffer(index) ?: return
      buffer.clear()
      if (bytes.size > buffer.capacity()) {
        // Larger than the decoder will take: dropped, and the next keyframe recovers.
        codec.queueInputBuffer(index, 0, 0, ptsUs, 0)
        return
      }
      buffer.put(bytes)
      codec.queueInputBuffer(index, 0, bytes.size, ptsUs, flags)
    } catch (_: IllegalStateException) {
      // The decoder was replaced or stopped while this waited for a buffer.
    }
  }

  private fun stopNow() {
    running = false
    shown = false
    runCatching { server?.close() }
    runCatching { client?.close() }
    server = null
    client = null
    synchronized(lock) {
      video?.let { releaseQuietly(it) }
      audio?.let { releaseQuietly(it) }
      track?.let { runCatching { it.stop(); it.release() } }
      video = null
      audio = null
      track = null
    }
    surface = null
    main.post {
      page?.close()
      page = null
    }
  }

  private fun releaseQuietly(codec: MediaCodec) {
    runCatching { codec.stop() }
    runCatching { codec.release() }
  }

  private fun emit(state: String, message: String) {
    val event = JSONObject().put("type", "state").put("state", state).put("message", message)
    val script = "window.__mirrorEvent && window.__mirrorEvent($event)"
    main.post { webView.evaluateJavascript(script, null) }
  }
}
