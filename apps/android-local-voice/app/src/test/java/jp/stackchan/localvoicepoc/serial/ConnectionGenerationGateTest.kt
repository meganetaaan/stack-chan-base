package jp.stackchan.localvoicepoc.serial

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ConnectionGenerationGateTest {
    @Test
    fun staleCallbacksCannotMutateOrCloseTheCurrentConnection() {
        val gate = ConnectionGenerationGate()
        val first = gate.begin()
        val second = gate.begin()
        var mutations = 0
        var closes = 0

        assertFalse(gate.runIfCurrent(first) { mutations += 1 })
        assertFalse(gate.closeIfCurrent(first) { closes += 1 })
        assertTrue(gate.runIfCurrent(second) { mutations += 1 })

        assertEquals(1, mutations)
        assertEquals(0, closes)
    }

    @Test
    fun failedPublishedAttemptIsClearedAndAllowsRetry() {
        val gate = ConnectionGenerationGate()
        val resources = mutableListOf("port", "manager", "connection")
        val failed = gate.begin()

        assertTrue(gate.closeIfCurrent(failed) { resources.clear() })
        assertTrue(resources.isEmpty())
        assertFalse(gate.isCurrent(failed))
        val retry = gate.begin()
        assertTrue(gate.isCurrent(retry))
    }

    @Test
    fun exhaustiveStaleEventCheckRejectsTheBrokenVariant() {
        val events = listOf(Event.READY, Event.ERROR, Event.TIMEOUT)
        val counterexamples = mutableListOf<List<Event>>()
        for (first in events) {
            for (second in events) {
                val trace = listOf(first, Event.RECONNECT, second)
                if (brokenAcceptsOldGeneration(trace)) counterexamples += trace
                assertFalse("old event changed new state: $trace", correctAcceptsOldGeneration(trace))
            }
        }

        assertTrue("broken variant must produce a counterexample", counterexamples.isNotEmpty())
    }

    private fun correctAcceptsOldGeneration(events: List<Event>): Boolean {
        require(events[1] == Event.RECONNECT)
        val gate = ConnectionGenerationGate()
        val oldGeneration = gate.begin()
        gate.runIfCurrent(oldGeneration) { Unit }
        gate.begin()
        return gate.runIfCurrent(oldGeneration) { Unit }
    }

    private fun brokenAcceptsOldGeneration(events: List<Event>): Boolean =
        events.last() in listOf(Event.READY, Event.ERROR, Event.TIMEOUT)

    private enum class Event {
        READY,
        ERROR,
        TIMEOUT,
        RECONNECT,
    }
}
