package jp.stackchan.localvoicepoc.model

import android.content.Context
import android.os.storage.StorageManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.withContext
import java.io.BufferedInputStream
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Locale

class GemmaModelStore(
    context: Context,
    private val modelSpec: GemmaModelSpec,
) {
    enum class Stage { CHECKING, DOWNLOADING, VERIFYING }

    data class Progress(
        val stage: Stage,
        val fraction: Float,
    )

    private val modelDirectory = context.noBackupFilesDir.resolve("models/${modelSpec.id}")
    private val storageManager = context.getSystemService(StorageManager::class.java)
    private val modelFile = modelDirectory.resolve(modelSpec.fileName)
    private val partialFile = modelDirectory.resolve("${modelSpec.fileName}.part")
    private val verifiedMarker = modelDirectory.resolve("${modelSpec.fileName}.sha256")

    suspend fun prepare(onProgress: suspend (Progress) -> Unit): File = withContext(Dispatchers.IO) {
        check(modelDirectory.isDirectory || modelDirectory.mkdirs()) {
            "モデル保存先を作成できません: ${modelDirectory.absolutePath}"
        }
        onProgress(Progress(Stage.CHECKING, 0f))

        if (isTrustedExistingModel()) {
            onProgress(Progress(Stage.CHECKING, 1f))
            return@withContext modelFile
        }

        if (modelFile.isFile && modelFile.length() == modelSpec.expectedBytes) {
            onProgress(Progress(Stage.VERIFYING, 0f))
            val checksum = sha256(modelFile) { fraction ->
                onProgress(Progress(Stage.VERIFYING, fraction))
            }
            if (checksum == modelSpec.sha256) {
                writeVerifiedMarker()
                onProgress(Progress(Stage.VERIFYING, 1f))
                return@withContext modelFile
            }
        }

        Files.deleteIfExists(modelFile.toPath())
        Files.deleteIfExists(verifiedMarker.toPath())
        if (partialFile.length() > modelSpec.expectedBytes) {
            Files.deleteIfExists(partialFile.toPath())
        }

        ensureFreeSpace()
        download(onProgress)

        onProgress(Progress(Stage.VERIFYING, 0f))
        val checksum = sha256(partialFile) { fraction ->
            onProgress(Progress(Stage.VERIFYING, fraction))
        }
        if (checksum != modelSpec.sha256) {
            Files.deleteIfExists(partialFile.toPath())
            error("${modelSpec.name}のSHA-256が一致しません。再度ダウンロードしてください。")
        }

        moveAtomically(partialFile, modelFile)
        writeVerifiedMarker()
        onProgress(Progress(Stage.VERIFYING, 1f))
        modelFile
    }

    fun isPrepared(): Boolean =
        modelFile.isFile &&
            modelFile.length() == modelSpec.expectedBytes &&
            verifiedMarker.isFile &&
            verifiedMarker.readText().trim() == modelSpec.sha256

    private fun isTrustedExistingModel(): Boolean = isPrepared()

    private fun ensureFreeSpace() {
        val downloadedBytes = partialFile.length().coerceAtMost(modelSpec.expectedBytes)
        val requiredBytes = modelSpec.expectedBytes - downloadedBytes + FREE_SPACE_MARGIN_BYTES
        val storageUuid = storageManager.getUuidForPath(modelDirectory)
        val allocatableBytes = storageManager.getAllocatableBytes(storageUuid)
        if (allocatableBytes in 1 until requiredBytes) {
            val requiredGiB = requiredBytes.toDouble() / GIBIBYTE
            val availableGiB = allocatableBytes.toDouble() / GIBIBYTE
            error(
                "${modelSpec.name}用の空き容量が不足しています。" +
                    String.format(
                        Locale.ROOT,
                        "必要: %.2f GiB、空き: %.2f GiB",
                        requiredGiB,
                        availableGiB,
                    ),
            )
        }
        if (modelDirectory.usableSpace in 1 until requiredBytes) {
            runCatching { storageManager.allocateBytes(storageUuid, requiredBytes) }
                .getOrElse { error ->
                    throw IllegalStateException(
                        "${modelSpec.name}用の保存領域を確保できません: " +
                            (error.message ?: error::class.java.simpleName),
                        error,
                    )
                }
        }
    }

    private suspend fun download(onProgress: suspend (Progress) -> Unit) {
        var restartedAfterRangeError = false
        while (partialFile.length() < modelSpec.expectedBytes) {
            currentCoroutineContext().ensureActive()
            val requestedOffset = partialFile.length()
            val connection = openConnection(requestedOffset)
            try {
                val responseCode = connection.responseCode
                if (responseCode == HTTP_RANGE_NOT_SATISFIABLE && !restartedAfterRangeError) {
                    Files.deleteIfExists(partialFile.toPath())
                    restartedAfterRangeError = true
                    continue
                }
                check(responseCode == HttpURLConnection.HTTP_OK || responseCode == HttpURLConnection.HTTP_PARTIAL) {
                    "Gemma 4モデルの取得に失敗しました: HTTP $responseCode"
                }

                val append = responseCode == HttpURLConnection.HTTP_PARTIAL
                if (append) validateContentRange(connection, requestedOffset)
                val offset = if (append) requestedOffset else 0L
                val before = partialFile.length()

                BufferedInputStream(connection.inputStream, BUFFER_BYTES).use { input ->
                    FileOutputStream(partialFile, append).use { output ->
                        val buffer = ByteArray(BUFFER_BYTES)
                        var total = offset
                        var lastReportedAt = 0L
                        while (true) {
                            currentCoroutineContext().ensureActive()
                            val count = input.read(buffer)
                            if (count < 0) break
                            output.write(buffer, 0, count)
                            total += count
                            val now = System.nanoTime()
                            if (now - lastReportedAt >= PROGRESS_INTERVAL_NANOS) {
                                onProgress(
                                    Progress(
                                        Stage.DOWNLOADING,
                                        (total.toDouble() / modelSpec.expectedBytes)
                                            .toFloat()
                                            .coerceIn(0f, 1f),
                                    ),
                                )
                                lastReportedAt = now
                            }
                        }
                        output.fd.sync()
                    }
                }

                check(partialFile.length() > before || partialFile.length() == modelSpec.expectedBytes) {
                    "${modelSpec.name}のダウンロードが途中で停止しました"
                }
                check(partialFile.length() <= modelSpec.expectedBytes) {
                    "${modelSpec.name}のファイルサイズが配布情報と一致しません"
                }
            } finally {
                connection.disconnect()
            }
        }

        check(partialFile.length() == modelSpec.expectedBytes) {
            "${modelSpec.name}のダウンロードが完了していません"
        }
        onProgress(Progress(Stage.DOWNLOADING, 1f))
    }

    private fun openConnection(offset: Long): HttpURLConnection {
        var url = URL(modelSpec.downloadUrl)
        repeat(MAX_REDIRECTS + 1) { redirectCount ->
            val connection = (url.openConnection() as HttpURLConnection).apply {
                instanceFollowRedirects = false
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                setRequestProperty("Accept-Encoding", "identity")
                setRequestProperty("User-Agent", "stackchan-local-voice-poc/0.1")
                if (offset > 0L) setRequestProperty("Range", "bytes=$offset-")
            }
            val code = connection.responseCode
            if (code !in REDIRECT_CODES) return connection

            val location = connection.getHeaderField("Location")
            connection.disconnect()
            check(!location.isNullOrBlank() && redirectCount < MAX_REDIRECTS) {
                "Gemma 4モデルの取得先を解決できません"
            }
            url = URL(url, location)
        }
        error("Gemma 4モデルの取得でリダイレクト回数を超えました")
    }

    private fun validateContentRange(connection: HttpURLConnection, expectedOffset: Long) {
        val value = connection.getHeaderField("Content-Range").orEmpty()
        val match = CONTENT_RANGE.matchEntire(value)
        check(match != null && match.groupValues[1].toLong() == expectedOffset) {
            "Gemma 4モデルの再開位置がサーバー応答と一致しません"
        }
        val total = match.groupValues[3]
        check(total == "*" || total.toLong() == modelSpec.expectedBytes) {
            "${modelSpec.name}の配布サイズが変更されています"
        }
    }

    private suspend fun sha256(file: File, onProgress: suspend (Float) -> Unit): String {
        val digest = MessageDigest.getInstance("SHA-256")
        var processed = 0L
        FileInputStream(file).use { input ->
            val buffer = ByteArray(CHECKSUM_BUFFER_BYTES)
            while (true) {
                currentCoroutineContext().ensureActive()
                val count = input.read(buffer)
                if (count < 0) break
                digest.update(buffer, 0, count)
                processed += count
                onProgress((processed.toDouble() / file.length()).toFloat().coerceIn(0f, 1f))
            }
        }
        return digest.digest().joinToString(separator = "") { byte ->
            val value = byte.toInt() and 0xff
            "${HEX_DIGITS[value ushr 4]}${HEX_DIGITS[value and 0x0f]}"
        }
    }

    private fun writeVerifiedMarker() {
        verifiedMarker.writeText("${modelSpec.sha256}\n")
    }

    private fun moveAtomically(source: File, destination: File) {
        try {
            Files.move(
                source.toPath(),
                destination.toPath(),
                StandardCopyOption.ATOMIC_MOVE,
                StandardCopyOption.REPLACE_EXISTING,
            )
        } catch (_: AtomicMoveNotSupportedException) {
            Files.move(source.toPath(), destination.toPath(), StandardCopyOption.REPLACE_EXISTING)
        }
    }

    private companion object {
        const val BUFFER_BYTES = 1024 * 1024
        const val CHECKSUM_BUFFER_BYTES = 4 * 1024 * 1024
        const val CONNECT_TIMEOUT_MS = 30_000
        const val READ_TIMEOUT_MS = 60_000
        const val HTTP_RANGE_NOT_SATISFIABLE = 416
        const val MAX_REDIRECTS = 5
        const val PROGRESS_INTERVAL_NANOS = 250_000_000L
        const val FREE_SPACE_MARGIN_BYTES = 512L * 1024L * 1024L
        const val GIBIBYTE = 1024.0 * 1024.0 * 1024.0
        val REDIRECT_CODES = setOf(301, 302, 303, 307, 308)
        val CONTENT_RANGE = Regex("bytes (\\d+)-(\\d+)/(\\d+|\\*)")
        const val HEX_DIGITS = "0123456789abcdef"
    }
}
