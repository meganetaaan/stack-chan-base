package jp.stackchan.localvoicepoc.piper

data class PiperDownloadArtifact(
    val name: String,
    val fileName: String,
    val url: String,
    val expectedBytes: Long,
    val sha256: String,
)

/** Download sources tested with the Piper Plus v1.13.0 Android runtime. */
object PiperAssetLinks {
    const val TSUKUYOMI_REVISION = "36b59c825c36bd386b8960cf3f604382f52f2a87"
    const val PIPER_PLUS_VERSION = "1.13.0"
    const val RECOMMENDED_MODEL_NAME = "つくよみちゃん 6言語 FP16"
    const val RECOMMENDED_SETUP_ID =
        "tsukuyomi-6lang-fp16-$TSUKUYOMI_REVISION-piper-$PIPER_PLUS_VERSION"
    const val DICTIONARY_ENTRY_PREFIX = "piper/share/open_jtalk/dic/"

    private const val TSUKUYOMI_REPOSITORY =
        "https://huggingface.co/ayousanz/piper-plus-tsukuyomi-chan"

    const val MODEL_DOWNLOAD_URL =
        "$TSUKUYOMI_REPOSITORY/resolve/$TSUKUYOMI_REVISION/" +
            "tsukuyomi-chan-6lang-fp16.onnx?download=true"
    const val CONFIG_DOWNLOAD_URL =
        "$TSUKUYOMI_REPOSITORY/resolve/$TSUKUYOMI_REVISION/config.json?download=true"
    const val MODEL_LICENSE_URL = "https://tyc.rei-yumesaki.net/material/corpus/#terms3"
    const val DICTIONARY_DOWNLOAD_URL =
        "https://github.com/ayutaz/piper-plus/releases/download/v$PIPER_PLUS_VERSION/" +
            "piper-windows-x64.zip"

    val MODEL = PiperDownloadArtifact(
        name = "音声モデル",
        fileName = "voice.onnx",
        url = MODEL_DOWNLOAD_URL,
        expectedBytes = 39_652_717L,
        sha256 = "5289e9b6eaf21080803b7fe1c4dc85b5491d4c216121207a41df18dd5f68e5d7",
    )
    val CONFIG = PiperDownloadArtifact(
        name = "設定JSON",
        fileName = "voice.onnx.json",
        url = CONFIG_DOWNLOAD_URL,
        expectedBytes = 6_901L,
        sha256 = "516058f405ec914140f34832a9d8bb5d8272ba62af9bc7ffb29349715a539780",
    )
    val DICTIONARY_ARCHIVE = PiperDownloadArtifact(
        name = "OpenJTalk辞書",
        fileName = "piper-windows-x64.zip",
        url = DICTIONARY_DOWNLOAD_URL,
        expectedBytes = 32_461_242L,
        sha256 = "d8b6237a546d996a65009bd88f2eb845fad876505952cce98eb3fedaf99fa3d7",
    )

    val recommendedDownloads = listOf(MODEL, CONFIG, DICTIONARY_ARCHIVE)
    val recommendedDownloadBytes: Long = recommendedDownloads.sumOf { it.expectedBytes }

    const val EXTRACTED_DICTIONARY_BYTES = 107_304_813L
}
