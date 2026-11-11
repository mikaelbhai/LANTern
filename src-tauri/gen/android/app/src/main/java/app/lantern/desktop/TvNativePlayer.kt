package app.lantern.desktop

import android.app.Activity
import android.graphics.drawable.Drawable
import android.os.Handler
import android.os.Looper
import android.view.SurfaceView
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.VideoSize
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.DefaultRenderersFactory
import androidx.media3.exoplayer.ExoPlayer
import org.json.JSONArray
import org.json.JSONObject

/**
 * The television's video player: the system's own decoder, not the WebView's.
 *
 * A 4K HEVC MKV played through the page's <video> arrived on a television with a
 * line through the picture and repeated frames - Chromium's media stack decoding
 * a stream its chip could not keep up with. Media3 hands the same bytes to the
 * platform's hardware decoder directly, which is what every TV app that plays
 * such a file does, and plays what the WebView will not (E-AC-3, for one)
 * without the host re-cutting the film first.
 *
 * It has no controls. The picture goes to a SurfaceView placed *behind* the
 * WebView, which is made see-through while a film plays, so the page's own
 * remote-driven controls and subtitles draw over it exactly as they did over
 * the <video>. The page drives it through the `LanternTv` interface below and
 * hears back through `window.__lantvEvent`.
 *
 * Only registered on a television (see MainActivity.onWebViewCreate); a phone or
 * a desktop never has the interface and keeps the web player.
 */
class TvNativePlayer(private val activity: Activity, private val webView: WebView) {
  private val main = Handler(Looper.getMainLooper())
  private var player: ExoPlayer? = null
  private var surface: SurfaceView? = null
  private var pageBackground: Drawable? = null
  private var firstFrame = false

  // A call into the page's interface arrives on a binder thread, and the player
  // may only be touched from the one it was built on.
  @JavascriptInterface
  fun open(url: String, startMs: Long, autoplay: Boolean) {
    main.post { start(url, startMs, autoplay) }
  }

  @JavascriptInterface
  fun play() {
    main.post { player?.playWhenReady = true }
  }

  @JavascriptInterface
  fun pause() {
    main.post { player?.playWhenReady = false }
  }

  @JavascriptInterface
  fun seek(ms: Long) {
    main.post { player?.seekTo(ms.coerceAtLeast(0)) }
  }

  /** The nth audio track of the file, counted in the order the file lists them; -1 for its own default. */
  @JavascriptInterface
  fun selectAudio(index: Int) {
    main.post {
      val p = player ?: return@post
      val params = p.trackSelectionParameters.buildUpon()
      val group = audioGroups(p.currentTracks).getOrNull(index)
      if (index < 0 || group == null) {
        params.clearOverridesOfType(C.TRACK_TYPE_AUDIO)
      } else {
        params.setOverrideForType(TrackSelectionOverride(group.mediaTrackGroup, 0))
      }
      p.trackSelectionParameters = params.build()
    }
  }

  @JavascriptInterface
  fun close() {
    main.post { release() }
  }

  /** The window left the foreground: a film must not play on behind another app. */
  fun hostPaused() {
    // The listener reports the change to the page.
    player?.playWhenReady = false
  }

  fun destroy() {
    release()
  }

