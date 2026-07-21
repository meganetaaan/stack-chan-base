package jp.stackchan.localvoicepoc.serial

import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

interface StackChanUsbTransport {
    val state: StateFlow<StackChanUsbState>
    val frames: SharedFlow<StackChanFrame>

    suspend fun send(frame: StackChanFrame)

    suspend fun sendControl(
        control: StackChanControl,
        sampleRate: Int = 0,
        payload: ByteArray = byteArrayOf(),
    )
}
