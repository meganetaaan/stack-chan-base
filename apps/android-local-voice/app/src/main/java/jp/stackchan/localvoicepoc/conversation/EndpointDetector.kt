package jp.stackchan.localvoicepoc.conversation

import com.konovalov.vad.webrtc.VadWebRTC
import com.konovalov.vad.webrtc.config.FrameSize
import com.konovalov.vad.webrtc.config.Mode
import com.konovalov.vad.webrtc.config.SampleRate
import jp.stackchan.localvoicepoc.util.Pcm

interface SpeechEndpointDetector : AutoCloseable {
    fun reset()
    fun isSpeech(chunk: ByteArray): Boolean
}

/** Detects speech from 16 kHz, mono, little-endian PCM16 audio. */
class EndpointDetector(
    private val minimumRmsThreshold: Float = 0.0035f,
    private val noiseMultiplier: Float = 2.2f,
) : SpeechEndpointDetector {
    private val vad = VadWebRTC(
        SampleRate.SAMPLE_RATE_16K,
        FrameSize.FRAME_SIZE_320,
        Mode.NORMAL,
        0,
        0,
    )
    private val frame = ShortArray(FRAME_SAMPLES)
    private val noiseGate = AdaptiveNoiseGate(minimumRmsThreshold, noiseMultiplier)

    override fun reset() {
        noiseGate.reset()
    }

    override fun isSpeech(chunk: ByteArray): Boolean {
        val webRtcSpeech = detectWithWebRtc(chunk)
        val rms = Pcm.rms16Le(chunk)

        return noiseGate.isSpeech(rms, webRtcSpeech)
    }

    override fun close() {
        vad.close()
    }

    private fun detectWithWebRtc(chunk: ByteArray): Boolean {
        var speech = false
        var byteOffset = 0
        while (byteOffset + FRAME_BYTES <= chunk.size) {
            for (sampleIndex in frame.indices) {
                val low = chunk[byteOffset + sampleIndex * 2].toInt() and 0xff
                val high = chunk[byteOffset + sampleIndex * 2 + 1].toInt()
                frame[sampleIndex] = ((high shl 8) or low).toShort()
            }
            speech = vad.isSpeech(frame) || speech
            byteOffset += FRAME_BYTES
        }
        return speech
    }

    private companion object {
        const val FRAME_SAMPLES = 320 // 20 ms at 16 kHz; a valid WebRTC VAD frame.
        const val FRAME_BYTES = FRAME_SAMPLES * 2
    }
}
