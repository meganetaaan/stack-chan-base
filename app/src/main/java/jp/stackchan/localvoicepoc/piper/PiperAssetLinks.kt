package jp.stackchan.localvoicepoc.piper

/** Download sources tested with the Piper Plus v1.13.0 Android runtime. */
object PiperAssetLinks {
    private const val TSUKUYOMI_REVISION = "36b59c825c36bd386b8960cf3f604382f52f2a87"
    private const val TSUKUYOMI_REPOSITORY =
        "https://huggingface.co/ayousanz/piper-plus-tsukuyomi-chan"

    const val MODEL_DOWNLOAD_URL =
        "$TSUKUYOMI_REPOSITORY/resolve/$TSUKUYOMI_REVISION/" +
            "tsukuyomi-chan-6lang-fp16.onnx?download=true"
    const val CONFIG_DOWNLOAD_URL =
        "$TSUKUYOMI_REPOSITORY/resolve/$TSUKUYOMI_REVISION/config.json?download=true"
    const val MODEL_LICENSE_URL = "https://tyc.rei-yumesaki.net/material/corpus/#terms3"
    const val DICTIONARY_DOWNLOAD_URL =
        "https://github.com/ayutaz/piper-plus/releases/download/v1.13.0/" +
            "piper-windows-x64.zip"
}
