package jp.stackchan.localvoicepoc.model

data class GemmaModelSpec(
    val id: String,
    val name: String,
    val variant: String,
    val repository: String,
    val revision: String,
    val fileName: String,
    val expectedBytes: Long,
    val sha256: String,
) {
    val downloadUrl: String
        get() = "https://huggingface.co/$repository/resolve/$revision/$fileName?download=true"

    val modelCardUrl: String
        get() = "https://huggingface.co/$repository"
}

object GemmaModelManifest {
    const val RUNTIME = "LiteRT-LM 0.14.0"
    const val FORMAT = "litertlm"
    const val DEFAULT_MAX_CONTEXT_TOKENS = 2_048
    const val LICENSE_NAME = "Gemma Terms of Use"
    const val LICENSE_URL = "https://ai.google.dev/gemma/terms"

    val E2B = GemmaModelSpec(
        id = "gemma-4-e2b-it-litert-lm",
        name = "Gemma 4 E2B IT",
        variant = "E2B",
        repository = "litert-community/gemma-4-E2B-it-litert-lm",
        revision = "a4a831c060880f3733135ad22f10e0e9f758f45d",
        fileName = "gemma-4-E2B-it.litertlm",
        expectedBytes = 2_588_147_712L,
        sha256 = "181938105e0eefd105961417e8da75903eacda102c4fce9ce90f50b97139a63c",
    )

    val E4B = GemmaModelSpec(
        id = "gemma-4-e4b-it-litert-lm",
        name = "Gemma 4 E4B IT",
        variant = "E4B",
        repository = "litert-community/gemma-4-E4B-it-litert-lm",
        revision = "f7ad3343bd6ebc9607f4dc3bc4f2398bd5749bc5",
        fileName = "gemma-4-E4B-it.litertlm",
        expectedBytes = 3_659_530_240L,
        sha256 = "0b2a8980ce155fd97673d8e820b4d29d9c7d99b8fa6806f425d969b145bd52e0",
    )

    val all: List<GemmaModelSpec> = listOf(E2B, E4B)
    val default: GemmaModelSpec = E2B

    fun find(id: String?): GemmaModelSpec? = all.firstOrNull { it.id == id }
}