  private fun start(url: String, startMs: Long, autoplay: Boolean) {
    release()
    val host = webView.parent as? ViewGroup ?: run {
      emit(JSONObject().put("type", "error").put("message", "no place for the picture").put("firstFrame", false))
      return
    }

    // Kept lit: the page's own <video> held the screen on by playing, and this
    // one is not the page's, so the set would otherwise dim to its screensaver
    // in the middle of a film.
    val view = SurfaceView(activity).apply {
      isFocusable = false
      keepScreenOn = true
    }
    // Index 0 is the bottom of the stack: behind the page.
    host.addView(view, 0, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
    surface = view
    pageBackground = webView.background
    webView.setBackgroundColor(0x00000000)

    // A 4K remux is tens of megabits a second over Wi-Fi: hold a long way ahead,
    // and by size as well as by seconds, so a dense film cannot starve the player
    // nor a light one fill the memory.
    val load = DefaultLoadControl.Builder()
      .setBufferDurationsMs(30_000, 120_000, 2_500, 5_000)
      .setTargetBufferBytes(96 * 1024 * 1024)
      .setPrioritizeTimeOverSizeThresholds(false)
      .build()
    // Software extension decoders are left off: this is about the hardware ones.
    // Falling back to the next decoder is on, so a stream the first one refuses
    // (a Dolby Vision profile it cannot do) plays from its base layer instead.
    val renderers = DefaultRenderersFactory(activity)
      .setEnableDecoderFallback(true)
      .setExtensionRendererMode(DefaultRenderersFactory.EXTENSION_RENDERER_MODE_OFF)

    firstFrame = false
    val exo = ExoPlayer.Builder(activity, renderers).setLoadControl(load).build()
    exo.setAudioAttributes(
      AudioAttributes.Builder()
        .setUsage(C.USAGE_MEDIA)
        .setContentType(C.AUDIO_CONTENT_TYPE_MOVIE)
        .build(),
      true,
    )
    exo.setVideoSurfaceView(view)
    exo.addListener(listener)
    exo.setMediaItem(MediaItem.fromUri(url), startMs.coerceAtLeast(0))
    exo.playWhenReady = autoplay
    exo.prepare()
    player = exo
    main.postDelayed(ticker, TICK_MS)
  }

  private fun release() {
    main.removeCallbacks(ticker)
    player?.let {
      it.removeListener(listener)
      it.release()
    }
    player = null
    surface?.let { (it.parent as? ViewGroup)?.removeView(it) }
    surface = null
    if (pageBackground != null) {
      webView.background = pageBackground
      pageBackground = null
    }
  }

  /** Position, a couple of times a second: the page draws its bar from this. */
  private val ticker = object : Runnable {
    override fun run() {
      val p = player ?: return
      emit(
        JSONObject()
          .put("type", "time")
          .put("positionMs", p.currentPosition)
          .put("bufferedMs", p.bufferedPosition)
          .put("durationMs", if (p.duration == C.TIME_UNSET) 0 else p.duration),
      )
      main.postDelayed(this, TICK_MS)
    }
  }

  private val listener = object : Player.Listener {
    override fun onPlaybackStateChanged(state: Int) {
      val p = player ?: return
      when (state) {
        Player.STATE_BUFFERING -> emit(JSONObject().put("type", "buffering").put("buffering", true))
        Player.STATE_READY -> {
          emit(
            JSONObject()
              .put("type", "ready")
              .put("durationMs", if (p.duration == C.TIME_UNSET) 0 else p.duration),
          )
          emit(JSONObject().put("type", "buffering").put("buffering", false))
        }
        Player.STATE_ENDED -> emit(JSONObject().put("type", "ended"))
        else -> {}
      }
    }

    // What the viewer (or the system, taking audio focus away) asked for, not
    // whether a frame is moving this instant. `isPlaying` goes false while the
    // film is merely buffering, and the page - which pauses the player whenever
    // it believes it is paused - turned every stall into a permanent pause.
    override fun onPlayWhenReadyChanged(playWhenReady: Boolean, reason: Int) {
      emit(JSONObject().put("type", "playing").put("playing", playWhenReady))
    }

    override fun onRenderedFirstFrame() {
      firstFrame = true
      emit(JSONObject().put("type", "firstFrame"))
    }

    override fun onVideoSizeChanged(size: VideoSize) {
      emit(JSONObject().put("type", "size").put("width", size.width).put("height", size.height))
    }

    override fun onTracksChanged(tracks: Tracks) {
      val list = JSONArray()
      audioGroups(tracks).forEachIndexed { i, group ->
        val f = group.getTrackFormat(0)
        list.put(
          JSONObject()
            .put("index", i)
            .put("lang", f.language ?: "")
            .put("label", f.label ?: "")
            .put("mime", f.sampleMimeType ?: "")
            .put("channels", f.channelCount)
            .put("supported", group.isSupported)
            .put("selected", group.isSelected),
        )
      }
      emit(JSONObject().put("type", "tracks").put("audio", list))
    }

    override fun onPlayerError(error: PlaybackException) {
      emit(
        JSONObject()
          .put("type", "error")
          .put("message", error.errorCodeName)
          .put("firstFrame", firstFrame),
      )
    }
  }

  private fun audioGroups(tracks: Tracks): List<Tracks.Group> =
    tracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }

  /** Tells the page. JSON is a valid JavaScript literal, so it goes in as one. */
  private fun emit(event: JSONObject) {
    val script = "window.__lantvEvent && window.__lantvEvent($event)"
    main.post { webView.evaluateJavascript(script, null) }
  }

  companion object {
    private const val TICK_MS = 500L
  }
}
