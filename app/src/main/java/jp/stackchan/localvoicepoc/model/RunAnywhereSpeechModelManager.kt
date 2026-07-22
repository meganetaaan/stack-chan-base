package jp.stackchan.localvoicepoc.model

import ai.runanywhere.proto.v1.InferenceFramework
import ai.runanywhere.proto.v1.ModelCategory
import ai.runanywhere.proto.v1.ModelFileDescriptor
import ai.runanywhere.proto.v1.ModelInfo
import com.runanywhere.sdk.foundation.bridge.extensions.CppBridgeModelRegistry
import com.runanywhere.sdk.public.RunAnywhere
import com.runanywhere.sdk.public.extensions.Models.create
import com.runanywhere.sdk.public.extensions.downloadModel
import com.runanywhere.sdk.public.extensions.registerModel
import jp.stackchan.localvoicepoc.speech.LocalSpeechRecognizer
import java.io.File

/** RunAnywhere is retained only as the download registry for the sherpa-onnx ASR files. */
class RunAnywhereSpeechModelManager(
    private val speechRecognizer: LocalSpeechRecognizer,
) {
    fun isPrepared(): Boolean {
        CppBridgeModelRegistry.discoverDownloadedModels()
        return downloadedModelPath(ModelCatalog.stt.id) != null
    }

    suspend fun prepare(onProgress: suspend (ModelPreparationProgress) -> Unit) {
        val stt = registerStt()
        CppBridgeModelRegistry.discoverDownloadedModels()

        downloadAndLoad(stt, onProgress)
        onProgress(ModelPreparationProgress(ModelComponent.VAD, "準備完了", 1f))
    }

    private suspend fun registerStt(): ModelInfo {
        val model = ModelCatalog.stt
        return RunAnywhere.registerModel(
            id = model.id,
            name = model.name,
            multiFile = model.files.map { file ->
                ModelFileDescriptor.create(
                    url = file.url,
                    filename = file.filename,
                    isRequired = true,
                )
            },
            framework = InferenceFramework.INFERENCE_FRAMEWORK_ONNX,
            modality = ModelCategory.MODEL_CATEGORY_SPEECH_RECOGNITION,
            memoryRequirement = model.memoryBytes,
        )
    }

    private suspend fun downloadAndLoad(
        model: ModelInfo,
        onProgress: suspend (ModelPreparationProgress) -> Unit,
    ) {
        if (downloadedModelPath(model.id) == null) {
            onProgress(ModelPreparationProgress(ModelComponent.STT, "ダウンロード中", 0f))
            RunAnywhere.downloadModel(model) { update ->
                val fraction = update.overall_progress.coerceIn(0f, 1f)
                onProgress(
                    ModelPreparationProgress(
                        component = ModelComponent.STT,
                        stage = "ダウンロード中 ${(fraction * 100).toInt()}%",
                        fraction = fraction,
                    ),
                )
            }
        }

        onProgress(ModelPreparationProgress(ModelComponent.STT, "ロード中", 1f))
        val downloadedPath = requireNotNull(downloadedModelPath(model.id)) {
            "Whisperの保存先を取得できません"
        }
        val modelDirectory = if (downloadedPath.isDirectory) {
            downloadedPath
        } else {
            requireNotNull(downloadedPath.parentFile) { "Whisperモデルのフォルダーを取得できません" }
        }
        speechRecognizer.load(modelDirectory)
        onProgress(ModelPreparationProgress(ModelComponent.STT, "準備完了", 1f))
    }

    private fun downloadedModelPath(modelId: String): File? {
        val localPath = CppBridgeModelRegistry.get(modelId)?.local_path.orEmpty()
        if (localPath.isBlank()) return null
        return File(localPath).takeIf(File::exists)
    }
}
