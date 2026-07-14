package jp.stackchan.localvoicepoc.serial

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class StackChanFrameCodecTest {
    @Test
    fun roundTripsPcmFrame() {
        val original = StackChanFrame(
            type = StackChanFrame.Type.SPEAKER_PCM,
            sequence = 42,
            sampleRate = 22_050,
            payload = byteArrayOf(1, 2, 3, 4),
        )
        val decoded = StackChanFrameCodec.decode(StackChanFrameCodec.encode(original))
        assertEquals(original.type, decoded.type)
        assertEquals(original.sequence, decoded.sequence)
        assertEquals(original.sampleRate, decoded.sampleRate)
        assertArrayEquals(original.payload, decoded.payload)
    }

    @Test
    fun rejectsCorruptedPayload() {
        val encoded = StackChanFrameCodec.encode(
            StackChanFrame(
                type = StackChanFrame.Type.SPEAKER_PCM,
                sequence = 1,
                payload = byteArrayOf(1, 2, 3),
            ),
        )
        encoded[20] = (encoded[20].toInt() xor 0x01).toByte()
        assertThrows(IllegalArgumentException::class.java) {
            StackChanFrameCodec.decode(encoded)
        }
    }
}
