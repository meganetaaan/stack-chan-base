package jp.stackchan.localvoicepoc.model

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class LiteRtGemmaDeviceTest {
    @Test
    fun loadsExistingE2bModelAndGeneratesText() {
        verifyModel(GemmaModelManifest.E2B)
    }

    @Test
    fun loadsExistingE4bModelAndGeneratesText() {
        verifyModel(GemmaModelManifest.E4B)
    }

    private fun verifyModel(modelSpec: GemmaModelSpec) {
        runBlocking {
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val modelFile = context.noBackupFilesDir.resolve(
                "models/${modelSpec.id}/${modelSpec.fileName}",
            )
            assumeTrue("検証済み${modelSpec.name}が端末にありません", modelFile.isFile)

            val model = LiteRtGemmaLanguageModel(context)
            try {
                withTimeout(TEST_TIMEOUT_MS) {
                    val backend = model.prepare(modelFile)
                    val response = StringBuilder()
                    model.generate(
                        GenerationRequest(
                            systemInstruction = "日本語で指示どおりに短く答えてください。",
                            history = emptyList(),
                            userText = "「はい」とだけ答えてください。",
                            sampling = SamplingProfile(temperature = 0.1),
                        ),
                    ).collect(response::append)

                    assertTrue("Gemmaが空の応答を返しました", response.isNotBlank())
                    Log.i(
                        TAG,
                        "Gemma device smoke test passed: model=${modelSpec.variant}, " +
                            "backend=$backend, response=$response",
                    )
                }
            } finally {
                model.close()
            }
        }
    }

    private companion object {
        const val TAG = "LiteRtGemmaDeviceTest"
        const val TEST_TIMEOUT_MS = 180_000L
    }
}
