package jp.stackchan.localvoicepoc.piper

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.BufferedInputStream
import java.io.BufferedOutputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.util.zip.ZipInputStream

internal object PiperDictionaryExtractor {
    suspend fun extract(
        archive: File,
        destination: File,
        entryPrefix: String,
        onProgress: suspend (Float) -> Unit = {},
    ) = withContext(Dispatchers.IO) {
        require(archive.isFile && archive.length() > 0L) {
            "OpenJTalk辞書ZIPが見つかりません"
        }
        require(entryPrefix.endsWith('/')) { "辞書ZIP内のパス指定が不正です" }

        val staging = destination.resolveSibling("${destination.name}.staging")
        val backup = destination.resolveSibling("${destination.name}.backup")
        staging.deleteRecursively()
        backup.deleteRecursively()
        check(staging.mkdirs()) { "OpenJTalk辞書の展開先を作成できません" }

        try {
            var extractedBytes = 0L
            var extractedFiles = 0
            ZipInputStream(BufferedInputStream(FileInputStream(archive), BUFFER_BYTES)).use { zip ->
                while (true) {
                    currentCoroutineContext().ensureActive()
                    val entry = zip.nextEntry ?: break
                    try {
                        if (!entry.name.startsWith(entryPrefix)) continue
                        val relativeName = entry.name.removePrefix(entryPrefix)
                        if (relativeName.isBlank()) continue

                        val target = safeTarget(staging, relativeName)
                        if (entry.isDirectory) {
                            check(target.isDirectory || target.mkdirs()) {
                                "OpenJTalk辞書のフォルダを作成できません: $relativeName"
                            }
                            continue
                        }

                        target.parentFile?.let { parent ->
                            check(parent.isDirectory || parent.mkdirs()) {
                                "OpenJTalk辞書のフォルダを作成できません: $relativeName"
                            }
                        }
                        BufferedOutputStream(FileOutputStream(target), BUFFER_BYTES).use { output ->
                            val buffer = ByteArray(BUFFER_BYTES)
                            while (true) {
                                currentCoroutineContext().ensureActive()
                                val count = zip.read(buffer)
                                if (count < 0) break
                                extractedBytes += count
                                check(extractedBytes <= MAX_EXTRACTED_BYTES) {
                                    "OpenJTalk辞書の展開サイズが上限を超えました"
                                }
                                output.write(buffer, 0, count)
                                onProgress(
                                    (extractedBytes.toDouble() / PiperAssetLinks.EXTRACTED_DICTIONARY_BYTES)
                                        .toFloat()
                                        .coerceIn(0f, 1f),
                                )
                            }
                        }
                        extractedFiles += 1
                    } finally {
                        zip.closeEntry()
                    }
                }
            }

            check(extractedFiles > 0) { "ZIP内にOpenJTalk辞書が見つかりません" }
            val missingFiles = OpenJTalkDictionaryFiles.missingFrom(staging)
            check(missingFiles.isEmpty()) {
                "OpenJTalk辞書の必須ファイルが不足しています: ${missingFiles.joinToString()}"
            }

            replaceDirectory(staging, destination, backup)
            onProgress(1f)
        } catch (error: Throwable) {
            staging.deleteRecursively()
            if (!destination.exists() && backup.exists()) {
                backup.renameTo(destination)
            }
            throw error
        } finally {
            backup.deleteRecursively()
        }
    }

    private fun safeTarget(root: File, relativeName: String): File {
        require('\\' !in relativeName) { "辞書ZIPに不正なパスが含まれています" }
        val target = root.resolve(relativeName)
        val rootPath = root.canonicalFile.toPath()
        val targetPath = target.canonicalFile.toPath()
        require(targetPath.startsWith(rootPath)) {
            "辞書ZIPに展開先外のパスが含まれています"
        }
        return target
    }

    private fun replaceDirectory(staging: File, destination: File, backup: File) {
        if (destination.exists()) {
            check(destination.renameTo(backup)) {
                "既存のOpenJTalk辞書を退避できません"
            }
        }
        if (!staging.renameTo(destination)) {
            if (backup.exists()) backup.renameTo(destination)
            error("OpenJTalk辞書を配置できません")
        }
        backup.deleteRecursively()
    }

    private const val BUFFER_BYTES = 1024 * 1024
    private const val MAX_EXTRACTED_BYTES = 160L * 1024L * 1024L
}
