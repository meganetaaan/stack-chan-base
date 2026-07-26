package jp.stackchan.localvoicepoc.piper

import java.io.File

data class PiperInstallation(
    val model: File,
    val config: File,
    val dictionaryDirectory: File,
) {
    val hasCompleteDictionary: Boolean
        get() = dictionaryDirectory.isDirectory &&
            OpenJTalkDictionaryFiles.missingFrom(dictionaryDirectory).isEmpty()

    val isComplete: Boolean
        get() = model.isFile && config.isFile && hasCompleteDictionary
}
