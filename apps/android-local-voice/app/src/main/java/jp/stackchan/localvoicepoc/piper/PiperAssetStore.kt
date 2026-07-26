package jp.stackchan.localvoicepoc.piper

import android.content.Context
import android.net.Uri
import android.os.storage.StorageManager
import androidx.documentfile.provider.DocumentFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.nio.file.Files

class PiperAssetStore(context: Context) {
    data class RecommendedProgress(
        val stage: String,
        val fraction: Float,
    )

    private val appContext = context.applicationContext
    private val preferences = PiperPreferences(appContext)
    private val baseDirectory = File(appContext.filesDir, "piper-plus")
    private val storageManager = appContext.getSystemService(StorageManager::class.java)

    fun hasConfirmedRecommendedTerms(): Boolean =
        preferences.hasConfirmedRecommendedTerms(PiperAssetLinks.RECOMMENDED_SETUP_ID)

    fun confirmRecommendedTerms() {
        preferences.confirmRecommendedTerms(PiperAssetLinks.RECOMMENDED_SETUP_ID)
    }

    suspend fun prepareRecommended(
        onProgress: suspend (RecommendedProgress) -> Unit,
    ): PiperInstallation = withContext(Dispatchers.IO) {
        check(baseDirectory.isDirectory || baseDirectory.mkdirs()) {
            "Piper Plusの保存先を作成できません: ${baseDirectory.absolutePath}"
        }
        val recommendedDirectory = baseDirectory.resolve(
            "recommended/${PiperAssetLinks.RECOMMENDED_SETUP_ID}",
        )
        val downloader = PiperAssetDownloader(recommendedDirectory)
        if (!hasTrustedRecommendedInstallation(recommendedDirectory, downloader)) {
            ensureRecommendedFreeSpace()
        }
        var completedBytes = 0L

        suspend fun prepareArtifact(artifact: PiperDownloadArtifact): File {
            val file = downloader.prepare(artifact) { progress ->
                val action = when (progress.stage) {
                    PiperAssetDownloader.Stage.CHECKING -> "確認中"
                    PiperAssetDownloader.Stage.DOWNLOADING ->
                        "ダウンロード中 ${(progress.fraction * 100).toInt()}%"
                    PiperAssetDownloader.Stage.VERIFYING ->
                        "SHA-256検証中 ${(progress.fraction * 100).toInt()}%"
                }
                val artifactFraction = when (progress.stage) {
                    PiperAssetDownloader.Stage.CHECKING -> progress.fraction
                    PiperAssetDownloader.Stage.DOWNLOADING -> progress.fraction * 0.9f
                    PiperAssetDownloader.Stage.VERIFYING -> 0.9f + progress.fraction * 0.1f
                }
                val downloadedFraction = (
                    (completedBytes + artifact.expectedBytes * artifactFraction) /
                        PiperAssetLinks.recommendedDownloadBytes.toDouble()
                    ).toFloat().coerceIn(0f, 1f)
                val overall = downloadedFraction * DOWNLOAD_PROGRESS_WEIGHT
                onProgress(RecommendedProgress("${artifact.name}: $action", overall))
            }
            completedBytes += artifact.expectedBytes
            return file
        }

        val model = prepareArtifact(PiperAssetLinks.MODEL)
        val config = prepareArtifact(PiperAssetLinks.CONFIG)
        val dictionaryDirectory = recommendedDirectory.resolve("open_jtalk_dic")
        val dictionaryMarker = recommendedDirectory.resolve("open_jtalk_dic.sha256")
        val trustedDictionary = dictionaryDirectory.isDirectory &&
            OpenJTalkDictionaryFiles.missingFrom(dictionaryDirectory).isEmpty() &&
            dictionaryMarker.isFile &&
            dictionaryMarker.readText().trim() == PiperAssetLinks.DICTIONARY_ARCHIVE.sha256

        if (trustedDictionary) {
            completedBytes += PiperAssetLinks.DICTIONARY_ARCHIVE.expectedBytes
            val staleArchive = recommendedDirectory.resolve(
                PiperAssetLinks.DICTIONARY_ARCHIVE.fileName,
            )
            Files.deleteIfExists(staleArchive.toPath())
            Files.deleteIfExists(
                staleArchive.resolveSibling("${staleArchive.name}.sha256").toPath(),
            )
            onProgress(RecommendedProgress("OpenJTalk辞書: 確認済み", 1f))
        } else {
            val dictionaryArchive = prepareArtifact(PiperAssetLinks.DICTIONARY_ARCHIVE)
            onProgress(
                RecommendedProgress(
                    "OpenJTalk辞書: 展開中 0%",
                    DOWNLOAD_PROGRESS_WEIGHT,
                ),
            )
            PiperDictionaryExtractor.extract(
                archive = dictionaryArchive,
                destination = dictionaryDirectory,
                entryPrefix = PiperAssetLinks.DICTIONARY_ENTRY_PREFIX,
            ) { fraction ->
                onProgress(
                    RecommendedProgress(
                        "OpenJTalk辞書: 展開中 ${(fraction * 100).toInt()}%",
                        DOWNLOAD_PROGRESS_WEIGHT +
                            fraction * (1f - DOWNLOAD_PROGRESS_WEIGHT),
                    ),
                )
            }
            dictionaryMarker.writeText("${PiperAssetLinks.DICTIONARY_ARCHIVE.sha256}\n")
            Files.deleteIfExists(dictionaryArchive.toPath())
            Files.deleteIfExists(
                dictionaryArchive.resolveSibling("${dictionaryArchive.name}.sha256").toPath(),
            )
        }

        val installation = PiperInstallation(
            model = model,
            config = config,
            dictionaryDirectory = dictionaryDirectory,
        )
        check(installation.isComplete) { "Piper Plusの推奨ファイル一式を準備できませんでした" }
        preferences.save(installation)
        onProgress(RecommendedProgress("ファイル準備完了", 1f))
        installation
    }

