package jp.stackchan.localvoicepoc.audio

interface PcmAudioSink {
    suspend fun begin(sampleRate: Int)
    suspend fun setCaption(text: String) = Unit
    suspend fun write(samples: ShortArray)
    suspend fun finish()
    suspend fun abort() = stop()
    fun stop()
}
