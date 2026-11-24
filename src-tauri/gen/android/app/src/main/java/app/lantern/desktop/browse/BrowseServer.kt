package app.lantern.desktop.browse

import java.io.BufferedInputStream
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors

/**
 * Plays a file the WebView cannot open by itself.
 *
 * A <video> cannot read `smb://`, or a path on the phone's storage. So the file is
 * offered on this phone's loopback address, with Range support (a player seeks by
 * asking for bytes), which is the same job readahead.rs does for another device's
 * films. Subtitles are served as WebVTT, which is all a <track> reads.
 *
 * Only reachable from this phone, and only with the random token in the path:
 * another app on the phone can open sockets to 127.0.0.1 too, and must not be able to
 * read the person's files - or a share they are signed in to - through this one.
 */
class BrowseServer {
  private class Entry(val source: Streamable, val path: String, val name: String, val vtt: Boolean)

  private val token: String = ByteArray(24).also { SecureRandom().nextBytes(it) }
    .joinToString("") { "%02x".format(it.toInt() and 0xff) }
  private val entries = ConcurrentHashMap<String, Entry>()
  private val pool = Executors.newCachedThreadPool()
  private var server: ServerSocket? = null
  private var counter = 0L

  @Synchronized
  private fun ensureStarted(): ServerSocket {
    server?.let { if (!it.isClosed) return it }
    val socket = ServerSocket(0, 16, InetAddress.getByName("127.0.0.1"))
    server = socket
    Thread({
      while (!socket.isClosed) {
        val client = try { socket.accept() } catch (_: IOException) { break }
        pool.execute { serve(client) }
      }
    }, "browse-server").start()
    return socket
  }

  /** The address to hand the player for a file. */
  @Synchronized
  fun urlFor(source: Streamable, path: String, name: String, vtt: Boolean): String {
    val port = ensureStarted().localPort
    val id = java.lang.Long.toHexString(++counter)
    // Bounded: a long evening of browsing must not grow this for ever.
    if (entries.size > 512) entries.keys.take(256).forEach { entries.remove(it) }
    entries[id] = Entry(source, path, name, vtt)
    return "http://127.0.0.1:$port/$token/$id/${BrowseCore.encodeSegment(name)}"
  }

  fun stop() {
    runCatching { server?.close() }
    server = null
    entries.clear()
  }

  private fun serve(client: Socket) {
    client.use { socket ->
      try {
        socket.soTimeout = 30_000
        val input = BufferedInputStream(socket.getInputStream())
        val out = socket.getOutputStream()
        val request = readHead(input) ?: return
        val lines = request.split("\r\n")
        val parts = lines[0].split(' ')
        if (parts.size < 2) return respond(out, 400, "Bad request")
        val method = parts[0]
        // A <video> with crossOrigin (the player's volume boost needs it) and a fetch with a
        // suffix range are cross-origin requests that ask permission first.
        if (method == "OPTIONS") return preflight(out)
        if (method != "GET" && method != "HEAD") return respond(out, 405, "Method not allowed")
        val path = parts[1].substringBefore('?')
        val id = BrowseCore.idFromPath(path, token) ?: return respond(out, 404, "Not found")
        val entry = entries[id] ?: return respond(out, 404, "Not found")
        val range = lines.drop(1).firstOrNull { it.startsWith("Range:", ignoreCase = true) }?.substringAfter(':')

        if (entry.vtt) return sendSubtitle(out, entry, method == "HEAD")

        val total = entry.source.size(entry.path)
        when (val r = BrowseCore.parseRange(range, total)) {
          is BrowseCore.Range.Unsatisfiable -> respond(out, 416, "Range not satisfiable", "Content-Range: bytes */$total")
          is BrowseCore.Range.Whole -> stream(out, entry, 200, 0, total - 1, total, method == "HEAD")
          is BrowseCore.Range.Part -> stream(out, entry, 206, r.start, r.end, total, method == "HEAD")
        }
      } catch (_: IOException) {
        // The player went away, which it does whenever it seeks.
      } catch (e: Exception) {
        runCatching { respond(socket.getOutputStream(), 500, "Could not read this file") }
      }
    }
  }

