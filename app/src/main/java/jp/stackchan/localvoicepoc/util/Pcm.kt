package jp.stackchan.localvoicepoc.util

import kotlin.math.sqrt

object Pcm {
    fun floatSamples16Le(bytes: ByteArray): FloatArray {
        val samples = FloatArray(bytes.size / 2)
        for (sampleIndex in samples.indices) {
            val byteIndex = sampleIndex * 2
            val low = bytes[byteIndex].toInt() and 0xff
            val high = bytes[byteIndex + 1].toInt()
            samples[sampleIndex] = ((high shl 8) or low).toShort() / 32768f
        }
        return samples
    }

    fun rms16Le(bytes: ByteArray): Float {
        if (bytes.size < 2) return 0f
        var sum = 0.0
        var count = 0
        var index = 0
        while (index + 1 < bytes.size) {
            val low = bytes[index].toInt() and 0xff
            val high = bytes[index + 1].toInt()
            val sample = ((high shl 8) or low).toShort().toInt()
            val normalized = sample / 32768.0
            sum += normalized * normalized
            count += 1
            index += 2
        }
        return if (count == 0) 0f else sqrt(sum / count).toFloat()
    }
}
