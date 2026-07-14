package jp.stackchan.localvoicepoc.audio

import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioTrack
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext

class AndroidPcmAudioSink : PcmAudioSink {
    private val lock = Any()
    @Volatile private var track: AudioTrack? = null
    private var framesWritten = 0L
    private var sampleRate = 0

    override suspend fun begin(sampleRate: Int) = withContext(Dispatchers.IO) {
        synchronized(lock) {
            releaseLocked()
            val minimum = AudioTrack.getMinBufferSize(
                sampleRate,
                AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
            )
            require(minimum > 0) { "Unsupported AudioTrack configuration: $minimum" }

            track = AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_ASSISTANT)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build(),
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setSampleRate(sampleRate)
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build(),
                )
                .setBufferSizeInBytes(maxOf(minimum * 2, sampleRate))
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
                .also { created ->
                    check(created.state == AudioTrack.STATE_INITIALIZED) {
                        "AudioTrack could not be initialized"
                    }
                    framesWritten = 0L
                    this@AndroidPcmAudioSink.sampleRate = sampleRate
                    created.play()
                }
        }
    }

    override suspend fun write(samples: ShortArray) = withContext(Dispatchers.IO) {
        val local = synchronized(lock) { track }
            ?: throw IllegalStateException("Audio sink has not been started")
        var offset = 0
        while (offset < samples.size) {
            val written = local.write(
                samples,
                offset,
                samples.size - offset,
                AudioTrack.WRITE_BLOCKING,
            )
            if (written <= 0) throw IllegalStateException("AudioTrack.write failed: $written")
            synchronized(lock) {
                if (track === local) framesWritten += written
            }
            offset += written
        }
    }

    override suspend fun finish() = withContext(Dispatchers.IO) {
        val pending = synchronized(lock) {
            track?.let { local ->
                PendingPlayback(
                    track = local,
                    targetFrames = framesWritten,
                    sampleRate = sampleRate,
                )
            }
        }
        if (pending != null) {
            try {
                awaitPlaybackEnd(pending)
            } finally {
                synchronized(lock) {
                    if (track === pending.track) {
                        runCatching { pending.track.stop() }
                        releaseLocked()
                    }
                }
            }
        }
    }

    override fun stop() {
        synchronized(lock) {
            track?.let { local ->
                runCatching { local.pause() }
                runCatching { local.flush() }
            }
            releaseLocked()
        }
    }

    private fun releaseLocked() {
        track?.let { runCatching { it.release() } }
        track = null
        framesWritten = 0L
        sampleRate = 0
    }

    private suspend fun awaitPlaybackEnd(pending: PendingPlayback) {
        if (pending.targetFrames <= 0L || pending.sampleRate <= 0) return

        val initialPosition = pending.track.playbackPositionOrNull() ?: return
        val remainingFrames = (pending.targetFrames - initialPosition).coerceAtLeast(0L)
        val expectedRemainingMs = framesToMilliseconds(remainingFrames, pending.sampleRate)
        val deadlineNanos = System.nanoTime() +
            (expectedRemainingMs + DRAIN_TIMEOUT_MARGIN_MS) * NANOS_PER_MILLISECOND

        while (true) {
            val playbackPosition = pending.track.playbackPositionOrNull() ?: return
            if (playbackPosition >= pending.targetFrames) {
                delay(OUTPUT_SETTLE_MS)
                return
            }
            if (pending.track.playState != AudioTrack.PLAYSTATE_PLAYING) return
            if (System.nanoTime() >= deadlineNanos) {
                Log.w(
                    TAG,
                    "Timed out draining AudioTrack: played=$playbackPosition, " +
                        "written=${pending.targetFrames}",
                )
                return
            }
            delay(DRAIN_POLL_INTERVAL_MS)
        }
    }

    private fun AudioTrack.playbackPositionOrNull(): Long? =
        runCatching { Integer.toUnsignedLong(playbackHeadPosition) }.getOrNull()

    private fun framesToMilliseconds(frames: Long, sampleRate: Int): Long =
        (frames * MILLIS_PER_SECOND + sampleRate - 1L) / sampleRate

    private data class PendingPlayback(
        val track: AudioTrack,
        val targetFrames: Long,
        val sampleRate: Int,
    )

    private companion object {
        const val TAG = "AndroidPcmAudioSink"
        const val DRAIN_POLL_INTERVAL_MS = 10L
        const val DRAIN_TIMEOUT_MARGIN_MS = 1_000L
        const val OUTPUT_SETTLE_MS = 40L
        const val MILLIS_PER_SECOND = 1_000L
        const val NANOS_PER_MILLISECOND = 1_000_000L
    }
}
