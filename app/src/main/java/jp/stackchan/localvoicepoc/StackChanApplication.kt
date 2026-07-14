package jp.stackchan.localvoicepoc

import android.app.Application
import android.util.Log
import com.runanywhere.sdk.core.onnx.ONNX
import com.runanywhere.sdk.foundation.bridge.extensions.CppBridgeDevice
import com.runanywhere.sdk.foundation.bridge.extensions.CppBridgeModelPaths
import com.runanywhere.sdk.foundation.bridge.extensions.CppBridgeTelemetry
import com.runanywhere.sdk.public.RunAnywhere
import com.runanywhere.sdk.public.SDKEnvironment
import com.runanywhere.sdk.storage.AndroidPlatformContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

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

    fun initialize(application: Application) {
        runCatching {
            AndroidPlatformContext.initialize(application)
            // RunAnywhere 0.20.6 has no pre-initialization telemetry opt-out.
            // A blank device ID makes its native telemetry manager stay disabled.
            CppBridgeDevice.setDeviceId("")
            RunAnywhere.initialize(environment = SDKEnvironment.DEVELOPMENT)
            // This PoC is offline-only after model setup. Disable SDK telemetry as well.
            CppBridgeTelemetry.unregister()
            CppBridgeModelPaths.setBaseDirectory(
                application.filesDir.resolve("runanywhere").absolutePath,
            )

            ONNX.register(priority = 100)
        }.onSuccess {
            mutableStatus.value = Status.Ready
        }.onFailure { error ->
            Log.e("StackChanPoC", "RunAnywhere initialization failed", error)
            mutableStatus.value = Status.Failed(error.message ?: error::class.java.simpleName)
        }
    }
}
