package jp.stackchan.localvoicepoc.serial

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.hardware.usb.UsbDevice
import android.hardware.usb.UsbDeviceConnection
import android.hardware.usb.UsbManager
import android.os.Build
import androidx.core.content.ContextCompat
import com.hoho.android.usbserial.driver.CdcAcmSerialDriver
import com.hoho.android.usbserial.driver.ProbeTable
import com.hoho.android.usbserial.driver.UsbSerialPort
import com.hoho.android.usbserial.driver.UsbSerialProber
import com.hoho.android.usbserial.util.SerialInputOutputManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger

sealed interface StackChanUsbState {
    data object Disconnected : StackChanUsbState
    data object PermissionPending : StackChanUsbState
    data object Connecting : StackChanUsbState
    data class Ready(val maxPayload: Int, val capabilities: Int) : StackChanUsbState
    data class Error(val message: String) : StackChanUsbState
}

class StackChanUsbConnection(context: Context) : StackChanUsbTransport, AutoCloseable {
    private val appContext = context.applicationContext
    private val usbManager = appContext.getSystemService(Context.USB_SERVICE) as UsbManager
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val parser = StackChanFrameStreamParser()
    private val generationGate = ConnectionGenerationGate()
    private val connectMutex = Mutex()
    private val writeMutex = Mutex()
    private val controlSequence = AtomicInteger(0)
    private val mutableState = MutableStateFlow<StackChanUsbState>(StackChanUsbState.Disconnected)
    private val mutableFrames = MutableSharedFlow<StackChanFrame>(extraBufferCapacity = 128)
    private val portLock = Any()

    private var device: UsbDevice? = null
    private var deviceConnection: UsbDeviceConnection? = null
    private var port: UsbSerialPort? = null
    private var ioManager: SerialInputOutputManager? = null
    @Volatile private var handshakeTimeout: Job? = null
    private var receiverRegistered = false
    @Volatile private var writeObserver: StackChanUsbWriteObserver? = null

    override val state: StateFlow<StackChanUsbState> = mutableState.asStateFlow()
    override val frames: SharedFlow<StackChanFrame> = mutableFrames.asSharedFlow()

