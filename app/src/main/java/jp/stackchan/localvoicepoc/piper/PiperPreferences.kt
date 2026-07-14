package jp.stackchan.localvoicepoc.piper

import android.content.Context
import androidx.core.content.edit
import java.io.File

class PiperPreferences(context: Context) {
    private val appContext = context.applicationContext
    private val preferences = appContext.getSharedPreferences("piper_plus", Context.MODE_PRIVATE)

    fun installation(): PiperInstallation {
        val base = File(appContext.filesDir, "piper-plus")
        return PiperInstallation(
            model = File(preferences.getString(KEY_MODEL, File(base, "voice.onnx").absolutePath)!!),
            config = File(preferences.getString(KEY_CONFIG, File(base, "voice.onnx.json").absolutePath)!!),
            dictionaryDirectory = File(
                preferences.getString(KEY_DICTIONARY, File(base, "open_jtalk_dic").absolutePath)!!,
            ),
        )
    }

    fun save(installation: PiperInstallation) {
        preferences.edit {
            putString(KEY_MODEL, installation.model.absolutePath)
            putString(KEY_CONFIG, installation.config.absolutePath)
            putString(KEY_DICTIONARY, installation.dictionaryDirectory.absolutePath)
        }
    }

    private companion object {
        const val KEY_MODEL = "model"
        const val KEY_CONFIG = "config"
        const val KEY_DICTIONARY = "dictionary"
    }
}
