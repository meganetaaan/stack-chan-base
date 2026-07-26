package jp.stackchan.localvoicepoc.serial

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class StackChanNegotiationContractTest {
    private val fixture by lazy {
        val input = checkNotNull(javaClass.classLoader?.getResourceAsStream("negotiation-vectors.json")) {
            "Shared USB negotiation vectors are missing"
        }
        input.bufferedReader().use { reader ->
            Json.parseToJsonElement(reader.readText()).jsonObject
        }
    }

    @Test
    fun matchesSharedHelloPayloadsAndCapabilityBits() {
        assertEquals("stackchan.usb-cdc.negotiation-vectors.v1", fixture.string("schema"))
        assertEquals(2, fixture.getValue("protocolVersion").jsonPrimitive.int)
        val bits = fixture.getValue("capabilityBits").jsonObject
        assertEquals(StackChanCapabilities.EVENT, bits.getValue("event").jsonPrimitive.int)
        assertEquals(StackChanCapabilities.STATUS_EXTENDED, bits.getValue("statusExtended").jsonPrimitive.int)

        fixture.getValue("helloPayloads").jsonArray.forEach { element ->
            val vector = element.jsonObject
            val expected = vector.string("payloadHex").hexToBytes()
            assertArrayEquals(
                vector.string("name"),
                expected,
                helloPayload(
                    maxPayload = vector.getValue("maxPayload").jsonPrimitive.int,
                    capabilities = vector.getValue("capabilities").jsonPrimitive.int,
                ),
            )
            if (vector.string("name") == "android-dock-all") {
                assertEquals(StackChanCapabilities.ALL, vector.getValue("capabilities").jsonPrimitive.int)
                assertArrayEquals(expected, helloPayload())
            }
        }
    }

    @Test
    fun exhaustsAllEventNegotiationCombinations() {
        val cases = fixture.getValue("eventNegotiation").jsonArray.map { it.jsonObject }
        assertEquals(4, cases.size)
        assertEquals(
            setOf(false to false, false to true, true to false, true to true),
            cases.mapTo(mutableSetOf()) {
                it.boolean("dockAdvertisesEvent") to it.boolean("firmwareAdvertisesEvent")
            },
        )

        cases.forEach { vector ->
            val dock = vector.boolean("dockAdvertisesEvent")
            val firmware = vector.boolean("firmwareAdvertisesEvent")
            val expected = vector.getValue("expected").jsonObject
            val dockCapabilities = if (dock) StackChanCapabilities.EVENT else 0
            val firmwareCapabilities = if (firmware) StackChanCapabilities.EVENT else 0

            assertEquals(
                expected.boolean("dockMaySendEvent"),
                firmwareCapabilities.hasStackChanCapability(StackChanCapabilities.EVENT),
            )
            assertEquals(
                expected.boolean("firmwareMaySendEvent"),
                dockCapabilities.hasStackChanCapability(StackChanCapabilities.EVENT),
            )
            assertEquals(
                expected.boolean("conversationControlAvailable"),
                canUseBidirectionalStackChanEvents(dockCapabilities, firmwareCapabilities),
            )
        }

        assertTrue(
            "one-sided EVENT advertisement must remain a negative control for OR-based negotiation",
            cases.any {
                val dock = it.boolean("dockAdvertisesEvent")
                val firmware = it.boolean("firmwareAdvertisesEvent")
                (dock || firmware) != it.getValue("expected").jsonObject.boolean("conversationControlAvailable")
            },
        )
    }

    @Test
    fun checksBothExtendedStatusNegotiationOutcomes() {
        val cases = fixture.getValue("extendedStatusNegotiation").jsonArray.map { it.jsonObject }
        assertEquals(2, cases.size)
        cases.forEach { vector ->
            val advertised = vector.boolean("firmwareAdvertisesStatusExtended")
            val capabilities = if (advertised) StackChanCapabilities.STATUS_EXTENDED else 0
            assertEquals(
                vector.boolean("expectedDockMaySendExtendedStatus"),
                capabilities.hasStackChanCapability(StackChanCapabilities.STATUS_EXTENDED),
            )
        }
        assertTrue(cases.any { it.boolean("firmwareAdvertisesStatusExtended") })
        assertFalse(cases.all { it.boolean("firmwareAdvertisesStatusExtended") })
    }

    private fun kotlinx.serialization.json.JsonObject.string(name: String): String =
        getValue(name).jsonPrimitive.content

    private fun kotlinx.serialization.json.JsonObject.boolean(name: String): Boolean =
        getValue(name).jsonPrimitive.boolean

    private fun String.hexToBytes(): ByteArray {
        require(length % 2 == 0)
        return chunked(2).map { it.toInt(16).toByte() }.toByteArray()
    }
}
