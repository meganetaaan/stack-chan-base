package jp.stackchan.localvoicepoc.model

import android.content.Context
import android.util.Log
import com.runanywhere.sdk.foundation.bridge.extensions.CppBridgeModelRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File

/** Removes only the Qwen artifact owned by the previous version of this app. */
class LegacyModelCleaner(context: Context) {
    private val runAnywhereDirectory = context.filesDir.resolve("runanywhere")

    suspend fun removeObsoleteQwen(): Long = withContext(Dispatchers.IO) {
        runCatching { CppBridgeModelRegistry.scanAndRestoreDownloadedModels() }
            .onFailure { Log.w(TAG, "Could not scan the legacy model registry", it) }

        if (!runAnywhereDirectory.isDirectory) {
            runCatching { CppBridgeModelRegistry.remove(LEGACY_MODEL_ID) }
            return@withContext 0L
        }

        val rootPath = runAnywhereDirectory.canonicalFile.toPath()
        val registeredPath = runCatching { CppBridgeModelRegistry.get(LEGACY_MODEL_ID) }
            .getOrNull()
            ?.localPath
            .orEmpty()
            .takeIf { it.isNotBlank() }
            ?.let(::File)

        val candidates = buildSet {
            registeredPath?.let { path ->
                if (path.isFile && path.name in LEGACY_FILE_NAMES) add(path)
            }
            runAnywhereDirectory.walkTopDown()
                .maxDepth(MAX_SCAN_DEPTH)
                .filter { it.isFile && it.name in LEGACY_FILE_NAMES }
                .forEach(::add)
        }

        var reclaimedBytes = 0L
        candidates.forEach { candidate ->
            val canonical = runCatching { candidate.canonicalFile }.getOrNull() ?: return@forEach
            if (!canonical.toPath().startsWith(rootPath)) return@forEach
            val size = canonical.length()
            if (canonical.delete()) {
                reclaimedBytes += size
                removeEmptyParents(canonical.parentFile)
            }
        }
        runCatching { CppBridgeModelRegistry.remove(LEGACY_MODEL_ID) }
        if (reclaimedBytes > 0L) {
            Log.i(TAG, "Removed obsolete Qwen model: bytes=$reclaimedBytes")
        }
        reclaimedBytes
    }

    private fun removeEmptyParents(start: File?) {
        var directory = start
        while (directory != null && directory != runAnywhereDirectory) {
            if (!directory.isDirectory || !directory.list().isNullOrEmpty()) return
            val parent = directory.parentFile
            if (!directory.delete()) return
            directory = parent
        }
    }

    private companion object {
        const val TAG = "LegacyModelCleaner"
        const val LEGACY_MODEL_ID = "qwen3-4b-q4_k_m"
        const val LEGACY_FILE_NAME = "Qwen3-4B-Q4_K_M.gguf"
        const val MAX_SCAN_DEPTH = 6
        val LEGACY_FILE_NAMES = setOf(LEGACY_FILE_NAME, "$LEGACY_FILE_NAME.part")
    }
}
