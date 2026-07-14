package jp.stackchan.localvoicepoc.model

import android.content.Context
import androidx.core.content.edit

class GemmaModelPreferences(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        PREFERENCES_NAME,
        Context.MODE_PRIVATE,
    )

    fun selected(): GemmaModelSpec =
        GemmaModelManifest.find(preferences.getString(KEY_SELECTED_MODEL, null))
            ?: GemmaModelManifest.default

    fun select(modelSpec: GemmaModelSpec) {
        preferences.edit { putString(KEY_SELECTED_MODEL, modelSpec.id) }
    }

    private companion object {
        const val PREFERENCES_NAME = "gemma_model"
        const val KEY_SELECTED_MODEL = "selected_model"
    }
}
