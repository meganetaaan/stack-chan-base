package jp.stackchan.localvoicepoc.diagnostics

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.AtomicMoveNotSupportedException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.time.Instant
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter

enum class RecognitionCaptureTrigger(val wireName: String) {
    AUTOMATIC("automatic_vad"),
    PUSH_TO_TALK("push_to_talk"),
}

class RecognitionCapture internal constructor(
    val id: String,
    val recordedAtUtc: String,
    val trigger: RecognitionCaptureTrigger,
    val sampleRate: Int,
    val pcmBytes: Int,
    val wavFile: File,
    val metadataFile: File,
)

/** Stores the exact PCM submitted to Whisper as a bounded WAV/JSON pair. */
class RecognitionCaptureStore(
    private val directory: File,
    private val maximumCaptures: Int = DEFAULT_MAXIMUM_CAPTURES,
    private val maximumBytes: Long = DEFAULT_MAXIMUM_BYTES,
    private val nowMillis: () -> Long = System::currentTimeMillis,
) {
    private val lock = Any()

    init {
        require(maximumCaptures > 0) { "Maximum captures must be positive" }
        require(maximumBytes > 0) { "Maximum capture bytes must be positive" }
    }

    suspend fun save(
        pcm16Le: ByteArray,
        sampleRate: Int,
        trigger: RecognitionCaptureTrigger,
    ): RecognitionCapture = withContext(Dispatchers.IO) {
        require(sampleRate > 0) { "Sample rate must be positive" }
        require(pcm16Le.size % PCM_BLOCK_ALIGN == 0) { "PCM16 data must contain complete samples" }
        synchronized(lock) {
            ensureDirectory()
            val timestampMillis = nowMillis()
            val recordedAt = Instant.ofEpochMilli(timestampMillis).toString()
            val prefix = "recognition-${FILE_TIMESTAMP.format(Instant.ofEpochMilli(timestampMillis))}-${trigger.wireName}"
            val id = uniqueId(prefix)
            val wavFile = directory.resolve("$id.wav")
            val metadataFile = directory.resolve("$id.json")
            writeAtomically(wavFile, wavBytes(pcm16Le, sampleRate))
            val capture = RecognitionCapture(
                id = id,
                recordedAtUtc = recordedAt,
                trigger = trigger,
                sampleRate = sampleRate,
                pcmBytes = pcm16Le.size,
                wavFile = wavFile,
                metadataFile = metadataFile,
            )
            writeMetadata(capture, status = "captured")
            prune()
            capture
        }
    }

    suspend fun recordRecognitionResult(
        capture: RecognitionCapture,
        rawTranscription: String?,
        sanitizedTranscription: String?,
        error: Throwable? = null,
    ) = withContext(Dispatchers.IO) {
        synchronized(lock) {
            if (!capture.wavFile.isFile) return@synchronized
            val status = when {
                error != null -> "recognition_failed"
                sanitizedTranscription == null -> "rejected_non_speech"
                else -> "accepted"
            }
            writeMetadata(
                capture = capture,
                status = status,
                rawTranscription = rawTranscription,
                sanitizedTranscription = sanitizedTranscription,
                error = error,
            )
        }
    }

    private fun writeMetadata(
        capture: RecognitionCapture,
        status: String,
        rawTranscription: String? = null,
        sanitizedTranscription: String? = null,
        error: Throwable? = null,
    ) {
        val durationMs = capture.pcmBytes.toLong() * 1_000L / (capture.sampleRate * PCM_BLOCK_ALIGN)
        val metadata = linkedMapOf<String, Any?>(
            "schemaVersion" to 1,
            "id" to capture.id,
            "recordedAtUtc" to capture.recordedAtUtc,
            "trigger" to capture.trigger.wireName,
            "status" to status,
            "audioFile" to capture.wavFile.name,
            "sampleRate" to capture.sampleRate,
            "channels" to 1,
            "bitsPerSample" to 16,
            "pcmBytes" to capture.pcmBytes,
            "durationMs" to durationMs,
            "rawTranscription" to rawTranscription,
            "sanitizedTranscription" to sanitizedTranscription,
            "errorType" to error?.javaClass?.name,
            "errorMessage" to error?.message,
        )
        writeAtomically(capture.metadataFile, DiagnosticJson.encode(metadata).toByteArray(Charsets.UTF_8))
    }

    private fun wavBytes(pcm16Le: ByteArray, sampleRate: Int): ByteArray {
        val result = ByteBuffer.allocate(WAV_HEADER_BYTES + pcm16Le.size).order(ByteOrder.LITTLE_ENDIAN)
        result.put("RIFF".toByteArray(Charsets.US_ASCII))
        result.putInt(36 + pcm16Le.size)
        result.put("WAVE".toByteArray(Charsets.US_ASCII))
        result.put("fmt ".toByteArray(Charsets.US_ASCII))
        result.putInt(16)
        result.putShort(1.toShort())
        result.putShort(1.toShort())
        result.putInt(sampleRate)
        result.putInt(sampleRate * PCM_BLOCK_ALIGN)
        result.putShort(PCM_BLOCK_ALIGN.toShort())
        result.putShort(16.toShort())
        result.put("data".toByteArray(Charsets.US_ASCII))
        result.putInt(pcm16Le.size)
        result.put(pcm16Le)
        return result.array()
    }

    private fun uniqueId(prefix: String): String {
        var suffix = 0
        while (true) {
            val candidate = if (suffix == 0) prefix else "$prefix-$suffix"
            if (!directory.resolve("$candidate.wav").exists() && !directory.resolve("$candidate.json").exists()) {
                return candidate
            }
            suffix += 1
        }
    }

    private fun prune() {
        directory.listFiles { file -> file.extension == "tmp" }?.forEach(File::delete)
        val captures = directory.listFiles { file -> file.extension == "wav" }
            ?.sortedByDescending(File::lastModified)
            .orEmpty()
        var retainedBytes = 0L
        captures.forEachIndexed { index, wavFile ->
            val keep = index < maximumCaptures && retainedBytes + wavFile.length() <= maximumBytes
            if (keep) {
                retainedBytes += wavFile.length()
            } else {
                wavFile.delete()
                directory.resolve("${wavFile.nameWithoutExtension}.json").delete()
            }
        }
        val retainedIds = directory.listFiles { file -> file.extension == "wav" }
            ?.mapTo(mutableSetOf()) { it.nameWithoutExtension }
            .orEmpty()
        directory.listFiles { file -> file.extension == "json" }
            ?.filter { it.nameWithoutExtension !in retainedIds }
            ?.forEach(File::delete)
    }

    private fun ensureDirectory() {
        check(directory.isDirectory || directory.mkdirs()) {
            "Could not create recognition capture directory: ${directory.absolutePath}"
        }
    }

    private companion object {
        const val WAV_HEADER_BYTES = 44
        const val PCM_BLOCK_ALIGN = 2
        const val DEFAULT_MAXIMUM_CAPTURES = 50
        const val DEFAULT_MAXIMUM_BYTES = 50L * 1024L * 1024L
        val FILE_TIMESTAMP: DateTimeFormatter = DateTimeFormatter
            .ofPattern("yyyyMMdd'T'HHmmss.SSS'Z'")
            .withZone(ZoneOffset.UTC)
    }
}

