package jp.stackchan.localvoicepoc.mcp

import io.ktor.client.HttpClient
import io.ktor.client.engine.cio.CIO
import io.ktor.client.plugins.HttpTimeout
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
import java.net.URI
import java.util.concurrent.ConcurrentHashMap

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
    private val inlineServerHosts: Set<String> = emptySet(),
    private val approvalHandler: McpApprovalHandler,
) : McpToolProvider {
    private data class Connection(
        val request: McpServerRequest,
        val client: Client,
        val httpClient: HttpClient,
        val forceApproval: Boolean,
    )
    private data class Route(val connection: Connection, val toolName: String)

    private val connections = ConcurrentHashMap<String, Connection>()
    private val routes = ConcurrentHashMap<String, Route>()
    private var lifecycleSink: suspend (String, String, String?) -> Unit = { _, _, _ -> }

    override fun setLifecycleSink(sink: suspend (type: String, serverLabel: String, error: String?) -> Unit) {
        lifecycleSink = sink
    }

    override suspend fun listTools(request: McpServerRequest): List<ToolDefinition.Mcp> {
        closeConnection(request.serverLabel)
        val resolved = request.connectorId?.let(profiles::resolve)
        val url = resolved?.profile?.serverUrl ?: requireNotNull(request.serverUrl).also {
            val uri = URI(it)
            require(uri.scheme == "https") { "インラインMCP URLはHTTPSに限ります" }
            require(inlineServerHosts.any { allowed -> allowed.equals(uri.host, ignoreCase = true) }) {
                "インラインMCP URLのホストは許可されていません。MCPプロファイルを使用してください"
            }
        }
        val token = resolved?.bearerToken
        val http = HttpClient(CIO) {
            install(SSE)
            install(HttpTimeout) {
                connectTimeoutMillis = MCP_CONNECT_TIMEOUT_MS
                requestTimeoutMillis = MCP_REQUEST_TIMEOUT_MS
                socketTimeoutMillis = MCP_SOCKET_TIMEOUT_MS
            }
        }
        val client = Client(Implementation(name = "stackchan-android", version = "1.0.0"))
        val transport = StreamableHttpClientTransport(client = http, url = url) {
            token?.let { header("Authorization", "Bearer $it") }
        }
        var registeredConnection: Connection? = null
        try {
            client.connect(transport)
            val connection = Connection(request, client, http, resolved?.profile?.forceApproval == true)
            registeredConnection = connection
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
            registeredConnection?.let { connection ->
                connections.remove(request.serverLabel, connection)
            }
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
        routes.entries.removeIf { it.value.connection.request.serverLabel == label }
    }

    private fun alias(label: String, name: String): String =
        "mcp__${safe(label)}__${safe(name)}"

    private fun safe(value: String): String = value.replace(Regex("[^A-Za-z0-9_]"), "_")

    private companion object {
        const val MCP_CONNECT_TIMEOUT_MS = 10_000L
        const val MCP_REQUEST_TIMEOUT_MS = 30_000L
        const val MCP_SOCKET_TIMEOUT_MS = 30_000L
    }
}
