package jp.stackchan.localvoicepoc.audio

import kotlinx.coroutines.flow.Flow

interface PcmAudioSource {
    val sampleRate: Int
    val channelCount: Int
    val bytesPerSample: Int

    /** A fresh, cold stream for each listening cycle. */
    fun chunks(): Flow<ByteArray>

    /** Stops the active capture immediately. Safe to call repeatedly. */
    fun stop()
}
