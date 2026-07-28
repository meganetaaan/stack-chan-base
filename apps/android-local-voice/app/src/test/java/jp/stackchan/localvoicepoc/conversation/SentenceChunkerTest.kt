package jp.stackchan.localvoicepoc.conversation

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SentenceChunkerTest {
    @Test
    fun emitsCompleteJapaneseSentencesAcrossTokenBoundaries() {
        val chunker = SentenceChunker()
        assertEquals(emptyList<String>(), chunker.push("こんにちは"))
        assertEquals(listOf("こんにちは。"), chunker.push("。今日は"))
        assertEquals(listOf("今日は元気ですか？"), chunker.push("元気ですか？"))
        assertNull(chunker.flush())
    }

    @Test
    fun flushesRemainder() {
        val chunker = SentenceChunker()
        chunker.push("短い返答")
        assertEquals("短い返答", chunker.flush())
    }
}
