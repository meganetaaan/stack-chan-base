package jp.stackchan.localvoicepoc.serial

import jp.stackchan.localvoicepoc.audio.PcmAudioSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import java.io.IOException
import java.util.concurrent.atomic.AtomicBoolean

class SerialPcmAudioSource(
    private val connection: StackChanUsbTransport,
) : PcmAudioSource, AutoCloseable {
    override val sampleRate: Int = 16_000
    override val channelCount: Int = 1
    override val bytesPerSample: Int = 2

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val capturing = AtomicBoolean(false)
    @Volatile private var stopActiveFlow: (() -> Unit)? = null

    @OptIn(ExperimentalCoroutinesApi::class)
    override fun chunks(): Flow<ByteArray> = callbackFlow {
        check(connection.state.value is StackChanUsbState.Ready) { "ｽﾀｯｸﾁｬﾝが接続されていません。" }
        check(capturing.compareAndSet(false, true)) { "Microphone is already active" }
        var expectedSequence = 0
        val frameBytes = sampleRate * bytesPerSample * FRAME_MILLISECONDS / 1_000
        val producer = this
        stopActiveFlow = { producer.close() }

        val collector = launch(start = CoroutineStart.UNDISPATCHED) {
            connection.frames.collect { frame ->
                when {
                    frame.type == StackChanFrame.Type.MICROPHONE_PCM -> {
                        if (frame.sampleRate != sampleRate || frame.payload.size != frameBytes) {
                            close(IOException("CoreS3マイクのPCM形式が不正です。"))
                            return@collect
                        }
                        val missing = frame.sequence - expectedSequence
                        if (missing !in 0..MAX_CONSECUTIVE_MISSING_FRAMES) {
                            close(IOException("CoreS3マイクのsequenceが不正です。"))
                            return@collect
                        }
                        repeat(missing) { trySend(ByteArray(frameBytes)) }
                        expectedSequence = frame.sequence + 1
                        trySend(frame.payload)
                    }
                    frame.type == StackChanFrame.Type.CONTROL &&
                        frame.flags == StackChanControl.ERROR.wireValue -> {
                        close(IOException("CoreS3がマイク入力エラーを返しました。"))
                    }
                }
            }
        }
        launch {
            runCatching { connection.sendControl(StackChanControl.MIC_START, sampleRate) }
                .onFailure { close(it) }
        }

        awaitClose {
            collector.cancel()
            capturing.set(false)
            stopActiveFlow = null
            scope.launch { runCatching { connection.sendControl(StackChanControl.MIC_STOP, sampleRate) } }
        }
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
    }
}
