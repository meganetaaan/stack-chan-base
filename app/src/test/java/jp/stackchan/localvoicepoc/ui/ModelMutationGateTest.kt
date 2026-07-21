package jp.stackchan.localvoicepoc.ui

import jp.stackchan.localvoicepoc.conversation.ConversationPhase
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ModelMutationGateTest {
    @Test
    fun permitsMutationOnlyWhileIdleAndNoOtherMutationIsRunning() {
        assertTrue(MainUiState(phase = ConversationPhase.IDLE).canStartModelMutation)

        ConversationPhase.entries
            .filterNot { it == ConversationPhase.IDLE }
            .forEach { phase ->
                assertFalse("phase=$phase", MainUiState(phase = phase).canStartModelMutation)
            }
        assertFalse(MainUiState(modelSetupRunning = true).canStartModelMutation)
        assertFalse(MainUiState(piperBusy = true).canStartModelMutation)
    }
}
