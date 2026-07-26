package jp.stackchan.localvoicepoc.realtime

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.boolean
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class StackChanApplicationEventTest {
    private val fixture by lazy {
        val input = checkNotNull(javaClass.classLoader?.getResourceAsStream("application-event-vectors.json")) {
            "Shared application event vectors are missing"
        }
        input.bufferedReader().use { reader ->
            Json.parseToJsonElement(reader.readText()).jsonObject
        }
    }

    @Test
    fun matchesEverySharedApplicationEventRoute() {
        assertEquals("stackchan.application-event.vectors.v1", fixture.getValue("schema").jsonPrimitive.content)
        assertEquals(STACKCHAN_EVENT_SCHEMA, fixture.getValue("applicationSchema").jsonPrimitive.content)

        fixture.getValue("vectors").jsonArray.forEach { element ->
            val vector = element.jsonObject
            val actual = when (StackChanApplicationEventCodec.route(vector.getValue("value").toString())) {
                is RoutedStackChanEvent.Conversation -> "conversation"
                is RoutedStackChanEvent.RawRealtime -> "raw"
                RoutedStackChanEvent.UnsupportedApplication -> "unsupported"
                RoutedStackChanEvent.Malformed -> "malformed"
            }
            assertEquals(
                vector.getValue("name").jsonPrimitive.content,
                vector.getValue("androidRoute").jsonPrimitive.content,
                actual,
            )
        }
    }

    @Test
    fun routesRawRealtimeSeparatelyFromConversationRequests() {
        assertTrue(
            StackChanApplicationEventCodec.route("""{"type":"session.update"}""") is
                RoutedStackChanEvent.RawRealtime,
        )
        assertEquals(
            RoutedStackChanEvent.Conversation(
                ConversationRequest(ConversationOperation.START, "start-1"),
            ),
            StackChanApplicationEventCodec.route(
                """{"schema":"stackchan.event.v1","type":"conversation.start","requestId":"start-1","source":"headTouch","gesture":"forwardSwipe"}""",
            ),
        )
        assertEquals(
            RoutedStackChanEvent.Conversation(
                ConversationRequest(ConversationOperation.STOP, "stop-1"),
            ),
            StackChanApplicationEventCodec.route(
                """{"schema":"stackchan.event.v1","type":"conversation.stop","requestId":"stop-1","source":"headTouch","gesture":"backwardSwipe"}""",
            ),
        )
    }

    @Test
    fun neverFallsBackToRealtimeForUnknownOrMalformedApplicationEvents() {
        val unsupported = listOf(
            """{"schema":"stackchan.event.v1","type":"unknown","requestId":"1"}""",
            """{"schema":"stackchan.event.v1","type":"conversation.start","requestId":"1","source":"headTouch","gesture":"backwardSwipe"}""",
            """{"schema":"future.event.v2","type":"session.update"}""",
        )

        unsupported.forEach {
            assertEquals(RoutedStackChanEvent.UnsupportedApplication, StackChanApplicationEventCodec.route(it))
        }
        assertEquals(RoutedStackChanEvent.Malformed, StackChanApplicationEventCodec.route("{"))
    }

    @Test
    fun createsAContractShapedConversationResult() {
        val result = StackChanApplicationEventCodec.conversationResult(
            "request-1",
            ConversationCommandResult(false, RemoteConversationState.BLOCKED, "not ready"),
        )

        assertEquals(STACKCHAN_EVENT_SCHEMA, result.getValue("schema").jsonPrimitive.content)
        assertEquals("conversation.result", result.getValue("type").jsonPrimitive.content)
        assertEquals("request-1", result.getValue("requestId").jsonPrimitive.content)
        assertEquals(false, result.getValue("success").jsonPrimitive.boolean)
        assertEquals("blocked", result.getValue("state").jsonPrimitive.content)
        assertEquals("not ready", result.getValue("error").jsonPrimitive.content)
    }
}
