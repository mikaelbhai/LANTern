package app.lantern.desktop

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * The incoming-call notification's own Decline button.
 *
 * A private broadcast this app sends to itself — see the `exported="false"`
 * receiver declaration in the manifest — from a `PendingIntent` nothing
 * outside this app ever holds. Kept as its own tiny class rather than
 * folded into `MainActivity` because the two are declared separately in the
 * manifest for the same reason: a broadcast should not need an activity to
 * already exist to answer it, and Android will happily instantiate this on
 * its own to deliver one while nothing else in the app is running.
 */
class CallDeclineReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val from = intent.getStringExtra("from") ?: return
    val callId = intent.getStringExtra("callId") ?: return
    // Straight to the wire, natively — see incomingcall.rs. Declining does
    // not need the WebView's JS awake to say so, any more than the ring
    // that led here needed it to go off in the first place.
    runCatching { nativeDeclineCall(from, callId) }
    MainActivity.cancelIncomingCall(callId)
  }

  /** Implemented in incomingcall.rs. */
  private external fun nativeDeclineCall(from: String, callId: String)

  companion object {
    init {
      // The library is ordinarily already loaded by MainActivity's own
      // companion object by the time a call could arrive - repeating it
      // here costs nothing and covers the receiver being instantiated on
      // its own with no activity in the process at all.
      runCatching { System.loadLibrary("lantern_lib") }
    }
  }
}
