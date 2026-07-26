package jp.stackchan.localvoicepoc.model

import android.content.Context
import kotlinx.coroutines.flow.Flow
import java.io.File

class SelectableLanguageModel(
    context: Context,
    tools: DeviceToolRegistry = DeviceToolRegistry(context),
    private val instructionOverlay: () -> String = { "" },
) : LocalLanguageModel {
    private val liteRt = LiteRtGemmaLanguageModel(context)
    private val agentsA1 = AgentsA1LanguageModel(context, tools)
    @Volatile
    private var active: LocalLanguageModel? = null

    override val isLoaded: Boolean get() = active?.isLoaded == true
    override val backend: LanguageModelBackend? get() = active?.backend

    override suspend fun prepare(
        modelSpec: LanguageModelSpec,
        modelFile: File,
        preference: LanguageModelBackendPreference,
    ): LanguageModelBackend {
        val target = when (modelSpec.runtime) {
            LanguageModelRuntime.LITERT_LM -> liteRt
            LanguageModelRuntime.LLAMA_CPP -> agentsA1
        }
        if (active !== target) {
            active?.shutdown()
            active = target
        }
        return target.prepare(modelSpec, modelFile, preference)
    }

    override fun generate(request: GenerationRequest): Flow<String> {
        val overlay = instructionOverlay().trim()
        val effective = if (overlay.isEmpty()) request else request.copy(
            systemInstruction = request.systemInstruction + "\n\n" + overlay,
        )
        return requireNotNull(active) { "LLMが選択されていません" }.generate(effective)
    }

    override suspend fun cancel() {
        active?.cancel()
    }

    override suspend fun shutdown() {
        active?.shutdown()
        active = null
    }

    override fun close() {
        liteRt.close()
        agentsA1.close()
        active = null
    }
}
