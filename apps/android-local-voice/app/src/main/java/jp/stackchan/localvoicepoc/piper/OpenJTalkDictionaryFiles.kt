package jp.stackchan.localvoicepoc.piper

import java.io.File

internal object OpenJTalkDictionaryFiles {
    val requiredNames = listOf(
        "char.bin",
        "left-id.def",
        "matrix.bin",
        "pos-id.def",
        "rewrite.def",
        "right-id.def",
        "sys.dic",
        "unk.dic",
    )

    fun missingFrom(directory: File): List<String> =
        requiredNames.filterNot { name -> directory.resolve(name).isFile }

    /** Restores names assigned by Android's trash provider, such as `.trashed-123-sys.dic`. */
    fun restoreTrashedNames(directory: File): Int {
        if (!directory.isDirectory) return 0
        var restoredCount = 0
        directory.listFiles().orEmpty().forEach { entry ->
            val match = TRASHED_NAME.matchEntire(entry.name)
            val restoredEntry = if (match != null) {
                val destination = directory.resolve(match.groupValues[1])
                if (!destination.exists() && entry.renameTo(destination)) {
                    restoredCount += 1
                    destination
                } else {
                    entry
                }
            } else {
                entry
            }
            if (restoredEntry.isDirectory) {
                restoredCount += restoreTrashedNames(restoredEntry)
            }
        }
        return restoredCount
    }

    private val TRASHED_NAME = Regex("\\.trashed-\\d+-(.+)")
}
