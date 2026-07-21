package jp.stackchan.localvoicepoc.serial

import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.CopyOnWriteArrayList

class SerialPcmAudioSinkTest {
    @Test
    fun sendsCaptionImmediatelyBeforeItsPcm() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL)
        val sink = SerialPcmAudioSink(transport)

        sink.begin(24_000)
        sink.setCaption("こんにちは")
        sink.write(ShortArray(480) { it.toShort() })
        sink.finish()

        assertEquals(StackChanControl.SPEAKER_START.wireValue, transport.sent[0].flags)
        assertEquals(StackChanControl.SPEAKER_TEXT.wireValue, transport.sent[1].flags)
        assertArrayEquals("こんにちは".toByteArray(Charsets.UTF_8), transport.sent[1].payload)
        assertEquals(StackChanFrame.Type.SPEAKER_PCM, transport.sent[2].type)
        assertEquals(960, transport.sent[2].payload.size)
        assertEquals(StackChanControl.SPEAKER_END.wireValue, transport.sent[3].flags)
        sink.close()
    }

    @Test
    fun omitsCaptionForOlderFirmwareWithoutTheCapability() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.REQUIRED)
        val sink = SerialPcmAudioSink(transport)

        sink.begin(24_000)
        sink.setCaption("not supported")
        sink.write(ShortArray(480))
        sink.finish()

        assertFalse(transport.sent.any { it.flags == StackChanControl.SPEAKER_TEXT.wireValue })
        assertTrue(transport.sent.any { it.type == StackChanFrame.Type.SPEAKER_PCM })
        sink.close()
    }

    @Test
    fun batchesPcmIntoEightyMillisecondFrames() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL)
        val sink = SerialPcmAudioSink(transport)

        sink.begin(24_000)
        sink.write(ShortArray(1_920))
        sink.finish()

        val pcm = transport.sent.single { it.type == StackChanFrame.Type.SPEAKER_PCM }
        assertEquals(3_840, pcm.payload.size)
        sink.close()
    }

    @Test
    fun writeCanQueueSeveralSecondsWhileUsbCreditIsStalled() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL, replenishCredit = false)
        val sink = SerialPcmAudioSink(transport)

        sink.begin(24_000)
        withTimeout(1_000) {
            sink.write(ShortArray(24_000 * 2))
        }

        withTimeout(1_000) {
            while (transport.sent.none { it.type == StackChanFrame.Type.SPEAKER_PCM }) yield()
        }
        assertTrue(transport.sent.count { it.type == StackChanFrame.Type.SPEAKER_PCM } > 0)
        sink.stop()
        sink.close()
    }

    @Test
    fun sendsAllTwelveSecondsOfPcmBeforeEndingPlayback() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL)
        val sink = SerialPcmAudioSink(transport)

        withTimeout(5_000) {
            sink.begin(24_000)
            sink.write(ShortArray(24_000 * 12) { (it % Short.MAX_VALUE).toShort() })
            sink.finish()
        }

        val pcmFrames = transport.sent.filter { it.type == StackChanFrame.Type.SPEAKER_PCM }
        val endIndex = transport.sent.indexOfFirst { it.flags == StackChanControl.SPEAKER_END.wireValue }
        val finalPcmIndex = transport.sent.indexOfLast { it.type == StackChanFrame.Type.SPEAKER_PCM }
        assertEquals(150, pcmFrames.size)
        assertEquals(24_000 * 12 * 2, pcmFrames.sumOf { it.payload.size })
        assertTrue(endIndex > finalPcmIndex)
        sink.close()
    }

    @Test
    fun firmwareErrorInterruptsAStalledCreditWait() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL, replenishCredit = false)
        val sink = SerialPcmAudioSink(transport)

        sink.begin(24_000)
        sink.write(ShortArray(24_000))
        transport.emitError()
        val failure = runCatching {
            withTimeout(1_000) { sink.finish() }
        }.exceptionOrNull()

        assertTrue(failure is java.io.IOException)
        assertTrue(transport.sent.any { it.flags == StackChanControl.SPEAKER_ABORT.wireValue })
        sink.close()
    }

    private class FakeUsbTransport(
        capabilities: Int,
        private val replenishCredit: Boolean = true,
    ) : StackChanUsbTransport {
        private val mutableState = MutableStateFlow<StackChanUsbState>(
            StackChanUsbState.Ready(StackChanFrameCodec.MAX_PAYLOAD_BYTES, capabilities),
        )
        private val mutableFrames = MutableSharedFlow<StackChanFrame>(extraBufferCapacity = 32)
        val sent = CopyOnWriteArrayList<StackChanFrame>()

        override val state: StateFlow<StackChanUsbState> = mutableState
        override val frames: SharedFlow<StackChanFrame> = mutableFrames

        override suspend fun send(frame: StackChanFrame) {
            sent += frame
            if (replenishCredit && frame.type == StackChanFrame.Type.SPEAKER_PCM) {
                mutableFrames.emit(
                    controlFrame(
                        StackChanControl.SPEAKER_CREDIT,
                        frame.sampleRate,
                        uint32Payload(frame.payload.size),
                    ),
                )
            }
        }

        override suspend fun sendControl(control: StackChanControl, sampleRate: Int, payload: ByteArray) {
            sent += controlFrame(control, sampleRate, payload)
            when (control) {
                StackChanControl.SPEAKER_START -> mutableFrames.emit(
                    controlFrame(
                        StackChanControl.SPEAKER_CREDIT,
                        sampleRate,
                        uint32Payload(minOf(12 * 1_024, sampleRate * 2)),
                    ),
                )
                StackChanControl.SPEAKER_END -> mutableFrames.emit(
                    controlFrame(StackChanControl.SPEAKER_DONE, sampleRate),
                )
                else -> Unit
            }
        }

        suspend fun emitError() {
            mutableFrames.emit(controlFrame(StackChanControl.ERROR, 0, uint32Payload(3)))
        }

        private fun controlFrame(
            control: StackChanControl,
            sampleRate: Int,
            payload: ByteArray = byteArrayOf(),
        ) = StackChanFrame(
            type = StackChanFrame.Type.CONTROL,
            flags = control.wireValue,
            sequence = 0,
            sampleRate = sampleRate,
            payload = payload,
        )
    }
}
