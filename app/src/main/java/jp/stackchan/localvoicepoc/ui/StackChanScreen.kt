package jp.stackchan.localvoicepoc.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import jp.stackchan.localvoicepoc.SdkBootstrap
import jp.stackchan.localvoicepoc.conversation.ConversationPhase
import jp.stackchan.localvoicepoc.model.GemmaModelManifest
import jp.stackchan.localvoicepoc.model.GemmaModelSpec
import jp.stackchan.localvoicepoc.model.ModelComponent
import jp.stackchan.localvoicepoc.piper.PiperAssetLinks
import java.util.Locale

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StackChanScreen(
    state: MainUiState,
    onGemmaModelSelected: (String) -> Unit,
    onPrepareModels: () -> Unit,
    onPickPiperModel: () -> Unit,
    onPickPiperConfig: () -> Unit,
    onPickDictionary: () -> Unit,
    onPrepareRecommendedPiper: () -> Unit,
    onConfirmRecommendedPiperTerms: () -> Unit,
    onDismissRecommendedPiperTerms: () -> Unit,
    onLoadPiper: () -> Unit,
    onAutomaticModeChanged: (Boolean) -> Unit,
    onStartAutomatic: () -> Unit,
    onStopConversation: () -> Unit,
    onStartPushToTalk: () -> Unit,
    onStopPushToTalk: () -> Unit,
    onRetryUsbConnection: () -> Unit,
    onDismissError: () -> Unit,
) {
    Scaffold(
        topBar = {
            TopAppBar(title = { Text("ｽﾀｯｸﾁｬﾝ Local Voice PoC") })
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(padding)
                .padding(horizontal = 16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            item { Spacer(Modifier.height(2.dp)) }
            item {
                SetupCard(
                    state = state,
                    onGemmaModelSelected = onGemmaModelSelected,
                    onPrepareModels = onPrepareModels,
                    onPickPiperModel = onPickPiperModel,
                    onPickPiperConfig = onPickPiperConfig,
                    onPickDictionary = onPickDictionary,
                    onPrepareRecommendedPiper = onPrepareRecommendedPiper,
                    onLoadPiper = onLoadPiper,
                )
            }
            item {
                ConversationControls(
                    state = state,
                    onAutomaticModeChanged = onAutomaticModeChanged,
                    onStartAutomatic = onStartAutomatic,
                    onStopConversation = onStopConversation,
                    onStartPushToTalk = onStartPushToTalk,
                    onStopPushToTalk = onStopPushToTalk,
                    onRetryUsbConnection = onRetryUsbConnection,
                )
            }
            if (state.messages.isEmpty() && state.assistantDraft.isBlank()) {
                item {
                    Text(
                        text = "モデルを準備し、Piper Plusをロードしてから会話を開始します。",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
            }
            items(state.messages) { message ->
                MessageCard(message)
            }
            if (state.assistantDraft.isNotBlank()) {
                item {
                    MessageCard(
                        ChatMessage(ChatMessage.Role.ASSISTANT, state.assistantDraft),
                        draft = true,
                    )
                }
            }
            item { Spacer(Modifier.height(24.dp)) }
        }
    }

    state.error?.let { message ->
        AlertDialog(
            onDismissRequest = onDismissError,
            confirmButton = {
                TextButton(onClick = onDismissError) { Text("閉じる") }
            },
            title = { Text("エラー") },
            text = { Text(message) },
        )
    }

    if (state.piperTermsConfirmationRequired) {
        val uriHandler = LocalUriHandler.current
        AlertDialog(
            onDismissRequest = onDismissRecommendedPiperTerms,
            confirmButton = {
                TextButton(onClick = onConfirmRecommendedPiperTerms) {
                    Text("確認して準備")
                }
            },
            dismissButton = {
                Row {
                    TextButton(onClick = { uriHandler.openUri(PiperAssetLinks.MODEL_LICENSE_URL) }) {
                        Text("利用条件を開く")
                    }
                    TextButton(onClick = onDismissRecommendedPiperTerms) {
                        Text("キャンセル")
                    }
                }
            },
            title = { Text("推奨音声の利用条件") },
            text = {
                Text(
                    "つくよみちゃんコーパスの利用条件が適用されます。" +
                        "リンク先を確認してからダウンロードしてください。",
                )
            },
        )
    }
}

@Composable
private fun SetupCard(
    state: MainUiState,
    onGemmaModelSelected: (String) -> Unit,
    onPrepareModels: () -> Unit,
    onPickPiperModel: () -> Unit,
    onPickPiperConfig: () -> Unit,
    onPickDictionary: () -> Unit,
    onPrepareRecommendedPiper: () -> Unit,
    onLoadPiper: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            Text("セットアップ", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
            StatusLine("ASRモデル管理", sdkLabel(state.sdkStatus))
            HorizontalDivider()

            Text("ローカルモデル", fontWeight = FontWeight.SemiBold)
            GemmaModelSelector(
                selected = state.selectedGemmaModel,
                enabled = state.canStartModelMutation,
                onSelected = onGemmaModelSelected,
            )
            ModelProgressLine(
                "LLM: ${state.selectedGemmaModel.name} (LiteRT-LM)",
                state.modelProgress.getValue(ModelComponent.LLM),
            )
            ModelProgressLine("STT: Whisper Small multilingual", state.modelProgress.getValue(ModelComponent.STT))
            ModelProgressLine("VAD: WebRTC 20 ms", state.modelProgress.getValue(ModelComponent.VAD))
            Text(
                "${state.selectedGemmaModel.name}は約" +
                    "${formatModelSize(state.selectedGemmaModel.expectedBytes)}です。" +
                    "初回だけアプリ内へダウンロードします。",
                style = MaterialTheme.typography.bodySmall,
            )
            GemmaInformationLinks(state.selectedGemmaModel)
            Button(
                modifier = Modifier.fillMaxWidth(),
                enabled = state.sdkStatus is SdkBootstrap.Status.Ready && state.canStartModelMutation,
                onClick = onPrepareModels,
            ) {
                Text(if (state.modelsReady) "モデルを再ロード" else "モデルをダウンロードして準備")
            }

            HorizontalDivider()
            Text("Piper Plus 日本語TTS", fontWeight = FontWeight.SemiBold)
            StatusLine("AAR", presentLabel(state.piperAarPresent))
            StatusLine("音声モデル .onnx", presentLabel(state.piperModelPresent))
            StatusLine("設定 .json", presentLabel(state.piperConfigPresent))
            StatusLine("OpenJTalk辞書", presentLabel(state.piperDictionaryPresent))
            Text("推奨音声", style = MaterialTheme.typography.labelLarge)
            Text(
                "${PiperAssetLinks.RECOMMENDED_MODEL_NAME}を約72MBダウンロードし、" +
                    "辞書を展開して自動ロードします。保存には約180MB使用します。",
                style = MaterialTheme.typography.bodySmall,
            )
            ModelProgressLine("自動セットアップ", state.piperProgress)
            Button(
                modifier = Modifier.fillMaxWidth(),
                enabled = state.piperAarPresent && state.canStartModelMutation,
                onClick = onPrepareRecommendedPiper,
            ) {
                Text("推奨音声をダウンロードして準備")
            }

            HorizontalDivider()
            Text("任意音声の手動設定", style = MaterialTheme.typography.labelLarge)
            PiperDownloadLinks()

            Row(modifier = Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                OutlinedButton(
                    modifier = Modifier.weight(1f),
                    enabled = state.canStartModelMutation,
                    onClick = onPickPiperModel,
                ) { Text("ONNX") }
                OutlinedButton(
                    modifier = Modifier.weight(1f),
                    enabled = state.canStartModelMutation,
                    onClick = onPickPiperConfig,
                ) { Text("JSON") }
                OutlinedButton(
                    modifier = Modifier.weight(1f),
                    enabled = state.canStartModelMutation,
                    onClick = onPickDictionary,
                ) { Text("辞書") }
            }
            Button(
                modifier = Modifier.fillMaxWidth(),
                enabled = state.piperAarPresent && state.piperModelPresent &&
                    state.piperConfigPresent && state.piperDictionaryPresent && state.canStartModelMutation,
                onClick = onLoadPiper,
            ) {
                Text(if (state.piperLoaded) "Piper Plus ロード済み" else "Piper Plusをロード")
            }
        }
    }
}

@Composable
private fun GemmaModelSelector(
    selected: GemmaModelSpec,
    enabled: Boolean,
    onSelected: (String) -> Unit,
) {
    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(8.dp),
    ) {
        GemmaModelManifest.all.forEach { model ->
            val label = when (model) {
                GemmaModelManifest.E2B -> "E2B（速度重視）"
                GemmaModelManifest.E4B -> "E4B（品質重視）"
                else -> model.variant
            }
            if (model == selected) {
                Button(
                    modifier = Modifier.weight(1f),
                    enabled = enabled,
                    onClick = { onSelected(model.id) },
                ) {
                    Text(label)
                }
            } else {
                OutlinedButton(
                    modifier = Modifier.weight(1f),
                    enabled = enabled,
                    onClick = { onSelected(model.id) },
                ) {
                    Text(label)
                }
            }
        }
    }
}

@Composable
private fun GemmaInformationLinks(modelSpec: GemmaModelSpec) {
    val uriHandler = LocalUriHandler.current

    Row(
        modifier = Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.SpaceEvenly,
    ) {
        TextButton(onClick = { uriHandler.openUri(modelSpec.modelCardUrl) }) {
            Text("モデル情報")
        }
        TextButton(onClick = { uriHandler.openUri(GemmaModelManifest.LICENSE_URL) }) {
            Text("Gemma利用条件")
        }
    }
}

private fun formatModelSize(bytes: Long): String =
    String.format(Locale.ROOT, "%.2fGB", bytes / 1_000_000_000.0)

@Composable
private fun PiperDownloadLinks() {
    val uriHandler = LocalUriHandler.current

    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text("取得先", style = MaterialTheme.typography.labelLarge)
        Text("取得リンクは外部ブラウザで開きます。", style = MaterialTheme.typography.bodySmall)
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            TextButton(onClick = { uriHandler.openUri(PiperAssetLinks.MODEL_DOWNLOAD_URL) }) {
                Text("ONNXを取得")
            }
            TextButton(onClick = { uriHandler.openUri(PiperAssetLinks.CONFIG_DOWNLOAD_URL) }) {
                Text("JSONを取得")
            }
        }
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.SpaceEvenly,
        ) {
            TextButton(onClick = { uriHandler.openUri(PiperAssetLinks.DICTIONARY_DOWNLOAD_URL) }) {
                Text("辞書ZIPを取得")
            }
            TextButton(onClick = { uriHandler.openUri(PiperAssetLinks.MODEL_LICENSE_URL) }) {
                Text("利用条件")
            }
        }
        Text(
            text = "辞書ZIPを展開し、piper/share/open_jtalk/dicフォルダを選択してください。",
            style = MaterialTheme.typography.bodySmall,
        )
        Text(
            text = "取得後、下のONNX・JSON・辞書ボタンから各ファイルを取り込みます。",
            style = MaterialTheme.typography.bodySmall,
        )
    }
}

