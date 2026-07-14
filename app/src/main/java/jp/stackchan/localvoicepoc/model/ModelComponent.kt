package jp.stackchan.localvoicepoc.model

enum class ModelComponent { LLM, STT, VAD }

data class ModelPreparationProgress(
    val component: ModelComponent,
    val stage: String,
    val fraction: Float = 0f,
)
