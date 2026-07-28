package jp.stackchan.localvoicepoc.ui

import jp.stackchan.localvoicepoc.SdkBootstrap
import jp.stackchan.localvoicepoc.conversation.ConversationPhase
import jp.stackchan.localvoicepoc.model.GemmaModelManifest
import jp.stackchan.localvoicepoc.model.GemmaModelSpec
import jp.stackchan.localvoicepoc.model.ModelComponent
import jp.stackchan.localvoicepoc.mcp.McpApprovalRequest
import jp.stackchan.localvoicepoc.mcp.McpProfile

data class ChatMessage(
    val role: Role,
    val text: String,
) {
    enum class Role { USER, ASSISTANT }
}

data class ComponentProgress(
    val stage: String = "未準備",
    val fraction: Float = 0f,
)

enum class UsbConnectionStatus {
    DISCONNECTED,
    PERMISSION_PENDING,
    CONNECTING,
    READY,
    ERROR,
}

enum class AppStartupStatus {
    CHECKING,
    RESTORING,
    SETUP_REQUIRED,
    READY,
    FAILED,
}

enum class SetupStep {
    MODEL,
    VOICE,
    DEVICE,
}

data class MainUiState(
    val startupStatus: AppStartupStatus = AppStartupStatus.CHECKING,
    val startupMessage: String = "保存済みのデータを確認しています",
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
    val piperProgress: ComponentProgress = ComponentProgress(stage = "未準備"),
    val piperTermsConfirmationRequired: Boolean = false,
    val phase: ConversationPhase = ConversationPhase.IDLE,
    val audioLevel: Float = 0f,
    val automaticMode: Boolean = false,
    val usbStatus: UsbConnectionStatus = UsbConnectionStatus.DISCONNECTED,
    val usbError: String? = null,
    val mcpProfiles: List<McpProfile> = emptyList(),
    val mcpApprovalRequest: McpApprovalRequest? = null,
    val messages: List<ChatMessage> = emptyList(),
    val assistantDraft: String = "",
    val error: String? = null,
) {
    val canStartModelMutation: Boolean
        get() = phase == ConversationPhase.IDLE && !modelSetupRunning && !piperBusy

    val pipelineReady: Boolean
        get() = sdkStatus is SdkBootstrap.Status.Ready && modelsReady && piperLoaded &&
            usbStatus == UsbConnectionStatus.READY

    val setupStep: SetupStep
        get() = when {
            !modelsReady -> SetupStep.MODEL
            !piperLoaded -> SetupStep.VOICE
            else -> SetupStep.DEVICE
        }
}
