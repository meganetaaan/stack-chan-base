package jp.stackchan.localvoicepoc.serial

import jp.stackchan.localvoicepoc.audio.PcmAudioSink
import jp.stackchan.localvoicepoc.diagnostics.PlaybackTraceSession
import jp.stackchan.localvoicepoc.diagnostics.PlaybackTraceStore
import jp.stackchan.localvoicepoc.util.StreamingPcmResampler
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Deferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withContext
import kotlinx.coroutines.currentCoroutineContext
import java.io.IOException

class SerialPcmAudioSink(
    private val connection: StackChanUsbTransport,
    private val outputSampleRate: Int = DEFAULT_OUTPUT_SAMPLE_RATE,
    private val playbackTraceStore: PlaybackTraceStore? = null,
) : PcmAudioSink, AutoCloseable {
    private sealed interface SpeakerItem {
        data class Caption(val payload: ByteArray) : SpeakerItem
        data class Pcm(val payload: ByteArray) : SpeakerItem
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val creditMutex = Mutex()
    private val creditChanged = Channel<Unit>(Channel.CONFLATED)

    private var collector: Job? = null
    private var pendingAbort: Job? = null
    private var outbound: Channel<SpeakerItem>? = null
    private var sender: Deferred<Unit>? = null
    private var resampler: StreamingPcmResampler? = null
    private var pending = ByteArray(0)
    private var negotiatedFrameBytes = 0
    private var sequence = 0
    private var activeStreamId = 0
    private var availableCredit = 0
    private var playbackDone: CompletableDeferred<Unit>? = null
    private var speakerTextSupported = false
    private var traceSession: PlaybackTraceSession? = null
    private var inputSampleRate = 0
    private var inputSamples = 0L
    private var outputPcmBytes = 0L
    private var sentPcmBytes = 0L
    private var sentPcmFrames = 0
    private var receivedCreditBytes = 0L
    private var captionCount = 0
    private var speakerStartSent = false
    private var speakerEndSent = false
    private var speakerDoneReceived = false

    init {
        require(outputSampleRate in SUPPORTED_OUTPUT_SAMPLE_RATES) { "Unsupported CoreS3 output sample rate" }
    }

    override suspend fun begin(sampleRate: Int) {
        pendingAbort?.join()
        pendingAbort = null
        val ready = connection.state.value as? StackChanUsbState.Ready
            ?: error("ｽﾀｯｸﾁｬﾝが接続されていません。")
        check(collector == null) { "Speaker output is already active" }
        resetSessionMetrics(sampleRate)
        traceSession = runCatching { playbackTraceStore?.start(sampleRate, outputSampleRate) }.getOrNull()
        resampler = StreamingPcmResampler(sampleRate, outputSampleRate)
        pending = ByteArray(0)
        negotiatedFrameBytes = minOf(defaultFrameBytes, ready.maxPayload) and -2
        check(negotiatedFrameBytes >= 2) { "CoreS3の最大payload長が不正です。" }
        sequence = 0
        activeStreamId = connection.allocateStreamId()
        availableCredit = 0
        playbackDone = CompletableDeferred()
        speakerTextSupported = ready.capabilities and StackChanCapabilities.SPEAKER_TEXT != 0
        val sessionScope = CoroutineScope(currentCoroutineContext())
        collector = sessionScope.launch(start = CoroutineStart.UNDISPATCHED) {
            connection.frames.collect { frame -> handleFrame(frame) }
        }
        try {
            connection.sendControl(
                StackChanControl.SPEAKER_START,
                outputSampleRate,
                streamId = activeStreamId,
            )
            speakerStartSent = true
            traceEvent("speaker_start_sent")
            withTimeout(CONTROL_TIMEOUT_MILLISECONDS) { awaitCredit(1) }
            traceEvent("initial_credit_received", linkedMapOf("availableCreditBytes" to availableCredit))
            val queue = Channel<SpeakerItem>(OUTBOUND_QUEUE_ITEMS)
            outbound = queue
            sender = sessionScope.async(start = CoroutineStart.UNDISPATCHED) {
                try {
                    for (item in queue) {
                        when (item) {
                            is SpeakerItem.Caption -> connection.sendControl(
                                StackChanControl.SPEAKER_TEXT,
                                outputSampleRate,
                                item.payload,
                                activeStreamId,
                            )
                            is SpeakerItem.Pcm -> sendPcm(item.payload)
                        }
                    }
                } catch (error: Throwable) {
                    queue.close(error)
                    throw error
                }
            }
        } catch (error: Throwable) {
            withContext(NonCancellable) { sendAbort("begin_failed", error) }
            closeTrace("begin_failed", error)
            cleanup()
            throw error
        }
    }

    override suspend fun setCaption(text: String) {
        if (!speakerTextSupported) return
        val payload = captionPayload(text)
        if (payload.isEmpty()) return
        captionCount += 1
        traceEvent(
            "caption_queued",
            linkedMapOf("captionIndex" to captionCount, "text" to text, "utf8Bytes" to payload.size),
        )
        enqueue(SpeakerItem.Caption(payload))
    }

    override suspend fun write(samples: ShortArray) {
        val activeResampler = checkNotNull(resampler) { "Speaker output has not begun" }
        inputSamples += samples.size
        val converted = shortsToBytes(activeResampler.process(samples))
        if (converted.isEmpty()) return
        outputPcmBytes += converted.size
        val combined = ByteArray(pending.size + converted.size)
        pending.copyInto(combined)
        converted.copyInto(combined, pending.size)
        var offset = 0
        while (combined.size - offset >= negotiatedFrameBytes) {
            enqueue(SpeakerItem.Pcm(combined.copyOfRange(offset, offset + negotiatedFrameBytes)))
            offset += negotiatedFrameBytes
        }
        pending = combined.copyOfRange(offset, combined.size)
    }

    override suspend fun finish() {
        checkNotNull(resampler) { "Speaker output has not begun" }
        try {
            traceEvent("finish_requested", sessionMetrics())
            if (pending.isNotEmpty()) enqueue(SpeakerItem.Pcm(pending))
            pending = ByteArray(0)
            checkNotNull(outbound) { "Speaker output queue is unavailable" }.close()
            checkNotNull(sender) { "Speaker output sender is unavailable" }.await()
            traceEvent("all_pcm_sent", sessionMetrics())
            connection.sendControl(
                StackChanControl.SPEAKER_END,
                outputSampleRate,
                streamId = activeStreamId,
            )
            speakerEndSent = true
            traceEvent("speaker_end_sent", sessionMetrics())
            withTimeout(PLAYBACK_TIMEOUT_MILLISECONDS) { checkNotNull(playbackDone).await() }
            closeTrace("completed")
        } catch (error: Throwable) {
            traceEvent(
                "finish_failed",
                sessionMetrics(linkedMapOf("errorType" to error.javaClass.name, "errorMessage" to error.message)),
            )
            withContext(NonCancellable) { sendAbort("finish_failed", error) }
            closeTrace("failed", error)
            throw error
        } finally {
            cleanup()
        }
    }

    override suspend fun abort() {
        pendingAbort?.join()
        pendingAbort = null
        if (collector == null) return
        traceEvent("abort_requested", sessionMetrics())
        withContext(NonCancellable) {
            quiesceSender()
            sendAbort("abort_requested")
        }
        closeTrace("aborted")
        cleanup()
    }

    override fun stop() {
        if (collector == null) return
        val shouldAbort = speakerStartSent && !speakerDoneReceived
        val session = traceSession
        val sessionStreamId = activeStreamId
        traceSession = null
        session?.event("stop_requested", sessionMetrics())
        val activeSender = sender
        outbound?.cancel()
        outbound = null
        activeSender?.cancel()
        sender = null
        cleanup()
        pendingAbort = scope.launch {
            activeSender?.join()
            if (shouldAbort) {
                runCatching {
                    connection.sendControl(
                        StackChanControl.SPEAKER_ABORT,
                        outputSampleRate,
                        streamId = sessionStreamId,
                    )
                }
                    .onSuccess { session?.event("speaker_abort_sent") }
                    .onFailure { error ->
                        session?.event(
                            "speaker_abort_failed",
                            linkedMapOf("errorType" to error.javaClass.name, "errorMessage" to error.message),
                        )
                    }
            }
            session?.close("stopped")
        }
    }

    private suspend fun enqueue(item: SpeakerItem) {
        checkNotNull(outbound) { "Speaker output has not begun" }.send(item)
    }

    private suspend fun sendPcm(bytes: ByteArray) {
        try {
            withTimeout(CREDIT_TIMEOUT_MILLISECONDS) { awaitCredit(bytes.size) }
        } catch (error: TimeoutCancellationException) {
            throw IOException(
                "CoreS3の再生creditが${CREDIT_TIMEOUT_MILLISECONDS}ms更新されませんでした。" +
                    "sentFrames=$sentPcmFrames, sentBytes=$sentPcmBytes",
                error,
            )
        }
        creditMutex.withLock { availableCredit -= bytes.size }
        connection.send(
            StackChanFrame(
                type = StackChanFrame.Type.SPEAKER_PCM,
                sequence = sequence++,
                sampleRate = outputSampleRate,
                payload = bytes,
                streamId = activeStreamId,
            ),
        )
        sentPcmFrames += 1
        sentPcmBytes += bytes.size
    }

    private suspend fun awaitCredit(required: Int) {
        while (true) {
            val terminal = playbackDone
            if (terminal?.isCompleted == true) {
                terminal.await()
                throw IOException("CoreS3がPCM送信完了前に再生を終了しました。")
            }
            val ready = creditMutex.withLock { availableCredit >= required }
            if (ready) return
            creditChanged.receive()
        }
    }

    private suspend fun handleFrame(frame: StackChanFrame) {
        if (frame.type != StackChanFrame.Type.CONTROL) return
        if (frame.streamId != activeStreamId) return
        when (StackChanControl.fromWire(frame.flags)) {
            StackChanControl.SPEAKER_CREDIT -> {
                if (frame.sampleRate != outputSampleRate) return
                val credit = runCatching { parseUint32Payload(frame.payload) }.getOrElse {
                    failPlayback(IOException("CoreS3のcredit応答が不正です。"))
                    return
                }
                val accepted = creditMutex.withLock {
                    if (credit !in 1..speakerCapacityBytes || availableCredit > speakerCapacityBytes - credit) {
                        false
                    } else {
                        availableCredit += credit
                        true
                    }
                }
                if (!accepted) {
                    failPlayback(IOException("CoreS3のcredit量が不正です。"))
                    return
                }
                receivedCreditBytes += credit
                creditChanged.trySend(Unit)
            }
            StackChanControl.SPEAKER_DONE -> {
                if (frame.sampleRate != outputSampleRate) return
                speakerDoneReceived = true
                traceEvent("speaker_done_received", sessionMetrics())
                playbackDone?.complete(Unit)
                creditChanged.trySend(Unit)
            }
            StackChanControl.ERROR -> {
                val errorCode = runCatching { parseUint32Payload(frame.payload) }.getOrElse {
                    failPlayback(IOException("CoreS3のエラー応答が不正です。", it))
                    return
                }
                traceEvent(
                    "firmware_error_received",
                    sessionMetrics(linkedMapOf("firmwareErrorCode" to errorCode, "streamId" to frame.streamId)),
                )
                failPlayback(StackChanRemoteException(errorCode, frame.streamId))
            }
            else -> Unit
        }
    }

    private fun failPlayback(error: IOException) {
        playbackDone?.completeExceptionally(error)
        creditChanged.trySend(Unit)
    }

    private suspend fun sendAbort(reason: String, cause: Throwable? = null) {
        if (!speakerStartSent || speakerDoneReceived) return
        try {
            connection.sendControl(
                StackChanControl.SPEAKER_ABORT,
                outputSampleRate,
                streamId = activeStreamId,
            )
            traceEvent("speaker_abort_sent", linkedMapOf("reason" to reason))
        } catch (abortError: Throwable) {
            traceEvent(
                "speaker_abort_failed",
                linkedMapOf(
                    "reason" to reason,
                    "errorType" to abortError.javaClass.name,
                    "errorMessage" to abortError.message,
                    "originalErrorType" to cause?.javaClass?.name,
                ),
            )
        }
    }

    private suspend fun quiesceSender() {
        outbound?.cancel()
        outbound = null
        val activeSender = sender
        sender = null
        activeSender?.cancel()
        activeSender?.join()
    }

    private fun resetSessionMetrics(sampleRate: Int) {
        inputSampleRate = sampleRate
        inputSamples = 0
        outputPcmBytes = 0
        sentPcmBytes = 0
        sentPcmFrames = 0
        receivedCreditBytes = 0
        captionCount = 0
        speakerStartSent = false
        speakerEndSent = false
        speakerDoneReceived = false
        activeStreamId = 0
    }

    private fun sessionMetrics(extra: LinkedHashMap<String, Any?> = linkedMapOf()): LinkedHashMap<String, Any?> =
        linkedMapOf<String, Any?>(
            "inputSampleRate" to inputSampleRate,
            "inputSamples" to inputSamples,
            "inputDurationMs" to if (inputSampleRate > 0) inputSamples * 1_000L / inputSampleRate else 0,
            "outputSampleRate" to outputSampleRate,
            "streamId" to activeStreamId,
            "outputPcmBytes" to outputPcmBytes,
            "outputDurationMs" to outputPcmBytes * 1_000L / (outputSampleRate * 2L),
            "sentPcmBytes" to sentPcmBytes,
            "sentPcmFrames" to sentPcmFrames,
            "receivedCreditBytes" to receivedCreditBytes,
            "captionCount" to captionCount,
            "speakerStartSent" to speakerStartSent,
            "speakerEndSent" to speakerEndSent,
            "speakerDoneReceived" to speakerDoneReceived,
        ).apply { putAll(extra) }

    private fun traceEvent(name: String, fields: Map<String, Any?> = emptyMap()) {
        runCatching { traceSession?.event(name, fields) }
    }

    private fun closeTrace(outcome: String, error: Throwable? = null) {
        val session = traceSession
        traceSession = null
        runCatching {
            session?.close(
                outcome,
                sessionMetrics(
                    linkedMapOf(
                        "errorType" to error?.javaClass?.name,
                        "errorMessage" to error?.message,
                    ),
                ),
            )
        }
    }

    private fun cleanup() {
        outbound?.cancel()
        outbound = null
        sender?.cancel()
        sender = null
        collector?.cancel()
        collector = null
        resampler?.reset()
        resampler = null
        pending = ByteArray(0)
        negotiatedFrameBytes = 0
        availableCredit = 0
        playbackDone = null
        speakerTextSupported = false
        speakerStartSent = false
        speakerEndSent = false
        speakerDoneReceived = false
        activeStreamId = 0
        while (creditChanged.tryReceive().isSuccess) Unit
    }

    override fun close() {
        stop()
        pendingAbort?.cancel()
        scope.cancel()
    }

    private fun shortsToBytes(samples: ShortArray): ByteArray {
        val output = ByteArray(samples.size * 2)
        for (index in samples.indices) {
            val sample = samples[index].toInt()
            output[index * 2] = sample.toByte()
            output[index * 2 + 1] = (sample ushr 8).toByte()
        }
        return output
    }

    private fun captionPayload(text: String): ByteArray {
        val encoded = text.trim().toByteArray(Charsets.UTF_8)
        if (encoded.size <= MAX_CAPTION_BYTES) return encoded
        var end = MAX_CAPTION_BYTES
        while (end > 0 && encoded[end].toInt() and 0xc0 == 0x80) end -= 1
        return encoded.copyOf(end)
    }

    private val defaultFrameBytes: Int
        get() = outputSampleRate * 2 * FRAME_MILLISECONDS / 1_000

    private val speakerCapacityBytes: Int
        get() = outputSampleRate * 2

    companion object {
        const val DEFAULT_OUTPUT_SAMPLE_RATE = 24_000
        val SUPPORTED_OUTPUT_SAMPLE_RATES = setOf(8_000, 16_000, 24_000)
        private const val FRAME_MILLISECONDS = 80
        private const val OUTBOUND_QUEUE_ITEMS = 5_000 / FRAME_MILLISECONDS
        private const val MAX_CAPTION_BYTES = 1_024
        private const val CONTROL_TIMEOUT_MILLISECONDS = 2_000L
        private const val CREDIT_TIMEOUT_MILLISECONDS = 15_000L
        private const val PLAYBACK_TIMEOUT_MILLISECONDS = 30_000L
    }
}
