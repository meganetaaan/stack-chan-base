package jp.stackchan.localvoicepoc.piper

import kotlinx.coroutines.flow.Flow

interface SpeechSynthesizer : AutoCloseable {
    data class AudioChunk(val sampleRate: Int, val samples: ShortArray)

    val isLoaded: Boolean
    suspend fun load(installation: PiperInstallation)
    fun synthesize(text: String): Flow<AudioChunk>
    fun cancel()
}
