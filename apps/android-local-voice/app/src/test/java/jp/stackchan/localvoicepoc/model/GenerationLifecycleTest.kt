package jp.stackchan.localvoicepoc.model

import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class GenerationLifecycleTest {
    @Test
    fun cancellationDuringSetupRemainsSetAfterTheConversationIsAttached() {
        val lifecycle = GenerationLifecycle<Any>()
        val generation = lifecycle.begin()

        assertNull(lifecycle.requestCancellation())
        val conversation = Any()
        generation.attach(conversation)

        assertTrue(generation.isCancellationRequested)
        assertSame(conversation, lifecycle.requestCancellation())
        lifecycle.finish(generation)
    }

    @Test
    fun cancellationAfterSetupTargetsTheAttachedConversation() {
        val lifecycle = GenerationLifecycle<Any>()
        val generation = lifecycle.begin()
        val conversation = Any()
        generation.attach(conversation)

        assertSame(conversation, lifecycle.requestCancellation())
        assertTrue(generation.isCancellationRequested)
        lifecycle.finish(generation)
    }

    @Test
    fun finishingAGenerationDoesNotCancelTheNextGeneration() {
        val lifecycle = GenerationLifecycle<Any>()
        val first = lifecycle.begin()
        lifecycle.requestCancellation()
        lifecycle.finish(first)

        assertNull(lifecycle.requestCancellation())
        val second = lifecycle.begin()
        assertFalse(second.isCancellationRequested)
        lifecycle.finish(second)
    }
}
