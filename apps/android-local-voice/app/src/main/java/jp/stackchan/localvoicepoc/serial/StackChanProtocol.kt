package jp.stackchan.localvoicepoc.serial

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger

enum class StackChanErrorCode(val wireValue: Int, val description: String) {
    INVALID_REQUEST(1, "要求形式が不正です"),
    INVALID_STREAM_DATA(2, "音声streamデータが不正です"),
    TRANSPORT_OVERFLOW(3, "USB送信キューがあふれました"),
    AUDIO_OUTPUT(4, "AudioOutでエラーが発生しました"),
    BUSY(5, "別の音声streamを処理中です"),
    SPEAKER_SEQUENCE_MISMATCH(6, "PCM sequenceが欠落しました"),
    SPEAKER_BUFFER_OVERFLOW(7, "PCM受信バッファがあふれました"),
    CAPTION_QUEUE_OVERFLOW(8, "字幕キューがあふれました");

    companion object {
        fun descriptionFor(wireValue: Int): String =
            entries.firstOrNull { it.wireValue == wireValue }?.description ?: "不明なエラーです"
    }
}

class StackChanRemoteException(
    val errorCode: Int,
    val streamId: Int = 0,
) : IOException(
    "CoreS3がエラーを返しました。" +
        "code=$errorCode (${StackChanErrorCode.descriptionFor(errorCode)}), stream=$streamId",
)

enum class StackChanControl(val wireValue: Int) {
    HELLO(1), HELLO_ACK(2), ERROR(3),
    MIC_START(16), MIC_STARTED(17), MIC_STOP(18), MIC_STOPPED(19),
    SPEAKER_START(32), SPEAKER_CREDIT(33), SPEAKER_END(34), SPEAKER_DONE(35), SPEAKER_ABORT(36),
    SPEAKER_TEXT(37), STATUS(48);

    companion object {
        fun fromWire(value: Int): StackChanControl? = entries.firstOrNull { it.wireValue == value }
    }
}

object StackChanCapabilities {
    const val MICROPHONE_PCM = 1 shl 0
    const val SPEAKER_PCM = 1 shl 1
    const val SPEAKER_CREDIT = 1 shl 2
    const val SPEAKER_RATE_8000 = 1 shl 3
    const val SPEAKER_RATE_16000 = 1 shl 4
    const val SPEAKER_RATE_24000 = 1 shl 5
    const val SPEAKER_TEXT = 1 shl 6
    const val STATUS_ICON = 1 shl 8
    const val STREAM_ID = 1 shl 9
    const val REQUIRED = MICROPHONE_PCM or SPEAKER_PCM or SPEAKER_CREDIT or SPEAKER_RATE_24000 or STREAM_ID
    const val ALL = REQUIRED or SPEAKER_RATE_8000 or SPEAKER_RATE_16000 or SPEAKER_TEXT or STATUS_ICON or STREAM_ID
}

internal object StackChanStreamIdAllocator {
    private val lastId = AtomicInteger(0)

    fun next(): Int = lastId.updateAndGet { current -> if (current >= 0xffff) 1 else current + 1 }
}

enum class StackChanStatus(val wireValue: Int) {
    IDLE(0),
    RECOGNIZING(1),
    SPEAKING(2),
}

fun helloPayload(maxPayload: Int = StackChanFrameCodec.MAX_PAYLOAD_BYTES): ByteArray =
    ByteBuffer.allocate(8).order(ByteOrder.LITTLE_ENDIAN)
        .putInt(maxPayload)
        .putInt(StackChanCapabilities.ALL)
        .array()

fun parseHelloPayload(payload: ByteArray): Pair<Int, Int> {
    require(payload.size == 8) { "Invalid HELLO payload" }
    val buffer = ByteBuffer.wrap(payload).order(ByteOrder.LITTLE_ENDIAN)
    return buffer.int to buffer.int
}

fun uint32Payload(value: Int): ByteArray =
    ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN).putInt(value).array()

fun parseUint32Payload(payload: ByteArray): Int {
    require(payload.size == 4) { "Expected a four-byte payload" }
    return ByteBuffer.wrap(payload).order(ByteOrder.LITTLE_ENDIAN).int
}

class StackChanFrameStreamParser {
    private var pending = ByteArray(0)

    fun push(chunk: ByteArray): List<StackChanFrame> {
        if (chunk.isEmpty()) return emptyList()
        pending += chunk
        val result = mutableListOf<StackChanFrame>()
        val minimum = StackChanFrameCodec.HEADER_BYTES + StackChanFrameCodec.CRC_BYTES
        while (pending.size >= minimum) {
            val magic = findMagic(pending)
            if (magic < 0) {
                pending = pending.takeLast(1).toByteArray()
                break
            }
            if (magic > 0) pending = pending.copyOfRange(magic, pending.size)
            if (pending.size < minimum) break
            val payloadLength = ByteBuffer.wrap(pending, 16, 4).order(ByteOrder.LITTLE_ENDIAN).int
            if (payloadLength !in 0..StackChanFrameCodec.MAX_PAYLOAD_BYTES) {
                pending = pending.copyOfRange(1, pending.size)
                continue
            }
            val frameLength = StackChanFrameCodec.HEADER_BYTES + payloadLength + StackChanFrameCodec.CRC_BYTES
            if (pending.size < frameLength) break
            val candidate = pending.copyOfRange(0, frameLength)
            val decoded = runCatching { StackChanFrameCodec.decode(candidate) }.getOrNull()
            if (decoded == null) {
                pending = pending.copyOfRange(1, pending.size)
            } else {
                result += decoded
                pending = pending.copyOfRange(frameLength, pending.size)
            }
        }
        return result
    }

    fun reset() {
        pending = ByteArray(0)
    }

    private fun findMagic(bytes: ByteArray): Int {
        for (index in 0 until bytes.lastIndex) {
            if (bytes[index] == 0x43.toByte() && bytes[index + 1] == 0x53.toByte()) return index
        }
        return -1
    }
}
