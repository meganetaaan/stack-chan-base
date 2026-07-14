package jp.stackchan.localvoicepoc.conversation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class TranscriptionSanitizerTest {
    @Test
    fun rejectsNonSpeechCaptions() {
        assertNull(
            TranscriptionSanitizer.sanitize(
                "(clicking) (scissors snipping) (scissors snipping)",
            ),
        )
        assertNull(TranscriptionSanitizer.sanitize("[MUSIC]"))
    }

    @Test
    fun preservesSpeechAndRemovesTrailingCaption() {
        assertEquals(
            "こんにちは",
            TranscriptionSanitizer.sanitize("  こんにちは   (background noise) "),
        )
        assertEquals("Hello", TranscriptionSanitizer.sanitize("Hello"))
    }
}
