#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if ! command -v kotlinc >/dev/null; then
  echo "kotlinc is not installed; running the equivalent Gradle unit tests instead."
  exec "$ROOT/scripts/dev.sh" "$ROOT/gradlew" :app:testDebugUnitTest
fi
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
cat > "$TMP/Smoke.kt" <<'KOTLIN'
import jp.stackchan.localvoicepoc.conversation.SentenceChunker
import jp.stackchan.localvoicepoc.conversation.TranscriptionSanitizer
import jp.stackchan.localvoicepoc.conversation.UtteranceAccumulator
import jp.stackchan.localvoicepoc.serial.StackChanFrame
import jp.stackchan.localvoicepoc.serial.StackChanFrameCodec
import jp.stackchan.localvoicepoc.util.Pcm

fun main() {
    val chunker = SentenceChunker()
    check(chunker.push("こんにちは").isEmpty())
    check(chunker.push("。次です！") == listOf("こんにちは。", "次です！"))
    check(chunker.push("残り").isEmpty())
    check(chunker.flush() == "残り")

    val accumulator = UtteranceAccumulator(
        chunkDurationMs = 100,
        preRollMs = 200,
        endSilenceMs = 300,
        minimumSpeechMs = 200,
        maximumUtteranceMs = 2_000,
    )
    val quiet = ByteArray(4) { 0 }
    val voiced = ByteArray(4) { 1 }
    check(accumulator.accept(quiet, speech = false) == null)
    check(accumulator.accept(voiced, speech = true) == null)
    check(accumulator.accept(voiced, speech = true) == null)
    check(accumulator.accept(quiet, speech = false) == null)
    check(accumulator.accept(quiet, speech = false) == null)
    val utterance = accumulator.accept(quiet, speech = false)
    check(utterance != null && utterance.isNotEmpty())

    val impulse = UtteranceAccumulator(
        chunkDurationMs = 100,
        preRollMs = 0,
        endSilenceMs = 300,
        minimumSpeechMs = 200,
        maximumUtteranceMs = 2_000,
    )
    check(impulse.accept(voiced, speech = true) == null)
    repeat(3) { check(impulse.accept(quiet, speech = false) == null) }
    check(!impulse.isCapturing)

    check(TranscriptionSanitizer.sanitize("(clicking) (scissors snipping)") == null)
    check(TranscriptionSanitizer.sanitize("こんにちは (background noise)") == "こんにちは")
    check(Pcm.floatSamples16Le(byteArrayOf(0x00, 0x80.toByte())).single() == -1f)

    val original = StackChanFrame(
        type = StackChanFrame.Type.SPEAKER_PCM,
        sequence = 3,
        sampleRate = 22050,
        payload = byteArrayOf(1, 2, 3),
    )
    val encoded = StackChanFrameCodec.encode(original)
    val decoded = StackChanFrameCodec.decode(encoded)
    check(original.type == decoded.type)
    check(original.sequence == decoded.sequence)
    check(original.sampleRate == decoded.sampleRate)
    check(original.flags == decoded.flags)
    check(original.payload.contentEquals(decoded.payload))

    val corrupted = encoded.copyOf().also { it[20] = (it[20].toInt() xor 0x01).toByte() }
    check(runCatching { StackChanFrameCodec.decode(corrupted) }.isFailure)

    println("Pure Kotlin smoke tests: OK")
}
KOTLIN
kotlinc \
  "$ROOT/app/src/main/java/jp/stackchan/localvoicepoc/conversation/SentenceChunker.kt" \
  "$ROOT/app/src/main/java/jp/stackchan/localvoicepoc/conversation/TranscriptionSanitizer.kt" \
  "$ROOT/app/src/main/java/jp/stackchan/localvoicepoc/conversation/UtteranceAccumulator.kt" \
  "$ROOT/app/src/main/java/jp/stackchan/localvoicepoc/serial/StackChanFrame.kt" \
  "$ROOT/app/src/main/java/jp/stackchan/localvoicepoc/util/Pcm.kt" \
  "$TMP/Smoke.kt" -include-runtime -d "$TMP/smoke.jar"
java -jar "$TMP/smoke.jar"
