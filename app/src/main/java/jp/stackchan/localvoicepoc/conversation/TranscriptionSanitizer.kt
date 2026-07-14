package jp.stackchan.localvoicepoc.conversation

/** Removes Whisper non-speech captions and rejects results that contain no spoken text. */
object TranscriptionSanitizer {
    private val caption = Regex("""(?i)(\([^)]{1,80}\)|\[[^]]{1,80}]|\*[^*]{1,80}\*)""")
    private val whitespace = Regex("""\s+""")
    private val wordSeparator = Regex("""[^a-z]+""")
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

    fun sanitize(raw: String): String? {
        val withoutCaptions = raw.replace(caption, " ").replace(whitespace, " ").trim()
        if (withoutCaptions.isEmpty()) return null

        val englishWords = withoutCaptions.lowercase().split(wordSeparator).filter(String::isNotEmpty)
        if (englishWords.isNotEmpty() && englishWords.all(nonSpeechWords::contains)) return null

        return withoutCaptions
    }
}
