package jp.stackchan.localvoicepoc.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.ComposeContentTestRule
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import jp.stackchan.localvoicepoc.SdkBootstrap
import org.junit.Rule
import org.junit.Test

class StackChanScreenTest {
    @get:Rule
    val composeRule = createComposeRule()

    @Test
    fun setupStartsWithModelSelection() {
        composeRule.setStackChanScreen(
            MainUiState(
                startupStatus = AppStartupStatus.SETUP_REQUIRED,
                sdkStatus = SdkBootstrap.Status.Ready,
                piperAarPresent = true,
            ),
        )

        composeRule.onNodeWithText("会話モデル").assertIsDisplayed()
        composeRule.onNodeWithText("モデルを準備").assertIsDisplayed()
    }

    @Test
    fun conversationIsDisabledUntilUsbIsConnected() {
        composeRule.setStackChanScreen(
            MainUiState(
                startupStatus = AppStartupStatus.READY,
                sdkStatus = SdkBootstrap.Status.Ready,
                modelsReady = true,
                piperLoaded = true,
                usbStatus = UsbConnectionStatus.DISCONNECTED,
            ),
        )

        composeRule.onNodeWithText("CoreS3を接続してください").assertIsDisplayed()
        composeRule.onNodeWithText("話しかける").assertIsNotEnabled()
        composeRule.onNodeWithContentDescription("設定").assertIsDisplayed()
    }
}

private fun ComposeContentTestRule.setStackChanScreen(state: MainUiState) {
    setContent {
        StackChanTheme {
            StackChanScreen(
                state = state,
                onGemmaModelSelected = {},
                onPrepareModels = {},
                onPickPiperModel = {},
                onPickPiperConfig = {},
                onPickDictionary = {},
                onPrepareRecommendedPiper = {},
                onConfirmRecommendedPiperTerms = {},
                onDismissRecommendedPiperTerms = {},
                onLoadPiper = {},
                onAutomaticModeChanged = {},
                onStartAutomatic = {},
                onStopConversation = {},
                onStartPushToTalk = {},
                onStopPushToTalk = {},
                onRetryUsbConnection = {},
                onFinishSetup = {},
                onRetryStartup = {},
                onDismissError = {},
            )
        }
    }
}
