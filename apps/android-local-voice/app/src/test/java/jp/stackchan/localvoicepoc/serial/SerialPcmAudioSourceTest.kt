package jp.stackchan.localvoicepoc.serial

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.coroutines.yield
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList

class SerialPcmAudioSourceTest {
    @Test
    fun ignoresPcmThatArrivesBeforeMicStarted() = runBlocking {
        val transport = FakeUsbTransport()
        val source = SerialPcmAudioSource(transport)
        val result = async { source.chunks().first() }
        transport.awaitControlCount(StackChanControl.MIC_START, 1)

        transport.emitPcm(sequence = 0, fill = 1)
        transport.emitControl(StackChanControl.MIC_STARTED)
        transport.emitPcm(sequence = 0, fill = 2)

        assertArrayEquals(ByteArray(FRAME_BYTES) { 2 }, withTimeout(1_000) { result.await() })
        transport.awaitControlCount(StackChanControl.MIC_STOP, 1)
        source.close()
    }

    @Test
    fun ignoresPcmFromAnotherStream() = runBlocking {
        val transport = FakeUsbTransport()
        val source = SerialPcmAudioSource(transport)
        val result = async { source.chunks().first() }
        transport.awaitControlCount(StackChanControl.MIC_START, 1)

        val activeStream = transport.currentMicStream
        val otherStream = if (activeStream == 1) 2 else 1
        transport.emitControl(StackChanControl.MIC_STARTED, streamId = activeStream)
        transport.emitPcm(sequence = 0, fill = 1, streamId = otherStream)
        transport.emitPcm(sequence = 0, fill = 2, streamId = activeStream)

        assertArrayEquals(ByteArray(FRAME_BYTES) { 2 }, withTimeout(1_000) { result.await() })
        source.close()
    }

    @Test
    fun waitsForMicStoppedBeforeStartingTheNextCapture() = runBlocking {
        val transport = FakeUsbTransport(autoAcknowledgeStop = false)
        val source = SerialPcmAudioSource(transport)
        val first = launch { source.chunks().collect() }
        transport.awaitControlCount(StackChanControl.MIC_START, 1)
        transport.emitControl(StackChanControl.MIC_STARTED)
        first.cancelAndJoin()
        transport.awaitControlCount(StackChanControl.MIC_STOP, 1)

        val second = launch { source.chunks().collect() }
        val startedBeforeOldStopCompleted = withTimeoutOrNull(200) {
            transport.awaitControlCount(StackChanControl.MIC_START, 2)
            true
        } ?: false
        transport.emitControl(StackChanControl.MIC_STOPPED)
        transport.awaitControlCount(StackChanControl.MIC_START, 2)
        transport.emitControl(StackChanControl.MIC_STARTED)
        second.cancelAndJoin()
        transport.emitControl(StackChanControl.MIC_STOPPED)

        assertFalse("A new MIC_START must wait for the previous MIC_STOPPED", startedBeforeOldStopCompleted)
        source.close()
    }

    @Test
    fun reportsOverflowInsteadOfSilentlyDroppingPcm() = runBlocking {
        val transport = FakeUsbTransport()
        val source = SerialPcmAudioSource(transport)
        val releaseConsumer = CompletableDeferred<Unit>()
        var received = 0
        val collection = async {
            runCatching {
                source.chunks().collect {
                    received += 1
                    if (received == 1) releaseConsumer.await()
                }
            }.exceptionOrNull()
        }
        transport.awaitControlCount(StackChanControl.MIC_START, 1)
        transport.emitControl(StackChanControl.MIC_STARTED)

        repeat(500) { sequence -> transport.emitPcm(sequence, sequence.toByte()) }
        delay(100)
        releaseConsumer.complete(Unit)
        val failure = withTimeoutOrNull(1_000) { collection.await() }
        if (failure == null) {
            source.stop()
            withTimeout(1_000) { collection.await() }
        }

        assertTrue("PCM overflow must be reported as an IOException", failure is IOException)
        source.close()
    }

    private class FakeUsbTransport(
        private val autoAcknowledgeStop: Boolean = true,
    ) : StackChanUsbTransport {
        private val mutableState = MutableStateFlow<StackChanUsbState>(
            StackChanUsbState.Ready(StackChanFrameCodec.MAX_PAYLOAD_BYTES, StackChanCapabilities.ALL),
        )
        private val mutableFrames = MutableSharedFlow<StackChanFrame>(extraBufferCapacity = 256)
        val sentControls = CopyOnWriteArrayList<StackChanControl>()
        var currentMicStream = 0
            private set

        override val state: StateFlow<StackChanUsbState> = mutableState
        override val frames: SharedFlow<StackChanFrame> = mutableFrames

        override suspend fun send(frame: StackChanFrame) = Unit

        override suspend fun sendControl(
            control: StackChanControl,
            sampleRate: Int,
            payload: ByteArray,
            streamId: Int,
        ) {
            sentControls += control
            if (control == StackChanControl.MIC_START) currentMicStream = streamId
            if (control == StackChanControl.MIC_STOP && autoAcknowledgeStop) {
                emitControl(StackChanControl.MIC_STOPPED, streamId)
            }
        }

        suspend fun emitControl(control: StackChanControl, streamId: Int = currentMicStream) {
            mutableFrames.emit(
                StackChanFrame(
                    type = StackChanFrame.Type.CONTROL,
                    flags = control.wireValue,
                    sequence = 0,
                    sampleRate = SAMPLE_RATE,
                    streamId = streamId,
                ),
            )
        }

        suspend fun emitPcm(sequence: Int, fill: Byte, streamId: Int = currentMicStream) {
            mutableFrames.emit(
                StackChanFrame(
                    type = StackChanFrame.Type.MICROPHONE_PCM,
                    sequence = sequence,
                    sampleRate = SAMPLE_RATE,
                    payload = ByteArray(FRAME_BYTES) { fill },
                    streamId = streamId,
                ),
            )
        }

        suspend fun awaitControlCount(control: StackChanControl, count: Int) {
            withTimeout(1_000) {
                while (sentControls.count { it == control } < count) yield()
            }
        }
    }

    private companion object {
        const val SAMPLE_RATE = 16_000
        const val FRAME_BYTES = 640
    }
}
