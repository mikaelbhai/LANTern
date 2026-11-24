package app.lantern.desktop.browse

import java.io.File
import java.io.IOException
import java.io.InputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.Properties
import jcifs.CIFSContext
import jcifs.config.PropertyConfiguration
import jcifs.context.BaseContext
import jcifs.smb.NtlmPasswordAuthenticator
import jcifs.smb.SmbAuthException
import jcifs.smb.SmbException
import jcifs.smb.SmbFile
import jcifs.smb.SmbRandomAccessFile

/** One thing in a folder. `url` is set when something can play it without us streaming it. */
class Entry(
  val name: String,
  val path: String,
  val dir: Boolean,
  val size: Long,
  val modified: Long,
  val url: String? = null,
)

/** Raised when a share wants a login that was not given or was wrong. */
class AuthRequired(message: String) : IOException(message)

/** A place with files in it: the phone, a computer's shared drive, a media server. */
interface Source {
  fun list(path: String): List<Entry>
}

/** A source whose files this app has to stream itself (the others play by address). */
interface Streamable : Source {
  fun size(path: String): Long
  fun open(path: String, offset: Long): InputStream
}

/* ------------------------------------------------------------------ the phone */

/**
 * The phone's own storage, by path.
 *
 * Needs Android's "All files access" for anything but the app's own folders (see
 * storage.rs): without it a listing is not refused but empty, which looks exactly
 * like an empty phone, so the page says so rather than showing nothing.
 *
 * Confined to /storage. A path with `..` in it, or a link out of it, must not reach
 * the app's private data or anything else on the device.
 */
class LocalSource : Streamable {
  private fun resolve(path: String): File {
    val file = File(path).canonicalFile
    val ok = file.path == "/storage" || file.path.startsWith("/storage/")
    if (!ok) throw IOException("not a place on this phone's storage")
    return file
  }

  override fun list(path: String): List<Entry> {
    val dir = resolve(path)
    val children = dir.listFiles() ?: throw IOException("cannot read this folder")
    return children
      .filter { !it.name.startsWith(".") }
      .map { Entry(it.name, it.path, it.isDirectory, if (it.isDirectory) 0 else it.length(), it.lastModified()) }
  }

  override fun size(path: String): Long = resolve(path).length()

  override fun open(path: String, offset: Long): InputStream {
    val input = java.io.FileInputStream(resolve(path))
    if (offset > 0) input.channel.position(offset)
    return input
  }
}

/* --------------------------------------------------------- shared drives (SMB) */

/**
 * A computer's shared drives, over SMB 2 and 3.
 *
 * SMB 1 is not offered: it is the old dialect Windows turned off for good reason,
 * and a phone that spoke it would be a way into anything that still does. A very old
 * NAS that only has it is the price.
 *
 * `path` is "" for the computer itself (which lists its shares), then
 * "/Share/folder/file". Login is guest unless the person gave one.
 */
class SmbSource(private val host: String, user: String?, password: String?) : Streamable {
  private val context: CIFSContext = run {
    val props = Properties().apply {
      setProperty("jcifs.smb.client.minVersion", "SMB202")
      setProperty("jcifs.smb.client.maxVersion", "SMB311")
      setProperty("jcifs.smb.client.connTimeout", "6000")
      setProperty("jcifs.smb.client.responseTimeout", "15000")
      setProperty("jcifs.smb.client.soTimeout", "20000")
      // Hosts are addressed by name or number we were given; broadcast name lookups
      // (NetBIOS) would be a request to everybody on the network for nothing.
      setProperty("jcifs.resolveOrder", "DNS")
    }
    val base: CIFSContext = BaseContext(PropertyConfiguration(props))
    if (user.isNullOrEmpty()) base.withGuestCrendentials()
    else {
      // "DOMAIN\name" or "name@domain" as Windows writes them.
      val (domain, name) = when {
        '\\' in user -> user.substringBefore('\\') to user.substringAfter('\\')
        '@' in user -> user.substringAfter('@') to user.substringBefore('@')
        else -> "" to user
      }
      base.withCredentials(NtlmPasswordAuthenticator(domain, name, password.orEmpty()))
    }
  }

  private fun file(path: String, directory: Boolean) =
    SmbFile(BrowseCore.smbUrl(host, BrowseCore.names(path), directory), context)

