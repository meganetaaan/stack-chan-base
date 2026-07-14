package jp.stackchan.localvoicepoc.conversation

import org.junit.Assert.assertNotNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class UtteranceAccumulatorTest {
    @Test
    fun emitsAfterMinimumSpeechAndTrailingSilence() {
        val accumulator = UtteranceAccumulator(
            chunkDurationMs = 100,
            preRollMs = 200,
            endSilenceMs = 300,
            minimumSpeechMs = 200,
            maximumUtteranceMs = 2_000,
        )
        val quiet = ByteArray(8)
        val voice = ByteArray(8) { 1 }

        assertNull(accumulator.accept(quiet, false))
        assertNull(accumulator.accept(voice, true))
        assertNull(accumulator.accept(voice, true))
        assertNull(accumulator.accept(quiet, false))
        assertNull(accumulator.accept(quiet, false))
        assertNotNull(accumulator.accept(quiet, false))
    }

    @Test
    fun discardsShortImpulseAfterTrailingSilence() {
        val accumulator = UtteranceAccumulator(
            chunkDurationMs = 100,
            preRollMs = 200,
            endSilenceMs = 300,
            minimumSpeechMs = 200,
            maximumUtteranceMs = 2_000,
        )
        val quiet = ByteArray(8)
        val impulse = ByteArray(8) { 1 }

        assertNull(accumulator.accept(impulse, true))
        assertNull(accumulator.accept(quiet, false))
        assertNull(accumulator.accept(quiet, false))
        assertNull(accumulator.accept(quiet, false))
        assertFalse(accumulator.isCapturing)

        assertNull(accumulator.accept(quiet, false))
    }

    @Test
    fun discardsShortImpulseAtMaximumDuration() {
        val accumulator = UtteranceAccumulator(
            chunkDurationMs = 100,
            preRollMs = 0,
            endSilenceMs = 5_000,
            minimumSpeechMs = 200,
            maximumUtteranceMs = 400,
        )
        val quiet = ByteArray(8)
        val impulse = ByteArray(8) { 1 }

        assertNull(accumulator.accept(impulse, true))
        repeat(4) { assertNull(accumulator.accept(quiet, false)) }
        assertFalse(accumulator.isCapturing)
    }
}
