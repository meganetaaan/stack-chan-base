package jp.stackchan.localvoicepoc.conversation

import jp.stackchan.localvoicepoc.audio.PcmAudioSink
import jp.stackchan.localvoicepoc.audio.PcmAudioSource
import jp.stackchan.localvoicepoc.model.DialogueMessage
import jp.stackchan.localvoicepoc.model.GenerationRequest
import jp.stackchan.localvoicepoc.model.LocalLanguageModel
import jp.stackchan.localvoicepoc.piper.SpeechSynthesizer
import jp.stackchan.localvoicepoc.speech.LocalSpeechRecognizer
import jp.stackchan.localvoicepoc.util.Pcm
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.mapNotNull
import kotlinx.coroutines.isActive
import kotlinx.coroutines.joinAll
import kotlinx.coroutines.launch
import java.io.ByteArrayOutputStream
import java.util.ArrayDeque

class ConversationEngine(
    private val audioSource: PcmAudioSource,
    private val audioSink: PcmAudioSink,
    private val synthesizer: SpeechSynthesizer,
    private val speechRecognizer: LocalSpeechRecognizer,
    private val languageModel: LocalLanguageModel,
) : AutoCloseable {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val detector = EndpointDetector()
    private val mutableEvents = MutableSharedFlow<ConversationEvent>(extraBufferCapacity = 64)
    private val history = ArrayDeque<Pair<String, String>>()

    val events: SharedFlow<ConversationEvent> = mutableEvents.asSharedFlow()

    @Volatile private var sessionJob: Job? = null
    @Volatile private var pushToTalkJob: Job? = null
    @Volatile private var pushToTalkBuffer: ByteArrayOutputStream? = null

    fun startAutomatic() {
        check(sessionJob?.isActive != true) { "A conversation session is already running" }
        check(synthesizer.isLoaded) { "Piper Plus is not loaded" }
        check(languageModel.isLoaded) { "Gemma 4 is not loaded" }

        sessionJob = scope.launch {
            try {
                while (isActive) {
                    emitPhase(ConversationPhase.LISTENING)
                    val audio = captureAutomaticUtterance()
                    processUtterance(audio)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                mutableEvents.emit(
                    ConversationEvent.Failure(error.message ?: error::class.java.simpleName, error),
                )
            } finally {
                audioSource.stop()
                audioSink.stop()
                emitPhase(ConversationPhase.IDLE)
            }
        }
    }

    fun startPushToTalk() {
        check(sessionJob?.isActive != true) { "Automatic conversation is running" }
        check(pushToTalkJob?.isActive != true) { "Push-to-talk recording is already running" }
        check(synthesizer.isLoaded) { "Piper Plus is not loaded" }
        check(languageModel.isLoaded) { "Gemma 4 is not loaded" }

        val buffer = ByteArrayOutputStream()
        pushToTalkBuffer = buffer
        pushToTalkJob = scope.launch {
            try {
                emitPhase(ConversationPhase.RECORDING)
                audioSource.chunks().collect { chunk ->
                    buffer.write(chunk)
                    mutableEvents.tryEmit(ConversationEvent.AudioLevel(Pcm.rms16Le(chunk)))
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                mutableEvents.emit(
                    ConversationEvent.Failure(error.message ?: error::class.java.simpleName, error),
                )
            }
        }
    }

    fun stopPushToTalkAndProcess() {
        val recordingJob = pushToTalkJob ?: return
        pushToTalkJob = null
        audioSource.stop()

        sessionJob = scope.launch {
            recordingJob.join()
            val audio = pushToTalkBuffer?.toByteArray() ?: ByteArray(0)
            pushToTalkBuffer = null
            if (audio.size < audioSource.sampleRate * audioSource.bytesPerSample / 4) {
                mutableEvents.emit(ConversationEvent.Failure("録音が短すぎます。"))
                emitPhase(ConversationPhase.IDLE)
                return@launch
            }
            try {
                processUtterance(audio)
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                mutableEvents.emit(
                    ConversationEvent.Failure(error.message ?: error::class.java.simpleName, error),
                )
            } finally {
                emitPhase(ConversationPhase.IDLE)
            }
        }
    }

    suspend fun stop() {
        audioSource.stop()
        synthesizer.cancel()
        audioSink.stop()
        languageModel.cancel()
        pushToTalkJob?.cancelAndJoin()
        sessionJob?.cancelAndJoin()
        pushToTalkJob = null
        sessionJob = null
        pushToTalkBuffer = null
        emitPhase(ConversationPhase.IDLE)
    }

    private suspend fun captureAutomaticUtterance(): ByteArray {
        detector.reset()
        val accumulator = UtteranceAccumulator()
        return audioSource.chunks()
            .mapNotNull { chunk ->
                mutableEvents.tryEmit(ConversationEvent.AudioLevel(Pcm.rms16Le(chunk)))
                val speech = detector.isSpeech(chunk)
                val wasCapturing = accumulator.isCapturing
                val result = accumulator.accept(chunk, speech)
                when {
                    !wasCapturing && accumulator.isCapturing -> emitPhase(ConversationPhase.RECORDING)
                    wasCapturing && !accumulator.isCapturing && result == null -> {
                        emitPhase(ConversationPhase.LISTENING)
                    }
                }
                result
            }
            .first()
            .also { audioSource.stop() }
    }

    private suspend fun processUtterance(audio: ByteArray) {
        emitPhase(ConversationPhase.TRANSCRIBING)
        val transcription = TranscriptionSanitizer.sanitize(
            speechRecognizer.transcribe(audio, audioSource.sampleRate),
        ) ?: return
        mutableEvents.emit(ConversationEvent.UserText(transcription))

        emitPhase(ConversationPhase.THINKING)
        val response = generateAndSpeak(transcription).trim()
        if (response.isEmpty()) error("LLM returned an empty response")

        history.addLast(transcription to response)
        while (history.size > MAX_HISTORY_TURNS) history.removeFirst()
        mutableEvents.emit(ConversationEvent.AssistantText(response))
    }

    private suspend fun generateAndSpeak(userText: String): String = coroutineScope {
        val sentenceChannel = Channel<String>(capacity = 2)
        val chunker = SentenceChunker()
        var audioBegun = false

        val speaker = launch(Dispatchers.IO) {
            try {
                for (sentence in sentenceChannel) {
                    synthesizer.synthesize(sentence).collect { chunk ->
                        if (!audioBegun) {
                            audioSink.begin(chunk.sampleRate)
                            audioBegun = true
                            emitPhase(ConversationPhase.SPEAKING)
                        }
                        audioSink.write(chunk.samples)
                    }
                }
            } finally {
                if (audioBegun) audioSink.finish()
            }
        }

        val response = StringBuilder()
        try {
            languageModel.generate(
                GenerationRequest(
                    systemInstruction = SYSTEM_PROMPT,
                    history = history.flatMap { (user, assistant) ->
                        listOf(
                            DialogueMessage(DialogueMessage.Role.USER, user),
                            DialogueMessage(DialogueMessage.Role.ASSISTANT, assistant),
                        )
                    },
                    userText = userText,
                ),
            ).collect { chunk ->
                val delta = chunk.replace("\u0000", "")
                if (delta.isNotEmpty()) {
                    response.append(delta)
                    mutableEvents.emit(ConversationEvent.AssistantDraft(response.toString().trimStart()))
                    chunker.push(delta).forEach { sentenceChannel.send(it) }
                }
            }
            chunker.flush()?.let { sentenceChannel.send(it) }
        } finally {
            sentenceChannel.close()
        }

        listOf(speaker).joinAll()
        response.toString().trim()
    }

    private suspend fun emitPhase(phase: ConversationPhase) {
        mutableEvents.emit(ConversationEvent.PhaseChanged(phase))
    }

    override fun close() {
        audioSource.stop()
        detector.close()
        speechRecognizer.close()
        languageModel.close()
        synthesizer.close()
        audioSink.stop()
        scope.cancel()
    }

    private companion object {
        const val MAX_HISTORY_TURNS = 4
        const val SYSTEM_PROMPT =
            "あなたは手のひらサイズのロボット『ｽﾀｯｸﾁｬﾝ』です。" +
                "自然な日本語で、親しみはあるが簡潔に答えてください。" +
                "返答は原則1〜3文、読み上げやすい文章にし、Markdownや箇条書きは使わないでください。" +
                "内部推論や思考過程は出力しないでください。"
    }
}
