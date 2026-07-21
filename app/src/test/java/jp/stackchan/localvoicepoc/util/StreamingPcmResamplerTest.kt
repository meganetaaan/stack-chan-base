package jp.stackchan.localvoicepoc.util

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test

class StreamingPcmResamplerTest {
    @Test
    fun convertsSixteenKilohertzToTwentyFourKilohertz() {
        val output = StreamingPcmResampler(16_000, 24_000)
            .process(shortArrayOf(0, 1_000, 2_000, 3_000))
        assertArrayEquals(shortArrayOf(0, 667, 1_333, 2_000, 2_667), output)
    }

    @Test
    fun preservesPhaseAcrossPiperChunks() {
        val input = ShortArray(101) { (it * 173 - 8_000).toShort() }
        val whole = StreamingPcmResampler(22_050, 24_000).process(input)
        val streaming = StreamingPcmResampler(22_050, 24_000)
        val chunked = streaming.process(input.copyOfRange(0, 37)) +
            streaming.process(input.copyOfRange(37, 78)) +
            streaming.process(input.copyOfRange(78, input.size))
        assertArrayEquals(whole, chunked)
        assertEquals(109, chunked.size)
    }

    @Test
    fun copiesSamplesWhenRateAlreadyMatchesCoreS3() {
        val input = shortArrayOf(Short.MIN_VALUE, -1, 0, 1, Short.MAX_VALUE)
        assertArrayEquals(input, StreamingPcmResampler(24_000, 24_000).process(input))
    }
}
