package jp.stackchan.localvoicepoc.piper

import android.content.Context
import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

class PiperAssetStore(private val context: Context) {
    private val preferences = PiperPreferences(context)
    private val baseDirectory = File(context.filesDir, "piper-plus")

    suspend fun importModel(uri: Uri): PiperInstallation = withContext(Dispatchers.IO) {
        baseDirectory.mkdirs()
        val current = preferences.installation()
        val destination = File(baseDirectory, "voice.onnx")
        copyContent(uri, destination)
        current.copy(model = destination).also(preferences::save)
    }

    suspend fun importConfig(uri: Uri): PiperInstallation = withContext(Dispatchers.IO) {
        baseDirectory.mkdirs()
        val current = preferences.installation()
        val destination = File(baseDirectory, "voice.onnx.json")
        copyContent(uri, destination)
        current.copy(config = destination).also(preferences::save)
    }

    suspend fun importDictionary(treeUri: Uri): PiperInstallation = withContext(Dispatchers.IO) {
        baseDirectory.mkdirs()
        val root = DocumentFile.fromTreeUri(context, treeUri)
            ?: error("OpenJTalk dictionary folder could not be opened")
        require(root.isDirectory) { "Selected OpenJTalk item is not a directory" }

        val destination = File(baseDirectory, "open_jtalk_dic")
        destination.deleteRecursively()
        destination.mkdirs()
        copyTree(root, destination)
        OpenJTalkDictionaryFiles.restoreTrashedNames(destination)
        val missingFiles = OpenJTalkDictionaryFiles.missingFrom(destination)
        require(missingFiles.isEmpty()) {
            "OpenJTalk辞書の必須ファイルが不足しています: ${missingFiles.joinToString()}"
        }

        preferences.installation().copy(dictionaryDirectory = destination).also(preferences::save)
    }

    fun current(): PiperInstallation = preferences.installation().also { installation ->
        OpenJTalkDictionaryFiles.restoreTrashedNames(installation.dictionaryDirectory)
    }

    private fun copyContent(uri: Uri, destination: File) {
        val input = context.contentResolver.openInputStream(uri)
            ?: error("Selected file could not be opened")
        destination.parentFile?.mkdirs()
        input.use { source ->
            destination.outputStream().buffered().use { output -> source.copyTo(output) }
        }
        require(destination.length() > 0L) { "Imported file is empty" }
    }

    private fun copyTree(source: DocumentFile, destination: File) {
        source.listFiles().forEach { child ->
            val safeName = child.name?.replace(Regex("[^A-Za-z0-9._-]"), "_")
                ?.takeIf(String::isNotBlank)
                ?: return@forEach
            val target = File(destination, safeName)
            when {
                child.isDirectory -> {
                    target.mkdirs()
                    copyTree(child, target)
                }
                child.isFile -> copyContent(child.uri, target)
            }
        }
    }
}
