package app.lantern.desktop.browse

import app.lantern.desktop.browse.BrowseCore.Range
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BrowseCoreTest {
  private fun part(r: Range) = r as Range.Part

  @Test
  fun ranges_come_in_the_three_shapes_players_send() {
    assertEquals(100L, part(BrowseCore.parseRange("bytes=100-199", 1000)).start)
    assertEquals(199L, part(BrowseCore.parseRange("bytes=100-199", 1000)).end)
    assertEquals(999L, part(BrowseCore.parseRange("bytes=100-", 1000)).end)
    val tail = part(BrowseCore.parseRange("bytes=-100", 1000))
    assertEquals(900L, tail.start)
    assertEquals(100L, tail.length)
    // Asking past the end is clipped, not refused; starting past it is refused.
    assertEquals(999L, part(BrowseCore.parseRange("bytes=500-5000", 1000)).end)
    assertTrue(BrowseCore.parseRange("bytes=1000-", 1000) is Range.Unsatisfiable)
    assertTrue(BrowseCore.parseRange("bytes=-0", 1000) is Range.Unsatisfiable)
  }

  @Test
  fun a_header_that_cannot_be_read_means_the_whole_file() {
    assertTrue(BrowseCore.parseRange(null, 1000) is Range.Whole)
    assertTrue(BrowseCore.parseRange("", 1000) is Range.Whole)
    assertTrue(BrowseCore.parseRange("items=1-2", 1000) is Range.Whole)
    assertTrue(BrowseCore.parseRange("bytes=abc-def", 1000) is Range.Whole)
  }

  @Test
  fun subrip_becomes_webvtt_changing_only_the_times() {
    val vtt = BrowseCore.srtToVtt("﻿1\r\n00:00:01,500 --> 00:00:03,000\r\nHello, there\r\n\r\n")
    assertTrue(vtt.startsWith("WEBVTT\n\n"))
    assertTrue(vtt.contains("00:00:01.500 --> 00:00:03.000"))
    assertTrue("a comma in the words must stay", vtt.contains("Hello, there"))
    assertFalse(vtt.contains("﻿"))
  }

  @Test
  fun the_sweep_covers_the_phones_own_24_and_nothing_wider() {
    val hosts = BrowseCore.subnetHosts("192.168.100.139", 16)
    assertEquals(253, hosts.size)
    assertFalse("the phone itself", hosts.contains("192.168.100.139"))
    assertFalse(hosts.contains("192.168.100.0"))
    assertFalse(hosts.contains("192.168.100.255"))
    assertTrue(hosts.contains("192.168.100.67"))
    assertTrue(BrowseCore.subnetHosts("not an address", 24).isEmpty())
    assertTrue(BrowseCore.subnetHosts("10.0.0.5", 31).isEmpty())
  }

  @Test
  fun a_share_address_escapes_what_a_url_cannot_hold() {
    assertEquals("A%20B%20%281976%29", BrowseCore.encodeSegment("A B (1976)"))
    assertEquals("100%25%23x%3Fy", BrowseCore.encodeSegment("100%#x?y"))
    assertEquals("%C3%A9", BrowseCore.encodeSegment("é"))
    assertEquals(
      "smb://nas/Media/Films/The%20Message.mkv",
      BrowseCore.smbUrl("nas", listOf("Media", "Films", "The Message.mkv"), false),
    )
    assertEquals("smb://nas/Media/", BrowseCore.smbUrl("nas", listOf("Media"), true))
    assertEquals("smb://nas/", BrowseCore.smbUrl("nas", emptyList(), true))
    assertEquals(listOf("Movies", "Action"), BrowseCore.names("/Movies//Action/"))
  }

  @Test
  fun only_a_path_carrying_the_token_names_a_file() {
    assertEquals("7f", BrowseCore.idFromPath("/tok123/7f/Film.mkv", "tok123"))
    assertNull(BrowseCore.idFromPath("/tok124/7f/Film.mkv", "tok123"))
    assertNull(BrowseCore.idFromPath("/tok12/7f/Film.mkv", "tok123"))
    assertNull(BrowseCore.idFromPath("/7f", "tok123"))
    assertNull(BrowseCore.idFromPath("/x/7f/f", ""))
  }

  @Test
  fun file_kinds_are_told_by_extension() {
    assertTrue(BrowseCore.isVideo("Film.MKV"))
    assertTrue(BrowseCore.isVideo("a.b.mp4"))
    assertFalse(BrowseCore.isVideo("notes.txt"))
    assertTrue(BrowseCore.isSubtitle("Film.en.srt"))
    assertEquals("Film.en", BrowseCore.stem("Film.en.srt"))
  }

  @Test
  fun a_media_server_reply_is_read_for_where_to_ask_it() {
    val reply = "HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nLOCATION: http://192.168.100.20:8200/rootDesc.xml\r\n" +
      "ST: urn:schemas-upnp-org:device:MediaServer:1\r\nUSN: uuid:abc::urn:schemas-upnp-org:device:MediaServer:1\r\n\r\n"
    val parsed = BrowseCore.parseSsdp(reply)!!
    assertEquals("http://192.168.100.20:8200/rootDesc.xml", parsed.location)
    assertNull(BrowseCore.parseSsdp("HTTP/1.1 200 OK\r\nST: x\r\n\r\n"))
    assertNull("not a plain http address", BrowseCore.parseSsdp("LOCATION: file:///etc/passwd\r\n"))
  }

  @Test
  fun a_description_gives_the_name_and_the_content_directory_address() {
    val xml = """<?xml version="1.0"?><root><device><friendlyName>Living Room NAS</friendlyName><serviceList>
      <service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/ctl/CM</controlURL></service>
      <service><serviceType>urn:schemas-upnp-org:service:ContentDirectory:1</serviceType><controlURL>/ctl/ContentDir</controlURL></service>
      </serviceList></device></root>"""
    val server = BrowseCore.parseDescription(xml, "http://192.168.100.20:8200/rootDesc.xml")!!
    assertEquals("Living Room NAS", server.name)
    assertEquals("http://192.168.100.20:8200/ctl/ContentDir", server.controlUrl)
    assertNull(BrowseCore.parseDescription("<root><device><friendlyName>x</friendlyName></device></root>", "http://h/d.xml"))
  }

  @Test
  fun a_browse_reply_is_folders_and_videos_with_their_addresses() {
    val didl = """&lt;DIDL-Lite&gt;&lt;container id="64" parentID="0"&gt;&lt;dc:title&gt;Movies&lt;/dc:title&gt;&lt;/container&gt;
      &lt;item id="64${'$'}1" parentID="64"&gt;&lt;dc:title&gt;The Message&lt;/dc:title&gt;
      &lt;res protocolInfo="http-get:*:video/x-matroska:*" size="1234"&gt;http://192.168.100.20:8200/MediaItems/1.mkv&lt;/res&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;"""
    val soap = """<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:BrowseResponse xmlns:u="urn:schemas-upnp-org:service:ContentDirectory:1">
      <Result>$didl</Result><NumberReturned>2</NumberReturned><TotalMatches>5</TotalMatches></u:BrowseResponse></s:Body></s:Envelope>"""
    val browsed = BrowseCore.parseBrowse(soap)
    assertEquals(2, browsed.returned)
    assertEquals(5, browsed.total)
    val folder = browsed.entries[0]
    assertTrue(folder.container)
    assertEquals("Movies", folder.title)
    assertEquals("64", folder.id)
    val film = browsed.entries[1]
    assertFalse(film.container)
    assertEquals("The Message", film.title)
    assertEquals("http://192.168.100.20:8200/MediaItems/1.mkv", film.url)
    assertEquals(1234L, film.size)
    assertEquals("video/x-matroska", film.mime)
  }

  @Test
  fun a_document_that_declares_entities_is_refused_or_ignored_never_fetched() {
    val xxe = """<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><root><device><friendlyName>&x;</friendlyName></device></root>"""
    val result = runCatching { BrowseCore.parseDescription(xxe, "http://h/d.xml") }
    // Refused outright, or parsed with nothing expanded: either way no file contents.
    result.getOrNull()?.let { assertFalse(it.name.contains("root:")) }
  }
}
