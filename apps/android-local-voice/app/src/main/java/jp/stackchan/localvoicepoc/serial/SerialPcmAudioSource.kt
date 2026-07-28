package jp.stackchan.localvoicepoc.serial

import jp.stackchan.localvoicepoc.audio.PcmAudioSource
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.ProducerScope
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean

class SerialPcmAudioSource(
    private val connection: StackChanUsbTransport,
) : PcmAudioSource, AutoCloseable {
    override val sampleRate: Int = 16_000
    override val channelCount: Int = 1
    override val bytesPerSample: Int = 2

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val startMutex = Mutex()
    private val capturing = AtomicBoolean(false)
    @Volatile private var pendingStop: Job? = null
    @Volatile private var stopActiveFlow: (() -> Unit)? = null

    @OptIn(ExperimentalCoroutinesApi::class)
    override fun chunks(): Flow<ByteArray> = callbackFlow {
        startMutex.withLock {
            pendingStop?.join()
            pendingStop = null
            check(connection.state.value is StackChanUsbState.Ready) { "ｽﾀｯｸﾁｬﾝが接続されていません。" }
            check(capturing.compareAndSet(false, true)) { "Microphone is already active" }
        }

        var expectedSequence = 0
        val streamId = connection.allocateStreamId()
        val frameBytes = sampleRate * bytesPerSample * FRAME_MILLISECONDS / 1_000
        val started = CompletableDeferred<Unit>()
        val stopped = CompletableDeferred<Unit>()
        val startedAcknowledged = AtomicBoolean(false)
        val producer = this
        stopActiveFlow = { producer.close() }

        val collector = scope.launch(start = CoroutineStart.UNDISPATCHED) {
            connection.frames.collect { frame ->
                if (frame.streamId != streamId) return@collect
                when {
                    frame.type == StackChanFrame.Type.CONTROL &&
                        frame.flags == StackChanControl.MIC_STARTED.wireValue &&
                        frame.sampleRate == sampleRate -> {
                        startedAcknowledged.set(true)
                        started.complete(Unit)
                    }
                    frame.type == StackChanFrame.Type.CONTROL &&
                        frame.flags == StackChanControl.MIC_STOPPED.wireValue &&
                        frame.sampleRate == sampleRate -> stopped.complete(Unit)
                    frame.type == StackChanFrame.Type.MICROPHONE_PCM && startedAcknowledged.get() -> {
                        if (frame.sampleRate != sampleRate || frame.payload.size != frameBytes) {
                            producer.close(IOException("CoreS3マイクのPCM形式が不正です。"))
                            return@collect
                        }
                        val missing = frame.sequence - expectedSequence
                        if (missing !in 0..MAX_CONSECUTIVE_MISSING_FRAMES) {
                            producer.close(IOException("CoreS3マイクのsequenceが不正です。"))
                            return@collect
                        }
                        repeat(missing) {
                            if (!producer.offerPcm(ByteArray(frameBytes))) return@collect
                        }
                        expectedSequence = frame.sequence + 1
                        producer.offerPcm(frame.payload)
                    }
                    frame.type == StackChanFrame.Type.CONTROL &&
                        frame.flags == StackChanControl.ERROR.wireValue -> {
                        val error = runCatching {
                            StackChanRemoteException(parseUint32Payload(frame.payload), frame.streamId)
                        }.getOrElse { IOException("CoreS3のエラー応答が不正です。", it) }
                        started.completeExceptionally(error)
                        producer.close(error)
                    }
                }
            }
        }
        val starter = launch {
            runCatching {
                connection.sendControl(StackChanControl.MIC_START, sampleRate, streamId = streamId)
                withTimeout(CONTROL_TIMEOUT_MILLISECONDS) { started.await() }
            }.onFailure { close(it) }
        }

        awaitClose {
            starter.cancel()
            if (stopActiveFlow != null) stopActiveFlow = null
            val stopJob = scope.launch(start = CoroutineStart.UNDISPATCHED) {
                withContext(NonCancellable) {
                    runCatching {
                        connection.sendControl(StackChanControl.MIC_STOP, sampleRate, streamId = streamId)
                        withTimeout(CONTROL_TIMEOUT_MILLISECONDS) { stopped.await() }
                    }
                    collector.cancelAndJoin()
                    capturing.set(false)
                }
            }
            pendingStop = stopJob
        }
    }

    @OptIn(ExperimentalCoroutinesApi::class)
    private fun ProducerScope<ByteArray>.offerPcm(bytes: ByteArray): Boolean {
        val result = trySend(bytes)
        if (result.isSuccess) return true
        if (!result.isClosed) close(IOException("CoreS3マイクの受信バッファがあふれました。"))
        return false
    }

    override fun stop() {
        stopActiveFlow?.invoke()
    }

    override fun close() {
        stop()
        scope.cancel()
    }

    private companion object {
        const val FRAME_MILLISECONDS = 20
        const val MAX_CONSECUTIVE_MISSING_FRAMES = 10
        const val CONTROL_TIMEOUT_MILLISECONDS = 2_000L
    }
}
