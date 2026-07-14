package jp.stackchan.localvoicepoc.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class GemmaModelManifestTest {
    @Test
    fun modelArtifactsArePinnedAndHaveIntegrityMetadata() {
        assertEquals(listOf("E2B", "E4B"), GemmaModelManifest.all.map { it.variant })
        assertEquals(GemmaModelManifest.E2B, GemmaModelManifest.default)
        assertEquals(
            GemmaModelManifest.all.size,
            GemmaModelManifest.all.map { it.id }.distinct().size,
        )
        GemmaModelManifest.all.forEach { model ->
            assertTrue(model.downloadUrl.startsWith("https://"))
            assertTrue(model.downloadUrl.contains("/resolve/${model.revision}/"))
            assertTrue(model.fileName.endsWith(".litertlm"))
            assertEquals(40, model.revision.length)
            assertEquals(64, model.sha256.length)
            assertTrue(model.sha256.all { it in '0'..'9' || it in 'a'..'f' })
            assertTrue(model.expectedBytes > 0L)
        }
        assertEquals("LiteRT-LM 0.14.0", GemmaModelManifest.RUNTIME)
        assertEquals("litertlm", GemmaModelManifest.FORMAT)
        assertEquals(2_048, GemmaModelManifest.DEFAULT_MAX_CONTEXT_TOKENS)
    }

    @Test
    fun e2bMetadataMatchesPublishedArtifact() {
        assertEquals("a4a831c060880f3733135ad22f10e0e9f758f45d", GemmaModelManifest.E2B.revision)
        assertEquals("gemma-4-E2B-it.litertlm", GemmaModelManifest.E2B.fileName)
        assertEquals(2_588_147_712L, GemmaModelManifest.E2B.expectedBytes)
        assertEquals(
            "181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c",
            GemmaModelManifest.E2B.sha256,
        )
    }

    @Test
    fun e4bMetadataMatchesPublishedArtifact() {
        assertEquals("f7ad3343bd6ebc9607f4dc3bc4f2398bd5749bc5", GemmaModelManifest.E4B.revision)
        assertEquals("gemma-4-E4B-it.litertlm", GemmaModelManifest.E4B.fileName)
        assertEquals(3_659_530_240L, GemmaModelManifest.E4B.expectedBytes)
        assertEquals(
            "0b2a8980ce155fd97673d8e820b4d29d9c7d99b8fa6806f425d969b145bd52e0",
            GemmaModelManifest.E4B.sha256,
        )
    }
}
