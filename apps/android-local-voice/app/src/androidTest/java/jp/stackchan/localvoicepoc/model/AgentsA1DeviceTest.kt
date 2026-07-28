package jp.stackchan.localvoicepoc.model

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import jp.stackchan.localvoicepoc.SdkBootstrap
import kotlinx.coroutines.flow.collect
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AgentsA1DeviceTest {
    @Test
    fun usesCurrentDateTimeToolWithExistingModel() {
        runBlocking {
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val modelSpec = LanguageModelCatalog.AGENTS_A1_4B
            val modelFile = context.noBackupFilesDir.resolve(
                "models/${modelSpec.id}/${modelSpec.fileName}",
            )
            assumeTrue("検証済み${modelSpec.name}が端末にありません", modelFile.isFile)

            withTimeout(TEST_TIMEOUT_MS) {
                val status = SdkBootstrap.status.first { it !is SdkBootstrap.Status.Starting }
                check(status is SdkBootstrap.Status.Ready) { "RunAnywhereの初期化に失敗しました: $status" }

                val executedTools = mutableListOf<String>()
                val model = AgentsA1LanguageModel(
                    context,
                    DeviceToolRegistry(context) { executedTools += it.name },
                )
                try {
                    model.prepare(modelSpec, modelFile)
                    val response = StringBuilder()
                    model.generate(
                        GenerationRequest(
                            systemInstruction =
                                "端末ツールを使って事実を確認し、日本語で短く答えてください。",
                            history = emptyList(),
                            userText = "端末の現在日時を教えてください。",
                            sampling = SamplingProfile(temperature = 0.2),
                        ),
                    ).collect(response::append)

                    assertEquals(
                        listOf(DeviceToolRegistry.CURRENT_DATETIME),
                        executedTools,
                    )
                    assertTrue("Agents A1が空の最終回答を返しました", response.isNotBlank())
                    Log.i(TAG, "Agents A1 tool test passed: response=$response")
                } finally {
                    model.close()
                }
            }
        }
    }

    private companion object {
        const val TAG = "AgentsA1DeviceTest"
        const val TEST_TIMEOUT_MS = 600_000L
    }
}
