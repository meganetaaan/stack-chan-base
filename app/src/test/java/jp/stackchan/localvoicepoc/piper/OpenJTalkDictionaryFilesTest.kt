package jp.stackchan.localvoicepoc.piper

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files

class OpenJTalkDictionaryFilesTest {
    @Test
    fun restoresAndroidTrashPrefixes() {
        val directory = Files.createTempDirectory("open-jtalk-dictionary").toFile()
        try {
            OpenJTalkDictionaryFiles.requiredNames.forEachIndexed { index, name ->
                directory.resolve(".trashed-${1_700_000_000 + index}-$name").writeText("data")
            }

            assertEquals(
                OpenJTalkDictionaryFiles.requiredNames.size,
                OpenJTalkDictionaryFiles.restoreTrashedNames(directory),
            )
            assertTrue(OpenJTalkDictionaryFiles.missingFrom(directory).isEmpty())
            assertFalse(directory.listFiles().orEmpty().any { it.name.startsWith(".trashed-") })
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun reportsMissingRequiredDictionaryFiles() {
        val directory = Files.createTempDirectory("incomplete-open-jtalk-dictionary").toFile()
        try {
            directory.resolve("sys.dic").writeText("data")

            val missing = OpenJTalkDictionaryFiles.missingFrom(directory)

            assertFalse("sys.dic" in missing)
            assertTrue("matrix.bin" in missing)
            assertTrue("unk.dic" in missing)
        } finally {
            directory.deleteRecursively()
        }
    }
}
