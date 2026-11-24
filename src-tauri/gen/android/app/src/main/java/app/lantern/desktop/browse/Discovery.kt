package app.lantern.desktop.browse

import android.content.Context
import android.os.Environment
import android.os.storage.StorageManager
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.net.Socket
import java.net.SocketTimeoutException
import java.net.URL
import java.util.concurrent.Callable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** Something found on the network that can be browsed. */
class Found(val id: String, val kind: String, val name: String, val host: String = "", val controlUrl: String = "")

/**
 * Looking for shared drives and media servers.
 *
 * Only ever run because somebody opened the screen or pressed refresh - never in
 * the background, and never beyond this phone's own network. Windows computers do
 * not announce their shares, so they are found the way VLC finds them: by asking
 * every address nearby whether it answers on the SMB port.
 */
object Discovery {
  private const val SMB_PORT = 445
  private const val SSDP_ADDRESS = "239.255.255.250"
  private const val SSDP_PORT = 1900

  /** The storage the phone itself has: internal storage, SD cards and USB drives. */
  fun phoneVolumes(context: Context): List<Pair<String, String>> {
    val out = LinkedHashMap<String, String>()
    val primary = Environment.getExternalStorageDirectory().path
    out[primary] = "Internal storage"
    val manager = context.getSystemService(Context.STORAGE_SERVICE) as? StorageManager
    // An app's own folder on each volume is /<volume>/Android/data/<package>; the
    // volume is everything before it. The only way to learn them before Android 11.
    for (dir in context.getExternalFilesDirs(null).filterNotNull()) {
      val root = dir.path.substringBefore("/Android/data")
      if (root == dir.path || root in out) continue
      val label = runCatching { manager?.getStorageVolume(dir)?.getDescription(context) }.getOrNull()
      out[root] = label?.takeIf { it.isNotBlank() } ?: "SD card"
    }
    return out.map { it.key to it.value }
  }

  /** This phone's address and how wide its network is, from its Wi-Fi (or wired) interface. */
  private fun own(): Pair<String, Int>? {
    for (iface in NetworkInterface.getNetworkInterfaces()?.toList().orEmpty()) {
      if (!iface.isUp || iface.isLoopback || iface.isVirtual) continue
      for (address in iface.interfaceAddresses) {
        val ip = address.address as? Inet4Address ?: continue
        if (ip.isLoopbackAddress || ip.isLinkLocalAddress) continue
        if (ip.isSiteLocalAddress) return ip.hostAddress!! to address.networkPrefixLength.toInt()
      }
    }
    return null
  }

  /** Computers on this network that answer on the SMB port. */
  fun sharedDrives(): List<Found> {
    val (ip, prefix) = own() ?: return emptyList()
    val hosts = BrowseCore.subnetHosts(ip, prefix)
    val pool = Executors.newFixedThreadPool(48)
    try {
      val open = hosts.map { host ->
        pool.submit(Callable {
          try {
            Socket().use { it.connect(InetSocketAddress(host, SMB_PORT), 700) }
            host
          } catch (_: Exception) {
            null
          }
        })
      }.mapNotNull { runCatching { it.get(8, TimeUnit.SECONDS) }.getOrNull() }

      // Names after, and only for the ones that answered: a reverse lookup against
      // a router can take seconds, and most of the sweep is addresses nobody holds.
      val names = open.map { host ->
        host to pool.submit(Callable { InetAddress.getByName(host).canonicalHostName })
      }.map { (host, future) ->
        val name = runCatching { future.get(2500, TimeUnit.MILLISECONDS) }.getOrNull()
        host to nameFor(host, name)
      }
      return names.map { (host, name) -> Found("smb:$host", "smb", name, host = host) }
    } finally {
      pool.shutdownNow()
    }
  }

  /** "mikael-pc.lan" is a name; "192.168.100.67" is just the lookup giving up. */
  private fun nameFor(host: String, looked: String?): String {
    if (looked.isNullOrBlank() || looked == host) return host
    return looked.substringBefore('.').uppercase()
  }

  /** DLNA / UPnP media servers, by asking the network who is one. */
  fun mediaServers(): List<Found> {
    val seen = ConcurrentHashMap<String, BrowseCore.SsdpReply>()
    try {
      DatagramSocket(null).use { socket ->
        socket.reuseAddress = true
        socket.bind(InetSocketAddress(0))
        socket.soTimeout = 700
        val search = "M-SEARCH * HTTP/1.1\r\nHOST: $SSDP_ADDRESS:$SSDP_PORT\r\nMAN: \"ssdp:discover\"\r\nMX: 2\r\n" +
          "ST: urn:schemas-upnp-org:device:MediaServer:1\r\n\r\n"
        val bytes = search.toByteArray(Charsets.US_ASCII)
        val target = InetAddress.getByName(SSDP_ADDRESS)
        // Sent twice: a single datagram on Wi-Fi is easily lost.
        repeat(2) { socket.send(DatagramPacket(bytes, bytes.size, target, SSDP_PORT)) }
        val deadline = System.currentTimeMillis() + 3200
        val buffer = ByteArray(2048)
        while (System.currentTimeMillis() < deadline) {
          try {
            val packet = DatagramPacket(buffer, buffer.size)
            socket.receive(packet)
            BrowseCore.parseSsdp(String(packet.data, 0, packet.length, Charsets.US_ASCII))?.let { seen.putIfAbsent(it.location, it) }
          } catch (_: SocketTimeoutException) {
            // Quiet for a moment: keep listening until the deadline.
          }
        }
      }
    } catch (_: Exception) {
      return emptyList()
    }

    return seen.values.mapNotNull { reply ->
      try {
        val connection = URL(reply.location).openConnection() as HttpURLConnection
        connection.connectTimeout = 2000
        connection.readTimeout = 3000
        val xml = try {
          connection.inputStream.use { String(it.readBytes(), Charsets.UTF_8) }
        } finally {
          connection.disconnect()
        }
        BrowseCore.parseDescription(xml, reply.location)?.let { server ->
          Found("upnp:" + Integer.toHexString(server.controlUrl.hashCode()), "upnp", server.name, controlUrl = server.controlUrl)
        }
      } catch (_: Exception) {
        null
      }
    }
  }
}