@Composable
private fun ConversationControls(
    state: MainUiState,
    onAutomaticModeChanged: (Boolean) -> Unit,
    onStartAutomatic: () -> Unit,
    onStopConversation: () -> Unit,
    onStartPushToTalk: () -> Unit,
    onStopPushToTalk: () -> Unit,
    onRetryUsbConnection: () -> Unit,
) {
    Card(modifier = Modifier.fillMaxWidth()) {
        Column(
            modifier = Modifier.padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Row(
                modifier = Modifier.fillMaxWidth(),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(modifier = Modifier.weight(1f)) {
                    Text("会話", style = MaterialTheme.typography.titleMedium, fontWeight = FontWeight.Bold)
                    Text(
                        "状態: ${phaseLabel(state.phase, state.automaticMode)}",
                        style = MaterialTheme.typography.bodySmall,
                    )
                }
                Text("自動VAD")
                Spacer(Modifier.width(8.dp))
                Switch(
                    checked = state.automaticMode,
                    enabled = state.phase == ConversationPhase.IDLE,
                    onCheckedChange = onAutomaticModeChanged,
                )
            }

            StatusLine("CoreS3 USB", usbStatusLabel(state))
            state.usbError?.let {
                Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall)
            }
            if (state.usbStatus == UsbConnectionStatus.DISCONNECTED || state.usbStatus == UsbConnectionStatus.ERROR) {
                OutlinedButton(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = onRetryUsbConnection,
                ) {
                    Text("USB接続を再試行")
                }
            }

            LinearProgressIndicator(
                progress = { state.audioLevel },
                modifier = Modifier.fillMaxWidth(),
            )

            when {
                state.automaticMode && state.phase == ConversationPhase.IDLE -> Button(
                    modifier = Modifier.fillMaxWidth(),
                    enabled = state.pipelineReady,
                    onClick = onStartAutomatic,
                ) { Text("自動会話を開始") }

                state.automaticMode -> Button(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = onStopConversation,
                ) { Text("自動会話を停止") }

                state.phase == ConversationPhase.IDLE -> Button(
                    modifier = Modifier.fillMaxWidth(),
                    enabled = state.pipelineReady,
                    onClick = onStartPushToTalk,
                ) { Text("録音開始") }

                state.phase == ConversationPhase.RECORDING -> Button(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = onStopPushToTalk,
                ) { Text("録音終了・応答") }

                else -> Button(
                    modifier = Modifier.fillMaxWidth(),
                    onClick = onStopConversation,
                ) { Text("処理を中断") }
            }
        }
    }
}

