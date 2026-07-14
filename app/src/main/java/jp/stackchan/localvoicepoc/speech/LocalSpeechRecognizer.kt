package jp.stackchan.localvoicepoc.speech

import java.io.File

interface LocalSpeechRecognizer : AutoCloseable {
    val isLoaded: Boolean

    suspend fun load(modelDirectory: File)

    suspend fun transcribe(pcm16Le: ByteArray, sampleRate: Int): String
}
