package jp.stackchan.localvoicepoc.piper

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

internal class PiperAssetDownloader(private val directory: File) {
    enum class Stage { CHECKING, DOWNLOADING, VERIFYING }

    data class Progress(
        val stage: Stage,
        val fraction: Float,
    )

    fun isTrusted(artifact: PiperDownloadArtifact): Boolean =
        isTrusted(
            destination = directory.resolve(artifact.fileName),
            marker = directory.resolve("${artifact.fileName}.sha256"),
            artifact = artifact,
        )

    suspend fun prepare(
        artifact: PiperDownloadArtifact,
        onProgress: suspend (Progress) -> Unit,
    ): File = withContext(Dispatchers.IO) {
        check(directory.isDirectory || directory.mkdirs()) {
            "Piper Plusの保存先を作成できません: ${directory.absolutePath}"
        }

        val destination = directory.resolve(artifact.fileName)
        val partial = directory.resolve("${artifact.fileName}.part")
        val marker = directory.resolve("${artifact.fileName}.sha256")
        onProgress(Progress(Stage.CHECKING, 0f))

        if (isTrusted(artifact)) {
            onProgress(Progress(Stage.CHECKING, 1f))
            return@withContext destination
        }

        if (destination.isFile && destination.length() == artifact.expectedBytes) {
            onProgress(Progress(Stage.VERIFYING, 0f))
            val checksum = sha256(destination) { fraction ->
                onProgress(Progress(Stage.VERIFYING, fraction))
            }
            if (checksum == artifact.sha256) {
                writeMarker(marker, artifact.sha256)
                onProgress(Progress(Stage.VERIFYING, 1f))
                return@withContext destination
            }
        }

        Files.deleteIfExists(destination.toPath())
        Files.deleteIfExists(marker.toPath())
        if (partial.length() > artifact.expectedBytes) {
            Files.deleteIfExists(partial.toPath())
        }

        download(artifact, partial, onProgress)
        onProgress(Progress(Stage.VERIFYING, 0f))
        val checksum = sha256(partial) { fraction ->
            onProgress(Progress(Stage.VERIFYING, fraction))
        }
        if (checksum != artifact.sha256) {
            Files.deleteIfExists(partial.toPath())
            error("${artifact.name}のSHA-256が一致しません。再度ダウンロードしてください。")
        }

        moveAtomically(partial, destination)
        writeMarker(marker, artifact.sha256)
        onProgress(Progress(Stage.VERIFYING, 1f))
        destination
    }

    private fun isTrusted(
        destination: File,
        marker: File,
        artifact: PiperDownloadArtifact,
    ): Boolean =
        destination.isFile &&
            destination.length() == artifact.expectedBytes &&
            marker.isFile &&
            marker.readText().trim() == artifact.sha256

    private suspend fun download(
        artifact: PiperDownloadArtifact,
        partial: File,
        onProgress: suspend (Progress) -> Unit,
    ) {
        var restartedAfterRangeError = false
        while (partial.length() < artifact.expectedBytes) {
            currentCoroutineContext().ensureActive()
            val requestedOffset = partial.length()
            val connection = openConnection(artifact.url, requestedOffset)
            try {
                val responseCode = connection.responseCode
                if (responseCode == HTTP_RANGE_NOT_SATISFIABLE && !restartedAfterRangeError) {
                    Files.deleteIfExists(partial.toPath())
                    restartedAfterRangeError = true
                    continue
                }
                check(
                    responseCode == HttpURLConnection.HTTP_OK ||
                        responseCode == HttpURLConnection.HTTP_PARTIAL,
                ) {
                    "${artifact.name}の取得に失敗しました: HTTP $responseCode"
                }

                val append = responseCode == HttpURLConnection.HTTP_PARTIAL
                if (append) validateContentRange(connection, requestedOffset, artifact)
                val offset = if (append) requestedOffset else 0L
                val before = partial.length()

                BufferedInputStream(connection.inputStream, BUFFER_BYTES).use { input ->
                    FileOutputStream(partial, append).use { output ->
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
                                        (total.toDouble() / artifact.expectedBytes)
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

                check(partial.length() > before || partial.length() == artifact.expectedBytes) {
                    "${artifact.name}のダウンロードが途中で停止しました"
                }
                check(partial.length() <= artifact.expectedBytes) {
                    "${artifact.name}のファイルサイズが配布情報と一致しません"
                }
            } finally {
                connection.disconnect()
            }
        }

        check(partial.length() == artifact.expectedBytes) {
            "${artifact.name}のダウンロードが完了していません"
        }
        onProgress(Progress(Stage.DOWNLOADING, 1f))
    }

    private fun openConnection(sourceUrl: String, offset: Long): HttpURLConnection {
        var url = URL(sourceUrl)
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
                "Piper Plusの取得先を解決できません"
            }
            url = URL(url, location)
        }
        error("Piper Plusの取得でリダイレクト回数を超えました")
    }

    private fun validateContentRange(
        connection: HttpURLConnection,
        expectedOffset: Long,
        artifact: PiperDownloadArtifact,
    ) {
        val value = connection.getHeaderField("Content-Range").orEmpty()
        val match = CONTENT_RANGE.matchEntire(value)
        check(match != null && match.groupValues[1].toLong() == expectedOffset) {
            "${artifact.name}の再開位置がサーバー応答と一致しません"
        }
        val total = match.groupValues[3]
        check(total == "*" || total.toLong() == artifact.expectedBytes) {
            "${artifact.name}の配布サイズが変更されています"
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

    private fun writeMarker(marker: File, checksum: String) {
        marker.writeText("$checksum\n")
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
        val REDIRECT_CODES = setOf(301, 302, 303, 307, 308)
        val CONTENT_RANGE = Regex("bytes (\\d+)-(\\d+)/(\\d+|\\*)")
        const val HEX_DIGITS = "0123456789abcdef"
    }
}
