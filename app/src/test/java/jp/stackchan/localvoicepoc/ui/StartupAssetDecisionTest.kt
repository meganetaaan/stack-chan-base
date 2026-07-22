package jp.stackchan.localvoicepoc.ui

import org.junit.Assert.assertEquals
import org.junit.Test

class StartupAssetDecisionTest {
    @Test
    fun restoresOnlyWhenAllAssetsAndRuntimeAreAvailable() {
        assertEquals(
            StartupAssetDecision.RESTORE,
            decideStartupAssets(
                modelAssetsReady = true,
                piperAssetsReady = true,
                piperRuntimeAvailable = true,
            ),
        )
    }

    @Test
    fun requiresSetupWhenAnyAssetIsMissing() {
        val inputs = listOf(
            Triple(false, true, true),
            Triple(true, false, true),
            Triple(true, true, false),
            Triple(false, false, false),
        )

        inputs.forEach { (model, piper, runtime) ->
            assertEquals(
                StartupAssetDecision.SETUP_REQUIRED,
                decideStartupAssets(model, piper, runtime),
            )
        }
    }
}
