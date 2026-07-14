package jp.stackchan.localvoicepoc.model

/** ASR files managed through the existing RunAnywhere download registry. */
object ModelCatalog {
    data class RemoteFile(
        val url: String,
        val filename: String,
    )

    data class MultiFileModel(
        val id: String,
        val name: String,
        val files: List<RemoteFile>,
        val memoryBytes: Long,
    )

    /** Multilingual Whisper Small, using the matched int8 encoder/decoder pair. */
    val stt = MultiFileModel(
        id = "sherpa-onnx-whisper-small-int8",
        name = "Sherpa Whisper Small Multilingual int8",
        files = listOf(
            RemoteFile(
                url = "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small/resolve/main/small-encoder.int8.onnx",
                filename = "small-encoder.int8.onnx",
            ),
            RemoteFile(
                url = "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small/resolve/main/small-decoder.int8.onnx",
                filename = "small-decoder.int8.onnx",
            ),
            RemoteFile(
                url = "https://huggingface.co/csukuangfj/sherpa-onnx-whisper-small/resolve/main/small-tokens.txt",
                filename = "small-tokens.txt",
            ),
        ),
        memoryBytes = 450_000_000L,
    )

}
