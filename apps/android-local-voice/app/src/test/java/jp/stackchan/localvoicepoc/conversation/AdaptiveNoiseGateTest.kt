package jp.stackchan.localvoicepoc.conversation

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AdaptiveNoiseGateTest {
    @Test
    fun calibrationConvergesToSteadyAmbientNoiseInsteadOfItsMinimum() {
        val gate = AdaptiveNoiseGate()

        assertFalse(gate.isSpeech(rms = 0.001f, webRtcSpeech = false))
        repeat(14) {
            assertFalse(gate.isSpeech(rms = 0.010f, webRtcSpeech = false))
        }

        assertFalse("steady ambient noise must remain below the adaptive gate", gate.isSpeech(0.012f, false))
        assertTrue("a clear energy increase must pass the adaptive gate", gate.isSpeech(0.030f, false))
    }
}
