package jp.stackchan.localvoicepoc

import android.app.Application
import android.net.Uri
import android.util.Log
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import jp.stackchan.localvoicepoc.conversation.ConversationEngine
import jp.stackchan.localvoicepoc.conversation.ConversationEvent
import jp.stackchan.localvoicepoc.conversation.ConversationPhase
import jp.stackchan.localvoicepoc.diagnostics.PlaybackTraceStore
import jp.stackchan.localvoicepoc.diagnostics.RecognitionCaptureStore
import jp.stackchan.localvoicepoc.model.GemmaModelManifest
import jp.stackchan.localvoicepoc.model.GemmaModelPreferences
import jp.stackchan.localvoicepoc.model.LiteRtGemmaLanguageModel
import jp.stackchan.localvoicepoc.model.ModelComponent
import jp.stackchan.localvoicepoc.model.ModelSetupManager
import jp.stackchan.localvoicepoc.piper.PiperAssetStore
import jp.stackchan.localvoicepoc.piper.PiperPlusReflectionSynthesizer
import jp.stackchan.localvoicepoc.speech.SherpaWhisperRecognizer
import jp.stackchan.localvoicepoc.serial.SerialPcmAudioSink
import jp.stackchan.localvoicepoc.serial.SerialPcmAudioSource
import jp.stackchan.localvoicepoc.serial.StackChanCapabilities
import jp.stackchan.localvoicepoc.serial.StackChanControl
import jp.stackchan.localvoicepoc.serial.StackChanStatus
import jp.stackchan.localvoicepoc.serial.StackChanUsbConnection
import jp.stackchan.localvoicepoc.serial.StackChanUsbState
import jp.stackchan.localvoicepoc.ui.ChatMessage
import jp.stackchan.localvoicepoc.ui.ComponentProgress
import jp.stackchan.localvoicepoc.ui.MainUiState
import jp.stackchan.localvoicepoc.ui.UsbConnectionStatus
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import java.io.File

class MainViewModel(application: Application) : AndroidViewModel(application) {
    private val voiceDiagnosticsDirectory = application.getExternalFilesDir("voice-diagnostics")
        ?: File(application.filesDir, "voice-diagnostics")
    private val recognitionCaptureStore = RecognitionCaptureStore(
        File(voiceDiagnosticsDirectory, "recognition-captures"),
    )
    private val playbackTraceStore = PlaybackTraceStore(
        File(voiceDiagnosticsDirectory, "playback-traces"),
    )
    private val gemmaPreferences = GemmaModelPreferences(application)
    private val speechRecognizer = SherpaWhisperRecognizer()
    private val languageModel = LiteRtGemmaLanguageModel(application)
    private val modelManager = ModelSetupManager(application, speechRecognizer, languageModel)
    private val piperStore = PiperAssetStore(application)
    private val synthesizer = PiperPlusReflectionSynthesizer(application)
    private val usbConnection = StackChanUsbConnection(application)
    private val serialAudioSource = SerialPcmAudioSource(usbConnection)
    private val serialAudioSink = SerialPcmAudioSink(
        connection = usbConnection,
        playbackTraceStore = playbackTraceStore,
    )
    private val engine = ConversationEngine(
        audioSource = serialAudioSource,
        audioSink = serialAudioSink,
        synthesizer = synthesizer,
        speechRecognizer = speechRecognizer,
        languageModel = languageModel,
        recognitionCaptureStore = recognitionCaptureStore,
    )

    private val mutableState = MutableStateFlow(
        MainUiState(
            selectedGemmaModel = gemmaPreferences.selected(),
            piperAarPresent = synthesizer.runtimeAvailable,
        ),
    )
    val state: StateFlow<MainUiState> = mutableState.asStateFlow()
    private val stackChanStatusMutex = Mutex()
    private var lastStackChanStatus: StackChanStatus? = null

    init {
        Log.i(TAG, "Voice diagnostics directory: ${voiceDiagnosticsDirectory.absolutePath}")
        refreshPiperFiles()
        viewModelScope.launch {
            SdkBootstrap.status.collect { status ->
                mutableState.update { it.copy(sdkStatus = status) }
            }
        }
        viewModelScope.launch {
            engine.events.collect(::handleConversationEvent)
        }
        viewModelScope.launch {
            usbConnection.state.collect { connectionState ->
                val (status, error) = when (connectionState) {
                    StackChanUsbState.Disconnected -> UsbConnectionStatus.DISCONNECTED to null
                    StackChanUsbState.PermissionPending -> UsbConnectionStatus.PERMISSION_PENDING to null
                    StackChanUsbState.Connecting -> UsbConnectionStatus.CONNECTING to null
                    is StackChanUsbState.Ready -> UsbConnectionStatus.READY to null
                    is StackChanUsbState.Error -> UsbConnectionStatus.ERROR to connectionState.message
                }
                mutableState.update { it.copy(usbStatus = status, usbError = error) }
                lastStackChanStatus = null
                if (connectionState is StackChanUsbState.Ready) {
                    syncStackChanStatus(mutableState.value.phase)
                }
                if (status != UsbConnectionStatus.READY && mutableState.value.phase != ConversationPhase.IDLE) {
                    engine.stop()
                }
            }
        }
    }

