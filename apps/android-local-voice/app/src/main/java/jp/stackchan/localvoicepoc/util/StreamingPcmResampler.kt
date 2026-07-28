package jp.stackchan.localvoicepoc.util

class StreamingPcmResampler(
    private val sourceSampleRate: Int,
    private val targetSampleRate: Int,
) {
    private var phase = 0L
    private var previousSample: Short? = null

    init {
        require(sourceSampleRate > 0) { "Source sample rate must be positive" }
        require(targetSampleRate > 0) { "Target sample rate must be positive" }
    }

    fun process(input: ShortArray): ShortArray {
        if (input.isEmpty()) return ShortArray(0)
        if (sourceSampleRate == targetSampleRate) return input.copyOf()

        var inputStart = 0
        var previous = previousSample
        if (previous == null) {
            previous = input[0]
            inputStart = 1
        }
        val available = input.size - inputStart
        val inputEnd = available.toLong() * targetSampleRate
        val capacity = ((available.toLong() * targetSampleRate + sourceSampleRate - 1) / sourceSampleRate).toInt()
        val output = ShortArray(capacity)
        var outputCount = 0
        while (phase < inputEnd) {
            val inputIndex = (phase / targetSampleRate).toInt()
            val fraction = phase % targetSampleRate
            val first = if (inputIndex == 0) previous.toInt() else input[inputStart + inputIndex - 1].toInt()
            val second = input[inputStart + inputIndex].toInt()
            var interpolated = first.toLong() * (targetSampleRate - fraction) + second.toLong() * fraction
            interpolated += if (interpolated >= 0) targetSampleRate / 2 else -(targetSampleRate / 2)
            output[outputCount++] = (interpolated / targetSampleRate)
                .toInt()
                .coerceIn(Short.MIN_VALUE.toInt(), Short.MAX_VALUE.toInt())
                .toShort()
            phase += sourceSampleRate
        }
        phase -= inputEnd
        previousSample = input.last()
        return output.copyOf(outputCount)
    }

    fun reset() {
        phase = 0
        previousSample = null
    }
}
