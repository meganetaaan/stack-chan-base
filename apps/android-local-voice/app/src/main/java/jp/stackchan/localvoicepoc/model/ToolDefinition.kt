package jp.stackchan.localvoicepoc.model

import kotlinx.serialization.json.JsonObject

sealed interface ToolDefinition {
    val name: String
    val description: String
    val parameters: JsonObject

    data class Function(
        override val name: String,
        override val description: String,
        override val parameters: JsonObject,
    ) : ToolDefinition

    data class Mcp(
        val serverLabel: String,
        val toolName: String,
        override val name: String,
        override val description: String,
        override val parameters: JsonObject,
    ) : ToolDefinition
}

data class DeviceToolCall(
    val name: String,
    val arguments: JsonObject = JsonObject(emptyMap()),
)

fun interface ToolExecutor {
    suspend fun execute(call: DeviceToolCall): String
}
