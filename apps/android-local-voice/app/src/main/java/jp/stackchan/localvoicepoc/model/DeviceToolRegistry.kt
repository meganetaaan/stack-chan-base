package jp.stackchan.localvoicepoc.model

import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.BatteryManager
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

interface RemoteToolRegistry {
    val definitions: List<ToolDefinition>

    fun installRemoteTools(
        tools: List<ToolDefinition>,
        functionExecutor: ToolExecutor,
        mcpToolExecutor: ToolExecutor,
    )

    fun clearRemoteTools()
}

class DeviceToolRegistry(
    context: Context,
    private val onExecute: (DeviceToolCall) -> Unit = {},
) : RemoteToolRegistry {
    private data class RemoteBinding(
        val tools: Map<String, ToolDefinition>,
        val functionExecutor: ToolExecutor?,
        val mcpExecutor: ToolExecutor?,
    )

    class Snapshot internal constructor(
        val definitions: List<ToolDefinition>,
        private val executeTool: suspend (DeviceToolCall) -> String,
    ) {
        val supportedNames: Set<String> = definitions.mapTo(linkedSetOf()) { it.name }

        val prompt: String = buildString {
            appendLine("必要な場合に限り、次のツールを使用できます。")
            definitions.forEach { tool ->
                append("- ").append(tool.name).append(": ").append(tool.description)
                append(" parameters=").append(tool.parameters).appendLine()
            }
            appendLine()
            appendLine("ツールを使う場合は説明文を付けず、次の形式だけを出力してください。")
            appendLine("<tool_call>")
            appendLine("<function=ツール名>")
            appendLine("<parameter=引数名>JSON値</parameter>")
            appendLine("</function>")
            appendLine("</tool_call>")
            append("引数がない場合はparameterを省略してください。ツール結果後はタグを含めず日本語で回答してください。")
        }

        suspend fun execute(call: DeviceToolCall): String = executeTool(call)
    }

    private val appContext = context.applicationContext

    @Volatile
    private var remoteBinding = RemoteBinding(emptyMap(), null, null)

    override val definitions: List<ToolDefinition>
        get() = snapshot().definitions

    val supportedNames: Set<String>
        get() = snapshot().supportedNames

    val prompt: String
        get() = snapshot().prompt

    fun snapshot(): Snapshot {
        val binding = remoteBinding
        return Snapshot(BUILT_INS + binding.tools.values) { call -> execute(call, binding) }
    }

    override fun installRemoteTools(
        tools: List<ToolDefinition>,
        functionExecutor: ToolExecutor,
        mcpToolExecutor: ToolExecutor,
    ) {
        val names = BUILT_INS.mapTo(mutableSetOf()) { it.name }
        require(tools.all { names.add(it.name) }) { "ツール名が重複しています" }
        remoteBinding = RemoteBinding(tools.associateBy { it.name }, functionExecutor, mcpToolExecutor)
    }

    override fun clearRemoteTools() {
        remoteBinding = RemoteBinding(emptyMap(), null, null)
    }

    suspend fun execute(call: DeviceToolCall): String = snapshot().execute(call)

    private suspend fun execute(call: DeviceToolCall, binding: RemoteBinding): String {
        onExecute(call)
        return when (call.name) {
            CURRENT_DATETIME -> currentDateTime()
            BATTERY_STATUS -> batteryStatus()
            else -> when (binding.tools[call.name]) {
                is ToolDefinition.Function ->
                    requireNotNull(binding.functionExecutor) { "function実行器がありません" }.execute(call)
                is ToolDefinition.Mcp -> requireNotNull(binding.mcpExecutor) { "MCP実行器がありません" }.execute(call)
                null -> "{\"error\":\"未対応のツールです\"}"
            }
        }
    }

    private fun currentDateTime(): String {
        val now = ZonedDateTime.now()
        val formatted = DateTimeFormatter
            .ofPattern("yyyy-MM-dd'T'HH:mm:ssXXX", Locale.ROOT)
            .format(now)
        return "{\"datetime\":\"$formatted\",\"timezone\":\"${now.zone.id}\"}"
    }

    private fun batteryStatus(): String {
        val manager = appContext.getSystemService(BatteryManager::class.java)
        val capacity = manager?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
            ?.takeIf { it in 0..100 }
        val battery = appContext.registerReceiver(null, IntentFilter(Intent.ACTION_BATTERY_CHANGED))
        val status = battery?.getIntExtra(BatteryManager.EXTRA_STATUS, -1) ?: -1
        val plugged = battery?.getIntExtra(BatteryManager.EXTRA_PLUGGED, 0) ?: 0
        val charging = status == BatteryManager.BATTERY_STATUS_CHARGING ||
            status == BatteryManager.BATTERY_STATUS_FULL
        val power = when (plugged) {
            BatteryManager.BATTERY_PLUGGED_AC -> "AC"
            BatteryManager.BATTERY_PLUGGED_USB -> "USB"
            BatteryManager.BATTERY_PLUGGED_WIRELESS -> "wireless"
            else -> "none"
        }
        return "{\"capacity_percent\":${capacity ?: "null"}," +
            "\"charging\":$charging,\"power_source\":\"$power\"}"
    }

    companion object {
        const val CURRENT_DATETIME = "get_current_datetime"
        const val BATTERY_STATUS = "get_battery_status"
        private val EMPTY_PARAMETERS = buildJsonObject {
            put("type", "object")
            put("properties", JsonObject(emptyMap()))
        }
        val BUILT_INS = listOf(
            ToolDefinition.Function(
                CURRENT_DATETIME,
                "端末の現在日時とタイムゾーンを取得する。",
                EMPTY_PARAMETERS,
            ),
            ToolDefinition.Function(
                BATTERY_STATUS,
                "バッテリー残量、充電状態、電源接続状態を取得する。",
                EMPTY_PARAMETERS,
            ),
        )
    }
}

object AgentsA1ToolCallParser {
    private val toolCallPattern = Regex(
        """<tool_call>\s*<function=([^>\s]+)>(.*?)</function>\s*</tool_call>""",
        setOf(RegexOption.DOT_MATCHES_ALL),
    )
    private val parameterPattern = Regex(
        """<parameter=([^>\s]+)>(.*?)</parameter>""",
        setOf(RegexOption.DOT_MATCHES_ALL),
    )
    private val hiddenPattern = Regex(
        """<(think|reasoning)>.*?</\1>|<tool_call>.*?</tool_call>""",
        setOf(RegexOption.DOT_MATCHES_ALL, RegexOption.IGNORE_CASE),
    )

    fun parse(text: String): DeviceToolCall? = toolCallPattern.find(text)?.let { match ->
        val arguments = buildJsonObject {
            parameterPattern.findAll(match.groupValues[2]).forEach { parameter ->
                val raw = parameter.groupValues[2].trim()
                put(
                    parameter.groupValues[1],
                    runCatching { kotlinx.serialization.json.Json.parseToJsonElement(raw) }
                        .getOrElse { kotlinx.serialization.json.JsonPrimitive(raw) },
                )
            }
        }
        DeviceToolCall(match.groupValues[1], arguments)
    }

    fun visibleText(text: String): String = text.replace(hiddenPattern, "").trim()
}
