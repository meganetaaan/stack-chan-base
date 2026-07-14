/*
 * API definitions adapted from sherpa-onnx v1.12.20.
 * SPDX-License-Identifier: Apache-2.0
 */
package com.k2fsa.sherpa.onnx

data class FeatureConfig(
    var sampleRate: Int = 16_000,
    var featureDim: Int = 80,
    var dither: Float = 0f,
)

data class QnnConfig(
    var backendLib: String = "",
    var contextBinary: String = "",
    var systemLib: String = "",
)

data class HomophoneReplacerConfig(
    var dictDir: String = "",
    var lexicon: String = "",
    var ruleFsts: String = "",
)

data class OfflineTransducerModelConfig(
    var encoder: String = "",
    var decoder: String = "",
    var joiner: String = "",
)

data class OfflineParaformerModelConfig(var model: String = "")

data class OfflineNemoEncDecCtcModelConfig(var model: String = "")

data class OfflineDolphinModelConfig(var model: String = "")

data class OfflineZipformerCtcModelConfig(
    var model: String = "",
    var qnnConfig: QnnConfig = QnnConfig(),
)

data class OfflineWenetCtcModelConfig(var model: String = "")

data class OfflineOmnilingualAsrCtcModelConfig(var model: String = "")

data class OfflineWhisperModelConfig(
    var encoder: String = "",
    var decoder: String = "",
    var language: String = "en",
    var task: String = "transcribe",
    var tailPaddings: Int = 1_000,
)

data class OfflineCanaryModelConfig(
    var encoder: String = "",
    var decoder: String = "",
    var srcLang: String = "en",
    var tgtLang: String = "en",
    var usePnc: Boolean = true,
)

data class OfflineFireRedAsrModelConfig(
    var encoder: String = "",
    var decoder: String = "",
)

data class OfflineMoonshineModelConfig(
    var preprocessor: String = "",
    var encoder: String = "",
    var uncachedDecoder: String = "",
    var cachedDecoder: String = "",
)

data class OfflineSenseVoiceModelConfig(
    var model: String = "",
    var language: String = "",
    var useInverseTextNormalization: Boolean = true,
    var qnnConfig: QnnConfig = QnnConfig(),
)

data class OfflineModelConfig(
    var transducer: OfflineTransducerModelConfig = OfflineTransducerModelConfig(),
    var paraformer: OfflineParaformerModelConfig = OfflineParaformerModelConfig(),
    var whisper: OfflineWhisperModelConfig = OfflineWhisperModelConfig(),
    var fireRedAsr: OfflineFireRedAsrModelConfig = OfflineFireRedAsrModelConfig(),
    var moonshine: OfflineMoonshineModelConfig = OfflineMoonshineModelConfig(),
    var nemo: OfflineNemoEncDecCtcModelConfig = OfflineNemoEncDecCtcModelConfig(),
    var senseVoice: OfflineSenseVoiceModelConfig = OfflineSenseVoiceModelConfig(),
    var dolphin: OfflineDolphinModelConfig = OfflineDolphinModelConfig(),
    var zipformerCtc: OfflineZipformerCtcModelConfig = OfflineZipformerCtcModelConfig(),
    var wenetCtc: OfflineWenetCtcModelConfig = OfflineWenetCtcModelConfig(),
    var omnilingual: OfflineOmnilingualAsrCtcModelConfig = OfflineOmnilingualAsrCtcModelConfig(),
    var canary: OfflineCanaryModelConfig = OfflineCanaryModelConfig(),
    var teleSpeech: String = "",
    var numThreads: Int = 1,
    var debug: Boolean = false,
    var provider: String = "cpu",
    var modelType: String = "",
    var tokens: String = "",
    var modelingUnit: String = "",
    var bpeVocab: String = "",
)

data class OfflineRecognizerConfig(
    var featConfig: FeatureConfig = FeatureConfig(),
    var modelConfig: OfflineModelConfig = OfflineModelConfig(),
    var hr: HomophoneReplacerConfig = HomophoneReplacerConfig(),
    var decodingMethod: String = "greedy_search",
    var maxActivePaths: Int = 4,
    var hotwordsFile: String = "",
    var hotwordsScore: Float = 1.5f,
    var ruleFsts: String = "",
    var ruleFars: String = "",
    var blankPenalty: Float = 0f,
)

data class OfflineRecognizerResult(
    val text: String,
    val tokens: Array<String>,
    val timestamps: FloatArray,
    val lang: String,
    val emotion: String,
    val event: String,
    val durations: FloatArray,
)

class OfflineStream(var ptr: Long) : AutoCloseable {
    fun acceptWaveform(samples: FloatArray, sampleRate: Int) {
        check(ptr != 0L) { "Offline stream is closed" }
        acceptWaveform(ptr, samples, sampleRate)
    }

    override fun close() {
        if (ptr == 0L) return
        delete(ptr)
        ptr = 0L
    }

    private external fun acceptWaveform(ptr: Long, samples: FloatArray, sampleRate: Int)
    private external fun delete(ptr: Long)

    private companion object {
        init {
            System.loadLibrary("sherpa-onnx-jni")
        }
    }
}

class OfflineRecognizer(
    val config: OfflineRecognizerConfig,
) : AutoCloseable {
    private var ptr: Long = newFromFile(config)

    init {
        check(ptr != 0L) { "Failed to create sherpa-onnx offline recognizer" }
    }

    fun createStream(): OfflineStream {
        check(ptr != 0L) { "Offline recognizer is closed" }
        return OfflineStream(createStream(ptr))
    }

    fun decode(stream: OfflineStream) {
        check(ptr != 0L) { "Offline recognizer is closed" }
        decode(ptr, stream.ptr)
    }

    fun getResult(stream: OfflineStream): OfflineRecognizerResult {
        check(ptr != 0L) { "Offline recognizer is closed" }
        val values = getResult(stream.ptr)
        @Suppress("UNCHECKED_CAST")
        return OfflineRecognizerResult(
            text = values[0] as String,
            tokens = values[1] as Array<String>,
            timestamps = values[2] as FloatArray,
            lang = values[3] as String,
            emotion = values[4] as String,
            event = values[5] as String,
            durations = values[6] as FloatArray,
        )
    }

    override fun close() {
        if (ptr == 0L) return
        delete(ptr)
        ptr = 0L
    }

    private external fun delete(ptr: Long)
    private external fun createStream(ptr: Long): Long
    private external fun newFromFile(config: OfflineRecognizerConfig): Long
    private external fun decode(ptr: Long, streamPtr: Long)
    private external fun getResult(streamPtr: Long): Array<Any>

    private companion object {
        init {
            System.loadLibrary("sherpa-onnx-jni")
        }
    }
}
