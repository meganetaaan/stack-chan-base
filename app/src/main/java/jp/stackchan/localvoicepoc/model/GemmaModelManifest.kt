package jp.stackchan.localvoicepoc.model

enum class LanguageModelRuntime {
    LITERT_LM,
    LLAMA_CPP,
}

data class LanguageModelSpec(
    val id: String,
    val name: String,
    val variant: String,
    val repository: String,
    val revision: String,
    val fileName: String,
    val expectedBytes: Long,
    val sha256: String,
    val runtime: LanguageModelRuntime,
    val runtimeLabel: String,
    val format: String,
    val maxContextTokens: Int,
    val licenseName: String,
    val licenseUrl: String,
    val supportsTools: Boolean = false,
) {
    val downloadUrl: String
        get() = "https://huggingface.co/$repository/resolve/$revision/$fileName?download=true"

    val modelCardUrl: String
        get() = "https://huggingface.co/$repository"
}

object LanguageModelCatalog {
    val GEMMA_E2B = LanguageModelSpec(
        id = "gemma-4-e2b-it-litert-lm",
        name = "Gemma 4 E2B IT",
        variant = "E2B",
        repository = "litert-community/gemma-4-E2B-it-litert-lm",
        revision = "a4a831c060880f3733135ad22f10e0e9f758f45d",
        fileName = "gemma-4-E2B-it.litertlm",
        expectedBytes = 2_588_147_712L,
        sha256 = "181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c",
        runtime = LanguageModelRuntime.LITERT_LM,
        runtimeLabel = "LiteRT-LM 0.14.0",
        format = "litertlm",
        maxContextTokens = 2_048,
        licenseName = "Gemma Terms of Use",
        licenseUrl = "https://ai.google.dev/gemma/terms",
    )

    val GEMMA_E4B = LanguageModelSpec(
        id = "gemma-4-e4b-it-litert-lm",
        name = "Gemma 4 E4B IT",
        variant = "E4B",
        repository = "litert-community/gemma-4-E4B-it-litert-lm",
        revision = "f7ad3343bd6ebc9607f4dc3bc4f2398bd5749bc5",
        fileName = "gemma-4-E4B-it.litertlm",
        expectedBytes = 3_659_530_240L,
        sha256 = "0b2a8980ce155fd97673d8e820b4d29d9c7d99b8fa6806f425d969b145bd52e0",
        runtime = LanguageModelRuntime.LITERT_LM,
        runtimeLabel = "LiteRT-LM 0.14.0",
        format = "litertlm",
        maxContextTokens = 2_048,
        licenseName = "Gemma Terms of Use",
        licenseUrl = "https://ai.google.dev/gemma/terms",
    )

    val AGENTS_A1_4B = LanguageModelSpec(
        id = "agents-a1-4b-q4-k-m-gguf",
        name = "Agents A1 4B Q4_K_M",
        variant = "A1 4B",
        repository = "InternScience/Agents-A1-4B-Q4_K_M-GGUF",
        revision = "d92b02e27074b27542384f72bc0e72203c970f0f",
        fileName = "Agents-A1-4B-Q4_K_M.gguf",
        expectedBytes = 2_708_805_312L,
        sha256 = "d93c393a9bd5139a4b5cfe24d31ef553c5a497bfb8afec178a354ecbf508f062",
        runtime = LanguageModelRuntime.LLAMA_CPP,
        runtimeLabel = "RunAnywhere llama.cpp 0.20.10",
        format = "GGUF Q4_K_M",
        maxContextTokens = 2_048,
        licenseName = "Apache License 2.0",
        licenseUrl = "https://www.apache.org/licenses/LICENSE-2.0",
        supportsTools = true,
    )

    val all = listOf(GEMMA_E2B, GEMMA_E4B, AGENTS_A1_4B)
    val default = GEMMA_E2B

    fun find(id: String?): LanguageModelSpec? = all.firstOrNull { it.id == id }
}

/** Compatibility facade for existing callers and saved UI work. */
typealias GemmaModelSpec = LanguageModelSpec

object GemmaModelManifest {
    const val RUNTIME = "LiteRT-LM 0.14.0"
    const val FORMAT = "litertlm"
    const val DEFAULT_MAX_CONTEXT_TOKENS = 2_048
    const val LICENSE_NAME = "Gemma Terms of Use"
    const val LICENSE_URL = "https://ai.google.dev/gemma/terms"
    val E2B = LanguageModelCatalog.GEMMA_E2B
    val E4B = LanguageModelCatalog.GEMMA_E4B
    val all = LanguageModelCatalog.all
    val default = LanguageModelCatalog.default
    fun find(id: String?): LanguageModelSpec? = LanguageModelCatalog.find(id)
}