  private fun stream(out: OutputStream, entry: Entry, status: Int, start: Long, end: Long, total: Long, headOnly: Boolean) {
    val length = end - start + 1
    val head = StringBuilder()
      .append(if (status == 206) "HTTP/1.1 206 Partial Content\r\n" else "HTTP/1.1 200 OK\r\n")
      .append("Content-Type: ${mime(entry.name)}\r\n")
      .append("Content-Length: $length\r\n")
      .append("Accept-Ranges: bytes\r\n")
      .append("Access-Control-Allow-Origin: *\r\n")
      // Content-Range is not readable across origins unless it is exposed.
      .append("Access-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n")
      .append("Cache-Control: no-store\r\n")
    if (status == 206) head.append("Content-Range: bytes $start-$end/$total\r\n")
    head.append("Connection: close\r\n\r\n")
    out.write(head.toString().toByteArray(Charsets.US_ASCII))
    if (headOnly || length <= 0) return out.flush()

    entry.source.open(entry.path, start).use { input ->
      val buffer = ByteArray(256 * 1024)
      var left = length
      while (left > 0) {
        val read = input.read(buffer, 0, minOf(buffer.size.toLong(), left).toInt())
        if (read < 0) break
        out.write(buffer, 0, read)
        left -= read
      }
    }
    out.flush()
  }

  private fun sendSubtitle(out: OutputStream, entry: Entry, headOnly: Boolean) {
    // A subtitle file is small. Read whole, with a ceiling so a mislabelled file cannot fill memory.
    val bytes = entry.source.open(entry.path, 0).use { readLimited(it, 2 * 1024 * 1024) }
    val text = String(bytes, Charsets.UTF_8)
    val vtt = if (BrowseCore.extension(entry.name) == "vtt") text else BrowseCore.srtToVtt(text)
    val body = vtt.toByteArray(Charsets.UTF_8)
    out.write(
      ("HTTP/1.1 200 OK\r\nContent-Type: text/vtt; charset=utf-8\r\nContent-Length: ${body.size}\r\n" +
        "Access-Control-Allow-Origin: *\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n").toByteArray(Charsets.US_ASCII),
    )
    if (!headOnly) out.write(body)
    out.flush()
  }

  private fun readLimited(input: InputStream, limit: Int): ByteArray {
    val out = java.io.ByteArrayOutputStream()
    val buffer = ByteArray(16 * 1024)
    while (out.size() < limit) {
      val read = input.read(buffer)
      if (read < 0) break
      out.write(buffer, 0, read)
    }
    return out.toByteArray()
  }

  private fun readHead(input: InputStream): String? {
    val sb = StringBuilder()
    while (sb.length < 16 * 1024) {
      val c = input.read()
      if (c < 0) return null
      sb.append(c.toChar())
      if (sb.endsWith("\r\n\r\n")) return sb.toString()
    }
    return null
  }

  private fun preflight(out: OutputStream) {
    out.write(
      ("HTTP/1.1 204 No Content\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Methods: GET, HEAD, OPTIONS\r\n" +
        "Access-Control-Allow-Headers: Range\r\nAccess-Control-Max-Age: 600\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
        .toByteArray(Charsets.US_ASCII),
    )
    out.flush()
  }

  private fun respond(out: OutputStream, status: Int, message: String, extra: String = "") {
    val body = message.toByteArray(Charsets.UTF_8)
    out.write(
      ("HTTP/1.1 $status $message\r\nContent-Type: text/plain\r\nContent-Length: ${body.size}\r\n" +
        // Without these a page cannot read an error either, and reports it as a network failure.
        "Access-Control-Allow-Origin: *\r\nAccess-Control-Expose-Headers: Content-Range, Content-Length, Accept-Ranges\r\n" +
        (if (extra.isEmpty()) "" else "$extra\r\n") + "Connection: close\r\n\r\n").toByteArray(Charsets.US_ASCII),
    )
    out.write(body)
    out.flush()
  }

  private fun mime(name: String): String = when (BrowseCore.extension(name)) {
    "mp4", "m4v" -> "video/mp4"
    "mkv" -> "video/x-matroska"
    "webm" -> "video/webm"
    "mov" -> "video/quicktime"
    "avi" -> "video/x-msvideo"
    "ts", "m2ts", "mts" -> "video/mp2t"
    "mpg", "mpeg" -> "video/mpeg"
    "3gp" -> "video/3gpp"
    else -> "application/octet-stream"
  }
}
