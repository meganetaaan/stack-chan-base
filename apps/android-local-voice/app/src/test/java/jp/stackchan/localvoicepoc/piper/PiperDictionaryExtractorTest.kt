package jp.stackchan.localvoicepoc.piper

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files
import java.util.zip.ZipEntry
import java.util.zip.ZipOutputStream

class PiperDictionaryExtractorTest {
    @Test
    fun extractsOnlyValidatedDictionarySubtree() {
        val root = Files.createTempDirectory("piper-dictionary-extractor").toFile()
        try {
            val archive = root.resolve("piper.zip")
            createArchive(
                archive,
                OpenJTalkDictionaryFiles.requiredNames.associate { name ->
                    "${PiperAssetLinks.DICTIONARY_ENTRY_PREFIX}$name" to "data-$name"
                } + ("piper/piper.exe" to "not extracted"),
            )
            val destination = root.resolve("dictionary")

            runBlocking {
                PiperDictionaryExtractor.extract(
                    archive,
                    destination,
                    PiperAssetLinks.DICTIONARY_ENTRY_PREFIX,
                )
            }

            assertTrue(OpenJTalkDictionaryFiles.missingFrom(destination).isEmpty())
            assertFalse(root.resolve("piper.exe").exists())
            assertFalse(destination.resolve("piper.exe").exists())
        } finally {
            root.deleteRecursively()
        }
    }

    @Test
    fun rejectsEntryEscapingDictionaryDirectory() {
        val root = Files.createTempDirectory("piper-dictionary-escape").toFile()
        try {
            val archive = root.resolve("malicious.zip")
            createArchive(
                archive,
                mapOf(
                    "${PiperAssetLinks.DICTIONARY_ENTRY_PREFIX}../../outside.txt" to "bad",
                ),
            )

            val result = runCatching {
                runBlocking {
                    PiperDictionaryExtractor.extract(
                        archive,
                        root.resolve("dictionary"),
                        PiperAssetLinks.DICTIONARY_ENTRY_PREFIX,
                    )
                }
            }

            assertTrue(result.exceptionOrNull() is IllegalArgumentException)
            assertFalse(root.resolve("outside.txt").exists())
        } finally {
            root.deleteRecursively()
        }
    }

    private fun createArchive(archive: File, entries: Map<String, String>) {
        ZipOutputStream(archive.outputStream().buffered()).use { zip ->
            entries.forEach { (name, content) ->
                zip.putNextEntry(ZipEntry(name))
                zip.write(content.toByteArray())
                zip.closeEntry()
            }
        }
    }
}
