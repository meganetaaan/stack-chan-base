package jp.stackchan.localvoicepoc.serial

import java.io.ByteArrayOutputStream
import java.util.concurrent.atomic.AtomicInteger

object StackChanEventFlags {
    const val START = 1
    const val END = 1 shl 1
}

class StackChanEventEncoder(
    private val nextMessageId: AtomicInteger = AtomicInteger(0),
) {
    fun encode(json: String, maxPayload: Int): List<StackChanFrame> {
        require(maxPayload in 1..StackChanFrameCodec.MAX_PAYLOAD_BYTES)
        val bytes = json.encodeToByteArray()
        require(bytes.size <= MAX_EVENT_BYTES) { "Event is too large" }
        val messageId = nextMessageId.updateAndGet { if (it >= 0xffff) 1 else it + 1 }
        if (bytes.isEmpty()) {
            return listOf(eventFrame(messageId, 0, StackChanEventFlags.START or StackChanEventFlags.END, bytes))
        }
        return bytes.asList().chunked(maxPayload).mapIndexed { index, part ->
            val flags = (if (index == 0) StackChanEventFlags.START else 0) or
                (if ((index + 1) * maxPayload >= bytes.size) StackChanEventFlags.END else 0)
            eventFrame(messageId, index, flags, part.toByteArray())
        }
    }

    private fun eventFrame(messageId: Int, sequence: Int, flags: Int, payload: ByteArray) = StackChanFrame(
        type = StackChanFrame.Type.EVENT,
        streamId = messageId,
        sequence = sequence,
        flags = flags,
        payload = payload,
    )

    companion object {
        const val MAX_EVENT_BYTES = 64 * 1024
    }
}

class StackChanEventDecoder {
    private data class Pending(val nextSequence: Int, val bytes: ByteArrayOutputStream)

    private val pending = mutableMapOf<Int, Pending>()

    fun push(frame: StackChanFrame): String? {
        require(frame.type == StackChanFrame.Type.EVENT)
        require(frame.streamId != 0) { "Event stream ID must not be zero" }
        val starts = frame.flags and StackChanEventFlags.START != 0
        val ends = frame.flags and StackChanEventFlags.END != 0
        val state = if (starts) {
            require(frame.sequence == 0) { "First event chunk must have sequence zero" }
            Pending(0, ByteArrayOutputStream()).also { pending[frame.streamId] = it }
        } else {
            pending[frame.streamId] ?: error("Event continuation has no start chunk")
        }
        require(frame.sequence == state.nextSequence) { "Event chunk sequence mismatch" }
        require(state.bytes.size() + frame.payload.size <= StackChanEventEncoder.MAX_EVENT_BYTES) {
            "Event is too large"
        }
        state.bytes.write(frame.payload)
        pending[frame.streamId] = state.copy(nextSequence = state.nextSequence + 1)
        if (!ends) return null
        pending.remove(frame.streamId)
        return state.bytes.toByteArray().decodeToString(throwOnInvalidSequence = true)
    }

    fun reset() = pending.clear()
}
