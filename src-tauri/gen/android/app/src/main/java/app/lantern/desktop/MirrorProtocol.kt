package app.lantern.desktop

import java.io.DataInputStream
import java.io.DataOutputStream
import java.io.EOFException
import java.io.IOException

/**
 * What travels between a phone mirroring its screen and the television showing it.
 *
 * One TCP connection, phone to television. It opens with the one-time token the
 * television handed out when it accepted (so nobody else on the network can push
 * pictures at it), then carries packets of `[kind:1][ptsUs:8][len:4][bytes]`:
 * the H.264 encoder's configuration and frames, and the AAC encoder's.
 *
 * Deliberately not a container format. Nothing is buffered, seeked or saved; a
 * frame is drawn the moment it arrives, and the framing is the least that lets the
 * other side tell one encoder output from the next.
 *
 * Pure and free of Android types, so it can be checked on the JVM
 * (MirrorProtocolTest).
 */
object MirrorProtocol {
  const val VIDEO_CONFIG = 1
  const val VIDEO_FRAME = 2
  const val AUDIO_CONFIG = 3
  const val AUDIO_FRAME = 4

  /** Larger than any frame an encoder at these settings produces; anything bigger is not ours. */
  const val MAX_PACKET = 8 * 1024 * 1024
  private const val MAX_TOKEN = 256

  /** The longest and shortest edge a mirrored picture is encoded at. */
  const val MAX_LONG = 1920
  const val MAX_SHORT = 1080

  class Packet(val kind: Int, val ptsUs: Long, val payload: ByteArray)

  fun writeHello(out: DataOutputStream, token: String) {
    val bytes = token.toByteArray(Charsets.UTF_8)
    require(bytes.size in 1..MAX_TOKEN) { "token length" }
    out.writeShort(bytes.size)
    out.write(bytes)
    out.flush()
  }

  fun readHello(input: DataInputStream): String {
    val length = input.readUnsignedShort()
    if (length !in 1..MAX_TOKEN) throw IOException("bad hello")
    val bytes = ByteArray(length)
    input.readFully(bytes)
    return String(bytes, Charsets.UTF_8)
  }

  fun write(out: DataOutputStream, kind: Int, ptsUs: Long, payload: ByteArray, offset: Int = 0, length: Int = payload.size) {
    out.writeByte(kind)
    out.writeLong(ptsUs)
    out.writeInt(length)
    out.write(payload, offset, length)
    out.flush()
  }

  /** The next packet, or EOFException when the phone has gone. */
  fun read(input: DataInputStream): Packet {
    val kind = input.read()
    if (kind < 0) throw EOFException()
    val pts = input.readLong()
    val length = input.readInt()
    if (length < 0 || length > MAX_PACKET) throw IOException("packet of $length bytes")
    val payload = ByteArray(length)
    input.readFully(payload)
    return Packet(kind, pts, payload)
  }

  /**
   * The size to encode a screen at: its own shape, no edge past 1920 by 1080
   * (in whichever orientation the phone is held), both even. Television decoders
   * are the limit - many refuse anything larger than 1080p - and an odd edge is
   * refused by most encoders.
   */
  fun fitSize(width: Int, height: Int): Pair<Int, Int> {
    if (width <= 0 || height <= 0) return MAX_LONG to MAX_SHORT
    val landscape = width >= height
    val maxW = if (landscape) MAX_LONG else MAX_SHORT
    val maxH = if (landscape) MAX_SHORT else MAX_LONG
    val scale = minOf(1.0, maxW.toDouble() / width, maxH.toDouble() / height)
    val w = (width * scale).toInt() and 1.inv()
    val h = (height * scale).toInt() and 1.inv()
    return maxOf(w, 2) to maxOf(h, 2)
  }

  /** A video configuration: the size it is for, then the encoder's own SPS/PPS bytes. */
  fun videoConfig(width: Int, height: Int, csd: ByteArray): ByteArray =
    ints(width, height) + csd

  fun parseVideoConfig(bytes: ByteArray): Triple<Int, Int, ByteArray> {
    if (bytes.size < 8) throw IOException("short video config")
    return Triple(int(bytes, 0), int(bytes, 4), bytes.copyOfRange(8, bytes.size))
  }

  /** An audio configuration: sample rate, channels, then the AAC AudioSpecificConfig. */
  fun audioConfig(sampleRate: Int, channels: Int, csd: ByteArray): ByteArray =
    ints(sampleRate, channels) + csd

  fun parseAudioConfig(bytes: ByteArray): Triple<Int, Int, ByteArray> {
    if (bytes.size < 8) throw IOException("short audio config")
    return Triple(int(bytes, 0), int(bytes, 4), bytes.copyOfRange(8, bytes.size))
  }

  /** Compares tokens in time that does not depend on where they first differ. */
  fun tokenMatches(expected: String, offered: String): Boolean {
    val a = expected.toByteArray(Charsets.UTF_8)
    val b = offered.toByteArray(Charsets.UTF_8)
    if (a.isEmpty() || a.size != b.size) return false
    var diff = 0
    for (i in a.indices) diff = diff or (a[i].toInt() xor b[i].toInt())
    return diff == 0
  }

  private fun ints(a: Int, b: Int): ByteArray = byteArrayOf(
    (a ushr 24).toByte(), (a ushr 16).toByte(), (a ushr 8).toByte(), a.toByte(),
    (b ushr 24).toByte(), (b ushr 16).toByte(), (b ushr 8).toByte(), b.toByte(),
  )

  private fun int(bytes: ByteArray, at: Int): Int =
    ((bytes[at].toInt() and 0xff) shl 24) or
      ((bytes[at + 1].toInt() and 0xff) shl 16) or
      ((bytes[at + 2].toInt() and 0xff) shl 8) or
      (bytes[at + 3].toInt() and 0xff)
}
