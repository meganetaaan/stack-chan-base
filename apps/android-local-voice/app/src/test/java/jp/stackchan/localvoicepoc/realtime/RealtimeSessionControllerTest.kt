package jp.stackchan.localvoicepoc.realtime

import jp.stackchan.localvoicepoc.model.DeviceToolCall
import jp.stackchan.localvoicepoc.model.RemoteToolRegistry
import jp.stackchan.localvoicepoc.model.ToolDefinition
import jp.stackchan.localvoicepoc.model.ToolExecutor
import jp.stackchan.localvoicepoc.serial.StackChanCapabilities
import jp.stackchan.localvoicepoc.serial.StackChanControl
import jp.stackchan.localvoicepoc.serial.StackChanEventDecoder
import jp.stackchan.localvoicepoc.serial.StackChanEventEncoder
import jp.stackchan.localvoicepoc.serial.StackChanFrame
import jp.stackchan.localvoicepoc.serial.StackChanUsbState
import jp.stackchan.localvoicepoc.serial.StackChanUsbTransport
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.yield
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException
import java.util.Collections
import java.util.concurrent.atomic.AtomicLong

class RealtimeSessionControllerTest {
    @Test
    fun announcesTheRealtimeSessionOnlyWhenEventWasNegotiated() = runBlocking {
        val supported = FakeUsbTransport(StackChanCapabilities.ALL)
        val unsupported = FakeUsbTransport(StackChanCapabilities.REQUIRED)
        val supportedController = controller(supported, FakeConversationCommands(), this)
        val unsupportedController = controller(unsupported, FakeConversationCommands(), this)

        supportedController.start()
        unsupportedController.start()
        await { supported.payloads().any { it.type() == "session.created" } }
        delay(20)

        assertTrue(unsupported.payloads().isEmpty())
        supportedController.close()
        unsupportedController.close()
    }

