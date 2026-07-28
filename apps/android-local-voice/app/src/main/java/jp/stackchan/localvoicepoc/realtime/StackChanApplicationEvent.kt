package jp.stackchan.localvoicepoc.realtime

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put

const val STACKCHAN_EVENT_SCHEMA = "stackchan.event.v1"

enum class RemoteConversationState(val wireValue: String) {
    STANDBY("standby"),
    CONNECTING("connecting"),
    LISTENING("listening"),
    RECOGNIZING("recognizing"),
    SPEAKING("speaking"),
    BLOCKED("blocked"),
}

enum class ConversationOperation {
    START,
    STOP,
}

data class ConversationRequest(
    val operation: ConversationOperation,
    val requestId: String,
)

data class ConversationCommandResult(
    val success: Boolean,
    val state: RemoteConversationState,
    val error: String? = null,
)

interface ConversationCommandHandler {
    suspend fun start(): ConversationCommandResult
    suspend fun stop(): ConversationCommandResult
}

sealed interface RoutedStackChanEvent {
    data class RawRealtime(val value: JsonObject) : RoutedStackChanEvent
    data class Conversation(val request: ConversationRequest) : RoutedStackChanEvent
    data object UnsupportedApplication : RoutedStackChanEvent
    data object Malformed : RoutedStackChanEvent
}

object StackChanApplicationEventCodec {
    private val json = Json { ignoreUnknownKeys = true }

    fun route(serialized: String): RoutedStackChanEvent {
        val root = runCatching { json.parseToJsonElement(serialized).jsonObject }.getOrNull()
            ?: return RoutedStackChanEvent.Malformed
        if ("schema" !in root) return RoutedStackChanEvent.RawRealtime(root)
        if (root.string("schema") != STACKCHAN_EVENT_SCHEMA) {
            return RoutedStackChanEvent.UnsupportedApplication
        }
        val requestId = root.string("requestId")
            ?.takeIf(String::isNotEmpty)
            ?: return RoutedStackChanEvent.UnsupportedApplication
        val operation = when (root.string("type")) {
            "conversation.start" -> {
                if (root.string("source") != "headTouch" || root.string("gesture") != "forwardSwipe") {
                    return RoutedStackChanEvent.UnsupportedApplication
                }
                ConversationOperation.START
            }
            "conversation.stop" -> {
                if (root.string("source") != "headTouch" || root.string("gesture") != "backwardSwipe") {
                    return RoutedStackChanEvent.UnsupportedApplication
                }
                ConversationOperation.STOP
            }
            else -> return RoutedStackChanEvent.UnsupportedApplication
        }
        return RoutedStackChanEvent.Conversation(ConversationRequest(operation, requestId))
    }

    fun conversationResult(requestId: String, result: ConversationCommandResult): JsonObject = buildJsonObject {
        put("schema", STACKCHAN_EVENT_SCHEMA)
        put("type", "conversation.result")
        put("requestId", requestId)
        put("success", result.success)
        put("state", result.state.wireValue)
        result.error?.let { put("error", it) }
    }

    private fun JsonObject.string(name: String): String? {
        val value = this[name] as? JsonPrimitive ?: return null
        if (!value.isString) return null
        return value.jsonPrimitive.contentOrNull
    }
}