class PlaybackTraceStore(
    private val directory: File,
    private val maximumTraces: Int = DEFAULT_MAXIMUM_TRACES,
    private val nowMillis: () -> Long = System::currentTimeMillis,
) {
    private val lock = Any()

    init {
        require(maximumTraces > 0) { "Maximum traces must be positive" }
    }

    fun start(inputSampleRate: Int, outputSampleRate: Int): PlaybackTraceSession = synchronized(lock) {
        check(directory.isDirectory || directory.mkdirs()) {
            "Could not create playback trace directory: ${directory.absolutePath}"
        }
        val timestampMillis = nowMillis()
        val prefix = "playback-${FILE_TIMESTAMP.format(Instant.ofEpochMilli(timestampMillis))}"
        var suffix = 0
        var file: File
        do {
            val id = if (suffix == 0) prefix else "$prefix-$suffix"
            file = directory.resolve("$id.jsonl")
            suffix += 1
        } while (file.exists())
        val session = PlaybackTraceSession(file, Instant.ofEpochMilli(timestampMillis).toString())
        session.event(
            "session_started",
            linkedMapOf("inputSampleRate" to inputSampleRate, "outputSampleRate" to outputSampleRate),
        )
        prune()
        session
    }

    private fun prune() {
        directory.listFiles { file -> file.extension == "jsonl" }
            ?.sortedByDescending(File::lastModified)
            ?.drop(maximumTraces)
            ?.forEach(File::delete)
    }

    private companion object {
        const val DEFAULT_MAXIMUM_TRACES = 50
        val FILE_TIMESTAMP: DateTimeFormatter = DateTimeFormatter
            .ofPattern("yyyyMMdd'T'HHmmss.SSS'Z'")
            .withZone(ZoneOffset.UTC)
    }
}

