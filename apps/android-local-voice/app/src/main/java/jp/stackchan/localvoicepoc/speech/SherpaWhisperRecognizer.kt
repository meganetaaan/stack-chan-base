package jp.stackchan.localvoicepoc.speech

import android.os.SystemClock
import android.util.Log
import com.k2fsa.sherpa.onnx.FeatureConfig
import com.k2fsa.sherpa.onnx.OfflineModelConfig
import com.k2fsa.sherpa.onnx.OfflineRecognizer
import com.k2fsa.sherpa.onnx.OfflineRecognizerConfig
import com.k2fsa.sherpa.onnx.OfflineWhisperModelConfig
import jp.stackchan.localvoicepoc.model.ModelCatalog
import jp.stackchan.localvoicepoc.util.Pcm
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

class SherpaWhisperRecognizer : LocalSpeechRecognizer {
    private val lock = Any()
    private var recognizer: OfflineRecognizer? = null

    @Volatile
    override var isLoaded: Boolean = false
        private set

    override suspend fun load(modelDirectory: File) = withContext(Dispatchers.IO) {
        val files = ModelCatalog.stt.files.associate { remote ->
            remote.filename to File(modelDirectory, remote.filename)
        }
        files.values.forEach { file ->
            require(file.isFile) { "Whisper file is missing: ${file.name}" }
        }

        val encoder = files.getValue("small-encoder.int8.onnx")
        val decoder = files.getValue("small-decoder.int8.onnx")
        val tokens = files.getValue("small-tokens.txt")
        val threadCount = Runtime.getRuntime().availableProcessors().coerceIn(2, MAX_THREADS)
        val config = OfflineRecognizerConfig(
            featConfig = FeatureConfig(sampleRate = SAMPLE_RATE, featureDim = FEATURE_DIM),
            modelConfig = OfflineModelConfig(
                whisper = OfflineWhisperModelConfig(
                    encoder = encoder.absolutePath,
                    decoder = decoder.absolutePath,
                    language = LANGUAGE,
                    task = "transcribe",
                ),
                numThreads = threadCount,
                debug = false,
                provider = "cpu",
                modelType = "whisper",
                tokens = tokens.absolutePath,
            ),
        )

        synchronized(lock) {
            isLoaded = false
            recognizer?.close()
            recognizer = OfflineRecognizer(config)
            isLoaded = true
        }
        Log.i(TAG, "Whisper recognizer loaded: language=$LANGUAGE, threads=$threadCount")
        Unit
    }

    override suspend fun transcribe(pcm16Le: ByteArray, sampleRate: Int): String =
        withContext(Dispatchers.IO) {
            require(sampleRate == SAMPLE_RATE) { "Whisper requires 16 kHz PCM: $sampleRate" }
            val samples = Pcm.floatSamples16Le(pcm16Le)
            val startedAt = SystemClock.elapsedRealtime()
            val result = synchronized(lock) {
                val active = checkNotNull(recognizer) { "Whisper recognizer is not loaded" }
                active.createStream().use { stream ->
                    stream.acceptWaveform(samples, sampleRate)
                    active.decode(stream)
                    active.getResult(stream)
                }
            }
            Log.i(
                TAG,
                "Whisper transcription: audioMs=${samples.size * 1_000L / sampleRate}, " +
                    "processingMs=${SystemClock.elapsedRealtime() - startedAt}, language=${result.lang}",
            )
            result.text
        }

    override fun close() {
        synchronized(lock) {
            isLoaded = false
            recognizer?.close()
            recognizer = null
        }
    }

    private companion object {
        const val TAG = "StackChanSTT"
        const val SAMPLE_RATE = 16_000
        const val FEATURE_DIM = 80
        const val LANGUAGE = "ja"
        const val MAX_THREADS = 4
    }
}
