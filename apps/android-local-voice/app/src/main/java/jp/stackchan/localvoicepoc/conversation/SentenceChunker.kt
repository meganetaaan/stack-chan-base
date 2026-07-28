package jp.stackchan.localvoicepoc.conversation

/** Incrementally turns streamed LLM text into stable TTS-sized clauses. */
class SentenceChunker(
    private val softLimit: Int = 52,
) {
    private val buffer = StringBuilder()

    fun push(delta: String): List<String> {
        if (delta.isEmpty()) return emptyList()
        val completed = mutableListOf<String>()
        delta.forEach { char ->
            buffer.append(char)
            when {
                char in TERMINATORS -> drain(completed)
                char == '\n' && buffer.length >= 4 -> drain(completed)
                buffer.length >= softLimit && char in SOFT_BREAKS -> drain(completed)
            }
        }
        return completed
    }

    fun flush(): String? {
        val value = buffer.toString().trim()
        buffer.clear()
        return value.takeIf(String::isNotEmpty)
    }

    private fun drain(target: MutableList<String>) {
        val value = buffer.toString().trim()
        buffer.clear()
        if (value.isNotEmpty()) target += value
    }

    private companion object {
        val TERMINATORS = setOf('。', '！', '？', '!', '?')
        val SOFT_BREAKS = setOf('、', ',', '，', ';', '；')
    }
}