    private val receiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            when (intent.action) {
                ACTION_USB_PERMISSION -> {
                    val target = intent.usbDevice() ?: return
                    if (intent.getBooleanExtra(UsbManager.EXTRA_PERMISSION_GRANTED, false)) {
                        scope.launch { connect(target) }
                    } else {
                        mutableState.value = StackChanUsbState.Error("USB接続の権限が拒否されました。")
                    }
                }
                UsbManager.ACTION_USB_DEVICE_ATTACHED -> retry()
                UsbManager.ACTION_USB_DEVICE_DETACHED -> {
                    val detached = intent.usbDevice()
                    if (detached?.deviceId == device?.deviceId) {
                        val generation = generationGate.current()
                        scope.launch { closePort(StackChanUsbState.Disconnected, generation) }
                    }
                }
            }
        }
    }

    init {
        val filter = IntentFilter().apply {
            addAction(ACTION_USB_PERMISSION)
            addAction(UsbManager.ACTION_USB_DEVICE_ATTACHED)
            addAction(UsbManager.ACTION_USB_DEVICE_DETACHED)
        }
        ContextCompat.registerReceiver(appContext, receiver, filter, ContextCompat.RECEIVER_NOT_EXPORTED)
        receiverRegistered = true
        retry()
    }

    fun retry() {
        scope.launch {
            val target = usbManager.deviceList.values.firstOrNull(::isStackChanUsbDevice)
            if (target == null) {
                closePort(StackChanUsbState.Disconnected)
                return@launch
            }
            if (!usbManager.hasPermission(target)) {
                mutableState.value = StackChanUsbState.PermissionPending
                val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0
                val intent = Intent(ACTION_USB_PERMISSION).setPackage(appContext.packageName)
                usbManager.requestPermission(target, PendingIntent.getBroadcast(appContext, 0, intent, flags))
                return@launch
            }
            connect(target)
        }
    }

    override suspend fun send(frame: StackChanFrame) {
        val queuedAtNanos = System.nanoTime()
        val encoded = StackChanFrameCodec.encode(frame)
        writeMutex.withLock {
            val activePort = synchronized(portLock) { port } ?: throw IOException("ｽﾀｯｸﾁｬﾝは未接続です。")
            val startedAtNanos = System.nanoTime()
            activePort.write(encoded, WRITE_TIMEOUT_MILLISECONDS)
            runCatching {
                writeObserver?.onWrite(
                    StackChanUsbWriteRecord(
                        frame = frame,
                        queuedAtNanos = queuedAtNanos,
                        startedAtNanos = startedAtNanos,
                        completedAtNanos = System.nanoTime(),
                        requestedBytes = encoded.size,
                        writtenBytes = encoded.size,
                    ),
                )
            }
        }
    }

    override fun setWriteObserver(observer: StackChanUsbWriteObserver?) {
        writeObserver = observer
    }

    override suspend fun sendControl(
        control: StackChanControl,
        sampleRate: Int,
        payload: ByteArray,
        streamId: Int,
    ) {
        send(
            StackChanFrame(
                type = StackChanFrame.Type.CONTROL,
                flags = control.wireValue,
                sequence = controlSequence.getAndIncrement(),
                sampleRate = sampleRate,
                payload = payload,
                streamId = streamId,
            ),
        )
    }

    private suspend fun connect(target: UsbDevice) {
        connectMutex.withLock { connectLocked(target) }
    }

    private suspend fun connectLocked(target: UsbDevice) {
        if (device?.deviceId == target.deviceId && port != null) return
        closePort(StackChanUsbState.Connecting)
        val generation = generationGate.begin()
        mutableState.value = StackChanUsbState.Connecting
        val driver = UsbSerialProber.getDefaultProber().probeDevice(target) ?: customProber().probeDevice(target)
        if (driver == null) {
            generationGate.closeIfCurrent(generation) {
                mutableState.value = StackChanUsbState.Error("対応するCDCインターフェースが見つかりません。")
            }
            return
        }
        val openedConnection = usbManager.openDevice(target)
        if (openedConnection == null) {
            generationGate.closeIfCurrent(generation) {
                mutableState.value = StackChanUsbState.Error("USBデバイスを開けません。")
            }
            return
        }
        val openedPort = driver.ports.firstOrNull()
        if (openedPort == null) {
            openedConnection.close()
            generationGate.closeIfCurrent(generation) {
                mutableState.value = StackChanUsbState.Error("USBシリアルポートがありません。")
            }
            return
        }
        var published = false
        try {
            openedPort.open(openedConnection)
            openedPort.setParameters(
                115_200,
                8,
                UsbSerialPort.STOPBITS_1,
                UsbSerialPort.PARITY_NONE,
            )
            val manager = SerialInputOutputManager(openedPort, object : SerialInputOutputManager.Listener {
                override fun onNewData(data: ByteArray) {
                    handleIncoming(data, generation)
                }

                override fun onRunError(error: Exception) {
                    scope.launch {
                        closePort(StackChanUsbState.Error("USB通信が停止しました: ${error.message}"), generation)
                    }
                }
            })
            val accepted = generationGate.runIfCurrent(generation) {
                synchronized(portLock) {
                    device = target
                    deviceConnection = openedConnection
                    port = openedPort
                    ioManager = manager
                    parser.reset()
                }
            }
            if (!accepted) {
                runCatching { openedPort.close() }
                openedConnection.close()
                return
            }
            published = true
            manager.start()
            sendControl(StackChanControl.HELLO, payload = helloPayload())
            handshakeTimeout = scope.launch {
                delay(HANDSHAKE_TIMEOUT_MILLISECONDS)
                closePort(
                    StackChanUsbState.Error("ｽﾀｯｸﾁｬﾝから応答がありません。"),
                    generation,
                    onlyWhileConnecting = true,
                )
            }
        } catch (error: Throwable) {
            val nextState = StackChanUsbState.Error("USB接続に失敗しました: ${error.message}")
            if (published) {
                closePort(nextState, generation)
            } else {
                runCatching { openedPort.close() }
                openedConnection.close()
                generationGate.closeIfCurrent(generation) {
                    mutableState.value = nextState
                }
            }
        }
    }

    private fun handleIncoming(data: ByteArray, generation: Long) {
        generationGate.runIfCurrent(generation) {
            for (frame in parser.push(data)) {
                if (
                    frame.type == StackChanFrame.Type.CONTROL &&
                    frame.flags == StackChanControl.HELLO_ACK.wireValue
                ) {
                    if (frame.streamId != 0) {
                        scope.launch { closePort(StackChanUsbState.Error("HELLO_ACKのstream IDが不正です。"), generation) }
                        return@runIfCurrent
                    }
                    val result = runCatching { parseHelloPayload(frame.payload) }.getOrElse {
                        scope.launch { closePort(StackChanUsbState.Error("HELLO_ACKが不正です。"), generation) }
                        return@runIfCurrent
                    }
                    if (result.first !in 640..StackChanFrameCodec.MAX_PAYLOAD_BYTES ||
                        result.second and StackChanCapabilities.REQUIRED != StackChanCapabilities.REQUIRED
                    ) {
                        scope.launch {
                            closePort(
                                StackChanUsbState.Error("USB音声プロトコルの機能が不足しています。"),
                                generation,
                            )
                        }
                        return@runIfCurrent
                    }
                    handshakeTimeout?.cancel()
                    mutableState.value = StackChanUsbState.Ready(result.first, result.second)
                }
                if (!mutableFrames.tryEmit(frame)) {
                    scope.launch { closePort(StackChanUsbState.Error("USB受信バッファがあふれました。"), generation) }
                    return@runIfCurrent
                }
            }
        }
    }

    private fun closePort(
        nextState: StackChanUsbState,
        expectedGeneration: Long? = null,
        onlyWhileConnecting: Boolean = false,
    ) {
        val closeAction = {
            handshakeTimeout?.cancel()
            handshakeTimeout = null
            val resources = synchronized(portLock) {
                val result = Triple(ioManager, port, deviceConnection)
                ioManager = null
                port = null
                deviceConnection = null
                device = null
                parser.reset()
                result
            }
            runCatching { resources.first?.stop() }
            runCatching { resources.second?.close() }
            runCatching { resources.third?.close() }
            mutableState.value = nextState
            Unit
        }
        when {
            expectedGeneration == null -> generationGate.invalidate(closeAction)
            onlyWhileConnecting -> generationGate.closeIfCurrentWhen(
                expectedGeneration,
                { mutableState.value is StackChanUsbState.Connecting },
                closeAction,
            )
            else -> generationGate.closeIfCurrent(expectedGeneration, closeAction)
        }
    }

    override fun close() {
        if (receiverRegistered) {
            appContext.unregisterReceiver(receiver)
            receiverRegistered = false
        }
        closePort(StackChanUsbState.Disconnected)
        scope.cancel()
    }

    @Suppress("DEPRECATION")
    private fun Intent.usbDevice(): UsbDevice? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            getParcelableExtra(UsbManager.EXTRA_DEVICE, UsbDevice::class.java)
        } else {
            getParcelableExtra(UsbManager.EXTRA_DEVICE)
        }

    private companion object {
        const val ESPRESSIF_VENDOR_ID = 0x303A
        const val USB_SERIAL_JTAG_PRODUCT_ID = 0x1001
        const val ACTION_USB_PERMISSION = "jp.stackchan.localvoicepoc.USB_PERMISSION"
        const val WRITE_TIMEOUT_MILLISECONDS = 2_000
        const val HANDSHAKE_TIMEOUT_MILLISECONDS = 2_000L

        fun isStackChanUsbDevice(device: UsbDevice): Boolean =
            device.vendorId == ESPRESSIF_VENDOR_ID && device.productId == USB_SERIAL_JTAG_PRODUCT_ID

        fun customProber(): UsbSerialProber = UsbSerialProber(
            ProbeTable().apply {
                addProduct(ESPRESSIF_VENDOR_ID, USB_SERIAL_JTAG_PRODUCT_ID, CdcAcmSerialDriver::class.java)
            },
        )
    }
}
