package jp.stackchan.localvoicepoc.model

import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.awaitClose
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.buffer
import kotlinx.coroutines.flow.callbackFlow
import java.util.concurrent.atomic.AtomicBoolean

internal fun <T> losslessCallbackFlow(
    start: (
        onValue: (T) -> Unit,
        onDone: () -> Unit,
        onError: (Throwable) -> Unit,
    ) -> Unit,
    cancel: () -> Unit,
): Flow<T> = callbackFlow {
    val terminalCallbackReceived = AtomicBoolean(false)
    start(
        { value -> trySend(value) },
        {
            terminalCallbackReceived.set(true)
            close()
        },
        { error ->
            terminalCallbackReceived.set(true)
            close(error)
        },
    )
    awaitClose {
        if (!terminalCallbackReceived.get()) cancel()
    }
}.buffer(Channel.UNLIMITED)
