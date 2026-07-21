package jp.stackchan.localvoicepoc.conversation

import jp.stackchan.localvoicepoc.audio.PcmAudioSink
import jp.stackchan.localvoicepoc.audio.PcmAudioSource
import jp.stackchan.localvoicepoc.model.GenerationRequest
import jp.stackchan.localvoicepoc.model.LanguageModelBackend
import jp.stackchan.localvoicepoc.model.LanguageModelBackendPreference
import jp.stackchan.localvoicepoc.model.LocalLanguageModel
import jp.stackchan.localvoicepoc.piper.PiperInstallation
import jp.stackchan.localvoicepoc.piper.SpeechSynthesizer
import jp.stackchan.localvoicepoc.speech.LocalSpeechRecognizer
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertFalse
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.io.IOException
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

class ConversationEngineTest {
    @Test
    fun languageModelFailureAfterAPartialSentenceAbortsPlayback() = runBlocking {
        val sink = RecordingSink()
        val languageModel = FakeLanguageModel(
            flow {
                emit("最初の文です。")
                sink.pcmWritten.await()
                throw IOException("generation failed")
            },
        )
        val engine = ConversationEngine(
            audioSource = EmptyAudioSource,
            audioSink = sink,
            synthesizer = OneChunkSynthesizer,
            speechRecognizer = UnusedRecognizer,
            languageModel = languageModel,
        )

        val failure = runCatching {
            withTimeout(1_000) { engine.generateAndSpeak("test") }
        }.exceptionOrNull()

        assertTrue(failure is IOException)
        assertTrue("partial playback must be aborted", "abort" in sink.events)
        assertFalse("failed generation must not finish playback", "finish" in sink.events)
        engine.close()
    }

    @Test
    fun stopCancelsTheSessionBeforeWaitingForSinkAbort() = runBlocking {
        val source = PushAudioSource()
        val sink = BlockingAbortSink()
        val synthesizer = ControlledSynthesizer()
        val engine = ConversationEngine(
            audioSource = source,
            audioSink = sink,
            synthesizer = synthesizer,
            speechRecognizer = FixedRecognizer,
            languageModel = FakeLanguageModel(flow { emit("一文目です。二文目です。") }),
        )

        engine.startPushToTalk()
        source.frames.send(ByteArray(9_000))
        engine.stopPushToTalkAndProcess()
        withTimeout(1_000) { sink.pcmWritten.await() }
        val stopping = async { engine.stop() }
        withTimeout(1_000) { sink.abortEntered.await() }
        synthesizer.allowFirstSentenceToComplete.complete(Unit)
        val secondSynthesisStarted = withTimeoutOrNull(300) {
            while (synthesizer.calls.get() < 2) delay(1)
            true
        } ?: false
        sink.releaseAbort.complete(Unit)
        withTimeout(1_000) { stopping.await() }

        assertFalse("no new Piper sentence may start after stop begins", secondSynthesisStarted)
        assertEquals(1, synthesizer.calls.get())
        engine.close()
    }

    private class RecordingSink : PcmAudioSink {
        val events = CopyOnWriteArrayList<String>()
        val pcmWritten = CompletableDeferred<Unit>()

        override suspend fun begin(sampleRate: Int) {
            events += "begin"
        }

        override suspend fun write(samples: ShortArray) {
            events += "write"
            pcmWritten.complete(Unit)
        }

        override suspend fun finish() {
            events += "finish"
        }

        override suspend fun abort() {
            events += "abort"
        }

        override fun stop() = Unit
    }

    private class BlockingAbortSink : PcmAudioSink {
        val pcmWritten = CompletableDeferred<Unit>()
        val abortEntered = CompletableDeferred<Unit>()
        val releaseAbort = CompletableDeferred<Unit>()
        private val abortCalls = AtomicInteger(0)

        override suspend fun begin(sampleRate: Int) = Unit

        override suspend fun write(samples: ShortArray) {
            pcmWritten.complete(Unit)
        }

        override suspend fun finish() = Unit

        override suspend fun abort() {
            if (abortCalls.incrementAndGet() == 1) {
                abortEntered.complete(Unit)
                releaseAbort.await()
            }
        }

        override fun stop() = Unit
    }

    private class FakeLanguageModel(
        private val output: Flow<String>,
    ) : LocalLanguageModel {
        override val isLoaded = true
        override val backend = LanguageModelBackend.CPU

        override suspend fun prepare(
            modelFile: File,
            preference: LanguageModelBackendPreference,
        ): LanguageModelBackend = backend

        override fun generate(request: GenerationRequest): Flow<String> = output

        override suspend fun cancel() = Unit

        override fun close() = Unit
    }

    private object OneChunkSynthesizer : SpeechSynthesizer {
        override val isLoaded = true

        override suspend fun load(installation: PiperInstallation) = Unit

        override fun synthesize(text: String): Flow<SpeechSynthesizer.AudioChunk> = flow {
            emit(SpeechSynthesizer.AudioChunk(24_000, ShortArray(240)))
        }

        override fun cancel() = Unit

        override fun close() = Unit
    }

    private class ControlledSynthesizer : SpeechSynthesizer {
        override val isLoaded = true
        val calls = AtomicInteger(0)
        val allowFirstSentenceToComplete = CompletableDeferred<Unit>()

        override suspend fun load(installation: PiperInstallation) = Unit

        override fun synthesize(text: String): Flow<SpeechSynthesizer.AudioChunk> = flow {
            val call = calls.incrementAndGet()
            emit(SpeechSynthesizer.AudioChunk(24_000, ShortArray(240)))
            if (call == 1) allowFirstSentenceToComplete.await()
        }

        override fun cancel() = Unit

        override fun close() = Unit
    }

    private class PushAudioSource : PcmAudioSource {
        override val sampleRate = 16_000
        override val channelCount = 1
        override val bytesPerSample = 2
        val frames = Channel<ByteArray>(Channel.UNLIMITED)

        override fun chunks(): Flow<ByteArray> = flow {
            for (frame in frames) emit(frame)
        }

        override fun stop() {
            frames.close()
        }
    }

    private object EmptyAudioSource : PcmAudioSource {
        override val sampleRate = 16_000
        override val channelCount = 1
        override val bytesPerSample = 2
        override fun chunks(): Flow<ByteArray> = emptyFlow()
        override fun stop() = Unit
    }

    private object UnusedRecognizer : LocalSpeechRecognizer {
        override val isLoaded = true
        override suspend fun load(modelDirectory: File) = Unit
        override suspend fun transcribe(pcm16Le: ByteArray, sampleRate: Int): String = error("unused")
        override fun close() = Unit
    }

    private object FixedRecognizer : LocalSpeechRecognizer {
        override val isLoaded = true
        override suspend fun load(modelDirectory: File) = Unit
        override suspend fun transcribe(pcm16Le: ByteArray, sampleRate: Int): String = "test"
        override fun close() = Unit
    }
}