  private fun <T> guarded(block: () -> T): T = try {
    block()
  } catch (e: SmbAuthException) {
    throw AuthRequired(e.message ?: "login needed")
  } catch (e: SmbException) {
    // Windows answers a guest it will not talk to with access denied or a failed logon.
    if (e.ntStatus == SmbException.NT_STATUS_ACCESS_DENIED || e.ntStatus == SmbException.NT_STATUS_LOGON_FAILURE ||
      e.ntStatus == SmbException.NT_STATUS_NETWORK_ACCESS_DENIED
    ) throw AuthRequired(e.message ?: "login needed")
    throw IOException(e.message ?: "could not read this share", e)
  }

  override fun list(path: String): List<Entry> = guarded {
    val atHost = BrowseCore.names(path).isEmpty()
    val parent = path.trimEnd('/')
    file(path, true).listFiles().mapNotNull { child ->
      val name = child.name.trimEnd('/')
      // A host lists its shares; the administrative ones ($) and printers are not somewhere to browse.
      if (atHost && (name.endsWith("$") || child.type != SmbFile.TYPE_SHARE)) return@mapNotNull null
      if (name.startsWith(".")) return@mapNotNull null
      val dir = atHost || child.isDirectory
      Entry(name, "$parent/$name", dir, if (dir) 0 else child.length(), child.lastModified())
    }
  }

  override fun size(path: String): Long = guarded { file(path, false).length() }

  override fun open(path: String, offset: Long): InputStream = guarded {
    val raf = SmbRandomAccessFile(file(path, false), "r")
    raf.seek(offset)
    object : InputStream() {
      override fun read(): Int = raf.read()
      override fun read(b: ByteArray, off: Int, len: Int): Int = raf.read(b, off, len)
      override fun close() {
        runCatching { raf.close() }
      }
    }
  }
}

/* ------------------------------------------------------ media servers (UPnP) */

/**
 * A DLNA / UPnP media server: Plex, Jellyfin, a NAS, Windows Media sharing, a TV box.
 *
 * `path` is a container's id ("0" is the top). The files it lists carry their own
 * http address, which plays directly, so there is nothing to stream here.
 */
class UpnpSource(private val controlUrl: String) : Source {
  override fun list(path: String): List<Entry> {
    val container = path.ifEmpty { "0" }
    val out = ArrayList<Entry>()
    var start = 0
    while (true) {
      val page = browse(container, start)
      for (d in page.entries) {
        out.add(
          Entry(
            name = d.title,
            path = d.id,
            dir = d.container,
            size = d.size,
            modified = 0,
            url = d.url,
          ),
        )
      }
      start += page.returned
      // A server that says it returned nothing, or has returned everything, is done.
      if (page.returned == 0 || start >= page.total || start >= 5000) break
    }
    return out.filter { it.dir || it.url != null }
  }

  private fun browse(container: String, start: Int): BrowseCore.Browsed {
    val body = """<?xml version="1.0" encoding="utf-8"?>
      <s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
      <s:Body><u:Browse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
      <ObjectID>${escape(container)}</ObjectID><BrowseFlag>BrowseDirectChildren</BrowseFlag><Filter>*</Filter>
      <StartingIndex>$start</StartingIndex><RequestedCount>200</RequestedCount><SortCriteria></SortCriteria>
      </u:Browse></s:Body></s:Envelope>"""
    val connection = URL(controlUrl).openConnection() as HttpURLConnection
    try {
      connection.connectTimeout = 5000
      connection.readTimeout = 15000
      connection.requestMethod = "POST"
      connection.doOutput = true
      connection.setRequestProperty("Content-Type", "text/xml; charset=\"utf-8\"")
      connection.setRequestProperty("SOAPACTION", "\"urn:schemas-upnp-org:service:ContentDirectory:1#Browse\"")
      connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
      if (connection.responseCode !in 200..299) throw IOException("media server answered ${connection.responseCode}")
      return BrowseCore.parseBrowse(connection.inputStream.use { String(it.readBytes(), Charsets.UTF_8) })
    } finally {
      connection.disconnect()
    }
  }

  private fun escape(s: String) = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;").replace("\"", "&quot;")
}
