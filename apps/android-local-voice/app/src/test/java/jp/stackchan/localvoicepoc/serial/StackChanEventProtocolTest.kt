package jp.stackchan.localvoicepoc.serial

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class StackChanEventProtocolTest {
    @Test
    fun roundTripsFragmentedUtf8Event() {
        val source = "{\"type\":\"session.update\",\"instructions\":\"こんにちは\"}"
        val frames = StackChanEventEncoder().encode(source, maxPayload = 7)
        val decoder = StackChanEventDecoder()

        frames.dropLast(1).forEach { assertNull(decoder.push(it)) }
        assertEquals(source, decoder.push(frames.last()))
        assertEquals(StackChanFrame.Type.EVENT, frames.first().type)
        assertEquals(StackChanEventFlags.START, frames.first().flags)
        assertEquals(StackChanEventFlags.END, frames.last().flags)
    }

    @Test
    fun rejectsMissingChunk() {
        val frames = StackChanEventEncoder().encode("x".repeat(30), maxPayload = 10)
        val decoder = StackChanEventDecoder()
        decoder.push(frames[0])

        assertThrows(IllegalArgumentException::class.java) { decoder.push(frames[2]) }
        assertThrows(IllegalStateException::class.java) { decoder.push(frames[2]) }
    }

    @Test
    fun rejectsOversizedEvent() {
        assertThrows(IllegalArgumentException::class.java) {
            StackChanEventEncoder().encode("x".repeat(StackChanEventEncoder.MAX_EVENT_BYTES + 1), 4096)
        }
    }
}
