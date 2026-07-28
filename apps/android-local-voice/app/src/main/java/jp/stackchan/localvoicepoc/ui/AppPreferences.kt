package jp.stackchan.localvoicepoc.ui

import android.content.Context
import androidx.core.content.edit

class AppPreferences(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(
        "stackchan_ui",
        Context.MODE_PRIVATE,
    )

    fun markOnboardingComplete() {
        preferences.edit { putBoolean("onboarding_complete", true) }
    }

    fun isOnboardingComplete(): Boolean = preferences.getBoolean("onboarding_complete", false)
}
