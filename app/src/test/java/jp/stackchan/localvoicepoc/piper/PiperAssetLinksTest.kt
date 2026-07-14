package jp.stackchan.localvoicepoc.piper

import org.junit.Assert.assertTrue
import org.junit.Test

class PiperAssetLinksTest {
    @Test
    fun downloadLinksAreHttpsAndVersionPinned() {
        val links = listOf(
            PiperAssetLinks.MODEL_DOWNLOAD_URL,
            PiperAssetLinks.CONFIG_DOWNLOAD_URL,
            PiperAssetLinks.MODEL_LICENSE_URL,
            PiperAssetLinks.DICTIONARY_DOWNLOAD_URL,
        )

        assertTrue(links.all { it.startsWith("https://") })
        assertTrue(PiperAssetLinks.MODEL_DOWNLOAD_URL.contains("/resolve/36b59c825c36"))
        assertTrue(PiperAssetLinks.CONFIG_DOWNLOAD_URL.contains("/resolve/36b59c825c36"))
        assertTrue(PiperAssetLinks.DICTIONARY_DOWNLOAD_URL.contains("/v1.13.0/"))
    }
}
