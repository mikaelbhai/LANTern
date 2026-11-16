package app.lantern.desktop

import android.app.Activity
import android.graphics.Color
import android.graphics.drawable.Drawable
import android.view.Gravity
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import android.widget.FrameLayout

/**
 * A picture drawn behind the page, with the page made see-through over it.
 *
 * The page keeps every control and every key press; the picture is a native
 * SurfaceView under it, which is the only way to show what a hardware decoder
 * produces. A black backdrop sits under the picture, so a picture that is not
 * the screen's shape (a phone held upright, shown on a television) is
 * letterboxed in black rather than in whatever the window happens to paint.
 *
 * Main thread only.
 */
class BehindPage(private val activity: Activity, private val webView: WebView) {
  private var backdrop: View? = null
  private var view: SurfaceView? = null
  private var pageBackground: Drawable? = null
  private var restore = false

  /** Puts the surface up; `ready` hears it once there is something to draw on. */
  fun open(ready: (android.view.Surface?) -> Unit): Boolean {
    close()
    val host = webView.parent as? ViewGroup ?: return false

    val black = View(activity).apply { setBackgroundColor(Color.BLACK) }
    val surface = SurfaceView(activity).apply {
      isFocusable = false
      // The screen must not dim to a screensaver while somebody is watching.
      keepScreenOn = true
    }
    surface.holder.addCallback(object : SurfaceHolder.Callback {
      override fun surfaceCreated(holder: SurfaceHolder) = ready(holder.surface)
      override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {}
      override fun surfaceDestroyed(holder: SurfaceHolder) = ready(null)
    })
    // Index 0 is the bottom of the stack: the backdrop, then the picture, then the page.
    host.addView(black, 0, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT))
    host.addView(surface, 1, FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT, Gravity.CENTER))
    backdrop = black
    view = surface
    pageBackground = webView.background
    restore = true
    webView.setBackgroundColor(Color.TRANSPARENT)
    return true
  }

  /** Sizes the picture to its own shape, as large as fits, centred. */
  fun fit(width: Int, height: Int) {
    val surface = view ?: return
    val host = surface.parent as? ViewGroup ?: return
    val hostW = host.width
    val hostH = host.height
    if (width <= 0 || height <= 0 || hostW <= 0 || hostH <= 0) return
    val scale = minOf(hostW.toDouble() / width, hostH.toDouble() / height)
    surface.layoutParams = FrameLayout.LayoutParams((width * scale).toInt(), (height * scale).toInt(), Gravity.CENTER)
  }

  fun close() {
    view?.let { (it.parent as? ViewGroup)?.removeView(it) }
    backdrop?.let { (it.parent as? ViewGroup)?.removeView(it) }
    view = null
    backdrop = null
    if (restore) {
      webView.background = pageBackground
      pageBackground = null
      restore = false
    }
  }
}