private fun usbStatusLabel(state: MainUiState): String = when (state.usbStatus) {
    UsbConnectionStatus.DISCONNECTED -> "未接続"
    UsbConnectionStatus.PERMISSION_PENDING -> "権限確認中"
    UsbConnectionStatus.CONNECTING -> "接続中"
    UsbConnectionStatus.READY -> "接続済み（PCM 16kHz入力／24kHz出力）"
    UsbConnectionStatus.ERROR -> "通信エラー"
}

@Composable
private fun ModelProgressLine(label: String, progress: ComponentProgress) {
    Column(verticalArrangement = Arrangement.spacedBy(3.dp)) {
        Row(modifier = Modifier.fillMaxWidth()) {
            Text(label, modifier = Modifier.weight(1f), style = MaterialTheme.typography.bodySmall)
            Text(progress.stage, style = MaterialTheme.typography.bodySmall)
        }
        LinearProgressIndicator(
            progress = { progress.fraction },
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

@Composable
private fun StatusLine(label: String, value: String) {
    Row(modifier = Modifier.fillMaxWidth()) {
        Text(label, modifier = Modifier.weight(1f))
        Text(value, fontWeight = FontWeight.Medium)
    }
}

@Composable
private fun MessageCard(message: ChatMessage, draft: Boolean = false) {
    Box(
        modifier = Modifier.fillMaxWidth(),
        contentAlignment = if (message.role == ChatMessage.Role.USER) Alignment.CenterEnd else Alignment.CenterStart,
    ) {
        Card(
            modifier = Modifier.fillMaxWidth(0.9f),
            shape = RoundedCornerShape(14.dp),
            colors = CardDefaults.cardColors(
                containerColor = if (message.role == ChatMessage.Role.USER) {
                    MaterialTheme.colorScheme.secondaryContainer
                } else {
                    MaterialTheme.colorScheme.surfaceVariant
                },
            ),
        ) {
            Column(modifier = Modifier.padding(12.dp)) {
                Text(
                    if (message.role == ChatMessage.Role.USER) "利用者" else "ｽﾀｯｸﾁｬﾝ",
                    style = MaterialTheme.typography.labelMedium,
                    fontWeight = FontWeight.Bold,
                )
                Text(message.text)
                if (draft) Text("生成中…", style = MaterialTheme.typography.labelSmall)
            }
        }
    }
}

private fun sdkLabel(status: SdkBootstrap.Status): String = when (status) {
    SdkBootstrap.Status.Starting -> "初期化中"
    SdkBootstrap.Status.Ready -> "準備完了"
    is SdkBootstrap.Status.Failed -> "失敗: ${status.message}"
}

private fun presentLabel(present: Boolean): String = if (present) "あり" else "未配置"

private fun phaseLabel(phase: ConversationPhase, automaticMode: Boolean): String = when (phase) {
    ConversationPhase.IDLE -> "待機"
    ConversationPhase.LISTENING -> "発話待ち"
    ConversationPhase.RECORDING -> if (automaticMode) "発話中" else "録音中"
    ConversationPhase.TRANSCRIBING -> "音声認識中"
    ConversationPhase.THINKING -> "応答生成中"
    ConversationPhase.SPEAKING -> "発話中"
}
