package jp.stackchan.localvoicepoc.model

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import kotlinx.serialization.json.jsonPrimitive

class AgentsA1ToolCallParserTest {
    @Test
    fun parsesAgentsA1FunctionTag() {
        val text = """
            <tool_call>
            <function=get_current_datetime>
            </function>
            </tool_call>
        """.trimIndent()

        assertEquals(DeviceToolRegistry.CURRENT_DATETIME, AgentsA1ToolCallParser.parse(text)?.name)
    }

    @Test
    fun removesReasoningAndToolMarkupFromVisibleText() {
        val text = "<think>確認します</think><tool_call><function=get_battery_status></function></tool_call>残量です。"

        assertEquals("残量です。", AgentsA1ToolCallParser.visibleText(text))
    }

    @Test
    fun plainAnswerDoesNotBecomeToolCall() {
        assertNull(AgentsA1ToolCallParser.parse("今日は水曜日です。"))
    }

    @Test
    fun parsesQwenCoderParametersAsJsonValues() {
        val call = AgentsA1ToolCallParser.parse(
            "<tool_call><function=set_led>" +
                "<parameter=color>\"red\"</parameter>" +
                "<parameter=brightness>0.5</parameter>" +
                "</function></tool_call>",
        )!!

        assertEquals("set_led", call.name)
        assertEquals("red", call.arguments.getValue("color").jsonPrimitive.content)
        assertEquals(0.5, call.arguments.getValue("brightness").jsonPrimitive.content.toDouble(), 0.0)
    }
}
