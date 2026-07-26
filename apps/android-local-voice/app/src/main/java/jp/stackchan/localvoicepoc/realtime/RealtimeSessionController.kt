package jp.stackchan.localvoicepoc.realtime

import jp.stackchan.localvoicepoc.model.DeviceToolCall
import jp.stackchan.localvoicepoc.model.RemoteToolRegistry
import jp.stackchan.localvoicepoc.model.ToolDefinition
import jp.stackchan.localvoicepoc.model.ToolExecutor
import jp.stackchan.localvoicepoc.serial.StackChanEventDecoder
import jp.stackchan.localvoicepoc.serial.StackChanEventEncoder
import jp.stackchan.localvoicepoc.serial.StackChanCapabilities
import jp.stackchan.localvoicepoc.serial.StackChanFrame
import jp.stackchan.localvoicepoc.serial.StackChanUsbState
import jp.stackchan.localvoicepoc.serial.StackChanUsbTransport
import jp.stackchan.localvoicepoc.serial.hasStackChanCapability
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withContext
import kotlinx.coroutines.Dispatchers
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import java.util.UUID

data class McpServerRequest(
    val serverLabel: String,
    val connectorId: String?,
    val serverUrl: String?,
    val allowedTools: Set<String>?,
    val requireApproval: Boolean,
)

interface McpToolProvider {
    suspend fun listTools(request: McpServerRequest): List<ToolDefinition.Mcp>
    suspend fun execute(call: DeviceToolCall): String
    fun setLifecycleSink(sink: suspend (type: String, serverLabel: String, error: String?) -> Unit) = Unit
    fun close() = Unit
}

