package jp.stackchan.localvoicepoc.conversation

/** Removes Whisper non-speech captions and rejects results that contain no spoken text. */
object TranscriptionSanitizer {
    private val caption = Regex(
        """(?i)(\([^)]{1,80}\)|（[^）]{1,80}）|\[[^]]{1,80}]|［[^］]{1,80}］|\*[^*]{1,80}\*)""",
    )
    private val whitespace = Regex("""\s+""")
    private val wordSeparator = Regex("""[^a-z]+""")
    private val punctuationOnly = Regex("""^[\p{P}\p{S}\s]+$""")
    private val nonSpeechWords = setOf(
        "applause",
        "beep",
        "breathing",
        "click",
        "clicking",
        "cough",
        "laughing",
        "music",
        "noise",
        "scissors",
        "silence",
        "snipping",
    )
    private val japaneseNonSpeechDescriptions = setOf(
        "bgm",
        "音楽",
        "雑音",
        "ノイズ",
        "無音",
        "拍手",
        "咳",
        "咳払い",
        "笑い",
        "笑い声",
        "呼吸",
        "呼吸音",
        "環境音",
    )

    fun sanitize(raw: String): String? {
        val withoutCaptions = raw.replace(caption, " ").replace(whitespace, " ").trim()
        if (withoutCaptions.isEmpty()) return null
        if (punctuationOnly.matches(withoutCaptions)) return null

        if (isIncompleteNonSpeechCaption(withoutCaptions)) return null

        val englishWords = withoutCaptions.lowercase().split(wordSeparator).filter(String::isNotEmpty)
        if (englishWords.isNotEmpty() && englishWords.all(nonSpeechWords::contains)) return null

        return withoutCaptions
    }

    private fun isIncompleteNonSpeechCaption(value: String): Boolean {
        if (value.firstOrNull() !in CAPTION_OPENERS) return false
        val description = value
            .drop(1)
            .trim()
            .trimEnd(*CAPTION_CLOSERS)
            .trim()
            .lowercase()
        if (description.isEmpty()) return true
        if (description in japaneseNonSpeechDescriptions) return true
        val englishWords = description.split(wordSeparator).filter(String::isNotEmpty)
        return englishWords.isNotEmpty() && englishWords.all(nonSpeechWords::contains)
    }

    private val CAPTION_OPENERS = setOf('(', '[', '（', '［', '*')
    private val CAPTION_CLOSERS = charArrayOf(')', ']', '）', '］', '*')
}
