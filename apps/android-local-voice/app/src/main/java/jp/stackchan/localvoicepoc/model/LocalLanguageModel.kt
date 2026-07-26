package jp.stackchan.localvoicepoc.model

import kotlinx.coroutines.flow.Flow
import java.io.File

enum class LanguageModelBackend(val displayName: String) {
    GPU("GPU"),
    CPU("CPU"),
    LLAMA_CPP("llama.cpp"),
}

enum class LanguageModelBackendPreference {
    GPU_WITH_CPU_FALLBACK,
    CPU_ONLY,
}

data class DialogueMessage(
    val role: Role,
    val text: String,
) {
    enum class Role { USER, ASSISTANT }
}

data class SamplingProfile(
    val topK: Int = 40,
    val topP: Double = 0.9,
    val temperature: Double = 0.65,
    val seed: Int = 0,
)

data class GenerationRequest(
    val systemInstruction: String,
    val history: List<DialogueMessage>,
    val userText: String,
    val sampling: SamplingProfile = SamplingProfile(),
)

/** Runtime-independent boundary used by the conversation coordinator. */
interface LocalLanguageModel : AutoCloseable {
    val isLoaded: Boolean
    val backend: LanguageModelBackend?

    suspend fun prepare(
        modelSpec: LanguageModelSpec,
        modelFile: File,
        preference: LanguageModelBackendPreference =
            LanguageModelBackendPreference.GPU_WITH_CPU_FALLBACK,
    ): LanguageModelBackend

    fun generate(request: GenerationRequest): Flow<String>

    suspend fun cancel()
}
