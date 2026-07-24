package jp.stackchan.localvoicepoc.model

import android.content.Context
import android.util.Log
import com.google.ai.edge.litertlm.Backend
import com.google.ai.edge.litertlm.Capabilities
import com.google.ai.edge.litertlm.Content
import com.google.ai.edge.litertlm.Contents
import com.google.ai.edge.litertlm.Conversation
import com.google.ai.edge.litertlm.ConversationConfig
import com.google.ai.edge.litertlm.Engine
import com.google.ai.edge.litertlm.EngineConfig
import com.google.ai.edge.litertlm.ExperimentalApi
import com.google.ai.edge.litertlm.ExperimentalFlags
import com.google.ai.edge.litertlm.Message
import com.google.ai.edge.litertlm.MessageCallback
import com.google.ai.edge.litertlm.SamplerConfig
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File

/** Gemma 4 adapter implemented against the public LiteRT-LM API. */
@OptIn(ExperimentalApi::class)
class LiteRtGemmaLanguageModel(
    context: Context,
    private val inferenceDispatcher: CoroutineDispatcher = Dispatchers.IO,
) : LocalLanguageModel {
    private val applicationContext = context.applicationContext
    private val operationMutex = Mutex()

    @Volatile
    private var activeEngine: Engine? = null

    @Volatile
    private var generatingConversation: Conversation? = null

    @Volatile
    private var cancelRequested = false

    private var sessionHistory: List<DialogueMessage> = emptyList()
    private var sessionSystemInstruction: String? = null
    private var sessionSampling: SamplingProfile? = null
    private var retainedConversation: Conversation? = null

    @Volatile
    override var backend: LanguageModelBackend? = null
        private set

    override val isLoaded: Boolean
        get() = activeEngine?.isInitialized() == true

    override suspend fun prepare(
        modelSpec: LanguageModelSpec,
        modelFile: File,
        preference: LanguageModelBackendPreference,
    ): LanguageModelBackend =
        withContext(inferenceDispatcher) {
            operationMutex.withLock {
                require(modelFile.isFile && modelFile.length() > 0L) {
                    "Gemma 4モデルが見つかりません: ${modelFile.absolutePath}"
                }

                closeConversation()
                closeEngine()

                var gpuError: Throwable? = null
                if (preference == LanguageModelBackendPreference.GPU_WITH_CPU_FALLBACK) {
                    val speculativeDecoding = runCatching {
                        Capabilities(modelFile.absolutePath).use {
                            it.hasSpeculativeDecodingSupport()
                        }
                    }.onFailure { error ->
                        Log.w(TAG, "Could not inspect model capabilities", error)
                    }.getOrDefault(false)

                    ExperimentalFlags.enableSpeculativeDecoding = speculativeDecoding
                    val gpuResult = runCatching {
                        initializeEngine(modelFile, Backend.GPU(), modelSpec.maxContextTokens)
                    }

                    if (gpuResult.isSuccess) {
                        activeEngine = gpuResult.getOrThrow()
                        backend = LanguageModelBackend.GPU
                        return@withLock LanguageModelBackend.GPU
                    }

                    gpuError = requireNotNull(gpuResult.exceptionOrNull())
                    Log.w(TAG, "LiteRT-LM GPU initialization failed; trying CPU", gpuError)
                }

                ExperimentalFlags.enableSpeculativeDecoding = false

                val cpuThreads = Runtime.getRuntime().availableProcessors().coerceIn(2, 6)
                val cpuResult = runCatching {
                    initializeEngine(modelFile, Backend.CPU(threadCount = cpuThreads), modelSpec.maxContextTokens)
                }
                if (cpuResult.isSuccess) {
                    activeEngine = cpuResult.getOrThrow()
                    backend = LanguageModelBackend.CPU
                    return@withLock LanguageModelBackend.CPU
                }

                val cpuError = requireNotNull(cpuResult.exceptionOrNull())
                val gpuDetail = gpuError?.let {
                    "GPU: ${it.message ?: it::class.java.simpleName} / "
                }.orEmpty()
                throw IllegalStateException(
                    "LiteRT-LMの初期化に失敗しました。" +
                        gpuDetail +
                        "CPU: ${cpuError.message ?: cpuError::class.java.simpleName}",
                    cpuError,
                )
            }
        }

    override fun generate(request: GenerationRequest): Flow<String> = flow {
        operationMutex.withLock {
            val engine = checkNotNull(activeEngine) { "Gemma 4がロードされていません" }
            check(engine.isInitialized()) { "LiteRT-LMエンジンが初期化されていません" }

            val conversation = conversationFor(engine, request)
            cancelRequested = false
            generatingConversation = conversation
            val generated = StringBuilder()
            var succeeded = false
            try {
                if (cancelRequested) throw CancellationException("Gemma 4の生成を中断しました")
                streamMessages(conversation, request.userText).collect { message ->
                    val delta = message.contents.contents
                        .filterIsInstance<Content.Text>()
                        .joinToString(separator = "") { it.text }
                    if (delta.isNotEmpty()) {
                        generated.append(delta)
                        emit(delta)
                    }
                }
                if (cancelRequested) throw CancellationException("Gemma 4の生成を中断しました")
                check(generated.isNotBlank()) { "Gemma 4が空の応答を返しました" }
                sessionHistory = request.history +
                    DialogueMessage(DialogueMessage.Role.USER, request.userText) +
                    DialogueMessage(DialogueMessage.Role.ASSISTANT, generated.toString())
                succeeded = true
            } finally {
                generatingConversation = null
                if (!succeeded) {
                    runCatching { conversation.cancelProcess() }
                    closeConversation()
                }
            }
        }
    }.flowOn(inferenceDispatcher)

    override suspend fun cancel() {
        cancelRequested = true
        runCatching { generatingConversation?.cancelProcess() }
            .onFailure { Log.w(TAG, "LiteRT-LM cancellation failed", it) }
    }

    override fun close() {
        cancelRequested = true
        runCatching { generatingConversation?.cancelProcess() }
        closeConversation()
        closeEngine()
        ExperimentalFlags.enableSpeculativeDecoding = null
    }

    private fun initializeEngine(
        modelFile: File,
        runtimeBackend: Backend,
        maxContextTokens: Int,
    ): Engine {
        val cacheDirectory = applicationContext.cacheDir.resolve("litertlm").apply {
            check(isDirectory || mkdirs()) { "LiteRT-LMキャッシュを作成できません: $absolutePath" }
        }
        val candidate = Engine(
            EngineConfig(
                modelPath = modelFile.absolutePath,
                backend = runtimeBackend,
                visionBackend = null,
                audioBackend = null,
                maxNumTokens = maxContextTokens,
                cacheDir = cacheDirectory.absolutePath,
            ),
        )
        return try {
            candidate.initialize()
            candidate
        } catch (error: Throwable) {
            if (candidate.isInitialized()) runCatching { candidate.close() }
            throw error
        }
    }

    /**
     * LiteRT-LM 0.14.0のFlow版APIは、Android上でCoroutinesのABI不一致を起こす。
     * コールバック版APIを明示的に使い、アプリ側でFlowへ変換する。
     */
    private fun streamMessages(
        conversation: Conversation,
        userText: String,
    ): Flow<Message> = losslessCallbackFlow(
        start = { onValue, onDone, onError ->
            val callback = object : MessageCallback {
                override fun onMessage(message: Message) {
                    onValue(message)
                }

                override fun onDone() {
                    onDone()
                }

                override fun onError(throwable: Throwable) {
                    onError(throwable)
                }
            }
            conversation.sendMessageAsync(userText, callback, TEMPLATE_CONTEXT)
        },
        cancel = {
            runCatching { conversation.cancelProcess() }
                .onFailure { Log.w(TAG, "LiteRT-LM cancellation failed", it) }
        },
    )

    private fun conversationFor(engine: Engine, request: GenerationRequest): Conversation {
        val reusable = retainedConversation
        if (
            reusable != null &&
            sessionHistory == request.history &&
            sessionSystemInstruction == request.systemInstruction &&
            sessionSampling == request.sampling
        ) {
            return reusable
        }

        closeConversation()
        val initialMessages = request.history.map { message ->
            when (message.role) {
                DialogueMessage.Role.USER -> Message.user(message.text)
                DialogueMessage.Role.ASSISTANT -> Message.model(message.text)
            }
        }
        return engine.createConversation(
            ConversationConfig(
                systemInstruction = Contents.of(request.systemInstruction),
                initialMessages = initialMessages,
                samplerConfig = SamplerConfig(
                    topK = request.sampling.topK,
                    topP = request.sampling.topP,
                    temperature = request.sampling.temperature,
                    seed = request.sampling.seed,
                ),
                extraContext = TEMPLATE_CONTEXT,
            ),
        ).also { conversation ->
            retainedConversation = conversation
            sessionHistory = request.history
            sessionSystemInstruction = request.systemInstruction
            sessionSampling = request.sampling
        }
    }

    private fun closeConversation() {
        val conversation = retainedConversation
        retainedConversation = null
        generatingConversation = null
        sessionHistory = emptyList()
        sessionSystemInstruction = null
        sessionSampling = null
        if (conversation != null) runCatching { conversation.close() }
    }

    private fun closeEngine() {
        val engine = activeEngine
        activeEngine = null
        backend = null
        if (engine?.isInitialized() == true) runCatching { engine.close() }
    }

    private companion object {
        const val TAG = "LiteRtGemma"
        val TEMPLATE_CONTEXT: Map<String, Any> = mapOf("enable_thinking" to false)
    }
}
