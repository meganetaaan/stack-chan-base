package jp.stackchan.localvoicepoc.ui

import jp.stackchan.localvoicepoc.SdkBootstrap
import jp.stackchan.localvoicepoc.conversation.ConversationPhase
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class MainUiStateFlowTest {
    @Test
    fun setupAdvancesFromModelToVoiceToDevice() {
        assertEquals(SetupStep.MODEL, MainUiState().setupStep)
        assertEquals(SetupStep.VOICE, MainUiState(modelsReady = true).setupStep)
        assertEquals(
            SetupStep.DEVICE,
            MainUiState(modelsReady = true, piperLoaded = true).setupStep,
        )
    }

    @Test
    fun conversationRequiresModelsVoiceAndUsb() {
        val ready = MainUiState(
            sdkStatus = SdkBootstrap.Status.Ready,
            modelsReady = true,
            piperLoaded = true,
            usbStatus = UsbConnectionStatus.READY,
        )

        assertTrue(ready.pipelineReady)
        assertFalse(ready.copy(usbStatus = UsbConnectionStatus.DISCONNECTED).pipelineReady)
        assertFalse(ready.copy(piperLoaded = false).pipelineReady)
        assertFalse(ready.copy(modelsReady = false).pipelineReady)
    }

    @Test
    fun modelMutationRemainsBlockedDuringConversation() {
        assertFalse(MainUiState(phase = ConversationPhase.THINKING).canStartModelMutation)
    }
}
