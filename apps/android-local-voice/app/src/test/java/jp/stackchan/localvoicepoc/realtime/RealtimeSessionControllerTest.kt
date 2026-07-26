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
        val controller = controller(transport, FakeConversationCommands(), this)
        transport.failNextWrites = 1
        controller.start()
        delay(20)

        transport.changeState(StackChanUsbState.Disconnected)
        yield()
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
        await { registry.functionExecutor != null }
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
    fun boundsTheConversationResultCacheAtSixtyFourEntries() = runBlocking {
        val transport = FakeUsbTransport(StackChanCapabilities.ALL)
        val commands = FakeConversationCommands()
        val controller = controller(transport, commands, this)
        controller.start()
        await { transport.payloads().any { it.type() == "session.created" } }
        transport.clearSent()

        repeat(65) { index -> transport.receive(startRequest("request-$index")) }
        await { commands.startCalls == 65 }
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
    ) = RealtimeSessionController(
        transport = transport,
        registry = registry,
        mcp = FakeMcp(),
        conversationCommands = commands,
        scope = scope,
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
        override val definitions: List<ToolDefinition> = emptyList()
        @Volatile var functionExecutor: ToolExecutor? = null
        @Volatile var clearCalls = 0

        override fun installRemoteTools(
            tools: List<ToolDefinition>,
            functionExecutor: ToolExecutor,
            mcpToolExecutor: ToolExecutor,
        ) {
            this.functionExecutor = functionExecutor
        }

        override fun clearRemoteTools() {
            clearCalls += 1
            functionExecutor = null
        }
    }

    private class FakeMcp : McpToolProvider {
        override suspend fun listTools(request: McpServerRequest): List<ToolDefinition.Mcp> = emptyList()
        override suspend fun execute(call: DeviceToolCall): String = ""
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

        override suspend fun send(frame: StackChanFrame) {
            if (failNextWrites > 0) {
                failNextWrites -= 1
                throw IOException("simulated write failure")
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