class RealtimeSessionController(
    private val transport: StackChanUsbTransport,
    private val registry: RemoteToolRegistry,
    private val mcp: McpToolProvider,
    private val conversationCommands: ConversationCommandHandler,
    private val scope: CoroutineScope,
) : AutoCloseable {
    private data class CachedConversationResult(
        val operation: ConversationOperation,
        val result: ConversationCommandResult,
    )

    private val encoder = StackChanEventEncoder()
    private val decoder = StackChanEventDecoder()
    private val pendingFunctionsLock = Any()
    private val pendingFunctions = mutableMapOf<String, CompletableDeferred<String>>()
    private val conversationResults = LinkedHashMap<String, CachedConversationResult>()
    private var remoteFunctionsAvailable = false
    private var controllerClosed = false
    private var instructionOverlay = ""
    private var remoteDefinitions: List<ToolDefinition> = emptyList()
    private var eventJob: Job? = null
    private var stateJob: Job? = null

    fun start() {
        if (eventJob != null) return
        mcp.setLifecycleSink(::sendMcpLifecycle)
        eventJob = scope.launch {
            transport.frames.collect { frame ->
                if (frame.type == StackChanFrame.Type.EVENT) handleEventFrame(frame)
            }
        }
        stateJob = scope.launch {
            transport.state.collect { state ->
                if (
                    state is StackChanUsbState.Ready &&
                    state.capabilities.hasStackChanCapability(StackChanCapabilities.EVENT)
                ) {
                    if (activateRemoteFunctions()) {
                        try {
                            sendSessionEvent("session.created")
                        } catch (cancelled: CancellationException) {
                            throw cancelled
                        } catch (_: Throwable) {
                            // Keep observing state so a reconnect can announce the next session.
                        }
                    }
                } else {
                    resetSession(
                        if (state is StackChanUsbState.Ready) {
                            "接続先はEVENTに対応していません"
                        } else {
                            "USB接続が切断されました"
                        },
                    )
                }
            }
        }
    }

    val instructions: String get() = instructionOverlay

    private suspend fun handleEventFrame(frame: StackChanFrame) {
        val ready = transport.state.value as? StackChanUsbState.Ready ?: return
        if (!ready.capabilities.hasStackChanCapability(StackChanCapabilities.EVENT)) return
        try {
            decoder.push(frame)?.let { payload ->
                when (val routed = StackChanApplicationEventCodec.route(payload)) {
                    is RoutedStackChanEvent.RawRealtime -> handleRealtimeEvent(routed.value)
                    is RoutedStackChanEvent.Conversation -> handleConversationRequest(routed.request)
                    RoutedStackChanEvent.Malformed,
                    RoutedStackChanEvent.UnsupportedApplication,
                    -> Unit
                }
            }
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            runCatching {
                sendError(null, "invalid_event", error.message ?: "EVENTを解析できません")
            }
        }
    }

    private suspend fun handleRealtimeEvent(root: JsonObject) {
        val eventId = root.string("event_id")
        when (root.requiredString("type")) {
            "session.update" -> applySessionUpdate(root, eventId)
            "conversation.item.create" -> acceptConversationItem(root, eventId)
            "response.create" -> Unit
            else -> sendError(eventId, "invalid_request", "未対応のイベントです")
        }
    }

    private suspend fun handleConversationRequest(request: ConversationRequest) {
        val cached = conversationResults[request.requestId]
        val result = when {
            cached == null -> executeConversationRequest(request).also {
                rememberConversationResult(request, it)
            }
            cached.operation == request.operation -> cached.result
            else -> ConversationCommandResult(
                success = false,
                state = RemoteConversationState.BLOCKED,
                error = "requestIdが異なる会話操作に再利用されました",
            )
        }
        send(StackChanApplicationEventCodec.conversationResult(request.requestId, result))
    }

    private suspend fun executeConversationRequest(request: ConversationRequest): ConversationCommandResult = try {
        when (request.operation) {
            ConversationOperation.START -> conversationCommands.start()
            ConversationOperation.STOP -> conversationCommands.stop()
        }
    } catch (cancelled: CancellationException) {
        throw cancelled
    } catch (error: Throwable) {
        ConversationCommandResult(
            success = false,
            state = RemoteConversationState.BLOCKED,
            error = error.message ?: error::class.java.simpleName,
        )
    }

    private fun rememberConversationResult(request: ConversationRequest, result: ConversationCommandResult) {
        conversationResults[request.requestId] = CachedConversationResult(request.operation, result)
        while (conversationResults.size > CONVERSATION_RESULT_CACHE_SIZE) {
            conversationResults.remove(conversationResults.keys.first())
        }
    }

    private suspend fun applySessionUpdate(root: JsonObject, eventId: String?) {
        runCatching {
            val session = root["session"]?.jsonObject ?: error("sessionがありません")
            val nextInstructions = if ("instructions" in session) {
                session["instructions"]?.jsonPrimitive?.contentOrNull ?: ""
            } else {
                instructionOverlay
            }
            val nextTools = if ("tools" in session) parseTools(session["tools"]!!.jsonArray) else remoteDefinitions
            instructionOverlay = nextInstructions
            remoteDefinitions = nextTools
            registry.installRemoteTools(nextTools, ToolExecutor(::executeRemoteFunction), ToolExecutor(mcp::execute))
        }.onSuccess {
            sendSessionEvent("session.updated", eventId)
        }.onFailure {
            sendError(eventId, "invalid_request", it.message ?: "session.updateを適用できません")
        }
    }

    private suspend fun parseTools(array: JsonArray): List<ToolDefinition> {
        val result = mutableListOf<ToolDefinition>()
        for (element in array) {
            val tool = element.jsonObject
            when (tool.requiredString("type")) {
                "function" -> result += ToolDefinition.Function(
                    name = tool.requiredString("name"),
                    description = tool.string("description").orEmpty(),
                    parameters = tool["parameters"]?.jsonObject ?: emptyObjectSchema(),
                )
                "mcp" -> {
                    val label = tool.requiredString("server_label")
                    val connectorId = tool.string("connector_id")
                    val serverUrl = tool.string("server_url")
                    require((connectorId == null) xor (serverUrl == null)) {
                        "MCPにはconnector_idまたはserver_urlのどちらか一方が必要です"
                    }
                    require(tool["authorization"] == null && tool["headers"] == null) {
                        "認証情報はAndroidのMCPプロファイルに保存してください"
                    }
                    val allowed = tool["allowed_tools"]?.jsonArray
                        ?.mapTo(linkedSetOf()) { it.jsonPrimitive.content }
                    val approval = when (tool.string("require_approval") ?: "always") {
                        "always" -> true
                        "never" -> false
                        else -> error("require_approvalはalwaysまたはneverを指定してください")
                    }
                    sendMcpLifecycle("mcp_list_tools.in_progress", label)
                    val listed = runCatching {
                        mcp.listTools(McpServerRequest(label, connectorId, serverUrl, allowed, approval))
                    }.onFailure {
                        sendMcpLifecycle("mcp_list_tools.failed", label, it.message)
                    }.getOrThrow()
                    result += listed
                    sendMcpLifecycle("mcp_list_tools.completed", label)
                }
                else -> error("未対応のtool typeです")
            }
        }
        return result
    }

    private suspend fun executeRemoteFunction(call: DeviceToolCall): String {
        val callId = UUID.randomUUID().toString()
        val itemId = UUID.randomUUID().toString()
        val responseId = UUID.randomUUID().toString()
        val result = CompletableDeferred<String>()
        synchronized(pendingFunctionsLock) {
            check(remoteFunctionsAvailable && !controllerClosed) {
                "Realtimeセッションは利用できません"
            }
            pendingFunctions[callId] = result
        }
        send(buildJsonObject {
            put("type", "response.output_item.added")
            put("response_id", responseId)
            put("item", buildJsonObject {
                put("id", itemId)
                put("type", "function_call")
                put("call_id", callId)
                put("name", call.name)
                put("arguments", "")
            })
        })
        send(
            buildJsonObject {
                put("type", "response.function_call_arguments.done")
                put("event_id", UUID.randomUUID().toString())
                put("response_id", responseId)
                put("item_id", itemId)
                put("call_id", callId)
                put("name", call.name)
                put("arguments", call.arguments.toString())
            },
        )
        send(buildJsonObject {
            put("type", "response.output_item.done")
            put("response_id", responseId)
            put("item", buildJsonObject {
                put("id", itemId)
                put("type", "function_call")
                put("call_id", callId)
                put("name", call.name)
                put("arguments", call.arguments.toString())
            })
        })
        return try {
            withTimeout(FUNCTION_TIMEOUT_MS) { result.await() }
        } finally {
            synchronized(pendingFunctionsLock) {
                pendingFunctions.remove(callId)
            }
        }
    }

    private suspend fun acceptConversationItem(root: JsonObject, eventId: String?) {
        val item = root["item"]?.jsonObject ?: return sendError(eventId, "invalid_request", "itemがありません")
        if (item.string("type") != "function_call_output") {
            return sendError(eventId, "invalid_request", "function_call_outputが必要です")
        }
        val callId = item.requiredString("call_id")
        val output = item["output"]?.let {
            if (it is JsonPrimitive && it.isString) it.content else it.toString()
        } ?: ""
        val completed = synchronized(pendingFunctionsLock) {
            pendingFunctions[callId]?.complete(output) == true
        }
        if (!completed) {
            return sendError(eventId, "unknown_call_id", "対応するfunction callがありません")
        }
        send(buildJsonObject {
            put("type", "conversation.item.created")
            eventId?.let { put("event_id", it) }
            put("item", item)
        })
    }

    private suspend fun sendSessionEvent(type: String, eventId: String? = null) {
        send(buildJsonObject {
            put("type", type)
            put("event_id", eventId ?: UUID.randomUUID().toString())
            put("session", buildJsonObject {
                put("instructions", instructionOverlay)
                put("tools", buildJsonArray {
                    registry.definitions.forEach { add(toolJson(it)) }
                })
            })
        })
    }

    private fun toolJson(tool: ToolDefinition): JsonObject = buildJsonObject {
        put("type", if (tool is ToolDefinition.Mcp) "mcp_tool" else "function")
        put("name", tool.name)
        put("description", tool.description)
        put("parameters", tool.parameters)
        if (tool is ToolDefinition.Mcp) {
            put("server_label", tool.serverLabel)
            put("mcp_tool_name", tool.toolName)
        }
    }

    private suspend fun sendMcpLifecycle(type: String, label: String, error: String? = null) = send(
        buildJsonObject {
            put("type", type)
            put("server_label", label)
            error?.let { put("error", it) }
        },
    )

    private suspend fun sendError(eventId: String?, code: String, message: String) = send(
        buildJsonObject {
            put("type", "error")
            eventId?.let { put("event_id", it) }
            put("error", buildJsonObject {
                put("type", "invalid_request_error")
                put("code", code)
                put("message", message)
            })
        },
    )

    private suspend fun send(value: JsonObject) {
        val ready = transport.state.value as? StackChanUsbState.Ready ?: return
        if (!ready.capabilities.hasStackChanCapability(StackChanCapabilities.EVENT)) return
        withContext(Dispatchers.IO) {
            encoder.encode(value.toString(), ready.maxPayload).forEach { transport.send(it) }
        }
    }

    private fun activateRemoteFunctions(): Boolean = synchronized(pendingFunctionsLock) {
        if (controllerClosed) {
            false
        } else {
            remoteFunctionsAvailable = true
            true
        }
    }

    private fun resetSession(reason: String, closing: Boolean = false) {
        val functionsToFail = synchronized(pendingFunctionsLock) {
            remoteFunctionsAvailable = false
            if (closing) controllerClosed = true
            pendingFunctions.values.toList().also { pendingFunctions.clear() }
        }
        functionsToFail.forEach { it.completeExceptionally(IllegalStateException(reason)) }
        decoder.reset()
        instructionOverlay = ""
        remoteDefinitions = emptyList()
        registry.clearRemoteTools()
        mcp.close()
    }

    override fun close() {
        eventJob?.cancel()
        stateJob?.cancel()
        resetSession("セッションを終了しました", closing = true)
        conversationResults.clear()
    }

    private fun JsonObject.string(name: String): String? = this[name]?.jsonPrimitive?.contentOrNull
    private fun JsonObject.requiredString(name: String): String = string(name) ?: error("${name}がありません")
    private fun emptyObjectSchema() = buildJsonObject {
        put("type", "object")
        put("properties", JsonObject(emptyMap()))
    }

    private companion object {
        const val FUNCTION_TIMEOUT_MS = 30_000L
        const val CONVERSATION_RESULT_CACHE_SIZE = 64
    }
}
