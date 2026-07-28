package jp.stackchan.localvoicepoc.piper

import android.util.Log
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import jp.stackchan.localvoicepoc.audio.AndroidPcmAudioSink
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.math.abs

@RunWith(AndroidJUnit4::class)
class PiperDeviceTest {
    @Test
    fun downloadsRecommendedAssetsAndSynthesizesPcm() {
        runBlocking {
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val store = PiperAssetStore(context)
            var lastStage = ""
            val installation = withTimeout(RECOMMENDED_SETUP_TIMEOUT_MS) {
                store.prepareRecommended { progress ->
                    if (progress.stage != lastStage) {
                        Log.i(TAG, "Recommended setup: ${progress.stage} ${progress.fraction}")
                        lastStage = progress.stage
                    }
                }
            }
            assertTrue("推奨Piperファイル一式が揃っていません", installation.isComplete)
            assertTrue(
                "推奨音声モデルのサイズが一致しません",
                installation.model.length() == PiperAssetLinks.MODEL.expectedBytes,
            )
            assertTrue(
                "推奨設定JSONのサイズが一致しません",
                installation.config.length() == PiperAssetLinks.CONFIG.expectedBytes,
            )

            val synthesizer = PiperPlusReflectionSynthesizer(context)
            try {
                synthesizer.load(installation)
                var sampleCount = 0L
                var peak = 0
                withTimeout(TEST_TIMEOUT_MS) {
                    synthesizer.synthesize("自動セットアップの確認です。").collect { chunk ->
                        sampleCount += chunk.samples.size
                        chunk.samples.forEach { sample ->
                            peak = maxOf(peak, abs(sample.toInt()))
                        }
                    }
                }
                assertTrue("推奨音声モデルがPCMを返しませんでした", sampleCount > 0L)
                assertTrue("推奨音声モデルのPCMが無音です", peak > MINIMUM_PEAK)
            } finally {
                synthesizer.close()
            }
        }
    }

    @Test
    fun synthesizesNonSilentPcmFromInstalledAssets() {
        runBlocking {
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val installation = PiperAssetStore(context).current()
            assertTrue("Piperのファイル一式が揃っていません", installation.isComplete)

            val synthesizer = PiperPlusReflectionSynthesizer(context)
            try {
                synthesizer.load(installation)
                var sampleRate = 0
                var sampleCount = 0L
                var peak = 0
                withTimeout(TEST_TIMEOUT_MS) {
                    synthesizer.synthesize("こんにちは、スタックチャンです。").collect { chunk ->
                        sampleRate = chunk.sampleRate
                        sampleCount += chunk.samples.size
                        chunk.samples.forEach { sample ->
                            peak = maxOf(peak, abs(sample.toInt()))
                        }
                    }
                }

                Log.i(TAG, "Piper output: sampleRate=$sampleRate, samples=$sampleCount, peak=$peak")
                assertTrue("PiperがPCMを返しませんでした", sampleCount > 0L)
                assertTrue("PiperのPCMが無音です", peak > MINIMUM_PEAK)
            } finally {
                synthesizer.close()
            }
        }
    }

    @Test
    fun playsSynthesizedPcmThroughAndroidAudioTrack() {
        runBlocking {
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val installation = PiperAssetStore(context).current()
            assertTrue("Piperのファイル一式が揃っていません", installation.isComplete)

            val synthesizer = PiperPlusReflectionSynthesizer(context)
            val audioSink = AndroidPcmAudioSink()
            var audioBegun = false
            var sampleRate = 0
            var sampleCount = 0L
            var playbackStartedAtMs = 0L
            try {
                synthesizer.load(installation)
                withTimeout(TEST_TIMEOUT_MS) {
                    synthesizer.synthesize("音声再生のテストです。聞こえていますか？").collect { chunk ->
                        if (!audioBegun) {
                            sampleRate = chunk.sampleRate
                            playbackStartedAtMs = SystemClock.elapsedRealtime()
                            audioSink.begin(chunk.sampleRate)
                            audioBegun = true
                        }
                        sampleCount += chunk.samples.size
                        audioSink.write(chunk.samples)
                    }
                    assertTrue("再生対象のPCMがありません", audioBegun)
                    audioSink.finish()

                    val elapsedMs = SystemClock.elapsedRealtime() - playbackStartedAtMs
                    val expectedMs = sampleCount * 1_000L / sampleRate
                    Log.i(
                        TAG,
                        "Piper playback: expected=${expectedMs}ms, elapsed=${elapsedMs}ms, " +
                            "samples=$sampleCount",
                    )
                    assertTrue(
                        "AudioTrackが末尾より早く終了しました: expected=${expectedMs}ms, " +
                            "elapsed=${elapsedMs}ms",
                        elapsedMs >= expectedMs - MAX_EARLY_FINISH_MS,
                    )
                }
            } finally {
                if (audioBegun) audioSink.stop()
                synthesizer.close()
            }
        }
    }

    private companion object {
        const val TAG = "PiperDeviceTest"
        const val TEST_TIMEOUT_MS = 60_000L
        const val RECOMMENDED_SETUP_TIMEOUT_MS = 300_000L
        const val MINIMUM_PEAK = 64
        const val MAX_EARLY_FINISH_MS = 100L
    }
}