class PlaybackTraceSession internal constructor(
    val file: File,
    private val startedAtUtc: String,
) {
    private val startedNanos = System.nanoTime()
    private var closed = false

    @Synchronized
    fun event(name: String, fields: Map<String, Any?> = emptyMap()) {
        if (closed) return
        val record = linkedMapOf<String, Any?>(
            "schemaVersion" to 1,
            "sessionStartedAtUtc" to startedAtUtc,
            "elapsedMs" to (System.nanoTime() - startedNanos) / 1_000_000L,
            "event" to name,
        )
        record.putAll(fields)
        file.appendText(DiagnosticJson.encode(record) + "\n", Charsets.UTF_8)
    }

    @Synchronized
    fun close(outcome: String, fields: Map<String, Any?> = emptyMap()) {
        if (closed) return
        event("session_closed", linkedMapOf<String, Any?>("outcome" to outcome).apply { putAll(fields) })
        closed = true
    }
}

private object DiagnosticJson {
    fun encode(values: Map<String, Any?>): String = values.entries.joinToString(
        prefix = "{",
        postfix = "}",
        separator = ",",
    ) { (key, value) -> "${string(key)}:${value(value)}" }

    private fun value(value: Any?): String = when (value) {
        null -> "null"
        is Boolean, is Number -> value.toString()
        else -> string(value.toString())
    }

    private fun string(value: String): String = buildString(value.length + 2) {
        append('"')
        value.forEach { character ->
            when (character) {
                '"' -> append("\\\"")
                '\\' -> append("\\\\")
                '\b' -> append("\\b")
                '\u000c' -> append("\\f")
                '\n' -> append("\\n")
                '\r' -> append("\\r")
                '\t' -> append("\\t")
                else -> if (character.code < 0x20) append("\\u%04x".format(character.code)) else append(character)
            }
        }
        append('"')
    }
}

private fun writeAtomically(target: File, bytes: ByteArray) {
    val temporary = requireNotNull(target.parentFile).resolve("${target.name}.tmp")
    temporary.writeBytes(bytes)
    try {
        Files.move(
            temporary.toPath(),
            target.toPath(),
            StandardCopyOption.ATOMIC_MOVE,
            StandardCopyOption.REPLACE_EXISTING,
        )
    } catch (_: AtomicMoveNotSupportedException) {
        Files.move(temporary.toPath(), target.toPath(), StandardCopyOption.REPLACE_EXISTING)
    } catch (error: Throwable) {
        temporary.delete()
        throw error
    }
}
