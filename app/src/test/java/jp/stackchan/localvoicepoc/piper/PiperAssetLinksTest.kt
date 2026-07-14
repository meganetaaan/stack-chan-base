package jp.stackchan.localvoicepoc.piper

import org.junit.Assert.assertEquals
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

    @Test
    fun recommendedAssetsArePinnedWithIntegrityMetadata() {
        assertEquals(39_652_717L, PiperAssetLinks.MODEL.expectedBytes)
        assertEquals(
            "5289e9b6eaf21080803b7fe1c4dc85b5491d4c216121207a41df18dd5f68e5d7",
            PiperAssetLinks.MODEL.sha256,
        )
        assertEquals(6_901L, PiperAssetLinks.CONFIG.expectedBytes)
        assertEquals(
            "516058f405ec914140f34832a9d8bb5d8272ba62af9bc7ffb29349715a539780",
            PiperAssetLinks.CONFIG.sha256,
        )
        assertEquals(32_461_242L, PiperAssetLinks.DICTIONARY_ARCHIVE.expectedBytes)
        assertEquals(
            "d8b6237a546d996a65009bd88f2eb845fad876505952cce98eb3fedaf99fa3d7",
            PiperAssetLinks.DICTIONARY_ARCHIVE.sha256,
        )
        assertEquals(
            PiperAssetLinks.recommendedDownloads.sumOf { it.expectedBytes },
            PiperAssetLinks.recommendedDownloadBytes,
        )
        PiperAssetLinks.recommendedDownloads.forEach { artifact ->
            assertEquals(64, artifact.sha256.length)
            assertTrue(artifact.url.startsWith("https://"))
        }
    }
}
