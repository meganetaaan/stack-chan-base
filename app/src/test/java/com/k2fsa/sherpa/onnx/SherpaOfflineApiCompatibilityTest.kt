package com.k2fsa.sherpa.onnx

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class SherpaOfflineApiCompatibilityTest {
    @Test
    fun `offline result JNI method returns recognizer result directly`() {
        val getResult = OfflineRecognizer::class.java.getDeclaredMethod(
            "getResult",
            Long::class.javaPrimitiveType,
        )

        assertEquals(OfflineRecognizerResult::class.java, getResult.returnType)
    }

    @Test
    fun `qnn config fields required by bundled JNI are present`() {
        val expectedType = QnnConfig::class.java

        assertEquals(
            expectedType,
            OfflineTransducerModelConfig::class.java.getDeclaredField("qnnConfig").type,
        )
        assertEquals(
            expectedType,
            OfflineParaformerModelConfig::class.java.getDeclaredField("qnnConfig").type,
        )
    }

    @Test
    fun `offline model fields required by bundled JNI are present`() {
        val expectedFields = setOf(
            "medasr",
            "funasrNano",
            "qwen3Asr",
            "fireRedAsrCtc",
            "cohereTranscribe",
        )

        val actualFields = OfflineModelConfig::class.java.declaredFields.map { it.name }.toSet()
        assertTrue(actualFields.containsAll(expectedFields))
        assertEquals(
            Boolean::class.javaPrimitiveType,
            OfflineWhisperModelConfig::class.java
                .getDeclaredField("enableTokenTimestamps")
                .type,
        )
        assertEquals(
            Boolean::class.javaPrimitiveType,
            OfflineWhisperModelConfig::class.java
                .getDeclaredField("enableSegmentTimestamps")
                .type,
        )
    }
}
