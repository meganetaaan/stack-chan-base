package jp.stackchan.localvoicepoc

import android.app.Application
import android.util.Log
import com.runanywhere.sdk.core.onnx.ONNX
import com.runanywhere.sdk.foundation.bridge.extensions.CppBridgeModelPaths
import com.runanywhere.sdk.llm.llamacpp.LlamaCPP
import com.runanywhere.sdk.public.RunAnywhere
import com.runanywhere.sdk.public.configuration.SDKEnvironment
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch

class StackChanApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        SdkBootstrap.initialize(this)
    }
}

object SdkBootstrap {
    sealed interface Status {
        data object Starting : Status
        data object Ready : Status
        data class Failed(val message: String) : Status
    }

    private val mutableStatus = MutableStateFlow<Status>(Status.Starting)
    val status: StateFlow<Status> = mutableStatus
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    fun initialize(application: Application) {
        scope.launch {
            runCatching {
                RunAnywhere.initialize(
                    context = application,
                    environment = SDKEnvironment.SDK_ENVIRONMENT_DEVELOPMENT,
                )
                CppBridgeModelPaths.setBaseDirectory(
                    application.filesDir.resolve("runanywhere").absolutePath,
                )
                ONNX.register()
                LlamaCPP.register()
            }.onSuccess {
                mutableStatus.value = Status.Ready
            }.onFailure { error ->
                Log.e("StackChanPoC", "RunAnywhere initialization failed", error)
                mutableStatus.value = Status.Failed(error.message ?: error::class.java.simpleName)
            }
        }
    }
}
