package jp.stackchan.localvoicepoc

import android.os.Bundle
import android.view.WindowManager
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Surface
import androidx.compose.runtime.Composable
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import jp.stackchan.localvoicepoc.ui.StackChanScreen
import jp.stackchan.localvoicepoc.ui.StackChanTheme

class MainActivity : ComponentActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        enableEdgeToEdge()
        setContent {
            StackChanTheme {
                Surface(modifier = androidx.compose.ui.Modifier.fillMaxSize()) {
                    StackChanApp()
                }
            }
        }
    }
}

@Composable
private fun StackChanApp(viewModel: MainViewModel = viewModel()) {
    val state = viewModel.state.collectAsStateWithLifecycle().value
    val modelPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri -> uri?.let(viewModel::importPiperModel) }
    val configPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocument(),
    ) { uri -> uri?.let(viewModel::importPiperConfig) }
    val dictionaryPicker = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenDocumentTree(),
    ) { uri -> uri?.let(viewModel::importPiperDictionary) }

    StackChanScreen(
        state = state,
        onGemmaModelSelected = viewModel::selectGemmaModel,
        onPrepareModels = viewModel::prepareModels,
        onPickPiperModel = { modelPicker.launch(arrayOf("application/octet-stream", "*/*")) },
        onPickPiperConfig = { configPicker.launch(arrayOf("application/json", "text/json", "*/*")) },
        onPickDictionary = { dictionaryPicker.launch(null) },
        onPrepareRecommendedPiper = viewModel::prepareRecommendedPiper,
        onConfirmRecommendedPiperTerms = viewModel::confirmRecommendedPiperTerms,
        onDismissRecommendedPiperTerms = viewModel::dismissRecommendedPiperTerms,
        onLoadPiper = viewModel::loadPiper,
        onAutomaticModeChanged = viewModel::setAutomaticMode,
        onStartAutomatic = viewModel::startAutomatic,
        onStopConversation = viewModel::stopConversation,
        onStartPushToTalk = viewModel::startPushToTalk,
        onStopPushToTalk = viewModel::stopPushToTalkAndProcess,
        onRetryUsbConnection = viewModel::retryUsbConnection,
        onSaveMcpProfile = viewModel::saveMcpProfile,
        onDeleteMcpProfile = viewModel::deleteMcpProfile,
        onResolveMcpApproval = viewModel::resolveMcpApproval,
        onFinishSetup = viewModel::finishSetup,
        onRetryStartup = viewModel::retryStartup,
        onDismissError = viewModel::clearError,
    )
}
