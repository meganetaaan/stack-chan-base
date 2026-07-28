package jp.stackchan.localvoicepoc.conversation

import java.io.ByteArrayOutputStream
import java.util.ArrayDeque

class UtteranceAccumulator(
    private val chunkDurationMs: Int = 100,
    private val preRollMs: Int = 300,
    private val endSilenceMs: Int = 800,
    private val minimumSpeechMs: Int = 350,
    private val maximumUtteranceMs: Int = 15_000,
) {
    private data class TimedChunk(val bytes: ByteArray, val durationMs: Int)

    private val preRoll = ArrayDeque<TimedChunk>()
    private var preRollDurationMs = 0
    private var utterance = ByteArrayOutputStream()
    private var started = false
    private var speechMs = 0
    private var silenceMs = 0
    private var totalMs = 0

    val isCapturing: Boolean
        get() = started

    fun accept(
        chunk: ByteArray,
        speech: Boolean,
        durationMs: Int = chunkDurationMs,
    ): ByteArray? {
        require(durationMs > 0) { "Chunk duration must be positive" }
        if (!started) {
            preRoll.addLast(TimedChunk(chunk.copyOf(), durationMs))
            preRollDurationMs += durationMs
            while (preRollDurationMs > preRollMs && preRoll.size > 1) {
                preRollDurationMs -= preRoll.removeFirst().durationMs
            }
            if (!speech) return null

            started = true
            preRoll.forEach { buffered -> utterance.write(buffered.bytes) }
            speechMs = durationMs
            totalMs = preRollDurationMs
            silenceMs = 0
            preRoll.clear()
            preRollDurationMs = 0
            return null
        }

        utterance.write(chunk)
        totalMs += durationMs
        if (speech) {
            speechMs += durationMs
            silenceMs = 0
        } else {
            silenceMs += durationMs
        }

        val silenceReached = silenceMs >= endSilenceMs
        val durationReached = totalMs >= maximumUtteranceMs
        if (!silenceReached && !durationReached) return null

        // A click or other short impulse must not start a 15-second transcription.
        if (speechMs < minimumSpeechMs) {
            reset()
            return null
        }

        val result = utterance.toByteArray()
        reset()
        return result
    }

    fun reset() {
        preRoll.clear()
        preRollDurationMs = 0
        utterance = ByteArrayOutputStream()
        started = false
        speechMs = 0
        silenceMs = 0
        totalMs = 0
    }
}
