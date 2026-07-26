package jp.stackchan.localvoicepoc.serial

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class StackChanContractVectorTest {
    private val vectors by lazy {
        val input = checkNotNull(javaClass.classLoader?.getResourceAsStream("test-vectors.json")) {
            "Shared USB contract vectors are missing"
        }
        input.bufferedReader().use { reader ->
            Json.parseToJsonElement(reader.readText()).jsonObject
        }
    }

    @Test
    fun matchesSharedValidFrameVectors() {
        assertEquals("stackchan.usb-cdc.test-vectors.v1", vectors.getValue("schema").jsonPrimitive.content)
        assertEquals(2, vectors.getValue("protocolVersion").jsonPrimitive.int)

        for (entry in vectors.getValue("validFrames").jsonArray) {
            val vector = entry.jsonObject
            val name = vector.getValue("name").jsonPrimitive.content
            val fields = vector.getValue("frame").jsonObject
            val frame = StackChanFrame(
                type = StackChanFrame.Type.fromWire(fields.getValue("type").jsonPrimitive.int),
                flags = fields.getValue("flags").jsonPrimitive.int,
                streamId = fields.getValue("streamId").jsonPrimitive.int,
                sequence = fields.getValue("sequence").jsonPrimitive.int,
                sampleRate = fields.getValue("sampleRate").jsonPrimitive.int,
                payload = fields.getValue("payloadHex").jsonPrimitive.content.hexToBytes(),
            )
            val expectedBytes = vector.getValue("encodedHex").jsonPrimitive.content.hexToBytes()
            val encoded = StackChanFrameCodec.encode(frame)
            assertArrayEquals("$name encoded bytes", expectedBytes, encoded)

            val decoded = StackChanFrameCodec.decode(expectedBytes)
            assertEquals("$name type", frame.type, decoded.type)
            assertEquals("$name flags", frame.flags, decoded.flags)
            assertEquals("$name stream ID", frame.streamId, decoded.streamId)
            assertEquals("$name sequence", frame.sequence, decoded.sequence)
            assertEquals("$name sample rate", frame.sampleRate, decoded.sampleRate)
            assertArrayEquals("$name payload", frame.payload, decoded.payload)
        }
    }

    @Test
    fun rejectsSharedInvalidFramesAndResynchronizes() {
        val invalidVectors = vectors.getValue("invalidFrames").jsonArray.map { it.jsonObject }
        invalidVectors.forEach { invalid ->
            val reason = invalid.getValue("reason").jsonPrimitive.content
            val invalidBytes = invalid.getValue("encodedHex").jsonPrimitive.content.hexToBytes()
            when (reason) {
                "crc_mismatch" -> assertThrows(IllegalArgumentException::class.java) {
                    StackChanFrameCodec.decode(invalidBytes)
                }
                else -> throw AssertionError("Unsupported invalid frame reason: $reason")
            }
        }

        val invalid = invalidVectors.single {
            it.getValue("reason").jsonPrimitive.content == "crc_mismatch"
        }
        val invalidBytes = invalid.getValue("encodedHex").jsonPrimitive.content.hexToBytes()
        val valid = vectors.getValue("validFrames").jsonArray.first().jsonObject
        val validBytes = valid.getValue("encodedHex").jsonPrimitive.content.hexToBytes()
        val decoded = StackChanFrameStreamParser().push(invalidBytes + validBytes)
        assertEquals(1, decoded.size)
        assertArrayEquals(validBytes, StackChanFrameCodec.encode(decoded.single()))
    }

    private fun String.hexToBytes(): ByteArray {
        require(length % 2 == 0) { "Hex string must contain whole bytes" }
        return chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    }
}
