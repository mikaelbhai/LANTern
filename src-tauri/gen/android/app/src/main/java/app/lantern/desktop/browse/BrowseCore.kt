package app.lantern.desktop.browse

import java.io.StringReader
import java.net.URI
import javax.xml.parsers.DocumentBuilderFactory
import org.w3c.dom.Element
import org.w3c.dom.Node
import org.xml.sax.InputSource

/**
 * The parts of browsing that need no network and no Android: byte ranges,
 * subtitle conversion, what a media server says, addresses and file names.
 *
 * Kept apart so they can be checked on the JVM (BrowseCoreTest). The things that
 * touch a socket or a share are in the sources and the server, where a mistake
 * only shows up against a real device - so everything that can be settled here
 * is.
 */
object BrowseCore {
  private val VIDEO = setOf(
    "mkv", "mp4", "m4v", "mov", "avi", "webm", "ts", "m2ts", "mts", "wmv", "flv", "mpg", "mpeg", "3gp", "ogv",
  )
  private val SUBTITLE = setOf("srt", "vtt")

  fun extension(name: String): String = name.substringAfterLast('.', "").lowercase()
  fun isVideo(name: String): Boolean = extension(name) in VIDEO
  fun isSubtitle(name: String): Boolean = extension(name) in SUBTITLE

  /** The name without its extension, for matching "Film.mkv" with "Film.en.srt". */
  fun stem(name: String): String = name.substringBeforeLast('.', name)

  /* ------------------------------------------------------------------ ranges */

  sealed class Range {
    /** No (usable) Range header: the whole thing, status 200. */
    object Whole : Range()
    class Part(val start: Long, val end: Long) : Range() {
      val length: Long get() = end - start + 1
    }
    /** A range that starts past the end: status 416. */
    object Unsatisfiable : Range()
  }

  /**
   * Reads `Range: bytes=...` for a resource of `total` bytes.
   *
   * One range only - a player asks for one - and the three shapes players send:
   * `a-b`, `a-` and the suffix `-n`. Anything it cannot read is treated as no
   * header at all, which is what a server may do, rather than refused.
   */
  fun parseRange(header: String?, total: Long): Range {
    val value = header?.trim()?.removePrefix("bytes=") ?: return Range.Whole
    if (header.isBlank() || !header.trim().startsWith("bytes=") || total <= 0) return Range.Whole
    val first = value.split(',').first().trim()
    val dash = first.indexOf('-')
    if (dash < 0) return Range.Whole
    val from = first.substring(0, dash).trim()
    val to = first.substring(dash + 1).trim()
    return try {
      val start: Long
      val end: Long
      if (from.isEmpty()) {
        val n = to.toLong()
        if (n <= 0) return Range.Unsatisfiable
        start = maxOf(0L, total - n)
        end = total - 1
      } else {
        start = from.toLong()
        end = if (to.isEmpty()) total - 1 else minOf(to.toLong(), total - 1)
      }
      if (start < 0 || start >= total || end < start) Range.Unsatisfiable else Range.Part(start, end)
    } catch (_: NumberFormatException) {
      Range.Whole
    }
  }

  /* --------------------------------------------------------------- subtitles */

  /** SubRip to WebVTT: a header, and a dot where SubRip puts a comma in the times. */
  fun srtToVtt(srt: String): String {
    val text = srt.removePrefix("﻿").replace("\r\n", "\n").replace('\r', '\n')
    val out = StringBuilder("WEBVTT\n\n")
    for (line in text.split('\n')) {
      out.append(if (line.contains("-->")) line.replace(',', '.') else line).append('\n')
    }
    return out.toString()
  }

  /* ---------------------------------------------------------- addresses, urls */

  /**
   * The other addresses on the phone's own network, for the SMB sweep.
   *
   * Never wider than a /24 around the phone, whatever the mask says: a /16 is
   * sixty-five thousand connection attempts, and nobody's shared drive is
   * worth that. The phone itself, the network and the broadcast address are left out.
   */
  fun subnetHosts(ip: String, prefix: Int): List<String> {
    val parts = ip.split('.')
    if (parts.size != 4 || parts.any { it.toIntOrNull() !in 0..255 }) return emptyList()
    if (prefix < 8 || prefix > 30) return emptyList()
    val own = parts[3].toInt()
    val base = parts.take(3).joinToString(".")
    return (1..254).filter { it != own }.map { "$base.$it" }
  }

  private const val UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~"

  /** Percent-encodes one path segment, UTF-8, keeping only what a URL never needs escaped. */
  fun encodeSegment(segment: String): String {
    val out = StringBuilder()
    for (b in segment.toByteArray(Charsets.UTF_8)) {
      val c = (b.toInt() and 0xff).toChar()
      if (c in UNRESERVED) out.append(c) else out.append('%').append("%02X".format(b.toInt() and 0xff))
    }
    return out.toString()
  }

  /** `smb://host/share/a/b` for a host and the names down to somewhere inside it. */
  fun smbUrl(host: String, names: List<String>, directory: Boolean): String {
    val path = names.filter { it.isNotEmpty() }.joinToString("/") { encodeSegment(it) }
    val url = "smb://$host/" + path
    return if (directory && !url.endsWith("/")) "$url/" else url
  }

