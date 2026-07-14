package jp.stackchan.localvoicepoc.audio

interface PcmAudioSink {
    suspend fun begin(sampleRate: Int)
    suspend fun write(samples: ShortArray)
    suspend fun finish()
    fun stop()
}
