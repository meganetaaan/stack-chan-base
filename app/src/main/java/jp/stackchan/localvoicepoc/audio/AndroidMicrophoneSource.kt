package jp.stackchan.localvoicepoc.audio

import android.annotation.SuppressLint
import android.media.AudioFormat
import android.media.AudioRecord
import android.media.MediaRecorder
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.callbackFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import java.util.concurrent.atomic.AtomicBoolean

class AndroidMicrophoneSource(
    override val sampleRate: Int = 16_000,
    private val chunkDurationMs: Int = 100,
) : PcmAudioSource {
    override val channelCount: Int = 1
    override val bytesPerSample: Int = 2

    private val capturing = AtomicBoolean(false)
    @Volatile private var recorder: AudioRecord? = null

    @OptIn(ExperimentalCoroutinesApi::class)
    @SuppressLint("MissingPermission")
    override fun chunks(): Flow<ByteArray> = callbackFlow {
        check(capturing.compareAndSet(false, true)) { "Microphone is already active" }

        val chunkBytes = sampleRate * bytesPerSample * chunkDurationMs / 1_000
        val minimum = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT,
        )
        require(minimum > 0) { "Unsupported AudioRecord configuration: $minimum" }

        val localRecorder = AudioRecord.Builder()
            .setAudioSource(MediaRecorder.AudioSource.VOICE_RECOGNITION)
            .setAudioFormat(
                AudioFormat.Builder()
                    .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                    .setSampleRate(sampleRate)
                    .setChannelMask(AudioFormat.CHANNEL_IN_MONO)
                    .build(),
            )
            .setBufferSizeInBytes(maxOf(minimum * 2, chunkBytes * 4))
            .build()

        if (localRecorder.state != AudioRecord.STATE_INITIALIZED) {
            localRecorder.release()
            capturing.set(false)
            close(IllegalStateException("AudioRecord initialization failed"))
            return@callbackFlow
        }

        recorder = localRecorder
        localRecorder.startRecording()

        val reader = launch(Dispatchers.IO) {
            try {
                val buffer = ByteArray(chunkBytes)
                while (isActive && capturing.get()) {
                    val count = localRecorder.read(buffer, 0, buffer.size, AudioRecord.READ_BLOCKING)
                    when {
                        count > 0 -> trySend(buffer.copyOf(count))
                        count == AudioRecord.ERROR_DEAD_OBJECT -> break
                        count < 0 && !capturing.get() -> break
                        count < 0 -> throw IllegalStateException("AudioRecord.read failed: $count")
                    }
                }
            } finally {
                close()
            }
        }

        awaitClose {
            reader.cancel()
            release(localRecorder)
        }
    }

    override fun stop() {
        capturing.set(false)
        recorder?.let(::release)
    }

    private fun release(target: AudioRecord) {
        if (recorder === target) recorder = null
        capturing.set(false)
        runCatching { if (target.recordingState == AudioRecord.RECORDSTATE_RECORDING) target.stop() }
        runCatching { target.release() }
    }
}
