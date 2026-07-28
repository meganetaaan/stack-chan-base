package jp.stackchan.localvoicepoc.realtime

import jp.stackchan.localvoicepoc.conversation.ConversationPhase
import jp.stackchan.localvoicepoc.serial.StackChanStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class RemoteConversationPolicyTest {
    @Test
    fun exhaustsRemoteStartDecisionsAcrossReadinessModeAndPhase() {
        ConversationPhase.values().forEach { phase ->
            listOf(false, true).forEach { pipelineReady ->
                listOf(false, true).forEach { automaticMode ->
                    val actual = decideRemoteConversationStart(
                        pipelineReady = pipelineReady,
                        automaticMode = automaticMode,
                        phase = phase,
                    )

                    when {
                        !pipelineReady -> {
                            assertTrue(
                                "$phase should be rejected while the pipeline is unavailable",
                                actual is RemoteConversationStartDecision.Reject,
                            )
                        }
                        phase == ConversationPhase.IDLE -> {
                            assertEquals(RemoteConversationStartDecision.StartAutomatic, actual)
                        }
                        automaticMode -> {
                            assertEquals(
                                RemoteConversationStartDecision.AlreadyActive(
                                    phase.toRemoteConversationState(),
                                ),
                                actual,
                            )
                        }
                        else -> {
                            assertEquals(
                                RemoteConversationStartDecision.Reject("押して話す操作を実行中です"),
                                actual,
                            )
                        }
                    }
                }
            }
        }
    }

    @Test
    fun exhaustsLegacyAndExtendedStatusMappings() {
        val legacy = mapOf(
            ConversationPhase.IDLE to StackChanStatus.IDLE,
            ConversationPhase.CONNECTING to StackChanStatus.IDLE,
            ConversationPhase.LISTENING to StackChanStatus.IDLE,
            ConversationPhase.RECORDING to StackChanStatus.IDLE,
            ConversationPhase.TRANSCRIBING to StackChanStatus.RECOGNIZING,
            ConversationPhase.THINKING to StackChanStatus.RECOGNIZING,
            ConversationPhase.SPEAKING to StackChanStatus.SPEAKING,
        )
        val extended = mapOf(
            ConversationPhase.IDLE to StackChanStatus.IDLE,
            ConversationPhase.CONNECTING to StackChanStatus.CONNECTING,
            ConversationPhase.LISTENING to StackChanStatus.LISTENING,
            ConversationPhase.RECORDING to StackChanStatus.LISTENING,
            ConversationPhase.TRANSCRIBING to StackChanStatus.RECOGNIZING,
            ConversationPhase.THINKING to StackChanStatus.RECOGNIZING,
            ConversationPhase.SPEAKING to StackChanStatus.SPEAKING,
        )

        ConversationPhase.values().forEach { phase ->
            listOf(false, true).forEach { hasError ->
                assertEquals(
                    "legacy phase=$phase error=$hasError",
                    legacy.getValue(phase),
                    stackChanStatusFor(phase, extended = false, hasError = hasError),
                )
                assertEquals(
                    "extended phase=$phase error=$hasError",
                    if (phase == ConversationPhase.IDLE && hasError) {
                        StackChanStatus.ERROR
                    } else {
                        extended.getValue(phase)
                    },
                    stackChanStatusFor(phase, extended = true, hasError = hasError),
                )
            }
        }
    }
}
