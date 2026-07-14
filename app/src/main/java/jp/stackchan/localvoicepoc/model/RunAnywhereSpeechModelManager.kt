package jp.stackchan.localvoicepoc.model

import com.runanywhere.sdk.core.types.InferenceFramework
import com.runanywhere.sdk.foundation.bridge.extensions.CppBridgeModelRegistry
import com.runanywhere.sdk.public.RunAnywhere
import com.runanywhere.sdk.public.extensions.Models.ModelCategory
import com.runanywhere.sdk.public.extensions.Models.ModelFileDescriptor
import com.runanywhere.sdk.public.extensions.Models.ModelInfo
import com.runanywhere.sdk.public.extensions.downloadModel
import com.runanywhere.sdk.public.extensions.registerMultiFileModel
import jp.stackchan.localvoicepoc.speech.LocalSpeechRecognizer
import java.io.File

/** RunAnywhere is retained only as the download registry for the sherpa-onnx ASR files. */
class RunAnywhereSpeechModelManager(
    private val speechRecognizer: LocalSpeechRecognizer,
) {
    suspend fun prepare(onProgress: suspend (ModelPreparationProgress) -> Unit) {
        val stt = registerStt()
        CppBridgeModelRegistry.scanAndRestoreDownloadedModels()

        downloadAndLoad(stt, onProgress)
        onProgress(ModelPreparationProgress(ModelComponent.VAD, "準備完了", 1f))
    }

    private fun registerStt(): ModelInfo {
        val model = ModelCatalog.stt
        return RunAnywhere.registerMultiFileModel(
            id = model.id,
            name = model.name,
            files = model.files.map { file ->
                ModelFileDescriptor(
                    url = file.url,
                    filename = file.filename,
                    isRequired = true,
                )
            },
            framework = InferenceFramework.ONNX,
            modality = ModelCategory.SPEECH_RECOGNITION,
            memoryRequirement = model.memoryBytes,
        )
    }

    private suspend fun downloadAndLoad(
        model: ModelInfo,
        onProgress: suspend (ModelPreparationProgress) -> Unit,
    ) {
        if (downloadedModelPath(model.id) == null) {
            onProgress(ModelPreparationProgress(ModelComponent.STT, "ダウンロード中", 0f))
            RunAnywhere.downloadModel(model.id).collect { update ->
                val fraction = update.progress.coerceIn(0f, 1f)
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
        val localPath = CppBridgeModelRegistry.get(modelId)?.localPath.orEmpty()
        if (localPath.isBlank()) return null
        return File(localPath).takeIf(File::exists)
    }
}