  /** "/Movies/Action" to ["Movies", "Action"]. */
  fun names(path: String): List<String> = path.split('/').filter { it.isNotEmpty() }

  /** Compares a path's token to the expected one without stopping at the first difference. */
  fun tokenMatches(expected: String, offered: String): Boolean {
    val a = expected.toByteArray(Charsets.UTF_8)
    val b = offered.toByteArray(Charsets.UTF_8)
    if (a.isEmpty() || a.size != b.size) return false
    var diff = 0
    for (i in a.indices) diff = diff or (a[i].toInt() xor b[i].toInt())
    return diff == 0
  }

  /** `/<token>/<id>/<name>` from the loopback server, or null when the token is not ours. */
  fun idFromPath(path: String, token: String): String? {
    val parts = path.removePrefix("/").split('/')
    if (parts.size < 2) return null
    return if (tokenMatches(token, parts[0])) parts[1] else null
  }

  /* ------------------------------------------------------------------- UPnP */

  class SsdpReply(val location: String, val usn: String)

  /** What a media server answers an `M-SEARCH` with: where its description is. */
  fun parseSsdp(reply: String): SsdpReply? {
    var location: String? = null
    var usn = ""
    for (line in reply.split("\r\n", "\n")) {
      val colon = line.indexOf(':')
      if (colon <= 0) continue
      when (line.substring(0, colon).trim().lowercase()) {
        "location" -> location = line.substring(colon + 1).trim()
        "usn" -> usn = line.substring(colon + 1).trim()
      }
    }
    return location?.takeIf { it.startsWith("http://") }?.let { SsdpReply(it, usn) }
  }

  class MediaServer(val name: String, val controlUrl: String)

  private fun parse(xml: String): org.w3c.dom.Document {
    val factory = DocumentBuilderFactory.newInstance()
    factory.isNamespaceAware = false
    // A media server is anybody on the network. No entity may be fetched or expanded
    // for it: where the parser lets the setting through it is refused outright.
    for ((feature, value) in listOf(
      "http://apache.org/xml/features/disallow-doctype-decl" to true,
      "http://xml.org/sax/features/external-general-entities" to false,
      "http://xml.org/sax/features/external-parameter-entities" to false,
    )) {
      try { factory.setFeature(feature, value) } catch (_: Exception) { /* this parser does not have it */ }
    }
    return factory.newDocumentBuilder().parse(InputSource(StringReader(xml)))
  }

  private fun Element.text(tag: String): String =
    getElementsByTagName(tag).item(0)?.textContent?.trim().orEmpty()

  /** A device description: its name and where its ContentDirectory takes requests. */
  fun parseDescription(xml: String, location: String): MediaServer? {
    val doc = parse(xml).documentElement
    val name = doc.text("friendlyName").ifEmpty { "Media server" }
    val services = doc.getElementsByTagName("service")
    for (i in 0 until services.length) {
      val service = services.item(i) as? Element ?: continue
      if (!service.text("serviceType").contains("ContentDirectory")) continue
      val control = service.text("controlURL")
      if (control.isEmpty()) continue
      val base = doc.text("URLBase").ifEmpty { location }
      return MediaServer(name, URI(base).resolve(control).toString())
    }
    return null
  }

  class Didl(
    val id: String,
    val title: String,
    val container: Boolean,
    val url: String?,
    val size: Long,
    val mime: String,
  )

  class Browsed(val entries: List<Didl>, val returned: Int, val total: Int)

  /** The body of a `BrowseResponse`: the DIDL-Lite inside it, and how many there are. */
  fun parseBrowse(soap: String): Browsed {
    val doc = parse(soap).documentElement
    val result = doc.text("Result")
    val entries = if (result.isEmpty()) emptyList() else parseDidl(result)
    return Browsed(entries, doc.text("NumberReturned").toIntOrNull() ?: entries.size, doc.text("TotalMatches").toIntOrNull() ?: entries.size)
  }

  fun parseDidl(xml: String): List<Didl> {
    val root = parse(xml).documentElement
    val out = ArrayList<Didl>()
    var node: Node? = root.firstChild
    while (node != null) {
      val element = node as? Element
      if (element != null && (element.tagName == "container" || element.tagName == "item")) {
        val isContainer = element.tagName == "container"
        var url: String? = null
        var size = 0L
        var mime = ""
        if (!isContainer) {
          val resources = element.getElementsByTagName("res")
          // The first resource that is video, else the first there is.
          var pick: Element? = null
          for (i in 0 until resources.length) {
            val res = resources.item(i) as? Element ?: continue
            if (pick == null || res.getAttribute("protocolInfo").contains("video/")) pick = res
            if (res.getAttribute("protocolInfo").contains("video/")) break
          }
          if (pick != null) {
            url = pick.textContent.trim().takeIf { it.startsWith("http") }
            size = pick.getAttribute("size").toLongOrNull() ?: 0L
            mime = pick.getAttribute("protocolInfo").split(':').getOrNull(2).orEmpty()
          }
        }
        out.add(Didl(element.getAttribute("id"), element.text("dc:title").ifEmpty { "Untitled" }, isContainer, url, size, mime))
      }
      node = node.nextSibling
    }
    return out
  }
}
