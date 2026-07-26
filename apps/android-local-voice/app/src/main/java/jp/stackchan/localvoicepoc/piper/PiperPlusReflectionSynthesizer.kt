package jp.stackchan.localvoicepoc.piper

import android.content.Context
import jp.stackchan.localvoicepoc.BuildConfig
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.withContext
import java.lang.reflect.InvocationTargetException
import java.lang.reflect.Modifier
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Runtime adapter for the optional Piper Plus AAR.
 *
 * Reflection is deliberate: it keeps this PoC buildable before the locally-built AAR is
 * copied into app/libs, while retaining the real Piper Plus API at runtime.
 */
class PiperPlusReflectionSynthesizer(context: Context) : SpeechSynthesizer {
    private val appContext = context.applicationContext
    private val lock = Any()
    private val cancelled = AtomicBoolean(false)

    @Volatile private var engine: Any? = null
    @Volatile private var engineClass: Class<*>? = null
    @Volatile private var modelSampleRate: Int = 0

    override val isLoaded: Boolean get() = engine != null

    val runtimeAvailable: Boolean
        get() = BuildConfig.PIPER_PLUS_AAR_PRESENT &&
            runCatching { Class.forName(CLASS_NAME) }.isSuccess

    override suspend fun load(installation: PiperInstallation) = withContext(Dispatchers.IO) {
        require(runtimeAvailable) {
            "Piper Plus AAR is missing. Copy piper-plus-release.aar to app/libs and rebuild."
        }
        require(installation.isComplete) {
            "Piper model, JSON config, and OpenJTalk dictionary must all be imported first."
        }

        synchronized(lock) {
            closeLocked()
            val clazz = Class.forName(CLASS_NAME)
            val created = invokeCreate(clazz, installation)
            val sampleRate = clazz.getMethod("getSampleRate").invoke(created) as Int
            require(sampleRate > 0) { "Piper Plus returned an invalid sample rate" }
            engineClass = clazz
            engine = created
            modelSampleRate = sampleRate
            cancelled.set(false)
        }
    }

    override fun synthesize(text: String): Flow<SpeechSynthesizer.AudioChunk> = flow {
        val normalized = text.trim()
        if (normalized.isEmpty()) return@flow
        cancelled.set(false)

        currentCoroutineContext().ensureActive()
        if (cancelled.get()) return@flow

        val result = synchronized(lock) {
            val localEngine = engine ?: error("Piper Plus is not loaded")
            val clazz = engineClass ?: error("Piper Plus class is unavailable")
            try {
                @Suppress("UNCHECKED_CAST")
                clazz.getMethod("synthesize", String::class.java, Int::class.javaPrimitiveType!!)
                    .invoke(localEngine, normalized, 0) as ShortArray
            } catch (error: InvocationTargetException) {
                throw error.targetException ?: error
            }
        }

        currentCoroutineContext().ensureActive()
        if (cancelled.get()) return@flow
        check(result.isNotEmpty()) {
            "Piper PlusがPCMを返しませんでした。OpenJTalk辞書を確認してください。"
        }
        emit(SpeechSynthesizer.AudioChunk(modelSampleRate, result))
    }.flowOn(Dispatchers.IO)

    override fun cancel() {
        cancelled.set(true)
    }

    override fun close() {
        synchronized(lock) { closeLocked() }
    }

    private fun invokeCreate(clazz: Class<*>, installation: PiperInstallation): Any {
        val parameterTypes = arrayOf<Class<*>>(
            Context::class.java,
            String::class.java,
            String::class.java,
            String::class.java,
        )
        val arguments = arrayOf(
            appContext,
            installation.model.absolutePath,
            installation.config.absolutePath,
            installation.dictionaryDirectory.absolutePath,
        )

        clazz.methods.firstOrNull { method ->
            method.name == "create" &&
                Modifier.isStatic(method.modifiers) &&
                method.parameterTypes.contentEquals(parameterTypes)
        }?.let { method ->
            return requireNotNull(method.invoke(null, *arguments)) {
                "PiperPlus.create returned null"
            }
        }

        val companion = requireNotNull(clazz.getField("Companion").get(null)) {
            "PiperPlus.Companion is null"
        }
        return requireNotNull(
            companion.javaClass.getMethod("create", *parameterTypes)
                .invoke(companion, *arguments),
        ) {
            "PiperPlus.Companion.create returned null"
        }
    }

    private fun closeLocked() {
        engine?.let { local ->
            runCatching { engineClass?.getMethod("close")?.invoke(local) }
        }
        engine = null
        engineClass = null
        modelSampleRate = 0
    }

    private companion object {
        const val CLASS_NAME = "com.piperplus.PiperPlus"
    }
}
