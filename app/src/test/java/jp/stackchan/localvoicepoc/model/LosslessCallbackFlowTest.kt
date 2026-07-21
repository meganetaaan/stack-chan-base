package jp.stackchan.localvoicepoc.model

import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

class LosslessCallbackFlowTest {
    @Test
    fun preservesEverySynchronousCallbackWhileTheConsumerIsSlow() = runBlocking {
        val expected = (0 until 512).toList()
        var cancelled = false

        val actual = losslessCallbackFlow<Int>(
            start = { onValue, onDone, _ ->
                expected.forEach(onValue)
                onDone()
            },
            cancel = { cancelled = true },
        ).onEach { delay(1) }.toList()

        assertEquals(expected, actual)
        assertFalse("normal completion must not cancel the producer", cancelled)
    }
}
