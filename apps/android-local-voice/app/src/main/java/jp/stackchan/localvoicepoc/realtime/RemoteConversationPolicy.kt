package jp.stackchan.localvoicepoc.realtime

import jp.stackchan.localvoicepoc.conversation.ConversationPhase
import jp.stackchan.localvoicepoc.serial.StackChanStatus

sealed interface RemoteConversationStartDecision {
    data object StartAutomatic : RemoteConversationStartDecision
    data class AlreadyActive(val state: RemoteConversationState) : RemoteConversationStartDecision
    data class Reject(val error: String) : RemoteConversationStartDecision
}

fun decideRemoteConversationStart(
    pipelineReady: Boolean,
    automaticMode: Boolean,
    phase: ConversationPhase,
): RemoteConversationStartDecision = when {
    !pipelineReady -> RemoteConversationStartDecision.Reject("Androidの会話機能が準備できていません")
    phase == ConversationPhase.IDLE -> RemoteConversationStartDecision.StartAutomatic
    automaticMode -> RemoteConversationStartDecision.AlreadyActive(phase.toRemoteConversationState())
    else -> RemoteConversationStartDecision.Reject("押して話す操作を実行中です")
}

fun ConversationPhase.toRemoteConversationState(): RemoteConversationState = when (this) {
    ConversationPhase.IDLE -> RemoteConversationState.STANDBY
    ConversationPhase.CONNECTING -> RemoteConversationState.CONNECTING
    ConversationPhase.LISTENING,
    ConversationPhase.RECORDING,
    -> RemoteConversationState.LISTENING
    ConversationPhase.TRANSCRIBING,
    ConversationPhase.THINKING,
    -> RemoteConversationState.RECOGNIZING
    ConversationPhase.SPEAKING -> RemoteConversationState.SPEAKING
}

fun stackChanStatusFor(
    phase: ConversationPhase,
    extended: Boolean,
    hasError: Boolean,
): StackChanStatus = when (phase) {
    ConversationPhase.IDLE -> {
        if (extended && hasError) StackChanStatus.ERROR else StackChanStatus.IDLE
    }
    ConversationPhase.CONNECTING -> {
        if (extended) StackChanStatus.CONNECTING else StackChanStatus.IDLE
    }
    ConversationPhase.LISTENING,
    ConversationPhase.RECORDING,
    -> if (extended) StackChanStatus.LISTENING else StackChanStatus.IDLE
    ConversationPhase.TRANSCRIBING,
    ConversationPhase.THINKING,
    -> StackChanStatus.RECOGNIZING
    ConversationPhase.SPEAKING -> StackChanStatus.SPEAKING
}
