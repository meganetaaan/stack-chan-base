package jp.stackchan.localvoicepoc.ui

enum class StartupAssetDecision {
    RESTORE,
    SETUP_REQUIRED,
}

fun decideStartupAssets(
    modelAssetsReady: Boolean,
    piperAssetsReady: Boolean,
    piperRuntimeAvailable: Boolean,
): StartupAssetDecision = if (modelAssetsReady && piperAssetsReady && piperRuntimeAvailable) {
    StartupAssetDecision.RESTORE
} else {
    StartupAssetDecision.SETUP_REQUIRED
}
