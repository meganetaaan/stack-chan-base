package jp.stackchan.localvoicepoc.model

import android.content.Context
import android.util.Log
import jp.stackchan.localvoicepoc.speech.LocalSpeechRecognizer
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout

class ModelSetupManager(
    context: Context,
    speechRecognizer: LocalSpeechRecognizer,
    private val languageModel: LocalLanguageModel,
) {
    private val appContext = context.applicationContext
    private val legacyModels = LegacyModelCleaner(context)
    private val speechModels = RunAnywhereSpeechModelManager(speechRecognizer)

    suspend fun hasPreparedAssets(modelSpec: GemmaModelSpec): Boolean =
        withContext(Dispatchers.IO) {
            GemmaModelStore(appContext, modelSpec).isPrepared() && speechModels.isPrepared()
        }

    suspend fun prepareAll(
        modelSpec: GemmaModelSpec,
        onProgress: suspend (ModelPreparationProgress) -> Unit,
    ) =
        withContext(Dispatchers.IO) {
            val gemmaStore = GemmaModelStore(appContext, modelSpec)
            val modelFile = gemmaStore.prepare { progress ->
                val stage = when (progress.stage) {
                    GemmaModelStore.Stage.CHECKING -> "既存ファイルを確認中"
                    GemmaModelStore.Stage.DOWNLOADING ->
                        "ダウンロード中 ${(progress.fraction * 100).toInt()}%"
                    GemmaModelStore.Stage.VERIFYING ->
                        "SHA-256検証中 ${(progress.fraction * 100).toInt()}%"
                }
                onProgress(ModelPreparationProgress(ModelComponent.LLM, stage, progress.fraction))
            }

            val loadingStage = if (modelSpec.runtime == LanguageModelRuntime.LLAMA_CPP) {
                "llama.cppでロード中"
            } else {
                "GPU優先でロード中"
            }
            onProgress(ModelPreparationProgress(ModelComponent.LLM, loadingStage, 1f))
            var backend = languageModel.prepare(modelSpec, modelFile)

            onProgress(ModelPreparationProgress(ModelComponent.LLM, "ウォームアップ中", 1f))
            val initialWarmUp = tryWarmUp()
            if (initialWarmUp.isFailure && backend == LanguageModelBackend.GPU) {
                val gpuError = requireNotNull(initialWarmUp.exceptionOrNull())
                onProgress(ModelPreparationProgress(ModelComponent.LLM, "GPU生成失敗、CPUへ退避", 1f))
                backend = languageModel.prepare(
                    modelSpec,
                    modelFile,
                    preference = LanguageModelBackendPreference.CPU_ONLY,
                )
                tryWarmUp().getOrElse { cpuError ->
                    throw IllegalStateException(
                        "${modelSpec.name}の生成検査に失敗しました。" +
                            "GPU: ${gpuError.message ?: gpuError::class.java.simpleName} / " +
                            "CPU: ${cpuError.message ?: cpuError::class.java.simpleName}",
                        cpuError,
                    )
                }
            } else {
                initialWarmUp.getOrThrow()
            }
            onProgress(
                ModelPreparationProgress(
                    ModelComponent.LLM,
                    "準備完了 (${backend.displayName})",
                    1f,
                ),
            )

            speechModels.prepare(onProgress)
            onProgress(ModelPreparationProgress(ModelComponent.LLM, "旧LLMを整理中", 1f))
            try {
                legacyModels.removeObsoleteQwen()
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                Log.w(TAG, "Could not remove the obsolete Qwen model", error)
            }
            onProgress(
                ModelPreparationProgress(
                    ModelComponent.LLM,
                    "準備完了 (${backend.displayName})",
                    1f,
                ),
            )
        }

    private suspend fun warmUp() {
        withTimeout(WARM_UP_TIMEOUT_MS) {
            languageModel.generate(
                GenerationRequest(
                    systemInstruction = "日本語で指示どおりに短く答えてください。",
                    history = emptyList(),
                    userText = "「はい」とだけ答えてください。",
                    sampling = SamplingProfile(temperature = 0.1),
                ),
            ).collect()
        }
    }

    private suspend fun tryWarmUp(): Result<Unit> = try {
        warmUp()
        Result.success(Unit)
    } catch (error: TimeoutCancellationException) {
        Result.failure(error)
    } catch (error: CancellationException) {
        throw error
    } catch (error: Throwable) {
        Result.failure(error)
    }

    private companion object {
        const val TAG = "ModelSetupManager"
        const val WARM_UP_TIMEOUT_MS = 60_000L
    }
}
