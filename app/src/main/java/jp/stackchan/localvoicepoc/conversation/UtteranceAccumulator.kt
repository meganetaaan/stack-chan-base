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
    private val preRoll = ArrayDeque<ByteArray>()
    private var utterance = ByteArrayOutputStream()
    private var started = false
    private var speechMs = 0
    private var silenceMs = 0
    private var totalMs = 0

    val isCapturing: Boolean
        get() = started

    fun accept(chunk: ByteArray, speech: Boolean): ByteArray? {
        if (!started) {
            preRoll.addLast(chunk.copyOf())
            while (preRoll.size * chunkDurationMs > preRollMs) preRoll.removeFirst()
            if (!speech) return null

            started = true
            preRoll.forEach { buffered -> utterance.write(buffered) }
            speechMs = chunkDurationMs
            totalMs = preRoll.size * chunkDurationMs
            silenceMs = 0
            preRoll.clear()
            return null
        }

        utterance.write(chunk)
        totalMs += chunkDurationMs
        if (speech) {
            speechMs += chunkDurationMs
            silenceMs = 0
        } else {
            silenceMs += chunkDurationMs
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
        utterance = ByteArrayOutputStream()
        started = false
        speechMs = 0
        silenceMs = 0
        totalMs = 0
    }
}
