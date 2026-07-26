package jp.stackchan.localvoicepoc.mcp

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.sse.SSE
import io.ktor.client.request.header
import io.modelcontextprotocol.kotlin.sdk.client.Client
import io.modelcontextprotocol.kotlin.sdk.client.StreamableHttpClientTransport
import io.modelcontextprotocol.kotlin.sdk.types.Implementation
import io.modelcontextprotocol.kotlin.sdk.types.ListToolsRequest
import io.modelcontextprotocol.kotlin.sdk.types.TextContent
import jp.stackchan.localvoicepoc.model.DeviceToolCall
import jp.stackchan.localvoicepoc.model.ToolDefinition
import jp.stackchan.localvoicepoc.realtime.McpServerRequest
import jp.stackchan.localvoicepoc.realtime.McpToolProvider
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

fun interface McpApprovalHandler {
    suspend fun approve(request: McpApprovalRequest): Boolean
}

data class McpApprovalRequest(
    val serverLabel: String,
    val toolName: String,
    val arguments: JsonObject,
)

class AndroidMcpToolProvider(
    private val profiles: McpProfileStore,
    private val approvalHandler: McpApprovalHandler,
) : McpToolProvider {
    private data class Connection(
        val request: McpServerRequest,
        val client: Client,
        val httpClient: HttpClient,
        val forceApproval: Boolean,
    )
    private data class Route(val connection: Connection, val toolName: String)

    private val connections = mutableMapOf<String, Connection>()
    private val routes = mutableMapOf<String, Route>()
    private var lifecycleSink: suspend (String, String, String?) -> Unit = { _, _, _ -> }

    override fun setLifecycleSink(sink: suspend (type: String, serverLabel: String, error: String?) -> Unit) {
        lifecycleSink = sink
    }

    override suspend fun listTools(request: McpServerRequest): List<ToolDefinition.Mcp> {
        closeConnection(request.serverLabel)
        val resolved = request.connectorId?.let(profiles::resolve)
        val url = resolved?.profile?.serverUrl ?: requireNotNull(request.serverUrl).also {
            require(java.net.URI(it).scheme == "https") { "インラインMCP URLはHTTPSに限ります" }
        }
        val token = resolved?.bearerToken
        val http = HttpClient(CIO) { install(SSE) }
        val client = Client(Implementation(name = "stackchan-android", version = "1.0.0"))
        val transport = StreamableHttpClientTransport(client = http, url = url) {
            token?.let { header("Authorization", "Bearer $it") }
        }
        try {
            client.connect(transport)
            val connection = Connection(request, client, http, resolved?.profile?.forceApproval == true)
            connections[request.serverLabel] = connection
            return client.listTools(ListToolsRequest()).tools
                .filter { request.allowedTools == null || it.name in request.allowedTools }
                .map { tool ->
                    val alias = alias(request.serverLabel, tool.name)
                    val properties = tool.inputSchema.properties ?: JsonObject(emptyMap())
                    val required = tool.inputSchema.required.orEmpty()
                    routes[alias] = Route(connection, tool.name)
                    ToolDefinition.Mcp(
                        serverLabel = request.serverLabel,
                        toolName = tool.name,
                        name = alias,
                        description = tool.description.orEmpty(),
                        parameters = buildJsonObject {
                            put("type", "object")
                            put("properties", properties)
                            if (required.isNotEmpty()) {
                                put("required", JsonArray(required.map { name -> JsonPrimitive(name) }))
                            }
                        },
                    )
                }
        } catch (error: Throwable) {
            http.close()
            throw error
        }
    }

    override suspend fun execute(call: DeviceToolCall): String {
        val route = routes[call.name] ?: error("MCPツールが見つかりません: ${call.name}")
        if (route.connection.forceApproval || route.connection.request.requireApproval) {
            val approved = approvalHandler.approve(
                McpApprovalRequest(route.connection.request.serverLabel, route.toolName, call.arguments),
            )
            if (!approved) {
                lifecycleSink("response.mcp_call.failed", route.connection.request.serverLabel, "ユーザーが拒否しました")
                return "{\"error\":\"ユーザーがMCPツールの実行を拒否しました\"}"
            }
        }
        lifecycleSink("response.mcp_call.in_progress", route.connection.request.serverLabel, null)
        return runCatching {
            val result = route.connection.client.callTool(route.toolName, call.arguments)
            result.structuredContent?.toString() ?: result.content.joinToString("\n") { content ->
                (content as? TextContent)?.text ?: content.toString()
            }
        }.onSuccess {
            lifecycleSink("response.mcp_call.completed", route.connection.request.serverLabel, null)
        }.onFailure {
            lifecycleSink("response.mcp_call.failed", route.connection.request.serverLabel, it.message)
        }.getOrThrow()
    }

    override fun close() {
        connections.keys.toList().forEach(::closeConnection)
        routes.clear()
    }

    private fun closeConnection(label: String) {
        connections.remove(label)?.httpClient?.close()
        routes.entries.removeAll { it.value.connection.request.serverLabel == label }
    }

    private fun alias(label: String, name: String): String =
        "mcp__${safe(label)}__${safe(name)}"

    private fun safe(value: String): String = value.replace(Regex("[^A-Za-z0-9_]"), "_")
}
