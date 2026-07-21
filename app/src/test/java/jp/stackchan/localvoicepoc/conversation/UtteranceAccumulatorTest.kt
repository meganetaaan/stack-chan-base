package jp.stackchan.localvoicepoc.conversation

import org.junit.Assert.assertNotNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

class UtteranceAccumulatorTest {
    @Test
    fun usesActualTwentyMillisecondFrameDurations() {
        val accumulator = UtteranceAccumulator()
        val frame = ByteArray(640)

        repeat(18) { assertNull(accumulator.accept(frame, true, durationMs = 20)) }
        repeat(39) { assertNull(accumulator.accept(frame, false, durationMs = 20)) }
        val utterance = accumulator.accept(frame, false, durationMs = 20)

        assertNotNull(utterance)
        assertEquals(58 * frame.size, utterance?.size)
    }

    @Test
    fun rejectsAnEightyMillisecondImpulseFromTwentyMillisecondFrames() {
        val accumulator = UtteranceAccumulator()
        val frame = ByteArray(640)

        repeat(4) { assertNull(accumulator.accept(frame, true, durationMs = 20)) }
        repeat(40) { assertNull(accumulator.accept(frame, false, durationMs = 20)) }

        assertFalse(accumulator.isCapturing)
    }

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
