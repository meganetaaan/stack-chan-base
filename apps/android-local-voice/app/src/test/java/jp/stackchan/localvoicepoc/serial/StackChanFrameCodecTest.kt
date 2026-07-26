package jp.stackchan.localvoicepoc.serial

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
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

    @Test
    fun matchesFirmwareWireVector() {
        val encoded = StackChanFrameCodec.encode(
            StackChanFrame(
                type = StackChanFrame.Type.SPEAKER_PCM,
                flags = StackChanControl.SPEAKER_START.wireValue,
                sequence = 42,
                sampleRate = 24_000,
                payload = byteArrayOf(1, 2, 3, 4),
            ),
        )
        assertEquals(
            "43530202200000002a000000c05d000004000000010203044304066c",
            encoded.joinToString("") { "%02x".format(it.toInt() and 0xff) },
        )
    }

    @Test
    fun roundTripsTheStreamIdInTheReservedHeaderField() {
        val encoded = StackChanFrameCodec.encode(
            StackChanFrame(
                type = StackChanFrame.Type.SPEAKER_PCM,
                streamId = 0x0201,
                sequence = 7,
                sampleRate = 24_000,
                payload = byteArrayOf(1, 2),
            ),
        )

        assertEquals(0x01, encoded[6].toInt() and 0xff)
        assertEquals(0x02, encoded[7].toInt() and 0xff)
        assertEquals(0x0201, StackChanFrameCodec.decode(encoded).streamId)
        assertTrue(StackChanCapabilities.ALL and StackChanCapabilities.STREAM_ID != 0)
    }

    @Test
    fun advertisesOptionalSentenceCaptions() {
        assertEquals(37, StackChanControl.SPEAKER_TEXT.wireValue)
        assertTrue(StackChanCapabilities.ALL and StackChanCapabilities.SPEAKER_TEXT != 0)
        assertEquals(0, StackChanCapabilities.REQUIRED and StackChanCapabilities.SPEAKER_TEXT)
    }

    @Test
    fun advertisesConversationStatusIcons() {
        assertEquals(48, StackChanControl.STATUS.wireValue)
        assertEquals(1, StackChanStatus.RECOGNIZING.wireValue)
        assertEquals(2, StackChanStatus.SPEAKING.wireValue)
        assertTrue(StackChanCapabilities.ALL and StackChanCapabilities.STATUS_ICON != 0)
    }

    @Test
    fun explainsDistinctFirmwareSpeakerReceiveErrors() {
        assertEquals(6, StackChanErrorCode.SPEAKER_SEQUENCE_MISMATCH.wireValue)
        assertEquals(7, StackChanErrorCode.SPEAKER_BUFFER_OVERFLOW.wireValue)
        assertEquals(8, StackChanErrorCode.CAPTION_QUEUE_OVERFLOW.wireValue)
        assertTrue(StackChanRemoteException(6, 2).message.orEmpty().contains("PCM sequenceが欠落"))
        assertTrue(StackChanRemoteException(7, 2).message.orEmpty().contains("PCM受信バッファ"))
    }

    @Test
    fun streamParserAcceptsFragmentedAndCoalescedFrames() {
        val first = StackChanFrameCodec.encode(
            StackChanFrame(StackChanFrame.Type.CONTROL, sequence = 0, flags = StackChanControl.HELLO.wireValue),
        )
        val second = StackChanFrameCodec.encode(
            StackChanFrame(StackChanFrame.Type.MICROPHONE_PCM, sequence = 0, sampleRate = 16_000, payload = byteArrayOf(1, 2)),
        )
        val parser = StackChanFrameStreamParser()
        assertTrue(parser.push(first.copyOfRange(0, 7)).isEmpty())
        val decoded = parser.push(first.copyOfRange(7, first.size) + second)
        assertEquals(2, decoded.size)
        assertEquals(StackChanFrame.Type.CONTROL, decoded[0].type)
        assertEquals(StackChanFrame.Type.MICROPHONE_PCM, decoded[1].type)
    }

    @Test
    fun streamParserResynchronizesAfterCorruption() {
        val corrupt = StackChanFrameCodec.encode(
            StackChanFrame(StackChanFrame.Type.MICROPHONE_PCM, sequence = 0, payload = byteArrayOf(1, 2)),
        )
        corrupt[20] = (corrupt[20].toInt() xor 1).toByte()
        val valid = StackChanFrameCodec.encode(
            StackChanFrame(StackChanFrame.Type.CONTROL, sequence = 1, flags = StackChanControl.MIC_STOPPED.wireValue),
        )
        val decoded = StackChanFrameStreamParser().push(byteArrayOf(9, 8, 7) + corrupt + valid)
        assertEquals(1, decoded.size)
        assertEquals(StackChanControl.MIC_STOPPED.wireValue, decoded.single().flags)
    }
}
