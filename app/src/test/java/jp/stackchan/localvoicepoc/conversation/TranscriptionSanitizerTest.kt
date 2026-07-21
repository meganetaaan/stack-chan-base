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
        assertNull(TranscriptionSanitizer.sanitize("("))
        assertNull(TranscriptionSanitizer.sanitize("(音楽"))
        assertNull(TranscriptionSanitizer.sanitize("（ノイズ"))
    }

    @Test
    fun preservesSpeechAndRemovesTrailingCaption() {
        assertEquals(
            "こんにちは",
            TranscriptionSanitizer.sanitize("  こんにちは   (background noise) "),
        )
        assertEquals("Hello", TranscriptionSanitizer.sanitize("Hello"))
        assertEquals("音楽について教えて", TranscriptionSanitizer.sanitize("音楽について教えて"))
    }
}
