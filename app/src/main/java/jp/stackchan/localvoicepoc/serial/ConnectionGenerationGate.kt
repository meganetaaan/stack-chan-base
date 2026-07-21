package jp.stackchan.localvoicepoc.serial

internal class ConnectionGenerationGate {
    private var generation = 0L

    @Synchronized
    fun begin(): Long {
        generation += 1
        return generation
    }

    @Synchronized
    fun current(): Long = generation

    @Synchronized
    fun isCurrent(expected: Long): Boolean = generation == expected

    @Synchronized
    fun runIfCurrent(expected: Long, action: () -> Unit): Boolean {
        if (generation != expected) return false
        action()
        return true
    }

    @Synchronized
    fun closeIfCurrent(expected: Long, action: () -> Unit): Boolean {
        if (generation != expected) return false
        generation += 1
        action()
        return true
    }

    @Synchronized
    fun closeIfCurrentWhen(expected: Long, predicate: () -> Boolean, action: () -> Unit): Boolean {
        if (generation != expected || !predicate()) return false
        generation += 1
        action()
        return true
    }

    @Synchronized
    fun invalidate(action: () -> Unit) {
        generation += 1
        action()
    }
}
