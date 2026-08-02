package jp.stackchan.localvoicepoc.model

import android.content.Context
import ai.runanywhere.proto.v1.InferenceFramework
import ai.runanywhere.proto.v1.LLMGenerationOptions
import ai.runanywhere.proto.v1.ModelCategory
import ai.runanywhere.proto.v1.ModelFormat
import ai.runanywhere.proto.v1.ModelInfo
import ai.runanywhere.proto.v1.ModelSource
import ai.runanywhere.proto.v1.ModelUnloadRequest
import com.runanywhere.sdk.foundation.bridge.extensions.CppBridgeModelRegistry
import com.runanywhere.sdk.public.RunAnywhere
import com.runanywhere.sdk.public.extensions.cancelGeneration
import com.runanywhere.sdk.public.extensions.generate
import com.runanywhere.sdk.public.extensions.loadModel
import com.runanywhere.sdk.public.extensions.unloadModel
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

class AgentsA1LanguageModel(
    context: Context,
    private val tools: DeviceToolRegistry = DeviceToolRegistry(context),
) : LocalLanguageModel {
    private val operationMutex = Mutex()
    private val cleanupScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val closed = AtomicBoolean(false)
    @Volatile
    private var loadedModel: ModelInfo? = null

    override val isLoaded: Boolean get() = !closed.get() && loadedModel != null
    override val backend: LanguageModelBackend? get() =
        if (isLoaded) LanguageModelBackend.LLAMA_CPP else null

    override suspend fun prepare(
        modelSpec: LanguageModelSpec,
        modelFile: File,
        preference: LanguageModelBackendPreference,
    ): LanguageModelBackend = operationMutex.withLock {
        check(!closed.get()) { "Agents A1は終了済みです" }
        require(modelSpec.runtime == LanguageModelRuntime.LLAMA_CPP)
        check(modelFile.isFile) { "LLMモデルが見つかりません: ${modelFile.absolutePath}" }
        loadedModel?.let { unload(it) }
        val info = ModelInfo(
            id = modelSpec.id,
            name = modelSpec.name,
            category = ModelCategory.MODEL_CATEGORY_LANGUAGE,
            format = ModelFormat.MODEL_FORMAT_GGUF,
            framework = InferenceFramework.INFERENCE_FRAMEWORK_LLAMA_CPP,
            local_path = modelFile.absolutePath,
            download_size_bytes = modelFile.length(),
            context_length = modelSpec.maxContextTokens,
            supports_thinking = false,
            source = ModelSource.MODEL_SOURCE_LOCAL,
            checksum_sha256 = modelSpec.sha256,
        )
        CppBridgeModelRegistry.save(info)
        val result = RunAnywhere.loadModel(info)
        check(result.success) {
            result.error_message.ifBlank { "${modelSpec.name}をllama.cppへロードできません" }
        }
        loadedModel = info
        LanguageModelBackend.LLAMA_CPP
    }

    override fun generate(request: GenerationRequest): Flow<String> = flow {
        operationMutex.withLock {
            check(!closed.get()) { "Agents A1は終了済みです" }
            check(isLoaded) { "Agents A1がロードされていません" }
            val warmUp = isWarmUp(request)
            val toolSnapshot = tools.snapshot()
            var prompt = conversationPrompt(request, toolSnapshot, includeTools = !warmUp)
            val called = mutableSetOf<String>()
            repeat(MAX_TOOL_CALLS + 1) { attempt ->
                val generated = generateBuffered(prompt, request)
                val call = AgentsA1ToolCallParser.parse(generated)
                if (call == null) {
                    val visible = AgentsA1ToolCallParser.visibleText(generated)
                    if (isWarmUp(request)) {
                        check(generated.isNotBlank()) { "Agents A1が空の応答を返しました" }
                        emit(visible.ifBlank { "はい" })
                    } else {
                        check(visible.isNotBlank()) { "Agents A1が空の応答を返しました" }
                        emit(visible)
                    }
                    return@flow
                }
                check(attempt < MAX_TOOL_CALLS) { "1回の応答で利用できるツール回数を超えました" }
                check(call.name in toolSnapshot.supportedNames) { "未対応のツールです: ${call.name}" }
                check(called.add("${call.name}:${call.arguments}")) {
                    "同じツール呼び出しの繰り返しを停止しました: ${call.name}"
                }
                val result = toolSnapshot.execute(call)
                prompt = continueAfterTool(prompt, generated, result)
            }
            error("Agents A1のツール処理が終了しませんでした")
        }
    }

    private suspend fun generateBuffered(requestText: String, request: GenerationRequest): String {
        val warmUp = isWarmUp(request)
        val sampling = if (request.sampling == SamplingProfile()) {
            SamplingProfile(topK = 20, topP = 0.95, temperature = 0.85)
        } else {
            request.sampling
        }
        val options = LLMGenerationOptions(
            max_tokens = if (warmUp) WARM_UP_MAX_TOKENS else MAX_OUTPUT_TOKENS,
            temperature = sampling.temperature.toFloat(),
            top_p = sampling.topP.toFloat(),
            top_k = sampling.topK,
            seed = sampling.seed.toLong(),
            streaming_enabled = false,
            // The bundled llama.cpp cannot apply this model's Qwen 3.5 Jinja template.
            // The request text is already formatted with the model's ChatML control tokens.
            system_prompt = "",
            preferred_framework = InferenceFramework.INFERENCE_FRAMEWORK_LLAMA_CPP,
            disable_thinking = true,
        )
        val result = RunAnywhere.generate(requestText, options)
        result.error_message?.takeIf(String::isNotBlank)?.let(::error)
        return result.text.ifBlank { result.thinking_content.orEmpty() }
    }

    private fun isWarmUp(request: GenerationRequest): Boolean =
        request.sampling.temperature <= WARM_UP_TEMPERATURE

    private fun conversationPrompt(
        request: GenerationRequest,
        toolSnapshot: DeviceToolRegistry.Snapshot,
        includeTools: Boolean,
    ): String = buildString {
        append(IM_START)
        append("system\n")
        append(request.systemInstruction)
        if (includeTools) {
            append("\n\n")
            append(toolSnapshot.prompt)
        }
        append(IM_END)
        append('\n')
        request.history.forEach { message ->
            append(IM_START)
            append(if (message.role == DialogueMessage.Role.USER) "user\n" else "assistant\n")
            append(message.text)
            append(IM_END)
            append('\n')
        }
        append(IM_START)
        append("user\n")
        append(request.userText)
        append(IM_END)
        append('\n')
        append(ASSISTANT_WITHOUT_THINKING)
    }

    private fun continueAfterTool(prompt: String, generated: String, result: String): String =
        buildString {
            append(prompt)
            append(generated)
            append(IM_END)
            append('\n')
            append(IM_START)
            append("user\n<tool_response>\n")
            append(result)
            append("\n</tool_response>\n")
            append("ツール結果を使って、タグを含めず日本語で最終回答してください。")
            append(IM_END)
            append('\n')
            append(ASSISTANT_WITHOUT_THINKING)
        }

    override suspend fun cancel() {
        RunAnywhere.cancelGeneration()
        operationMutex.withLock { }
    }

    override suspend fun shutdown() {
        RunAnywhere.cancelGeneration()
        operationMutex.withLock {
            val model = loadedModel ?: return@withLock
            loadedModel = null
            unload(model)
        }
    }

    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        cleanupScope.launch {
            operationMutex.withLock {
                val model = loadedModel ?: return@withLock
                loadedModel = null
                runCatching { unload(model) }
            }
        }
    }

    private suspend fun unload(model: ModelInfo) {
        RunAnywhere.unloadModel(
            ModelUnloadRequest(
                model_id = model.id,
                category = ModelCategory.MODEL_CATEGORY_LANGUAGE,
                framework = InferenceFramework.INFERENCE_FRAMEWORK_LLAMA_CPP,
            ),
        )
    }

    private companion object {
        const val MAX_TOOL_CALLS = 2
        const val MAX_OUTPUT_TOKENS = 512
        const val WARM_UP_MAX_TOKENS = 8
        const val WARM_UP_TEMPERATURE = 0.1
        const val IM_START = "<|im_start|>"
        const val IM_END = "<|im_end|>"
        const val ASSISTANT_WITHOUT_THINKING =
            "<|im_start|>assistant\n<think>\n\n</think>\n\n"
    }
}
