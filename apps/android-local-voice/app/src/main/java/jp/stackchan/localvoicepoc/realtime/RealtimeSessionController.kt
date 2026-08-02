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
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
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

internal const val CONVERSATION_RESULT_RETENTION_MS = 10_000L

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
    private val monotonicTimeMilliseconds: () -> Long = { System.nanoTime() / 1_000_000L },
) : AutoCloseable {
    private data class CachedConversationResult(
        val operation: ConversationOperation,
        val result: ConversationCommandResult,
        val retainedUntilMilliseconds: Long,
    )

    private class ProviderGenerationLease(
        val id: String,
        val session: JsonObject,
    ) {
        val operations = linkedSetOf<Job>()
        lateinit var announcement: JsonObject
        var announcementJob: Job? = null
    }

    private class ProviderGenerationRetiredCancellation(reason: String) : CancellationException(reason)

    private data class PendingFunction(
        val providerGeneration: ProviderGenerationLease,
        val result: CompletableDeferred<String>,
    )

    private data class RetiredProviderWork(
        val functions: List<CompletableDeferred<String>>,
        val operations: List<Job>,
        val announcementJob: Job?,
    )

    private val encoder = StackChanEventEncoder()
    private val decoder = StackChanEventDecoder()
    private val decoderLock = Any()
    private val pendingFunctionsLock = Any()
    private val providerTransitionMutex = Mutex()
    private val pendingFunctions = mutableMapOf<String, PendingFunction>()
    private val providerUpdateHistory = mutableMapOf<String, JsonObject>()
    private val conversationResults = LinkedHashMap<String, CachedConversationResult>()
    private var remoteFunctionsAvailable = false
    private var providerGeneration: ProviderGenerationLease? = null
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
            synchronized(decoderLock) { decoder.push(frame) }?.let { payload ->
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
        val cached = cachedConversationResult(request.requestId)
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

    private fun cachedConversationResult(requestId: String): CachedConversationResult? =
        synchronized(pendingFunctionsLock) {
            removeExpiredConversationResults(monotonicTimeMilliseconds())
            conversationResults[requestId]
        }

    private fun rememberConversationResult(request: ConversationRequest, result: ConversationCommandResult) {
        synchronized(pendingFunctionsLock) {
            if (controllerClosed) return
            val now = monotonicTimeMilliseconds()
            removeExpiredConversationResults(now)
            conversationResults[request.requestId] = CachedConversationResult(
                operation = request.operation,
                result = result,
                retainedUntilMilliseconds = now + CONVERSATION_RESULT_RETENTION_MS,
            )
        }
    }

    private fun removeExpiredConversationResults(nowMilliseconds: Long) {
        val iterator = conversationResults.entries.iterator()
        while (iterator.hasNext()) {
            if (iterator.next().value.retainedUntilMilliseconds < nowMilliseconds) {
                iterator.remove()
            }
        }
    }

    private suspend fun applySessionUpdate(root: JsonObject, eventId: String?) {
        try {
            val nextProviderGeneration = requireNotNull(eventId) { "session.updateにはevent_idが必要です" }
            val session = root["session"]?.jsonObject ?: error("sessionがありません")
            val knownSession = synchronized(pendingFunctionsLock) {
                providerUpdateHistory[nextProviderGeneration]
            }
            if (knownSession != null) {
                require(knownSession == session) {
                    "同じevent_idを異なるsession.updateに再利用できません"
                }
                val current = synchronized(pendingFunctionsLock) {
                    providerGeneration?.takeIf { it.id == nextProviderGeneration }
                }
                if (current != null) {
                    announceProviderGeneration(current)
                } else {
                    sendError(eventId, "stale_event_id", "provider世代はすでに終了しました")
                }
                return
            }
            val nextInstructions = if ("instructions" in session) {
                session["instructions"]?.jsonPrimitive?.contentOrNull ?: ""
            } else {
                instructionOverlay
            }
            val nextTools = if ("tools" in session) parseTools(session["tools"]!!.jsonArray) else remoteDefinitions
            val nextLease = ProviderGenerationLease(nextProviderGeneration, session)
            providerTransitionMutex.withLock {
                val retired = synchronized(pendingFunctionsLock) {
                    check(remoteFunctionsAvailable && !controllerClosed) {
                        "Realtimeセッションは利用できません"
                    }
                    registry.installRemoteTools(
                        nextTools,
                        ToolExecutor { call -> executeRemoteFunction(call, nextLease) },
                        ToolExecutor { call -> executeMcp(call, nextLease) },
                    )
                    instructionOverlay = nextInstructions
                    remoteDefinitions = nextTools
                    nextLease.announcement = sessionEvent(
                        type = "session.updated",
                        eventId = nextProviderGeneration,
                        instructions = nextInstructions,
                        definitions = registry.definitions,
                    )
                    retireProviderGenerationLocked().also {
                        providerGeneration = nextLease
                        providerUpdateHistory[nextProviderGeneration] = session
                    }
                }
                cancelRetiredProviderWork(retired, "ツール設定が更新されました")
            }
            announceProviderGeneration(nextLease)
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (error: Throwable) {
            sendError(eventId, "invalid_request", error.message ?: "session.updateを適用できません")
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

    private suspend fun executeRemoteFunction(
        call: DeviceToolCall,
        expectedProviderGeneration: ProviderGenerationLease,
    ): String = withProviderOperation(expectedProviderGeneration) {
        val callId = UUID.randomUUID().toString()
        val itemId = UUID.randomUUID().toString()
        val responseId = UUID.randomUUID().toString()
        val result = CompletableDeferred<String>()
        val pending = PendingFunction(expectedProviderGeneration, result)
        try {
            providerTransitionMutex.withLock {
                synchronized(pendingFunctionsLock) {
                    requireCurrentProviderGeneration(expectedProviderGeneration)
                    pendingFunctions[callId] = pending
                }
                send(buildJsonObject {
                    put("type", "response.output_item.added")
                    put("response_id", responseId)
                    put("stackchan_session_update_id", expectedProviderGeneration.id)
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
                        put("stackchan_session_update_id", expectedProviderGeneration.id)
                    },
                )
                send(buildJsonObject {
                    put("type", "response.output_item.done")
                    put("response_id", responseId)
                    put("stackchan_session_update_id", expectedProviderGeneration.id)
                    put("item", buildJsonObject {
                        put("id", itemId)
                        put("type", "function_call")
                        put("call_id", callId)
                        put("name", call.name)
                        put("arguments", call.arguments.toString())
                    })
                })
            }
            withTimeout(FUNCTION_TIMEOUT_MS) { result.await() }
        } finally {
            synchronized(pendingFunctionsLock) {
                if (pendingFunctions[callId] === pending) pendingFunctions.remove(callId)
            }
        }
    }

    private suspend fun executeMcp(
        call: DeviceToolCall,
        expectedProviderGeneration: ProviderGenerationLease,
    ): String = withProviderOperation(expectedProviderGeneration) { mcp.execute(call) }

    private suspend fun <Result> withProviderOperation(
        expectedProviderGeneration: ProviderGenerationLease,
        operation: suspend () -> Result,
    ): Result = try {
        coroutineScope {
            val operationJob = requireNotNull(currentCoroutineContext()[Job])
            synchronized(pendingFunctionsLock) {
                requireCurrentProviderGeneration(expectedProviderGeneration)
                expectedProviderGeneration.operations += operationJob
            }
            try {
                operation()
            } finally {
                synchronized(pendingFunctionsLock) {
                    expectedProviderGeneration.operations -= operationJob
                }
            }
        }
    } catch (retired: ProviderGenerationRetiredCancellation) {
        throw IllegalStateException(retired.message ?: "Realtime provider世代は終了しました", retired)
    }

    private fun requireCurrentProviderGeneration(expectedProviderGeneration: ProviderGenerationLease) {
        check(
            remoteFunctionsAvailable &&
                !controllerClosed &&
                providerGeneration === expectedProviderGeneration,
        ) {
            "Realtime provider世代は終了しました"
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
            val pending = pendingFunctions[callId]
            pending != null &&
                pending.providerGeneration === providerGeneration &&
                pending.result.complete(output)
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

    private fun announceProviderGeneration(generation: ProviderGenerationLease) {
        lateinit var announcementJob: Job
        announcementJob = scope.launch(start = CoroutineStart.LAZY) {
            try {
                var retryDelayMilliseconds = PROVIDER_ANNOUNCEMENT_RETRY_MS
                while (
                    synchronized(pendingFunctionsLock) {
                        providerGeneration === generation && remoteFunctionsAvailable && !controllerClosed
                    }
                ) {
                    try {
                        if (send(generation.announcement)) return@launch
                    } catch (cancelled: CancellationException) {
                        throw cancelled
                    } catch (_: Throwable) {
                        // Retry the acknowledgement while this provider generation owns the session.
                    }
                    delay(retryDelayMilliseconds)
                    retryDelayMilliseconds = (retryDelayMilliseconds * 2)
                        .coerceAtMost(PROVIDER_ANNOUNCEMENT_MAX_RETRY_MS)
                }
            } finally {
                synchronized(pendingFunctionsLock) {
                    if (generation.announcementJob === announcementJob) {
                        generation.announcementJob = null
                    }
                }
            }
        }
        val shouldStart = synchronized(pendingFunctionsLock) {
            if (providerGeneration !== generation || !remoteFunctionsAvailable || controllerClosed) {
                false
            } else {
                generation.announcementJob?.cancel(CancellationException("provider世代を再通知します"))
                generation.announcementJob = announcementJob
                true
            }
        }
        if (shouldStart) {
            announcementJob.start()
        } else {
            announcementJob.cancel()
        }
    }

    private suspend fun sendSessionEvent(type: String, eventId: String? = null) {
        send(sessionEvent(
            type = type,
            eventId = eventId ?: UUID.randomUUID().toString(),
            instructions = instructionOverlay,
            definitions = registry.definitions,
        ))
    }

    private fun sessionEvent(
        type: String,
        eventId: String,
        instructions: String,
        definitions: List<ToolDefinition>,
    ): JsonObject = buildJsonObject {
            put("type", type)
            put("event_id", eventId)
            put("session", buildJsonObject {
                put("instructions", instructions)
                put("tools", buildJsonArray {
                    definitions.forEach { add(toolJson(it)) }
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

    private suspend fun sendMcpLifecycle(type: String, label: String, error: String? = null) {
        send(buildJsonObject {
            put("type", type)
            put("server_label", label)
            error?.let { put("error", it) }
        })
    }

    private suspend fun sendError(eventId: String?, code: String, message: String) {
        send(buildJsonObject {
            put("type", "error")
            eventId?.let { put("event_id", it) }
            put("error", buildJsonObject {
                put("type", "invalid_request_error")
                put("code", code)
                put("message", message)
            })
        })
    }

    private suspend fun send(value: JsonObject): Boolean {
        if (synchronized(pendingFunctionsLock) { controllerClosed }) return false
        val ready = transport.state.value as? StackChanUsbState.Ready ?: return false
        if (!ready.capabilities.hasStackChanCapability(StackChanCapabilities.EVENT)) return false
        withContext(Dispatchers.IO) {
            encoder.encode(value.toString(), ready.maxPayload).forEach { transport.send(it) }
        }
        return true
    }

    private fun activateRemoteFunctions(): Boolean = synchronized(pendingFunctionsLock) {
        if (controllerClosed) {
            false
        } else {
            remoteFunctionsAvailable = true
            true
        }
    }

    private fun retireProviderGenerationLocked(): RetiredProviderWork {
        val generation = providerGeneration
        providerGeneration = null
        val functions = pendingFunctions.values.map(PendingFunction::result).also { pendingFunctions.clear() }
        val operations = generation?.operations?.toList().orEmpty()
        generation?.operations?.clear()
        val announcementJob = generation?.announcementJob
        if (generation != null) generation.announcementJob = null
        return RetiredProviderWork(functions, operations, announcementJob)
    }

    private fun cancelRetiredProviderWork(work: RetiredProviderWork, reason: String) {
        val failure = IllegalStateException(reason)
        work.functions.forEach { it.completeExceptionally(failure) }
        val cancellation = ProviderGenerationRetiredCancellation(reason)
        work.operations.forEach { it.cancel(cancellation) }
        work.announcementJob?.cancel(cancellation)
    }

    private suspend fun resetSession(reason: String) {
        providerTransitionMutex.withLock {
            resetSessionState(reason, closing = false)
        }
    }

    private fun resetSessionState(reason: String, closing: Boolean) {
        val retired = synchronized(pendingFunctionsLock) {
            remoteFunctionsAvailable = false
            if (closing) {
                controllerClosed = true
                conversationResults.clear()
            }
            providerUpdateHistory.clear()
            instructionOverlay = ""
            remoteDefinitions = emptyList()
            registry.clearRemoteTools()
            retireProviderGenerationLocked()
        }
        cancelRetiredProviderWork(retired, reason)
        synchronized(decoderLock) { decoder.reset() }
        mcp.close()
    }

    override fun close() {
        eventJob?.cancel()
        stateJob?.cancel()
        resetSessionState("セッションを終了しました", closing = true)
    }

    private fun JsonObject.string(name: String): String? = this[name]?.jsonPrimitive?.contentOrNull
    private fun JsonObject.requiredString(name: String): String = string(name) ?: error("${name}がありません")
    private fun emptyObjectSchema() = buildJsonObject {
        put("type", "object")
        put("properties", JsonObject(emptyMap()))
    }

    private companion object {
        const val FUNCTION_TIMEOUT_MS = 30_000L
        const val PROVIDER_ANNOUNCEMENT_RETRY_MS = 100L
        const val PROVIDER_ANNOUNCEMENT_MAX_RETRY_MS = 2_000L
    }
}
