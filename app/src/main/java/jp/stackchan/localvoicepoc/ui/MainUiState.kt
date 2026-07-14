package jp.stackchan.localvoicepoc.ui

import jp.stackchan.localvoicepoc.SdkBootstrap
import jp.stackchan.localvoicepoc.conversation.ConversationPhase
import jp.stackchan.localvoicepoc.model.GemmaModelManifest
import jp.stackchan.localvoicepoc.model.GemmaModelSpec
import jp.stackchan.localvoicepoc.model.ModelComponent

data class ChatMessage(
    val role: Role,
    val text: String,
) {
    enum class Role { USER, ASSISTANT }
}

data class ComponentProgress(
    val stage: String = "not prepared",
    val fraction: Float = 0f,
)

data class MainUiState(
    val sdkStatus: SdkBootstrap.Status = SdkBootstrap.Status.Starting,
    val selectedGemmaModel: GemmaModelSpec = GemmaModelManifest.default,
    val modelProgress: Map<ModelComponent, ComponentProgress> =
        ModelComponent.entries.associateWith { ComponentProgress() },
    val modelSetupRunning: Boolean = false,
    val modelsReady: Boolean = false,
    val piperAarPresent: Boolean = false,
    val piperModelPresent: Boolean = false,
    val piperConfigPresent: Boolean = false,
    val piperDictionaryPresent: Boolean = false,
    val piperLoaded: Boolean = false,
    val piperBusy: Boolean = false,
    val phase: ConversationPhase = ConversationPhase.IDLE,
    val audioLevel: Float = 0f,
    val automaticMode: Boolean = false,
    val messages: List<ChatMessage> = emptyList(),
    val assistantDraft: String = "",
    val error: String? = null,
) {
    val pipelineReady: Boolean
        get() = sdkStatus is SdkBootstrap.Status.Ready && modelsReady && piperLoaded
}
