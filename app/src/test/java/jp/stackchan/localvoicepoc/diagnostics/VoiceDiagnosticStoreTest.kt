package jp.stackchan.localvoicepoc.diagnostics

import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.file.Files

class VoiceDiagnosticStoreTest {
    @Test
    fun storesExactWhisperInputAsWavWithRecognitionMetadata() = runBlocking {
        val directory = Files.createTempDirectory("recognition-captures").toFile()
        try {
            val pcm = byteArrayOf(0x34, 0x12, 0x78, 0x56)
            val store = RecognitionCaptureStore(directory, nowMillis = { 1_721_523_600_123L })

            val capture = store.save(pcm, 16_000, RecognitionCaptureTrigger.AUTOMATIC)
            store.recordRecognitionResult(capture, "(音楽", null)

            val wav = capture.wavFile.readBytes()
            assertEquals("RIFF", wav.copyOfRange(0, 4).toString(Charsets.US_ASCII))
            assertEquals("WAVE", wav.copyOfRange(8, 12).toString(Charsets.US_ASCII))
            assertEquals(16_000, ByteBuffer.wrap(wav, 24, 4).order(ByteOrder.LITTLE_ENDIAN).int)
            assertArrayEquals(pcm, wav.copyOfRange(44, wav.size))
            val metadata = capture.metadataFile.readText()
            assertTrue(metadata.contains("\"status\":\"rejected_non_speech\""))
            assertTrue(metadata.contains("\"rawTranscription\":\"(音楽\""))
            assertTrue(metadata.contains("\"durationMs\":0"))
        } finally {
            directory.deleteRecursively()
        }
    }

    @Test
    fun writesPlaybackLifecycleAsJsonLines() {
        val directory = Files.createTempDirectory("playback-traces").toFile()
        try {
            val trace = PlaybackTraceStore(directory, nowMillis = { 1_721_523_600_123L })
                .start(22_050, 24_000)
            trace.event("speaker_end_sent", mapOf("sentPcmFrames" to 42))
            assertEquals("", trace.file.readText())
            trace.close("completed")

            val lines = trace.file.readLines()
            assertEquals(3, lines.size)
            assertTrue(lines[0].contains("\"event\":\"session_started\""))
            assertTrue(lines[0].contains("\"schemaVersion\":2"))
            assertTrue(lines[0].contains("\"elapsedUs\":"))
            assertTrue(lines[1].contains("\"sentPcmFrames\":42"))
            assertTrue(lines[2].contains("\"outcome\":\"completed\""))
        } finally {
            directory.deleteRecursively()
        }
    }
}
