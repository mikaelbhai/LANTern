package app.lantern.desktop

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder

/**
 * Keeps LANTern reachable while it is not on screen.
 *
 * Android stops a backgrounded process from holding sockets, and will kill it
 * outright under memory pressure. For most apps that is correct. For this one
 * it means the device silently drops off the network the moment you switch
 * away — peers see it leave, calls cannot reach it, and transfers stop
 * mid-file. A foreground service is the only supported way to say "this
 * process is doing something the user asked for, leave it running".
 *
 * The price is a permanent notification, which Android requires and does not
 * let an app hide. That is a fair trade: the notification is also the honest
 * signal that the app is still listening, and tapping it comes back.
 */
class LanternService : Service() {
  companion object {
    private const val CHANNEL_ID = "lantern-running"
    private const val NOTIFICATION_ID = 1
    const val ACTION_STOP = "app.lantern.desktop.STOP"

    fun start(context: Context) {
      val intent = Intent(context, LanternService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    // The notification's Stop action routes back here rather than to the
    // activity, so quitting works without bringing the window up first.
    if (intent?.action == ACTION_STOP) {
      stopForeground(STOP_FOREGROUND_REMOVE)
      stopSelf()
      return START_NOT_STICKY
    }

    createChannel()
    startForeground(NOTIFICATION_ID, buildNotification())

    // Restart if the system reclaims us: being reachable is the whole point,
    // and a device that quietly stopped answering is worse than one that
    // never started.
    return START_STICKY
  }

  private fun createChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    if (manager.getNotificationChannel(CHANNEL_ID) != null) return

    val channel = NotificationChannel(
      CHANNEL_ID,
      "Running in the background",
      // Low: this is a status, not an event. It should sit quietly in the
      // shade without making a sound every time the app starts.
      NotificationManager.IMPORTANCE_LOW,
    ).apply {
      description = "Shown while LANTern stays reachable to devices on your network."
      setShowBadge(false)
    }
    manager.createNotificationChannel(channel)
  }

  private fun buildNotification(): Notification {
    val open = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).apply {
        flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
      },
      PendingIntent.FLAG_IMMUTABLE,
    )

    val stop = PendingIntent.getService(
      this,
      1,
      Intent(this, LanternService::class.java).setAction(ACTION_STOP),
      PendingIntent.FLAG_IMMUTABLE,
    )

    val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      Notification.Builder(this, CHANNEL_ID)
    } else {
      @Suppress("DEPRECATION")
      Notification.Builder(this)
    }

    return builder
      .setContentTitle("LANTern is reachable")
      .setContentText("Peers on your network can call and send files.")
      .setSmallIcon(android.R.drawable.stat_sys_download_done)
      .setContentIntent(open)
      .setOngoing(true)
      .addAction(
        Notification.Action.Builder(null, "Stop", stop).build(),
      )
      .build()
  }
}
