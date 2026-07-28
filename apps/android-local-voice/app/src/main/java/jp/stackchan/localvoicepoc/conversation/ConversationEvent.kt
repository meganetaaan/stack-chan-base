package jp.stackchan.localvoicepoc.conversation

sealed interface ConversationEvent {
    data class PhaseChanged(val phase: ConversationPhase) : ConversationEvent
    data class AudioLevel(val rms: Float) : ConversationEvent
    data class UserText(val text: String) : ConversationEvent
    data class AssistantDraft(val text: String) : ConversationEvent
    data class AssistantText(val text: String) : ConversationEvent
    data class Failure(val message: String, val cause: Throwable? = null) : ConversationEvent
}

enum class ConversationPhase {
    IDLE,
    CONNECTING,
    LISTENING,
    RECORDING,
    TRANSCRIBING,
    THINKING,
    SPEAKING,
}
