package jp.stackchan.localvoicepoc.serial

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.supervisorScope
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.withContext
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
    fun respectsThePeerMaximumPayload() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL, maxPayload = 640)
        val sink = SerialPcmAudioSink(transport)

        sink.begin(24_000)
        sink.write(ShortArray(1_920))
        sink.finish()

        val pcmFrames = transport.sent.filter { it.type == StackChanFrame.Type.SPEAKER_PCM }
        assertTrue(pcmFrames.isNotEmpty())
        assertTrue(pcmFrames.all { it.payload.size <= 640 })
        assertEquals(3_840, pcmFrames.sumOf { it.payload.size })
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

        val failure = supervisorScope {
            val playback = async {
                sink.begin(24_000)
                sink.write(ShortArray(24_000))
                sink.finish()
            }
            withTimeout(1_000) {
                while (transport.sent.none { it.type == StackChanFrame.Type.SPEAKER_PCM }) yield()
            }
            transport.emitError()
            runCatching { withTimeout(1_000) { playback.await() } }.exceptionOrNull()
        }

        assertTrue(failure is java.io.IOException)
        assertTrue(transport.sent.any { it.flags == StackChanControl.SPEAKER_ABORT.wireValue })
        sink.close()
    }

    @Test
    fun firmwareErrorCancelsTheOwningPlaybackJobWithoutAnotherSinkCall() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL, replenishCredit = false)
        val sink = SerialPcmAudioSink(transport)
        val endedPromptly = supervisorScope {
            val playback = async {
                sink.begin(24_000)
                sink.write(ShortArray(24_000))
                awaitCancellation()
            }
            withTimeout(1_000) {
                while (transport.sent.none { it.type == StackChanFrame.Type.SPEAKER_PCM }) yield()
            }
            transport.emitError()
            val failure = withTimeoutOrNull(500) {
                runCatching { playback.await() }.exceptionOrNull()
            }
            if (failure == null) playback.cancelAndJoin()
            failure is java.io.IOException
        }

        assertTrue("Firmware ERROR must terminate the owning playback job", endedPromptly)
        sink.close()
    }

    @Test
    fun firmwareErrorPreservesTheRemoteErrorCode() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL, replenishCredit = false)
        val sink = SerialPcmAudioSink(transport)
        val failure = supervisorScope {
            val playback = async {
                sink.begin(24_000)
                sink.write(ShortArray(24_000))
                awaitCancellation()
            }
            withTimeout(1_000) {
                while (transport.sent.none { it.type == StackChanFrame.Type.SPEAKER_PCM }) yield()
            }
            transport.emitError(7)
            withTimeout(500) { runCatching { playback.await() }.exceptionOrNull() }
        }

        assertTrue(failure is StackChanRemoteException)
        assertEquals(7, (failure as StackChanRemoteException).errorCode)
        sink.close()
    }

    @Test
    fun ignoresAnErrorFromAnotherStream() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL, replenishCredit = false)
        val sink = SerialPcmAudioSink(transport)
        val ignored = supervisorScope {
            val playback = async {
                sink.begin(24_000)
                sink.write(ShortArray(24_000))
                awaitCancellation()
            }
            withTimeout(1_000) {
                while (transport.sent.none { it.type == StackChanFrame.Type.SPEAKER_PCM }) yield()
            }
            val activeStream = transport.sent.first {
                it.flags == StackChanControl.SPEAKER_START.wireValue
            }.streamId
            transport.emitError(errorCode = 7, streamId = activeStream xor 1)
            val endedByStaleError = withTimeoutOrNull(200) {
                playback.join()
                true
            } ?: false
            transport.emitError(errorCode = 7, streamId = activeStream)
            runCatching { withTimeout(500) { playback.await() } }
            endedByStaleError
        }

        assertFalse("an ERROR for another stream must be ignored", ignored)
        sink.close()
    }

    @Test
    fun abortWaitsForAnInFlightPcmWriteBeforeSendingTheAbortControl() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL, blockPcmWrites = true)
        val sink = SerialPcmAudioSink(transport)

        sink.begin(24_000)
        sink.write(ShortArray(1_920))
        withTimeout(1_000) { transport.pcmWriteEntered.await() }
        val abort = async { sink.abort() }
        yield()
        transport.releasePcmWrite.complete(Unit)
        withTimeout(1_000) { abort.await() }
        withTimeout(1_000) {
            while (transport.sent.none { it.type == StackChanFrame.Type.SPEAKER_PCM }) yield()
        }

        val pcmIndex = transport.sent.indexOfFirst { it.type == StackChanFrame.Type.SPEAKER_PCM }
        val abortIndex = transport.sent.indexOfFirst { it.flags == StackChanControl.SPEAKER_ABORT.wireValue }
        assertTrue("SPEAKER_ABORT must follow every in-flight PCM write", abortIndex > pcmIndex)
        sink.close()
    }

    private class FakeUsbTransport(
        capabilities: Int,
        private val replenishCredit: Boolean = true,
        maxPayload: Int = StackChanFrameCodec.MAX_PAYLOAD_BYTES,
        private val blockPcmWrites: Boolean = false,
    ) : StackChanUsbTransport {
        private val mutableState = MutableStateFlow<StackChanUsbState>(
            StackChanUsbState.Ready(maxPayload, capabilities),
        )
        private val mutableFrames = MutableSharedFlow<StackChanFrame>(extraBufferCapacity = 32)
        val sent = CopyOnWriteArrayList<StackChanFrame>()
        val pcmWriteEntered = CompletableDeferred<Unit>()
        val releasePcmWrite = CompletableDeferred<Unit>()
        private var currentSpeakerStream = 0

        override val state: StateFlow<StackChanUsbState> = mutableState
        override val frames: SharedFlow<StackChanFrame> = mutableFrames

        override suspend fun send(frame: StackChanFrame) {
            if (blockPcmWrites && frame.type == StackChanFrame.Type.SPEAKER_PCM) {
                withContext(NonCancellable) {
                    pcmWriteEntered.complete(Unit)
                    releasePcmWrite.await()
                    sent += frame
                }
            } else {
                sent += frame
            }
            if (replenishCredit && frame.type == StackChanFrame.Type.SPEAKER_PCM) {
                mutableFrames.emit(
                    controlFrame(
                        StackChanControl.SPEAKER_CREDIT,
                        frame.sampleRate,
                        uint32Payload(frame.payload.size),
                        frame.streamId,
                    ),
                )
            }
        }

        override suspend fun sendControl(
            control: StackChanControl,
            sampleRate: Int,
            payload: ByteArray,
            streamId: Int,
        ) {
            sent += controlFrame(control, sampleRate, payload, streamId)
            when (control) {
                StackChanControl.SPEAKER_START -> {
                    currentSpeakerStream = streamId
                    mutableFrames.emit(
                        controlFrame(
                            StackChanControl.SPEAKER_CREDIT,
                            sampleRate,
                            uint32Payload(minOf(12 * 1_024, sampleRate * 2)),
                            streamId,
                        ),
                    )
                }
                StackChanControl.SPEAKER_END -> mutableFrames.emit(
                    controlFrame(StackChanControl.SPEAKER_DONE, sampleRate, streamId = streamId),
                )
                else -> Unit
            }
        }

        suspend fun emitError(errorCode: Int = 3, streamId: Int = currentSpeakerStream) {
            mutableFrames.emit(
                controlFrame(StackChanControl.ERROR, 0, uint32Payload(errorCode), streamId),
            )
        }

        private fun controlFrame(
            control: StackChanControl,
            sampleRate: Int,
            payload: ByteArray = byteArrayOf(),
            streamId: Int = 0,
        ) = StackChanFrame(
            type = StackChanFrame.Type.CONTROL,
            flags = control.wireValue,
            sequence = 0,
            sampleRate = sampleRate,
            payload = payload,
            streamId = streamId,
        )
    }
}
