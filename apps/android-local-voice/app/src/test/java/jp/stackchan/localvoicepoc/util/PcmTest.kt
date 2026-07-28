package jp.stackchan.localvoicepoc.util

import org.junit.Assert.assertArrayEquals
import org.junit.Test

class PcmTest {
    @Test
    fun convertsLittleEndianPcm16ToNormalizedFloats() {
        val pcm = byteArrayOf(
            0x00, 0x80.toByte(),
            0x00, 0x00,
            0xff.toByte(), 0x7f,
            0x7f,
        )

        assertArrayEquals(
            floatArrayOf(-1f, 0f, 32_767f / 32_768f),
            Pcm.floatSamples16Le(pcm),
            0.000_001f,
        )
    }
}