    suspend fun importModel(uri: Uri): PiperInstallation = withContext(Dispatchers.IO) {
        baseDirectory.mkdirs()
        val current = preferences.installation()
        val destination = File(baseDirectory, "voice.onnx")
        copyContent(uri, destination)
        current.copy(model = destination).also(preferences::save)
    }

    suspend fun importConfig(uri: Uri): PiperInstallation = withContext(Dispatchers.IO) {
        baseDirectory.mkdirs()
        val current = preferences.installation()
        val destination = File(baseDirectory, "voice.onnx.json")
        copyContent(uri, destination)
        current.copy(config = destination).also(preferences::save)
    }

    suspend fun importDictionary(treeUri: Uri): PiperInstallation = withContext(Dispatchers.IO) {
        baseDirectory.mkdirs()
        val root = DocumentFile.fromTreeUri(appContext, treeUri)
            ?: error("OpenJTalk dictionary folder could not be opened")
        require(root.isDirectory) { "Selected OpenJTalk item is not a directory" }

        val destination = File(baseDirectory, "open_jtalk_dic")
        destination.deleteRecursively()
        destination.mkdirs()
        copyTree(root, destination)
        OpenJTalkDictionaryFiles.restoreTrashedNames(destination)
        val missingFiles = OpenJTalkDictionaryFiles.missingFrom(destination)
        require(missingFiles.isEmpty()) {
            "OpenJTalk辞書の必須ファイルが不足しています: ${missingFiles.joinToString()}"
        }

        preferences.installation().copy(dictionaryDirectory = destination).also(preferences::save)
    }

    fun current(): PiperInstallation = preferences.installation().also { installation ->
        OpenJTalkDictionaryFiles.restoreTrashedNames(installation.dictionaryDirectory)
    }

    private fun hasTrustedRecommendedInstallation(
        recommendedDirectory: File,
        downloader: PiperAssetDownloader,
    ): Boolean {
        val dictionaryDirectory = recommendedDirectory.resolve("open_jtalk_dic")
        val dictionaryMarker = recommendedDirectory.resolve("open_jtalk_dic.sha256")
        return downloader.isTrusted(PiperAssetLinks.MODEL) &&
            downloader.isTrusted(PiperAssetLinks.CONFIG) &&
            dictionaryDirectory.isDirectory &&
            OpenJTalkDictionaryFiles.missingFrom(dictionaryDirectory).isEmpty() &&
            dictionaryMarker.isFile &&
            dictionaryMarker.readText().trim() == PiperAssetLinks.DICTIONARY_ARCHIVE.sha256
    }

    private fun ensureRecommendedFreeSpace() {
        val requiredBytes = PiperAssetLinks.recommendedDownloadBytes +
            PiperAssetLinks.EXTRACTED_DICTIONARY_BYTES +
            FREE_SPACE_MARGIN_BYTES
        val availableBytes = baseDirectory.usableSpace
        val storageUuid = storageManager.getUuidForPath(baseDirectory)
        val allocatableBytes = storageManager.getAllocatableBytes(storageUuid)
        if (allocatableBytes in 1 until requiredBytes) {
            val requiredMiB = requiredBytes / MEBIBYTE
            val availableMiB = allocatableBytes / MEBIBYTE
            error(
                "Piper Plus推奨音声用の空き容量が不足しています。" +
                    "必要: ${requiredMiB}MiB、空き: ${availableMiB}MiB",
            )
        }
        if (availableBytes in 1 until requiredBytes) {
            runCatching { storageManager.allocateBytes(storageUuid, requiredBytes) }
                .getOrElse { error ->
                    throw IllegalStateException(
                        "Piper Plus推奨音声用の保存領域を確保できません: " +
                            (error.message ?: error::class.java.simpleName),
                        error,
                    )
                }
        }
    }

    private fun copyContent(uri: Uri, destination: File) {
        val input = appContext.contentResolver.openInputStream(uri)
            ?: error("Selected file could not be opened")
        destination.parentFile?.mkdirs()
        input.use { source ->
            destination.outputStream().buffered().use { output -> source.copyTo(output) }
        }
        require(destination.length() > 0L) { "Imported file is empty" }
    }

    private fun copyTree(source: DocumentFile, destination: File) {
        source.listFiles().forEach { child ->
            val safeName = child.name?.replace(Regex("[^A-Za-z0-9._-]"), "_")
                ?.takeIf { it.isNotBlank() && it != "." && it != ".." }
                ?: return@forEach
            val target = File(destination, safeName)
            when {
                child.isDirectory -> {
                    target.mkdirs()
                    copyTree(child, target)
                }
                child.isFile -> copyContent(child.uri, target)
            }
        }
    }

    private companion object {
        const val DOWNLOAD_PROGRESS_WEIGHT = 0.9f
        const val FREE_SPACE_MARGIN_BYTES = 128L * 1024L * 1024L
        const val MEBIBYTE = 1024L * 1024L
    }
}
