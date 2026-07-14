package jp.stackchan.localvoicepoc

import android.app.Application
import android.net.Uri
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import jp.stackchan.localvoicepoc.audio.AndroidMicrophoneSource
import jp.stackchan.localvoicepoc.audio.AndroidPcmAudioSink
import jp.stackchan.localvoicepoc.conversation.ConversationEngine
import jp.stackchan.localvoicepoc.conversation.ConversationEvent
import jp.stackchan.localvoicepoc.conversation.ConversationPhase
import jp.stackchan.localvoicepoc.model.GemmaModelManifest
import jp.stackchan.localvoicepoc.model.GemmaModelPreferences
import jp.stackchan.localvoicepoc.model.LiteRtGemmaLanguageModel
import jp.stackchan.localvoicepoc.model.ModelComponent
import jp.stackchan.localvoicepoc.model.ModelSetupManager
import jp.stackchan.localvoicepoc.piper.PiperAssetStore
import jp.stackchan.localvoicepoc.piper.PiperPlusReflectionSynthesizer
import jp.stackchan.localvoicepoc.speech.SherpaWhisperRecognizer
import jp.stackchan.localvoicepoc.ui.ChatMessage
import jp.stackchan.localvoicepoc.ui.ComponentProgress
import jp.stackchan.localvoicepoc.ui.MainUiState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val gemmaPreferences = GemmaModelPreferences(application)
    private val speechRecognizer = SherpaWhisperRecognizer()
    private val languageModel = LiteRtGemmaLanguageModel(application)
    private val modelManager = ModelSetupManager(application, speechRecognizer, languageModel)
    private val piperStore = PiperAssetStore(application)
    private val synthesizer = PiperPlusReflectionSynthesizer(application)
    private val engine = ConversationEngine(
        audioSource = AndroidMicrophoneSource(),
        audioSink = AndroidPcmAudioSink(),
        synthesizer = synthesizer,
        speechRecognizer = speechRecognizer,
        languageModel = languageModel,
    )

    private val mutableState = MutableStateFlow(
        MainUiState(
            selectedGemmaModel = gemmaPreferences.selected(),
            piperAarPresent = synthesizer.runtimeAvailable,
        ),
    )
    val state: StateFlow<MainUiState> = mutableState.asStateFlow()

    init {
        refreshPiperFiles()
        viewModelScope.launch {
            SdkBootstrap.status.collect { status ->
                mutableState.update { it.copy(sdkStatus = status) }
            }
        }
        viewModelScope.launch {
            engine.events.collect(::handleConversationEvent)
        }
    }

    fun prepareModels() {
        if (mutableState.value.modelSetupRunning) return
        val selectedModel = mutableState.value.selectedGemmaModel
        mutableState.update { it.copy(modelSetupRunning = true, modelsReady = false, error = null) }
        viewModelScope.launch {
            try {
                modelManager.prepareAll(selectedModel) { progress ->
                    mutableState.update { current ->
                        current.copy(
                            modelProgress = current.modelProgress + (
                                progress.component to ComponentProgress(
                                    stage = progress.stage,
                                    fraction = progress.fraction,
                                )
                            ),
                        )
                    }
                }
                mutableState.update {
                    it.copy(modelSetupRunning = false, modelsReady = true, error = null)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                mutableState.update {
                    it.copy(
                        modelSetupRunning = false,
                        modelsReady = false,
                        error = "モデル準備に失敗: ${error.message ?: error::class.java.simpleName}",
                    )
                }
            }
        }
    }

    fun selectGemmaModel(modelId: String) {
        val selectedModel = GemmaModelManifest.find(modelId) ?: return
        val current = mutableState.value
        if (
            current.selectedGemmaModel == selectedModel ||
            current.modelSetupRunning ||
            current.phase != ConversationPhase.IDLE
        ) {
            return
        }

        gemmaPreferences.select(selectedModel)
        mutableState.update { state ->
            state.copy(
                selectedGemmaModel = selectedModel,
                modelsReady = false,
                modelSetupRunning = true,
                modelProgress = state.modelProgress + (
                    ModelComponent.LLM to ComponentProgress(stage = "モデル切替中")
                ),
                error = null,
            )
        }
        viewModelScope.launch(Dispatchers.IO) {
            val closeError = runCatching { languageModel.close() }.exceptionOrNull()
            mutableState.update { state ->
                if (state.selectedGemmaModel != selectedModel) {
                    state
                } else {
                    state.copy(
                        modelSetupRunning = false,
                        modelProgress = state.modelProgress + (
                            ModelComponent.LLM to ComponentProgress(stage = "未準備")
                        ),
                        error = closeError?.let {
                            "モデル切替に失敗: ${it.message ?: it::class.java.simpleName}"
                        },
                    )
                }
            }
        }
    }

    fun importPiperModel(uri: Uri) = launchPiperOperation {
        piperStore.importModel(uri)
    }

    fun importPiperConfig(uri: Uri) = launchPiperOperation {
        piperStore.importConfig(uri)
    }

    fun importPiperDictionary(uri: Uri) = launchPiperOperation {
        piperStore.importDictionary(uri)
    }

    fun loadPiper() {
        if (mutableState.value.piperBusy) return
        mutableState.update { it.copy(piperBusy = true, piperLoaded = false, error = null) }
        viewModelScope.launch {
            try {
                synthesizer.load(piperStore.current())
                mutableState.update { state ->
                    state.copy(piperBusy = false, piperLoaded = true, error = null)
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                mutableState.update { state ->
                    state.copy(
                        piperBusy = false,
                        piperLoaded = false,
                        error = "Piper Plusのロードに失敗: ${error.message}",
                    )
                }
            }
        }
    }

    fun setAutomaticMode(enabled: Boolean) {
        if (mutableState.value.phase != ConversationPhase.IDLE) return
        mutableState.update { it.copy(automaticMode = enabled) }
    }

    fun startAutomatic() {
        runCatching { engine.startAutomatic() }
            .onFailure(::showError)
    }

    fun stopConversation() {
        viewModelScope.launch { engine.stop() }
    }

    fun startPushToTalk() {
        runCatching { engine.startPushToTalk() }
            .onFailure(::showError)
    }

    fun stopPushToTalkAndProcess() {
        engine.stopPushToTalkAndProcess()
    }

    fun clearError() {
        mutableState.update { it.copy(error = null) }
    }

    private fun launchPiperOperation(block: suspend () -> Unit) {
        if (mutableState.value.piperBusy) return
        mutableState.update { it.copy(piperBusy = true, piperLoaded = false, error = null) }
        viewModelScope.launch {
            try {
                block()
                refreshPiperFiles()
                mutableState.update { state -> state.copy(piperBusy = false) }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                mutableState.update { state ->
                    state.copy(piperBusy = false, error = "ファイル取込に失敗: ${error.message}")
                }
            }
        }
    }

    private fun refreshPiperFiles() {
        val installation = piperStore.current()
        mutableState.update {
            it.copy(
                piperAarPresent = synthesizer.runtimeAvailable,
                piperModelPresent = installation.model.isFile,
                piperConfigPresent = installation.config.isFile,
                piperDictionaryPresent = installation.hasCompleteDictionary,
            )
        }
    }

    private suspend fun handleConversationEvent(event: ConversationEvent) {
        when (event) {
            is ConversationEvent.PhaseChanged -> mutableState.update {
                it.copy(phase = event.phase, audioLevel = if (event.phase == ConversationPhase.IDLE) 0f else it.audioLevel)
            }
            is ConversationEvent.AudioLevel -> mutableState.update {
                it.copy(audioLevel = (event.rms * 12f).coerceIn(0f, 1f))
            }
            is ConversationEvent.UserText -> mutableState.update {
                it.copy(
                    messages = it.messages + ChatMessage(ChatMessage.Role.USER, event.text),
                    assistantDraft = "",
                    error = null,
                )
            }
            is ConversationEvent.AssistantDraft -> mutableState.update {
                it.copy(assistantDraft = event.text)
            }
            is ConversationEvent.AssistantText -> mutableState.update {
                it.copy(
                    messages = it.messages + ChatMessage(ChatMessage.Role.ASSISTANT, event.text),
                    assistantDraft = "",
                )
            }
            is ConversationEvent.Failure -> showError(event.cause ?: IllegalStateException(event.message))
        }
    }

    private fun showError(error: Throwable) {
        mutableState.update {
            it.copy(error = error.message ?: error::class.java.simpleName)
        }
    }

    override fun onCleared() {
        engine.close()
        super.onCleared()
    }
}
