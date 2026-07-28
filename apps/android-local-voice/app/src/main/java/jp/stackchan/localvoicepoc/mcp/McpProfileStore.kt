package jp.stackchan.localvoicepoc.mcp

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.core.content.edit
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@Serializable
data class McpProfile(
    val connectorId: String,
    val displayName: String,
    val serverUrl: String,
    val allowCleartext: Boolean = false,
    val forceApproval: Boolean = true,
    val hasBearerToken: Boolean = false,
)

class McpProfileStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)
    private val json = Json { ignoreUnknownKeys = true }

    fun profiles(): List<McpProfile> = runCatching {
        json.decodeFromString<List<McpProfile>>(preferences.getString(PROFILES, "[]") ?: "[]")
    }.getOrDefault(emptyList())

    fun save(profile: McpProfile, bearerToken: String?) {
        require(profile.connectorId.matches(Regex("[A-Za-z0-9_-]+"))) { "connector_idの形式が不正です" }
        validateUrl(profile.serverUrl, profile.allowCleartext)
        val tokenPresent = when {
            bearerToken == null -> profile.hasBearerToken
            bearerToken.isBlank() -> false
            else -> true
        }
        val stored = profile.copy(hasBearerToken = tokenPresent)
        val updated = profiles().filterNot { it.connectorId == profile.connectorId } + stored
        preferences.edit {
            putString(PROFILES, json.encodeToString(updated.sortedBy { it.connectorId }))
            when {
                bearerToken == null -> Unit
                bearerToken.isBlank() -> remove(tokenKey(profile.connectorId))
                else -> putString(tokenKey(profile.connectorId), encrypt(bearerToken))
            }
        }
    }

    fun delete(connectorId: String) {
        preferences.edit {
            putString(PROFILES, json.encodeToString(profiles().filterNot { it.connectorId == connectorId }))
            remove(tokenKey(connectorId))
        }
    }

    fun resolve(connectorId: String): ResolvedMcpProfile {
        val profile = profiles().firstOrNull { it.connectorId == connectorId }
            ?: error("MCPプロファイルが見つかりません: $connectorId")
        val token = preferences.getString(tokenKey(connectorId), null)?.let(::decrypt)
        return ResolvedMcpProfile(profile, token)
    }

    private fun validateUrl(url: String, allowCleartext: Boolean) {
        val uri = java.net.URI(url)
        require(uri.host != null) { "MCP URLが不正です" }
        require(
            uri.scheme == "https" ||
                (
                    uri.scheme == "http" &&
                        allowCleartext &&
                        uri.host.lowercase() in CLEARTEXT_MCP_HOSTS
                    )
        ) {
            "HTTP接続には平文通信の明示許可が必要です"
        }
    }

    private fun encrypt(value: String): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.ENCRYPT_MODE, secretKey())
        return Base64.encodeToString(cipher.iv + cipher.doFinal(value.encodeToByteArray()), Base64.NO_WRAP)
    }

    private fun decrypt(value: String): String {
        val bytes = Base64.decode(value, Base64.NO_WRAP)
        require(bytes.size > IV_BYTES) { "保存されたMCP認証情報が破損しています" }
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, secretKey(), GCMParameterSpec(128, bytes.copyOfRange(0, IV_BYTES)))
        return cipher.doFinal(bytes.copyOfRange(IV_BYTES, bytes.size)).decodeToString()
    }

    private fun secretKey(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey(KEY_ALIAS, null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").run {
            init(
                KeyGenParameterSpec.Builder(
                    KEY_ALIAS,
                    KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
                ).setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                    .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                    .build(),
            )
            generateKey()
        }
    }

    private fun tokenKey(connectorId: String) = "token.$connectorId"

    private companion object {
        const val PREFERENCES = "mcp_profiles"
        const val PROFILES = "profiles"
        const val KEY_ALIAS = "stackchan_mcp_profiles"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val IV_BYTES = 12
        val CLEARTEXT_MCP_HOSTS = setOf("localhost", "127.0.0.1", "10.0.2.2")
    }
}

data class ResolvedMcpProfile(val profile: McpProfile, val bearerToken: String?)
