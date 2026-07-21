package jp.stackchan.localvoicepoc.serial

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.zip.CRC32

data class StackChanFrame(
    val type: Type,
    val sequence: Int,
    val sampleRate: Int = 0,
    val flags: Int = 0,
    val payload: ByteArray = byteArrayOf(),
) {
    enum class Type(val wireValue: Int) {
        CONTROL(0),
        MICROPHONE_PCM(1),
        SPEAKER_PCM(2),
        EXPRESSION(3),
        MOTION(4),
        DIAGNOSTICS(5);

        companion object {
            fun fromWire(value: Int): Type = entries.firstOrNull { it.wireValue == value }
                ?: error("Unknown frame type: $value")
        }
    }
}

object StackChanFrameCodec {
    private const val MAGIC = 0x5343 // ASCII "SC"
    private const val VERSION = 1
    const val HEADER_BYTES = 20
    const val CRC_BYTES = 4
    const val MAX_PAYLOAD_BYTES = 4 * 1024

    fun encode(frame: StackChanFrame): ByteArray {
        require(frame.payload.size <= MAX_PAYLOAD_BYTES) { "Payload is too large" }
        val buffer = ByteBuffer.allocate(HEADER_BYTES + frame.payload.size + CRC_BYTES)
            .order(ByteOrder.LITTLE_ENDIAN)
        buffer.putShort(MAGIC.toShort())
        buffer.put(VERSION.toByte())
        buffer.put(frame.type.wireValue.toByte())
        buffer.putShort(frame.flags.toShort())
        buffer.putShort(0) // reserved
        buffer.putInt(frame.sequence)
        buffer.putInt(frame.sampleRate)
        buffer.putInt(frame.payload.size)
        buffer.put(frame.payload)

        val crc = CRC32().apply { update(buffer.array(), 0, HEADER_BYTES + frame.payload.size) }
        buffer.putInt(crc.value.toInt())
        return buffer.array()
    }

    fun decode(bytes: ByteArray): StackChanFrame {
        require(bytes.size >= HEADER_BYTES + CRC_BYTES) { "Frame is too short" }
        val buffer = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN)
        require(buffer.short.toInt() and 0xffff == MAGIC) { "Invalid magic" }
        require(buffer.get().toInt() and 0xff == VERSION) { "Unsupported version" }
        val type = StackChanFrame.Type.fromWire(buffer.get().toInt() and 0xff)
        val flags = buffer.short.toInt() and 0xffff
        buffer.short // reserved
        val sequence = buffer.int
        val sampleRate = buffer.int
        val payloadLength = buffer.int
        require(payloadLength in 0..MAX_PAYLOAD_BYTES) { "Invalid payload length" }
        require(bytes.size == HEADER_BYTES + payloadLength + CRC_BYTES) { "Frame length mismatch" }

        val expected = CRC32().apply { update(bytes, 0, HEADER_BYTES + payloadLength) }.value.toInt()
        val payload = ByteArray(payloadLength)
        buffer.get(payload)
        val actual = buffer.int
        require(actual == expected) { "CRC mismatch" }

        return StackChanFrame(
            type = type,
            sequence = sequence,
            sampleRate = sampleRate,
            flags = flags,
            payload = payload,
        )
    }
}