    fun prepareModels() {
        val current = mutableState.value
        if (!current.canStartModelMutation) return
        val selectedModel = current.selectedGemmaModel
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
        if (current.selectedGemmaModel == selectedModel || !current.canStartModelMutation) {
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

    fun prepareRecommendedPiper() {
        val current = mutableState.value
        if (!current.canStartModelMutation) return
        if (!piperStore.hasConfirmedRecommendedTerms()) {
            mutableState.update {
                it.copy(piperTermsConfirmationRequired = true, error = null)
            }
            return
        }
        startRecommendedPiperSetup()
    }

    fun confirmRecommendedPiperTerms() {
        if (!mutableState.value.canStartModelMutation) return
        piperStore.confirmRecommendedTerms()
        mutableState.update { it.copy(piperTermsConfirmationRequired = false) }
        startRecommendedPiperSetup()
    }

    fun dismissRecommendedPiperTerms() {
        mutableState.update { it.copy(piperTermsConfirmationRequired = false) }
    }

    fun loadPiper() {
        if (!mutableState.value.canStartModelMutation) return
        mutableState.update {
            it.copy(
                piperBusy = true,
                piperLoaded = false,
                piperProgress = ComponentProgress(stage = "Piper Plusをロード中"),
                error = null,
            )
        }
        viewModelScope.launch {
            try {
                synthesizer.load(piperStore.current())
                mutableState.update { state ->
                    state.copy(
                        piperBusy = false,
                        piperLoaded = true,
                        piperProgress = ComponentProgress(stage = "ロード済み", fraction = 1f),
                        error = null,
                    )
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                mutableState.update { state ->
                    state.copy(
                        piperBusy = false,
                        piperLoaded = false,
                        piperProgress = ComponentProgress(stage = "ロード失敗"),
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

    fun retryUsbConnection() {
        usbConnection.retry()
    }

    private fun launchPiperOperation(block: suspend () -> Unit) {
        if (!mutableState.value.canStartModelMutation) return
        mutableState.update {
            it.copy(
                piperBusy = true,
                piperLoaded = false,
                piperProgress = ComponentProgress(stage = "手動ファイルを取込中"),
                error = null,
            )
        }
        viewModelScope.launch {
            try {
                block()
                refreshPiperFiles()
                mutableState.update { state ->
                    state.copy(
                        piperBusy = false,
                        piperProgress = ComponentProgress(stage = "手動ファイル取込済み", fraction = 1f),
                    )
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                mutableState.update { state ->
                    state.copy(
                        piperBusy = false,
                        piperProgress = ComponentProgress(stage = "ファイル取込失敗"),
                        error = "ファイル取込に失敗: ${error.message}",
                    )
                }
            }
        }
    }

    private fun startRecommendedPiperSetup() {
        val current = mutableState.value
        if (
            !current.canStartModelMutation ||
            !current.piperAarPresent
        ) {
            return
        }
        mutableState.update {
            it.copy(
                piperBusy = true,
                piperLoaded = false,
                piperTermsConfirmationRequired = false,
                piperProgress = ComponentProgress(stage = "自動セットアップを開始"),
                error = null,
            )
        }
        viewModelScope.launch {
            try {
                withContext(Dispatchers.IO) { synthesizer.close() }
                val installation = piperStore.prepareRecommended { progress ->
                    mutableState.update { state ->
                        state.copy(
                            piperProgress = ComponentProgress(
                                stage = progress.stage,
                                fraction = progress.fraction,
                            ),
                        )
                    }
                }
                refreshPiperFiles()
                mutableState.update {
                    it.copy(
                        piperProgress = ComponentProgress(
                            stage = "Piper Plusをロード中",
                            fraction = 1f,
                        ),
                    )
                }
                synthesizer.load(installation)
                mutableState.update {
                    it.copy(
                        piperBusy = false,
                        piperLoaded = true,
                        piperProgress = ComponentProgress(stage = "準備完了", fraction = 1f),
                        error = null,
                    )
                }
            } catch (error: CancellationException) {
                throw error
            } catch (error: Throwable) {
                refreshPiperFiles()
                mutableState.update {
                    it.copy(
                        piperBusy = false,
                        piperLoaded = false,
                        piperProgress = ComponentProgress(stage = "自動セットアップ失敗"),
                        error = "Piper Plusの自動セットアップに失敗: " +
                            (error.message ?: error::class.java.simpleName),
                    )
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
            is ConversationEvent.PhaseChanged -> {
                mutableState.update {
                    it.copy(
                        phase = event.phase,
                        audioLevel = if (event.phase == ConversationPhase.IDLE) 0f else it.audioLevel,
                    )
                }
                syncStackChanStatus(event.phase)
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

    private suspend fun syncStackChanStatus(phase: ConversationPhase) {
        stackChanStatusMutex.withLock {
            val ready = usbConnection.state.value as? StackChanUsbState.Ready ?: return
            if (ready.capabilities and StackChanCapabilities.STATUS_ICON == 0) return
            val status = when (phase) {
                ConversationPhase.TRANSCRIBING -> StackChanStatus.RECOGNIZING
                ConversationPhase.SPEAKING -> StackChanStatus.SPEAKING
                else -> StackChanStatus.IDLE
            }
            if (status == lastStackChanStatus) return
            val sent = withContext(Dispatchers.IO) {
                runCatching {
                    usbConnection.sendControl(
                        StackChanControl.STATUS,
                        payload = byteArrayOf(status.wireValue.toByte()),
                    )
                }
            }
            sent.onSuccess { lastStackChanStatus = status }
                .onFailure { error -> Log.w(TAG, "Could not update Stack-chan status icon", error) }
        }
    }

    override fun onCleared() {
        engine.close()
        serialAudioSource.close()
        serialAudioSink.close()
        usbConnection.close()
        super.onCleared()
    }

    private companion object {
        const val TAG = "MainViewModel"
    }
}
