package app.lantern.desktop

import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.io.IOException
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

class MirrorProtocolTest {
  private fun roundTrip(write: (DataOutputStream) -> Unit): DataInputStream {
    val bytes = ByteArrayOutputStream()
    write(DataOutputStream(bytes))
    return DataInputStream(ByteArrayInputStream(bytes.toByteArray()))
  }

  @Test
  fun packets_come_back_as_they_were_sent_in_order() {
    val frame = ByteArray(70_000) { (it * 7).toByte() }
    val input = roundTrip { out ->
      MirrorProtocol.writeHello(out, "tok-123")
      MirrorProtocol.write(out, MirrorProtocol.VIDEO_CONFIG, 0, MirrorProtocol.videoConfig(1080, 1920, byteArrayOf(0, 0, 0, 1, 0x67)))
      MirrorProtocol.write(out, MirrorProtocol.VIDEO_FRAME, 33_333, frame)
      MirrorProtocol.write(out, MirrorProtocol.AUDIO_FRAME, 40_000, frame, 10, 20)
    }
    assertEquals("tok-123", MirrorProtocol.readHello(input))
    val config = MirrorProtocol.read(input)
    assertEquals(MirrorProtocol.VIDEO_CONFIG, config.kind)
    val (w, h, csd) = MirrorProtocol.parseVideoConfig(config.payload)
    assertEquals(1080, w)
    assertEquals(1920, h)
    assertArrayEquals(byteArrayOf(0, 0, 0, 1, 0x67), csd)
    val video = MirrorProtocol.read(input)
    assertEquals(33_333L, video.ptsUs)
    assertArrayEquals(frame, video.payload)
    val audio = MirrorProtocol.read(input)
    assertArrayEquals(frame.copyOfRange(10, 30), audio.payload)
    try {
      MirrorProtocol.read(input)
      fail("expected the end")
    } catch (_: EOFException) {
    }
  }

  @Test
  fun an_absurd_length_is_refused_rather_than_allocated() {
    val input = roundTrip { out ->
      out.writeByte(MirrorProtocol.VIDEO_FRAME)
      out.writeLong(0)
      out.writeInt(Int.MAX_VALUE)
    }
    try {
      MirrorProtocol.read(input)
      fail("expected a refusal")
    } catch (e: IOException) {
      assertFalse(e is EOFException)
    }
  }

  @Test
  fun a_screen_is_fitted_inside_1080p_keeping_its_shape_and_even_edges() {
    // A tall phone held upright, and on its side: scaled by 0.8 to fit 1920.
    assertEquals(864 to 1920, MirrorProtocol.fitSize(1080, 2400))
    assertEquals(1920 to 864, MirrorProtocol.fitSize(2400, 1080))
    // Already small enough: left alone.
    assertEquals(1280 to 720, MirrorProtocol.fitSize(1280, 720))
    // An odd edge is made even.
    assertEquals(0, MirrorProtocol.fitSize(1081, 721).first % 2)
  }

  @Test
  fun only_the_exact_token_matches() {
    assertTrue(MirrorProtocol.tokenMatches("abc123", "abc123"))
    assertFalse(MirrorProtocol.tokenMatches("abc123", "abc124"))
    assertFalse(MirrorProtocol.tokenMatches("abc123", "abc12"))
    assertFalse(MirrorProtocol.tokenMatches("", ""))
  }
}
