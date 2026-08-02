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
import jp.stackchan.localvoicepoc.realtime.McpToolCatalog
import jp.stackchan.localvoicepoc.realtime.McpToolProvider
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.net.URI
import java.util.concurrent.atomic.AtomicBoolean

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
    private inner class Catalog(
        val request: McpServerRequest,
        val client: Client,
        val httpClient: HttpClient,
        val forceApproval: Boolean,
        override val definitions: List<ToolDefinition.Mcp>,
        private val routes: Map<String, String>,
    ) : McpToolCatalog {
        private val closed = AtomicBoolean(false)

        override suspend fun execute(call: DeviceToolCall): String {
            check(!closed.get()) { "MCPカタログは終了済みです: ${request.serverLabel}" }
            val toolName = routes[call.name] ?: error("MCPツールが見つかりません: ${call.name}")
            if (forceApproval || request.requireApproval) {
                val approved = approvalHandler.approve(
                    McpApprovalRequest(request.serverLabel, toolName, call.arguments),
                )
                if (!approved) {
                    lifecycleSink("response.mcp_call.failed", request.serverLabel, "ユーザーが拒否しました")
                    return "{\"error\":\"ユーザーがMCPツールの実行を拒否しました\"}"
                }
            }
            lifecycleSink("response.mcp_call.in_progress", request.serverLabel, null)
            return runCatching {
                val result = client.callTool(toolName, call.arguments)
                result.structuredContent?.toString() ?: result.content.joinToString("\n") { content ->
                    (content as? TextContent)?.text ?: content.toString()
                }
            }.onSuccess {
                lifecycleSink("response.mcp_call.completed", request.serverLabel, null)
            }.onFailure {
                lifecycleSink("response.mcp_call.failed", request.serverLabel, it.message)
            }.getOrThrow()
        }

        override fun close() {
            if (!closed.compareAndSet(false, true)) return
            synchronized(catalogLock) { catalogs.remove(this) }
            httpClient.close()
        }
    }

    private val catalogLock = Any()
    private val catalogs = linkedSetOf<Catalog>()
    private var catalogEpoch = 0L
    private var lifecycleSink: suspend (String, String, String?) -> Unit = { _, _, _ -> }

    override fun setLifecycleSink(sink: suspend (type: String, serverLabel: String, error: String?) -> Unit) {
        lifecycleSink = sink
    }

    override suspend fun openCatalog(request: McpServerRequest): McpToolCatalog {
        val openingEpoch = synchronized(catalogLock) { catalogEpoch }
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
        try {
            client.connect(transport)
            val routes = linkedMapOf<String, String>()
            val definitions = client.listTools(ListToolsRequest()).tools
                .filter { request.allowedTools == null || it.name in request.allowedTools }
                .map { tool ->
                    val alias = alias(request.serverLabel, tool.name)
                    val properties = tool.inputSchema.properties ?: JsonObject(emptyMap())
                    val required = tool.inputSchema.required.orEmpty()
                    routes[alias] = tool.name
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
            val catalog = Catalog(
                request = request,
                client = client,
                httpClient = http,
                forceApproval = resolved?.profile?.forceApproval == true,
                definitions = definitions,
                routes = routes,
            )
            val accepted = synchronized(catalogLock) {
                if (catalogEpoch == openingEpoch) {
                    catalogs += catalog
                    true
                } else {
                    false
                }
            }
            check(accepted) { "MCPセッションはツール取得中に終了しました" }
            return catalog
        } catch (error: Throwable) {
            http.close()
            throw error
        }
    }

    override fun close() {
        val active = synchronized(catalogLock) {
            catalogEpoch += 1
            catalogs.toList().also { catalogs.clear() }
        }
        active.forEach(Catalog::close)
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