    @Test
    fun conversationRequestsAreIdempotentAndRejectRequestIdReuse() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL)
        val commands = FakeConversationCommands()
        val controller = controller(transport, commands, this)
        controller.start()
        await { transport.payloads().any { it.type() == "session.created" } }
        transport.clearSent()

        transport.receive(startRequest("same"))
        await { transport.conversationResults().size == 1 }
        transport.receive(startRequest("same"))
        await { transport.conversationResults().size == 2 }
        transport.receive(stopRequest("same"))
        await { transport.conversationResults().size == 3 }

        assertEquals(1, commands.startCalls)
        assertEquals(0, commands.stopCalls)
        assertEquals(
            transport.conversationResults()[0],
            transport.conversationResults()[1],
        )
        assertEquals(false, transport.conversationResults()[2].getValue("success").jsonPrimitive.content.toBoolean())
        assertTrue(transport.conversationResults()[2].getValue("error").jsonPrimitive.content.contains("再利用"))
        controller.close()
    }

    @Test
    fun returnsResultsForBothStartAndStopRequests() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL)
        val commands = FakeConversationCommands()
        val controller = controller(transport, commands, this)
        controller.start()
        await { transport.payloads().any { it.type() == "session.created" } }
        transport.clearSent()

        transport.receive(startRequest("start"))
        await { transport.conversationResults().size == 1 }
        transport.receive(stopRequest("stop"))
        await { transport.conversationResults().size == 2 }

        val results = transport.conversationResults()
        assertEquals(1, commands.startCalls)
        assertEquals(1, commands.stopCalls)
        assertEquals("start", results[0].getValue("requestId").jsonPrimitive.content)
        assertEquals("true", results[0].getValue("success").jsonPrimitive.content)
        assertEquals("connecting", results[0].getValue("state").jsonPrimitive.content)
        assertEquals("stop", results[1].getValue("requestId").jsonPrimitive.content)
        assertEquals("true", results[1].getValue("success").jsonPrimitive.content)
        assertEquals("standby", results[1].getValue("state").jsonPrimitive.content)
        controller.close()
    }

    @Test
    fun cachesTheResultBeforeAWriteFailureAndRetriesWithoutRepeatingTheOperation() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL)
        val commands = FakeConversationCommands()
        val controller = controller(transport, commands, this)
        controller.start()
        await { transport.payloads().any { it.type() == "session.created" } }
        transport.clearSent()
        transport.failNextWrites = 1

        transport.receive(startRequest("retry"))
        await { commands.startCalls == 1 }
        transport.receive(startRequest("retry"))
        await { transport.conversationResults().size == 1 }

        assertEquals(1, commands.startCalls)
        assertEquals("retry", transport.conversationResults().single().getValue("requestId").jsonPrimitive.content)
        controller.close()
    }

    @Test
    fun aFailedSessionAnnouncementDoesNotStopReconnectObservation() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL)
        val registry = FakeRegistry()
        val controller = controller(transport, FakeConversationCommands(), this, registry)
        transport.failNextWrites = 1
        controller.start()
        withTimeout(500) { transport.failedWriteAttempted.await() }

        transport.changeState(StackChanUsbState.Disconnected)
        await { registry.clearCalls > 0 }
        transport.changeState(StackChanUsbState.Ready(4_096, StackChanCapabilities.ALL))
        await { transport.payloads().any { it.type() == "session.created" } }

        controller.close()
    }

    @Test
    fun malformedAndUnknownApplicationEventsDoNotKillRawRealtimeHandling() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL)
        val controller = controller(transport, FakeConversationCommands(), this)
        controller.start()
        await { transport.payloads().any { it.type() == "session.created" } }

        transport.receive("{")
        transport.receive("""{"schema":"stackchan.event.v1","type":"unknown","requestId":"bad"}""")
        transport.receive(
            """{"type":"session.update","event_id":"raw-1","session":{"instructions":"updated","tools":[]}}""",
        )
        await { controller.instructions == "updated" }

        assertEquals("updated", controller.instructions)
        controller.close()
    }

    @Test
    fun disconnectFailsRegisteredAndLateRemoteFunctionCallsWithoutWaitingForTimeout() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL)
        val registry = FakeRegistry()
        val controller = controller(
            transport = transport,
            commands = FakeConversationCommands(),
            scope = this,
            registry = registry,
        )
        controller.start()
        await { transport.payloads().any { it.type() == "session.created" } }
        transport.receive(
            """{"type":"session.update","event_id":"tools","session":{"tools":[{"type":"function","name":"remote","description":"","parameters":{"type":"object","properties":{}}}]}}""",
        )
        await {
            transport.payloads().any {
                it.type() == "session.updated" && it["event_id"]?.jsonPrimitive?.content == "tools"
            }
        }
        val executor = requireNotNull(registry.functionExecutor)

        val registered = async {
            runCatching { executor.execute(DeviceToolCall("remote")) }.exceptionOrNull()
        }
        await {
            transport.payloads().any { it.type() == "response.function_call_arguments.done" }
        }
        transport.changeState(StackChanUsbState.Disconnected)
        await { registry.clearCalls > 0 }

        val registeredFailure = withTimeout(500) { registered.await() }
        val late = async {
            runCatching { executor.execute(DeviceToolCall("remote")) }.exceptionOrNull()
        }
        val lateFailure = withTimeout(500) { late.await() }

        assertTrue(registeredFailure is IllegalStateException)
        assertTrue(lateFailure is IllegalStateException)
        controller.close()
    }

    @Test
    fun rejectsToolCallsFromAResponseThatStartedBeforeTheProviderUpdate() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL)
        val registry = FakeRegistry()
        val controller = controller(
            transport = transport,
            commands = FakeConversationCommands(),
            scope = this,
            registry = registry,
        )
        controller.start()
        await { transport.payloads().any { it.type() == "session.created" } }

        transport.receive(remoteToolUpdate("provider-a"))
        await {
            transport.payloads().any {
                it.type() == "session.updated" && it["event_id"]?.jsonPrimitive?.content == "provider-a"
            }
        }
        val retiredExecutor = requireNotNull(registry.functionExecutor)

        transport.receive(remoteToolUpdate("provider-b"))
        await {
            transport.payloads().any {
                it.type() == "session.updated" && it["event_id"]?.jsonPrimitive?.content == "provider-b"
            }
        }
        val currentExecutor = requireNotNull(registry.functionExecutor)
        transport.clearSent()

        val retiredFailure = runCatching {
            retiredExecutor.execute(DeviceToolCall("remote"))
        }.exceptionOrNull()
        assertTrue(retiredFailure is IllegalStateException)
        assertTrue(transport.payloads().none { it.type() == "response.function_call_arguments.done" })

        val currentResult = async { currentExecutor.execute(DeviceToolCall("remote")) }
        await {
            transport.payloads().any { it.type() == "response.function_call_arguments.done" }
        }
        val functionCall = transport.payloads().last { it.type() == "response.function_call_arguments.done" }
        assertEquals("provider-b", functionCall.getValue("stackchan_session_update_id").jsonPrimitive.content)
        val callId = functionCall.getValue("call_id").jsonPrimitive.content
        transport.receive(
            """{"type":"conversation.item.create","event_id":"output","item":{"type":"function_call_output","call_id":"$callId","output":"current"}}""",
        )

        assertEquals("current", withTimeout(500) { currentResult.await() })
        controller.close()
    }

    @Test
    fun retriesTheActiveProviderAnnouncementAfterAWriteFailure() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL)
        val registry = FakeRegistry()
        val controller = controller(
            transport = transport,
            commands = FakeConversationCommands(),
            scope = this,
            registry = registry,
        )
        controller.start()
        await { transport.payloads().any { it.type() == "session.created" } }
        transport.clearSent()
        transport.failNextWrites = 1

        transport.receive(remoteToolUpdate("provider-a"))
        withTimeout(500) { transport.failedWriteAttempted.await() }
        val executor = requireNotNull(registry.functionExecutor)
        await {
            transport.payloads().any {
                it.type() == "session.updated" && it["event_id"]?.jsonPrimitive?.content == "provider-a"
            }
        }
        transport.clearSent()

        val result = async { executor.execute(DeviceToolCall("remote")) }
        await { transport.payloads().any { it.type() == "response.function_call_arguments.done" } }
        val callId = transport.payloads()
            .last { it.type() == "response.function_call_arguments.done" }
            .getValue("call_id").jsonPrimitive.content
        transport.receive(
            """{"type":"conversation.item.create","event_id":"output","item":{"type":"function_call_output","call_id":"$callId","output":"recovered"}}""",
        )

        assertEquals("recovered", withTimeout(500) { result.await() })
        controller.close()
    }

    @Test
    fun retriesTheCurrentUpdateIdempotentlyAndRejectsARetiredUpdateId() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL)
        val registry = FakeRegistry()
        val controller = controller(
            transport = transport,
            commands = FakeConversationCommands(),
            scope = this,
            registry = registry,
        )
        controller.start()
        await { transport.payloads().any { it.type() == "session.created" } }

        transport.receive(remoteToolUpdate("provider-a"))
        await {
            transport.payloads().any {
                it.type() == "session.updated" && it["event_id"]?.jsonPrimitive?.content == "provider-a"
            }
        }
        val providerAExecutor = requireNotNull(registry.functionExecutor)
        transport.clearSent()

        transport.receive(remoteToolUpdate("provider-a"))
        await {
            transport.payloads().any {
                it.type() == "session.updated" && it["event_id"]?.jsonPrimitive?.content == "provider-a"
            }
        }
        assertTrue(providerAExecutor === registry.functionExecutor)

        transport.receive(remoteToolUpdate("provider-b"))
        await {
            transport.payloads().any {
                it.type() == "session.updated" && it["event_id"]?.jsonPrimitive?.content == "provider-b"
            }
        }
        val providerBExecutor = requireNotNull(registry.functionExecutor)
        transport.clearSent()

        transport.receive(remoteToolUpdate("provider-a"))
        await {
            transport.payloads().any {
                it.type() == "error" && it["event_id"]?.jsonPrimitive?.content == "provider-a"
            }
        }

        assertTrue(providerBExecutor === registry.functionExecutor)
        assertTrue(
            transport.payloads().none {
                it.type() == "session.updated" && it["event_id"]?.jsonPrimitive?.content == "provider-a"
            },
        )
        controller.close()
    }

    @Test
    fun serializesAProviderUpdateAfterAnAlreadyStartedFunctionEmission() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL)
        val registry = FakeRegistry()
        val controller = controller(
            transport = transport,
            commands = FakeConversationCommands(),
            scope = this,
            registry = registry,
        )
        controller.start()
        await { transport.payloads().any { it.type() == "session.created" } }
        transport.receive(remoteToolUpdate("provider-a"))
        await {
            transport.payloads().any {
                it.type() == "session.updated" && it["event_id"]?.jsonPrimitive?.content == "provider-a"
            }
        }
        val retiredExecutor = requireNotNull(registry.functionExecutor)
        transport.clearSent()
        transport.blockNextWrite()

        val retiredResult = async {
            runCatching { retiredExecutor.execute(DeviceToolCall("remote")) }.exceptionOrNull()
        }
        withTimeout(500) { transport.blockedWriteAttempted.await() }
        transport.receive(remoteToolUpdate("provider-b"))
        delay(20)
        assertTrue(
            transport.payloads().none {
                it.type() == "session.updated" && it["event_id"]?.jsonPrimitive?.content == "provider-b"
            },
        )

        transport.releaseBlockedWrite()
        await {
            transport.payloads().any {
                it.type() == "session.updated" && it["event_id"]?.jsonPrimitive?.content == "provider-b"
            }
        }

        val payloads = transport.payloads()
        val argumentsIndex = payloads.indexOfFirst { it.type() == "response.function_call_arguments.done" }
        val updateIndex = payloads.indexOfFirst {
            it.type() == "session.updated" && it["event_id"]?.jsonPrimitive?.content == "provider-b"
        }
        assertTrue(argumentsIndex >= 0)
        assertTrue(argumentsIndex < updateIndex)
        assertTrue(withTimeout(500) { retiredResult.await() } != null)
        controller.close()
    }

    @Test
    fun cancelsAnMcpOperationWhenItsProviderGenerationIsRetired() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL)
        val registry = FakeRegistry()
        val mcp = BlockingMcp()
        val controller = controller(
            transport = transport,
            commands = FakeConversationCommands(),
            scope = this,
            registry = registry,
            mcp = mcp,
        )
        controller.start()
        await { transport.payloads().any { it.type() == "session.created" } }
        transport.receive(mcpToolUpdate("provider-a"))
        await {
            transport.payloads().any {
                it.type() == "session.updated" && it["event_id"]?.jsonPrimitive?.content == "provider-a"
            }
        }
        val retiredExecutor = requireNotNull(registry.mcpExecutor)

        val retiredResult = async {
            runCatching { retiredExecutor.execute(DeviceToolCall("mcp__test__write")) }.exceptionOrNull()
        }
        withTimeout(500) { mcp.executionStarted.await() }
        transport.receive(
            """{"type":"session.update","event_id":"provider-b","session":{"instructions":"updated"}}""",
        )
        await {
            transport.payloads().any {
                it.type() == "session.updated" && it["event_id"]?.jsonPrimitive?.content == "provider-b"
            }
        }
        mcp.releaseExecution.complete(Unit)

        assertTrue(withTimeout(500) { retiredResult.await() } is IllegalStateException)
        assertEquals(0, mcp.sideEffects)
        val currentExecutor = requireNotNull(registry.mcpExecutor)
        assertEquals("executed", currentExecutor.execute(DeviceToolCall("mcp__test__write")))
        assertEquals(1, mcp.sideEffects)
        controller.close()
    }

    @Test
    fun preservesCallerCancellationForACurrentProviderOperation() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL)
        val registry = FakeRegistry()
        val mcp = BlockingMcp()
        val controller = controller(
            transport = transport,
            commands = FakeConversationCommands(),
            scope = this,
            registry = registry,
            mcp = mcp,
        )
        controller.start()
        await { transport.payloads().any { it.type() == "session.created" } }
        transport.receive(mcpToolUpdate("provider-a"))
        await {
            transport.payloads().any {
                it.type() == "session.updated" && it["event_id"]?.jsonPrimitive?.content == "provider-a"
            }
        }
        val executor = requireNotNull(registry.mcpExecutor)

        val operation = async { executor.execute(DeviceToolCall("mcp__test__write")) }
        withTimeout(500) { mcp.executionStarted.await() }
        operation.cancel()
        val failure = runCatching { operation.await() }.exceptionOrNull()

        assertTrue(failure is CancellationException)
        assertEquals(0, mcp.sideEffects)
        controller.close()
    }

    @Test
    fun retainsAnMcpCatalogForInstructionsOnlyUpdatesAndClosesItWhenToolsAreRemoved() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL)
        val registry = FakeRegistry()
        val mcp = TrackingMcp()
        val controller = controller(
            transport = transport,
            commands = FakeConversationCommands(),
            scope = this,
            registry = registry,
            mcp = mcp,
        )
        controller.start()
        await { transport.payloads().any { it.type() == "session.created" } }
        transport.receive(mcpToolUpdate("provider-a"))
        await {
            transport.payloads().any {
                it.type() == "session.updated" && it["event_id"]?.jsonPrimitive?.content == "provider-a"
            }
        }
        val catalog = mcp.catalogs.single()

        transport.receive(
            """{"type":"session.update","event_id":"provider-b","session":{"instructions":"updated"}}""",
        )
        await {
            transport.payloads().any {
                it.type() == "session.updated" && it["event_id"]?.jsonPrimitive?.content == "provider-b"
            }
        }
        assertEquals(1, mcp.catalogs.size)
        assertEquals(0, catalog.closeCalls)
        assertEquals("catalog-0", requireNotNull(registry.mcpExecutor).execute(DeviceToolCall("mcp__test__write")))

        transport.receive(
            """{"type":"session.update","event_id":"provider-c","session":{"tools":[]}}""",
        )
        await {
            transport.payloads().any {
                it.type() == "session.updated" && it["event_id"]?.jsonPrimitive?.content == "provider-c"
            }
        }
        assertEquals(1, catalog.closeCalls)
        assertTrue(registry.definitions.none { it is ToolDefinition.Mcp })
        controller.close()
    }

    @Test
    fun rollsBackAPreparedMcpCatalogWhenTheProviderCommitFails() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL)
        val registry = FakeRegistry()
        val mcp = TrackingMcp()
        val controller = controller(
            transport = transport,
            commands = FakeConversationCommands(),
            scope = this,
            registry = registry,
            mcp = mcp,
        )
        controller.start()
        await { transport.payloads().any { it.type() == "session.created" } }
        transport.receive(mcpToolUpdate("provider-a"))
        await {
            transport.payloads().any {
                it.type() == "session.updated" && it["event_id"]?.jsonPrimitive?.content == "provider-a"
            }
        }
        val committedCatalog = mcp.catalogs.single()
        val committedExecutor = requireNotNull(registry.mcpExecutor)
        registry.failNextInstall = true

        transport.receive(mcpToolUpdate("provider-b"))
        await {
            transport.payloads().any {
                it.type() == "error" && it["event_id"]?.jsonPrimitive?.content == "provider-b"
            }
        }

        assertEquals(2, mcp.catalogs.size)
        assertEquals(0, committedCatalog.closeCalls)
        assertEquals(1, mcp.catalogs[1].closeCalls)
        assertTrue(committedExecutor === registry.mcpExecutor)
        assertEquals("catalog-0", committedExecutor.execute(DeviceToolCall("mcp__test__write")))
        controller.close()
        assertEquals(1, committedCatalog.closeCalls)
    }

    @Test
    fun ignoresInboundEventsWhenThePeerDidNotNegotiateEvent() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.REQUIRED)
        val commands = FakeConversationCommands()
        val controller = controller(transport, commands, this)
        controller.start()
        yield()

        transport.receive(startRequest("ignored"))
        delay(20)

        assertEquals(0, commands.startCalls)
        assertTrue(transport.payloads().isEmpty())
        controller.close()
    }

    @Test
    fun retainsEveryConversationResultThroughTheFirmwareRetryWindow() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL)
        val commands = FakeConversationCommands()
        val nowMilliseconds = AtomicLong(0)
        val controller = controller(
            transport = transport,
            commands = commands,
            scope = this,
            monotonicTimeMilliseconds = nowMilliseconds::get,
        )
        controller.start()
        await { transport.payloads().any { it.type() == "session.created" } }
        transport.clearSent()

        repeat(65) { index -> transport.receive(startRequest("request-$index")) }
        await { commands.startCalls == 65 }
        transport.receive(startRequest("request-0"))
        await { transport.conversationResults().size == 66 }
        assertEquals(65, commands.startCalls)

        nowMilliseconds.set(CONVERSATION_RESULT_RETENTION_MS)
        transport.receive(startRequest("request-0"))
        await { transport.conversationResults().size == 67 }
        assertEquals(65, commands.startCalls)

        nowMilliseconds.incrementAndGet()
        transport.receive(startRequest("request-0"))
        await { commands.startCalls == 66 }
        assertEquals(66, commands.startCalls)
        controller.close()
    }

    private fun controller(
        transport: FakeUsbTransport,
        commands: ConversationCommandHandler,
        scope: kotlinx.coroutines.CoroutineScope,
        registry: RemoteToolRegistry = FakeRegistry(),
        mcp: McpToolProvider = FakeMcp(),
        monotonicTimeMilliseconds: () -> Long = { System.nanoTime() / 1_000_000L },
    ) = RealtimeSessionController(
        transport = transport,
        registry = registry,
        mcp = mcp,
        conversationCommands = commands,
        scope = scope,
        monotonicTimeMilliseconds = monotonicTimeMilliseconds,
    )

    private suspend fun await(condition: () -> Boolean) {
        withTimeout(2_000) {
            while (!condition()) delay(1)
        }
    }

    private fun startRequest(requestId: String): String =
        """{"schema":"stackchan.event.v1","type":"conversation.start","requestId":"$requestId","source":"headTouch","gesture":"forwardSwipe"}"""

    private fun stopRequest(requestId: String): String =
        """{"schema":"stackchan.event.v1","type":"conversation.stop","requestId":"$requestId","source":"headTouch","gesture":"backwardSwipe"}"""

    private fun remoteToolUpdate(eventId: String): String =
        """{"type":"session.update","event_id":"$eventId","session":{"tools":[{"type":"function","name":"remote","description":"","parameters":{"type":"object","properties":{}}}]}}"""

    private fun mcpToolUpdate(eventId: String): String =
        """{"type":"session.update","event_id":"$eventId","session":{"tools":[{"type":"mcp","server_label":"test","connector_id":"profile","require_approval":"always"}]}}"""

    private class FakeConversationCommands : ConversationCommandHandler {
        var startCalls = 0
        var stopCalls = 0

        override suspend fun start(): ConversationCommandResult {
            startCalls += 1
            return ConversationCommandResult(true, RemoteConversationState.CONNECTING)
        }

        override suspend fun stop(): ConversationCommandResult {
            stopCalls += 1
            return ConversationCommandResult(true, RemoteConversationState.STANDBY)
        }
    }

    private class FakeRegistry : RemoteToolRegistry {
        @Volatile private var installedDefinitions: List<ToolDefinition> = emptyList()
        override val definitions: List<ToolDefinition> get() = installedDefinitions
        @Volatile var functionExecutor: ToolExecutor? = null
        @Volatile var mcpExecutor: ToolExecutor? = null
        @Volatile var clearCalls = 0
        @Volatile var failNextInstall = false

        override fun installRemoteTools(
            tools: List<ToolDefinition>,
            functionExecutor: ToolExecutor,
            mcpToolExecutor: ToolExecutor,
        ) {
            if (failNextInstall) {
                failNextInstall = false
                error("simulated registry commit failure")
            }
            installedDefinitions = tools
            this.functionExecutor = functionExecutor
            this.mcpExecutor = mcpToolExecutor
        }

        override fun clearRemoteTools() {
            clearCalls += 1
            installedDefinitions = emptyList()
            functionExecutor = null
            mcpExecutor = null
        }
    }

    private class FakeMcp : McpToolProvider {
        override suspend fun openCatalog(request: McpServerRequest): McpToolCatalog = object : McpToolCatalog {
            override val definitions: List<ToolDefinition.Mcp> = emptyList()
            override suspend fun execute(call: DeviceToolCall): String = ""
        }
    }

    private class BlockingMcp : McpToolProvider {
        val executionStarted = CompletableDeferred<Unit>()
        val releaseExecution = CompletableDeferred<Unit>()
        var sideEffects = 0

        override suspend fun openCatalog(request: McpServerRequest): McpToolCatalog = object : McpToolCatalog {
            override val definitions = listOf(
                ToolDefinition.Mcp(
                    serverLabel = request.serverLabel,
                    toolName = "write",
                    name = "mcp__test__write",
                    description = "",
                    parameters = JsonObject(emptyMap()),
                ),
            )

            override suspend fun execute(call: DeviceToolCall): String {
                executionStarted.complete(Unit)
                releaseExecution.await()
                sideEffects += 1
                return "executed"
            }
        }
    }

    private class TrackingMcp : McpToolProvider {
        val catalogs = mutableListOf<TrackingCatalog>()

        override suspend fun openCatalog(request: McpServerRequest): McpToolCatalog =
            TrackingCatalog(request, catalogs.size).also(catalogs::add)

        inner class TrackingCatalog(
            request: McpServerRequest,
            private val index: Int,
        ) : McpToolCatalog {
            var closeCalls = 0
                private set
            private var closed = false
            override val definitions = listOf(
                ToolDefinition.Mcp(
                    serverLabel = request.serverLabel,
                    toolName = "write",
                    name = "mcp__${request.serverLabel}__write",
                    description = "",
                    parameters = JsonObject(emptyMap()),
                ),
            )

            override suspend fun execute(call: DeviceToolCall): String {
                check(!closed) { "catalog is closed" }
                return "catalog-$index"
            }

            override fun close() {
                if (closed) return
                closed = true
                closeCalls += 1
            }
        }
    }

    private class FakeUsbTransport(capabilities: Int) : StackChanUsbTransport {
        private val mutableState = MutableStateFlow<StackChanUsbState>(
            StackChanUsbState.Ready(4_096, capabilities),
        )
        private val mutableFrames = MutableSharedFlow<StackChanFrame>(extraBufferCapacity = 256)
        private val sent = Collections.synchronizedList(mutableListOf<StackChanFrame>())
        private val incomingEncoder = StackChanEventEncoder()

        override val state = mutableState
        override val frames = mutableFrames
        var failNextWrites = 0
        val failedWriteAttempted = CompletableDeferred<Unit>()
        var blockedWriteAttempted = CompletableDeferred<Unit>()
            private set
        private var blockNextWrite = false
        private var releaseBlockedWrite = CompletableDeferred(Unit)

        override suspend fun send(frame: StackChanFrame) {
            if (failNextWrites > 0) {
                failNextWrites -= 1
                failedWriteAttempted.complete(Unit)
                throw IOException("simulated write failure")
            }
            if (blockNextWrite) {
                blockNextWrite = false
                blockedWriteAttempted.complete(Unit)
                releaseBlockedWrite.await()
            }
            sent += frame
        }

        override suspend fun sendControl(
            control: StackChanControl,
            sampleRate: Int,
            payload: ByteArray,
            streamId: Int,
        ) = Unit

        suspend fun receive(serialized: String) {
            incomingEncoder.encode(serialized, 4_096).forEach { mutableFrames.emit(it) }
        }

        fun changeState(state: StackChanUsbState) {
            mutableState.value = state
        }

        fun clearSent() = sent.clear()

        fun blockNextWrite() {
            check(!blockNextWrite && releaseBlockedWrite.isCompleted) { "a write is already blocked" }
            blockedWriteAttempted = CompletableDeferred()
            releaseBlockedWrite = CompletableDeferred()
            blockNextWrite = true
        }

        fun releaseBlockedWrite() {
            releaseBlockedWrite.complete(Unit)
        }

        fun payloads(): List<JsonObject> {
            val decoder = StackChanEventDecoder()
            val snapshot = synchronized(sent) { sent.toList() }
            return snapshot.mapNotNull { frame ->
                decoder.push(frame)?.let { Json.parseToJsonElement(it).jsonObject }
            }
        }

        fun conversationResults(): List<JsonObject> =
            payloads().filter { it["type"]?.jsonPrimitive?.content == "conversation.result" }
    }

    private fun JsonObject.type(): String? = this["type"]?.jsonPrimitive?.content
}
