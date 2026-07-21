package jp.stackchan.localvoicepoc.conversation

internal class AdaptiveNoiseGate(
    private val minimumRmsThreshold: Float = 0.0035f,
    private val noiseMultiplier: Float = 2.2f,
    private val calibrationChunkCount: Int = 15,
) {
    private var noiseFloor = INITIAL_NOISE_FLOOR
    private var calibrationChunks = 0
    private var calibrationSum = 0f

    fun reset() {
        noiseFloor = INITIAL_NOISE_FLOOR
        calibrationChunks = 0
        calibrationSum = 0f
    }

    fun isSpeech(rms: Float, webRtcSpeech: Boolean): Boolean {
        if (calibrationChunks < calibrationChunkCount && !webRtcSpeech) {
            calibrationSum += rms
            calibrationChunks += 1
            noiseFloor = calibrationSum / calibrationChunks
            return false
        }

        val energySpeech = rms >= maxOf(minimumRmsThreshold, noiseFloor * noiseMultiplier)
        if (!webRtcSpeech && !energySpeech) {
            noiseFloor = noiseFloor * NOISE_HISTORY_WEIGHT + rms * (1f - NOISE_HISTORY_WEIGHT)
        }
        return webRtcSpeech || energySpeech
    }

    private companion object {
        const val INITIAL_NOISE_FLOOR = 0.0015f
        const val NOISE_HISTORY_WEIGHT = 0.95f
    }
}
