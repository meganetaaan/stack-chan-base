package jp.stackchan.localvoicepoc.serial

import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

data class StackChanUsbWriteRecord(
    val frame: StackChanFrame,
    val queuedAtNanos: Long,
    val startedAtNanos: Long,
    val completedAtNanos: Long,
    val requestedBytes: Int,
    val writtenBytes: Int,
)

fun interface StackChanUsbWriteObserver {
    fun onWrite(record: StackChanUsbWriteRecord)
}

interface StackChanUsbTransport {
    val state: StateFlow<StackChanUsbState>
    val frames: SharedFlow<StackChanFrame>

    suspend fun send(frame: StackChanFrame)

    fun allocateStreamId(): Int = StackChanStreamIdAllocator.next()

    fun setWriteObserver(observer: StackChanUsbWriteObserver?) = Unit

    suspend fun sendControl(
        control: StackChanControl,
        sampleRate: Int = 0,
        payload: ByteArray = byteArrayOf(),
        streamId: Int = 0,
    )
}
